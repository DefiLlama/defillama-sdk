/**
 * XRP Ledger JSON-RPC client.
 *
 * Replaces the per-repo XRPL helpers:
 *  - server/defi/l2/utils.ts (XRPL_RPC, decodeXrplCurrency, isRetryableXrplError,
 *    xrplRpc, fetchXrplObligations, getXrplSupplies)
 *  - DefiLlama-Adapters/projects/helper/sumTokens.js (getRippleBalance, ripplePost,
 *    addRippleTokenBalance, rippleTokenDecimals)
 *  - peggedassets-server/src/adapters/peggedAssets/helper/getSupply.ts (rippleGetTotalSupply)
 *  - peggedassets-server/src/adapters/peggedAssets/xsgd/index.ts (rippleMinted)
 *  - dimension-adapters/helpers/ripple.ts (rpcCall)
 *
 * XRPL JSON-RPC is not JSON-RPC 2.0: the body is `{ method, params: [{...}] }` and
 * the node answers `{ result: { ..., status: 'success' | 'error', error, error_message } }`,
 * so `rpc` is implemented directly over `httpPost` instead of `jsonRpc`.
 *
 * Endpoints: `XRPL_RPC` env (comma separated) overrides `DEFAULT_ENDPOINTS`.
 *
 * Amount conventions: XRP balances are returned in drops (string, 1 XRP = 1e6 drops);
 * issued-currency amounts (`account_lines`, `gateway_balances`) are human-readable
 * decimal strings as reported by the ledger (IOUs have no on-chain `decimals`).
 */
import { createHash } from "crypto";
import { getEndpoints as resolveEndpoints, getLimiter, httpPost, sleep } from "./rpc";
import { debugLog } from "../util/debugLog";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Public XRPL nodes that answer bursts without throttling (xrpl.ws / xrpl.link 429 after a few calls). */
export const DEFAULT_ENDPOINTS: string[] = [
  'https://xrplcluster.com',
  'https://s1.ripple.com:51234',
  'https://s2.ripple.com:51234',
]

/** Seconds between the unix epoch and the ripple epoch (2000-01-01T00:00:00Z). */
export const RIPPLE_EPOCH_OFFSET = 946684800

/** Earliest ledger kept by full-history nodes (ledgers before this were lost). */
const EARLIEST_LEDGER = 32570

const CHAIN = 'xrpl'
const MAX_ATTEMPTS = 4
const REQUEST_TIMEOUT = 30_000
/** Per-request delay multiplier; 1500ms * attempt covers the ~7s quota window xrplcluster reports on a rate limit. */
const RETRY_DELAY = 1500

export function getEndpoints(): string[] {
  return resolveEndpoints(CHAIN, DEFAULT_ENDPOINTS)
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type LedgerIndex = number | string | 'validated' | 'closed' | 'current'

export interface TokenId {
  /** 3-char ISO-like code or 40-char hex for non-standard codes */
  currency: string
  /** issuer account (rXXX) */
  issuer: string
}

export interface AccountLine {
  account: string
  balance: string
  currency: string
  limit: string
  limit_peer: string
  quality_in: number
  quality_out: number
  no_ripple?: boolean
  no_ripple_peer?: boolean
  authorized?: boolean
  peer_authorized?: boolean
  freeze?: boolean
  freeze_peer?: boolean
  [key: string]: any
}

export interface LedgerInfo {
  number: number
  /** unix seconds (ripple epoch already converted) */
  timestamp: number
  hash: string
}

export class XrplRpcError extends Error {
  method: string
  /** node error code, e.g. `actNotFound`, `tooBusy`, `lgrNotFound` */
  error?: string
  constructor(method: string, message: string, error?: string) {
    super(`xrpl ${method} failed: ${message}`)
    this.name = 'XrplRpcError'
    this.method = method
    this.error = error
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * Decode a ledger currency code: 3-char codes pass through, 40-char hex blobs
 * (non-standard codes longer than 3 chars) are decoded to ascii with the trailing
 * null padding stripped. Anything else is returned unchanged.
 */
export function decodeCurrency(code: string): string {
  if (typeof code !== 'string') return code
  if (code.length === 3) return code
  if (/^[0-9A-Fa-f]{40}$/.test(code)) {
    const buf = Buffer.from(code, 'hex')
    let end = buf.length
    while (end > 0 && buf[end - 1] === 0) end--
    return buf.slice(0, end).toString('ascii')
  }
  return code
}

/**
 * Encode a human-readable currency code for the ledger: 3-char codes pass through,
 * longer codes become the 40-char uppercase hex the ledger uses (ascii, null padded).
 * A code that already is 40-char hex is returned uppercased.
 */
export function encodeCurrency(str: string): string {
  if (str.length === 3) return str
  if (/^[0-9A-Fa-f]{40}$/.test(str)) return str.toUpperCase()
  if (str.length > 20) throw new Error(`xrpl currency code too long (max 20 bytes): ${str}`)
  return Buffer.from(str, 'ascii').toString('hex').toUpperCase().padEnd(40, '0')
}

/** Accept `'CODE.rISSUER'` or `{ currency, issuer }` and return `{ currency, issuer }`. */
export function parseToken(token: string | TokenId): TokenId {
  if (typeof token === 'object' && token !== null) {
    if (!token.currency || !token.issuer) throw new Error(`xrpl: invalid token ${JSON.stringify(token)}`)
    return { currency: token.currency, issuer: token.issuer }
  }
  if (typeof token !== 'string') throw new Error(`xrpl: invalid token ${String(token)}`)
  const dotIdx = token.indexOf('.')
  if (dotIdx === -1) throw new Error(`xrpl: invalid token "${token}", expected "CODE.rISSUER"`)
  const currency = token.substring(0, dotIdx)
  const issuer = token.substring(dotIdx + 1)
  if (!currency || !issuer) throw new Error(`xrpl: invalid token "${token}", expected "CODE.rISSUER"`)
  return { currency, issuer }
}

/** Format `{ currency, issuer }` as `'CODE.rISSUER'`. */
export function formatToken({ currency, issuer }: TokenId): string {
  return `${currency}.${issuer}`
}

/**
 * xrplcluster answers `tooBusy` / `rate limit` under load, and a paged walk trips its
 * units quota on its own. Those are retryable; a malformed request or a real ledger
 * error (`actNotFound`, `lgrNotFound`, `invalidParams`, ...) is not.
 */
export function isRetryableError(message: string): boolean {
  return /rate ?limit|tooBusy|too busy|slowDown|quota|timeout|ECONN|ETIMEDOUT|EAI_AGAIN|socket|network|fetch failed|502|503|504|429|noNetwork|noCurrent|noClosed|empty response/i.test(String(message ?? ''))
}

export function rippleTimeToUnix(rippleTime: number): number {
  return Number(rippleTime) + RIPPLE_EPOCH_OFFSET
}

export function unixToRippleTime(timestamp: number): number {
  return Number(timestamp) - RIPPLE_EPOCH_OFFSET
}

const RIPPLE_ALPHABET = 'rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz'
const RIPPLE_ALPHABET_MAP: Record<string, number> = {}
for (let i = 0; i < RIPPLE_ALPHABET.length; i++) RIPPLE_ALPHABET_MAP[RIPPLE_ALPHABET[i]] = i

function base58Decode(str: string): Buffer | undefined {
  let value = BigInt(0)
  const base = BigInt(58)
  for (const ch of str) {
    const digit = RIPPLE_ALPHABET_MAP[ch]
    if (digit === undefined) return undefined
    value = value * base + BigInt(digit)
  }
  let hex = value.toString(16)
  if (hex.length % 2) hex = '0' + hex
  let bytes = Buffer.from(hex, 'hex')
  // leading zero bytes are encoded as leading 'r' (alphabet index 0)
  let leadingZeros = 0
  for (const ch of str) {
    if (ch !== RIPPLE_ALPHABET[0]) break
    leadingZeros++
  }
  if (value === BigInt(0)) bytes = Buffer.alloc(0)
  return Buffer.concat([Buffer.alloc(leadingZeros, 0), bytes])
}

/**
 * Classic address check: ripple base58 alphabet, 25..35 chars, decodes to 25 bytes
 * with the account-id type prefix (0x00) and a valid double-sha256 checksum.
 */
export function isValidAddress(str: string): boolean {
  if (typeof str !== 'string') return false
  if (str.length < 25 || str.length > 35) return false
  if (str[0] !== 'r') return false
  const bytes = base58Decode(str)
  if (!bytes || bytes.length !== 25) return false
  if (bytes[0] !== 0x00) return false
  const payload = bytes.slice(0, 21)
  const checksum = bytes.slice(21)
  const hash = createHash('sha256').update(createHash('sha256').update(payload).digest()).digest()
  return hash.slice(0, 4).equals(checksum)
}

// ---------------------------------------------------------------------------
// rpc
// ---------------------------------------------------------------------------

export interface RpcOptions {
  ledgerIndex?: LedgerIndex
  /** total attempts, default 4 */
  retries?: number
  timeout?: number
}

/**
 * Single XRPL JSON-RPC call. Returns `result`; throws `XrplRpcError` (with the
 * node's `error_message` / `error`) when the node reports `status: 'error'`.
 * Rotates over the endpoint list and retries only the transient error shapes
 * (`tooBusy`, `slowDown`, rate limits, timeouts, 5xx, network errors).
 */
export async function rpc(method: string, params: Record<string, any> = {}, options: RpcOptions = {}): Promise<any> {
  const { ledgerIndex, retries = MAX_ATTEMPTS, timeout = REQUEST_TIMEOUT } = options
  const endpoints = getEndpoints()
  const attempts = Math.max(1, retries, endpoints.length)
  const call = { ...params }
  if (ledgerIndex !== undefined && call.ledger_index === undefined && call.ledger_hash === undefined) call.ledger_index = ledgerIndex
  const body = { method, params: [call] }
  const label = params.account ?? call.ledger_index ?? ''
  const limiter = getLimiter(CHAIN, 5)
  const start = Math.floor(Math.random() * endpoints.length)
  let lastError: any
  for (let attempt = 0; attempt < attempts; attempt++) {
    const url = endpoints[(start + attempt) % endpoints.length]
    try {
      return await limiter(async () => {
        const data = await httpPost(url, body, { timeout, retries: 1 })
        const result = data?.result
        if (!result || typeof result !== 'object') throw new XrplRpcError(method, `empty response from ${url}`)
        if (result.status === 'error' || result.error) {
          // keep both the code (`slowDown`) and the text (`... too busy ...`) so the retry classifier sees either
          const text = [result.error, result.error_message].filter(Boolean).join(': ') || 'unknown error'
          throw new XrplRpcError(method, text, result.error)
        }
        return result
      })
    } catch (e: any) {
      lastError = e
      const message = e?.message ?? String(e)
      const isLast = attempt === attempts - 1
      if (isLast || !isRetryableError(message)) break
      const wait = RETRY_DELAY * (attempt + 1)
      debugLog(`[chains.xrpl] ${method} ${label} failed (attempt ${attempt + 1}/${attempts}) on ${url}, retrying in ${wait}ms: ${String(message).slice(0, 200)}`)
      await sleep(wait)
    }
  }
  if (lastError instanceof XrplRpcError) throw lastError
  throw new XrplRpcError(method, `${label} ${lastError?.message ?? String(lastError)}`.trim())
}

function isMissingAccount(e: any) {
  return e instanceof XrplRpcError && (e.error === 'actNotFound' || e.error === 'actMalformed')
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

/** `account_info` result (`account_data`, `ledger_index`, ...). Throws `actNotFound` for unfunded accounts. */
export async function getAccountInfo({ account, ledgerIndex = 'validated' }: { account: string, ledgerIndex?: LedgerIndex }): Promise<any> {
  return rpc('account_info', { account, strict: true }, { ledgerIndex })
}

/** XRP balance in drops as a string. Unfunded / malformed accounts resolve to `'0'`. */
export async function getXrpBalance({ account, ledgerIndex = 'validated' }: { account: string, ledgerIndex?: LedgerIndex }): Promise<string> {
  try {
    const res = await getAccountInfo({ account, ledgerIndex })
    return String(res?.account_data?.Balance ?? '0')
  } catch (e) {
    if (isMissingAccount(e)) return '0'
    throw e
  }
}

/** All trust lines of `account` (walks `marker` pages). Unfunded accounts resolve to `[]`. */
export async function getAccountLines({ account, peer, ledgerIndex = 'validated', limit = 400, maxPages = Infinity }: { account: string, peer?: string, ledgerIndex?: LedgerIndex, limit?: number, maxPages?: number }): Promise<AccountLine[]> {
  const lines: AccountLine[] = []
  let marker: any
  let pinnedLedger: LedgerIndex = ledgerIndex
  let pages = 0
  try {
    do {
      const params: Record<string, any> = { account, limit }
      if (peer) params.peer = peer
      if (marker !== undefined) params.marker = marker
      const res = await rpc('account_lines', params, { ledgerIndex: pinnedLedger })
      if (Array.isArray(res.lines)) lines.push(...res.lines)
      // pin the ledger after the first page so paging is consistent
      if (res.ledger_index !== undefined) pinnedLedger = res.ledger_index
      marker = res.marker
      pages++
      if (pages >= maxPages && marker) {
        debugLog(`[chains.xrpl] account_lines ${account}: stopped after ${pages} page(s), more available`)
        break
      }
    } while (marker !== undefined && marker !== null)
  } catch (e) {
    if (isMissingAccount(e) && !lines.length) return []
    throw e
  }
  return lines
}

/** All ledger objects owned by `account` (walks `marker` pages). `type` filters e.g. `'state'`, `'offer'`, `'escrow'`. */
export async function getAccountObjects({ account, type, ledgerIndex = 'validated', limit = 400 }: { account: string, type?: string, ledgerIndex?: LedgerIndex, limit?: number }): Promise<any[]> {
  const objects: any[] = []
  let marker: any
  let pinnedLedger: LedgerIndex = ledgerIndex
  try {
    do {
      const params: Record<string, any> = { account, limit }
      if (type) params.type = type
      if (marker !== undefined) params.marker = marker
      const res = await rpc('account_objects', params, { ledgerIndex: pinnedLedger })
      if (Array.isArray(res.account_objects)) objects.push(...res.account_objects)
      if (res.ledger_index !== undefined) pinnedLedger = res.ledger_index
      marker = res.marker
    } while (marker !== undefined && marker !== null)
  } catch (e) {
    if (isMissingAccount(e) && !objects.length) return []
    throw e
  }
  return objects
}

/**
 * Raw `gateway_balances` result for an issuer: `obligations` (currency -> total
 * owed to non-hot-wallet holders), `balances` (hot wallet holdings), `assets`.
 * `hotWallets` are the issuer's own operational accounts; an address equal to the
 * issuer is dropped (an issuer is never its own hot wallet and the node errors on it).
 */
export async function getGatewayBalances({ account, hotWallets = [], ledgerIndex = 'validated' }: { account: string, hotWallets?: string[], ledgerIndex?: LedgerIndex }): Promise<any> {
  const hotwallet = hotWallets.filter(w => w && w !== account)
  const params: Record<string, any> = { account, strict: true }
  if (hotwallet.length) params.hotwallet = hotwallet
  return rpc('gateway_balances', params, { ledgerIndex })
}

/**
 * Issuer obligations keyed by decoded currency code (circulating supply per
 * currency). Obligations owed to `hotWallets` are un-issued float and excluded by
 * the node. Throws rather than returning `{}` on a failed read, so an unreadable
 * issuer never looks like a zero-supply one.
 */
export async function getObligations({ issuer, hotWallets = [], ledgerIndex = 'validated' }: { issuer: string, hotWallets?: string[], ledgerIndex?: LedgerIndex }): Promise<{ [currency: string]: string }> {
  const res = await getGatewayBalances({ account: issuer, hotWallets, ledgerIndex })
  const obligations: { [currency: string]: string } = res?.obligations ?? {}
  const decoded: { [currency: string]: string } = {}
  for (const [code, amount] of Object.entries(obligations)) {
    const key = decodeCurrency(code)
    if (decoded[key] === undefined) decoded[key] = String(amount)
    else decoded[key] = String(Number(decoded[key]) + Number(amount)) // two encodings of the same code, extremely rare
  }
  return decoded
}

/**
 * Circulating supply of one issued currency as a decimal string (`'0'` when the
 * issuer has no such obligation). `currency` may be the 3-char / human code or the
 * 40-char hex form; `'CODE.rISSUER'` is accepted too.
 */
export async function getTokenSupply(token: string | (TokenId & { hotWallets?: string[], ledgerIndex?: LedgerIndex }), { hotWallets, ledgerIndex }: { hotWallets?: string[], ledgerIndex?: LedgerIndex } = {}): Promise<string> {
  const { currency, issuer } = parseToken(token)
  if (typeof token === 'object') {
    hotWallets = hotWallets ?? token.hotWallets
    ledgerIndex = ledgerIndex ?? token.ledgerIndex
  }
  const obligations = await getObligations({ issuer, hotWallets, ledgerIndex })
  return obligations[decodeCurrency(currency)] ?? '0'
}

/**
 * Balance of an issued currency held by `account` (trust line with `issuer`), as
 * the human-readable decimal string reported by `account_lines`. `'0'` when there is
 * no such line. Negative values mean `account` is itself the issuer of that line.
 */
export async function getTokenBalance({ account, currency, issuer, ledgerIndex = 'validated' }: { account: string, currency: string, issuer: string, ledgerIndex?: LedgerIndex }): Promise<string> {
  const lines = await getAccountLines({ account, peer: issuer, ledgerIndex })
  const wanted = decodeCurrency(currency)
  const line = lines.find(l => l.account === issuer && decodeCurrency(l.currency) === wanted)
  return line ? String(line.balance) : '0'
}

/**
 * All issued-currency balances of `account` keyed by `'CODE.rISSUER'` (currency
 * kept in ledger form). Amounts are human-readable decimal strings.
 */
export async function getTokenBalances({ account, ledgerIndex = 'validated' }: { account: string, ledgerIndex?: LedgerIndex }): Promise<{ [token: string]: string }> {
  const lines = await getAccountLines({ account, ledgerIndex })
  const balances: { [token: string]: string } = {}
  for (const line of lines) balances[formatToken({ currency: line.currency, issuer: line.account })] = String(line.balance)
  return balances
}

// ---------------------------------------------------------------------------
// ledgers
// ---------------------------------------------------------------------------

/** Ledger header: `{ number, timestamp (unix seconds), hash }`. */
export async function getLedger({ ledgerIndex = 'validated' }: { ledgerIndex?: LedgerIndex } = {}): Promise<LedgerInfo> {
  const res = await rpc('ledger', { transactions: false, expand: false, accounts: false }, { ledgerIndex })
  const ledger = res.ledger ?? res.closed?.ledger ?? {}
  const number = Number(ledger.ledger_index ?? res.ledger_index)
  const closeTime = ledger.close_time
  if (!Number.isFinite(number) || closeTime === undefined) throw new XrplRpcError('ledger', `unexpected response for ledger ${ledgerIndex}`)
  return {
    number,
    timestamp: rippleTimeToUnix(Number(closeTime)),
    hash: ledger.ledger_hash ?? res.ledger_hash,
  }
}

export async function getLatestLedger(): Promise<LedgerInfo> {
  return getLedger({ ledgerIndex: 'validated' })
}

/**
 * Last validated ledger closed at or before `timestamp` (unix seconds). Binary
 * search on `ledger_index`, starting from a bracket estimated with the ~3s minimum
 * close interval. Requires a full-history node for old timestamps.
 */
export async function getLedgerAtTimestamp({ timestamp }: { timestamp: number }): Promise<LedgerInfo> {
  const latest = await getLatestLedger()
  if (timestamp >= latest.timestamp) return latest
  let high = latest.number
  // ledgers close no faster than ~3s, so this many ledgers back is guaranteed to be at/before the target
  const estimate = Math.max(EARLIEST_LEDGER, high - Math.ceil((latest.timestamp - timestamp) / 3) - 10)
  let low = EARLIEST_LEDGER
  if (estimate > EARLIEST_LEDGER) {
    const guess = await getLedger({ ledgerIndex: estimate })
    if (guess.timestamp <= timestamp) low = guess.number
    else high = guess.number
  }
  let best: LedgerInfo | undefined
  while (low <= high) {
    const mid = Math.floor((low + high) / 2)
    const ledger = await getLedger({ ledgerIndex: mid })
    if (ledger.timestamp <= timestamp) {
      best = ledger
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  if (!best) throw new Error(`xrpl: no ledger found at or before timestamp ${timestamp}`)
  return best
}

/** `server_info` result (`info.validated_ledger`, `info.complete_ledgers`, ...). */
export async function getServerInfo(): Promise<any> {
  return rpc('server_info')
}
