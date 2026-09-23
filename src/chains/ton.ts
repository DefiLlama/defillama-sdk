/**
 * TON client: toncenter (v2 + v3), tonapi, and a dependency-free address / BoC codec.
 *
 * Replaces the TON glue scattered across the DefiLlama repos:
 * - DefiLlama-Adapters `projects/helper/chain/ton.js` (getTonBalance, getJettonBalances,
 *   getTokenRates, getJettonsInfo, call/runGetMethod, processTVMSliceReadAddress, parseBoc,
 *   BitReader, serializeAddress, computeCRC16) — the TVL parts (sumTokens, addJettonBalances,
 *   addTonBalances) are intentionally not ported.
 * - DefiLlama-Adapters `projects/helper/chain/utils/ton-address.js` (addressToInt,
 *   convertIntToAddress, compareAddress)
 * - DefiLlama-Adapters `projects/helper/utils/ton.js` and defillama-server
 *   `coins/src/utils/ton.ts` (ton-core `Address` + crc16)
 * - defillama-server `coins/src/adapters/other/ton.ts` (runGetMethod stack decoding) and
 *   `coins/src/scripts/coingeckoUtils.ts` (jetton symbol / decimals lookup)
 * - peggedassets-server `helper/getSupply.ts` tonTokenSupply (v3 jetton/masters)
 * - dimension-adapters `fees/sTONks`, `fees/hipo` (v3 /transactions and /messages window
 *   pagination) and `helpers/getBlock.ts` getTonBlock (v2 lookupBlock)
 *
 * Endpoints: `TON_RPC` (toncenter base, default https://toncenter.com) and `TON_API_RPC`
 * (tonapi base, default https://tonapi.io). Keys: `TONCENTER_API_KEY` (sent as `X-API-Key`)
 * and `TON_API_KEY` (tonapi bearer token). Unauthenticated toncenter / tonapi allow about one
 * request per second, so every call goes through a per-service limiter that spaces requests
 * (`TON_RPC_MIN_INTERVAL_MS` / `TONAPI_RPC_MIN_INTERVAL_MS` override the spacing,
 * `TON_RPC_CONCURRENCY` / `TONAPI_RPC_CONCURRENCY` the concurrency).
 */
import { getEnvValue } from "../util/env";
import { debugLog } from "../util/debugLog";
import { getEndpoints, getLimiter, httpGet, httpPost, sliceIntoChunks, sleep } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const DEFAULT_ENDPOINTS = {
  toncenter: 'https://toncenter.com',
  tonapi: 'https://tonapi.io',
}

/** All configured toncenter base urls (`TON_RPC`, comma separated) */
export function getToncenterEndpoints(): string[] {
  return getEndpoints('ton', DEFAULT_ENDPOINTS.toncenter)
}

export function getToncenterEndpoint(): string {
  return getToncenterEndpoints()[0]
}

/** All configured tonapi base urls (`TON_API_RPC`, comma separated) */
export function getTonapiEndpoints(): string[] {
  return getEndpoints('ton', DEFAULT_ENDPOINTS.tonapi, { envKey: 'TON_API_RPC' })
}

export function getTonapiEndpoint(): string {
  return getTonapiEndpoints()[0]
}

function getToncenterApiKey(): string | undefined {
  return getEnvValue('TONCENTER_API_KEY')
}

function getTonapiKey(): string | undefined {
  return getEnvValue('TON_API_KEY')
}

function toncenterHeaders(): Record<string, string> {
  const key = getToncenterApiKey()
  return key ? { 'X-API-Key': key } : {}
}

function tonapiHeaders(): Record<string, string> {
  const key = getTonapiKey()
  if (!key) return {}
  // the adapters repo stores the key with the scheme already included ("Bearer xxx"), accept both forms
  return { Authorization: /^bearer /i.test(key) ? key : `Bearer ${key}` }
}

// ---------------------------------------------------------------------------
// rate limiting
// ---------------------------------------------------------------------------

const lastRequestAt: Record<string, number> = {}

/**
 * Serialise requests per service and keep at least `minIntervalMs` between them. Without an
 * API key both toncenter and tonapi allow roughly one request per second; with a key the
 * spacing is dropped and the limiter allows a few parallel requests.
 */
async function paced<T>(service: 'TON' | 'TONAPI', fn: () => Promise<T>): Promise<T> {
  const hasKey = service === 'TON' ? !!getToncenterApiKey() : !!getTonapiKey()
  const envInterval = getEnvValue(`${service}_RPC_MIN_INTERVAL_MS`)
  const minIntervalMs = envInterval !== undefined ? +envInterval : hasKey ? 0 : 1100
  const limiter = getLimiter(service, hasKey ? 5 : 1)
  return limiter(async () => {
    const wait = (lastRequestAt[service] ?? 0) + minIntervalMs - Date.now()
    if (wait > 0) await sleep(wait)
    try {
      return await fn()
    } finally {
      lastRequestAt[service] = Date.now()
    }
  })
}

// 429s from toncenter need a longer pause than the transport default
const TONCENTER_RETRY = { retries: 4, delay: 1500, maxDelay: 8000 }
const TONAPI_RETRY = { retries: 3, delay: 1500, maxDelay: 8000 }

// ---------------------------------------------------------------------------
// toncenter transport
// ---------------------------------------------------------------------------

export interface ToncenterGetOptions {
  path: string
  params?: Record<string, any>
  /** api version, default 3 */
  version?: 2 | 3
}

export interface ToncenterPostOptions {
  path: string
  body?: any
  /** api version, default 2 */
  version?: 2 | 3
}

function toncenterPath(path: string, version: number) {
  return `/api/v${version}/${path.replace(/^\/+/, '')}`
}

function dropUndefined(params: Record<string, any> = {}) {
  const res: Record<string, any> = {}
  Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null) res[k] = params[k] })
  return res
}

/** toncenter v2 wraps everything in `{ ok, result, error }`; unwrap and surface errors */
function unwrapV2(res: any, label: string) {
  if (res && typeof res === 'object' && 'ok' in res) {
    if (!res.ok) throw new Error(`toncenter ${label} failed: ${res.error ?? res.result ?? 'unknown error'}${res.code !== undefined ? ` (code ${res.code})` : ''}`)
    return res.result
  }
  return res
}

/** GET `/api/v{version}/{path}` on toncenter. Returns the raw response body (v2 bodies are `{ok, result}`). */
export async function toncenterGet({ path, params, version = 3 }: ToncenterGetOptions): Promise<any> {
  return paced('TON', () => httpGet(getToncenterEndpoints(), {
    path: toncenterPath(path, version),
    params: dropUndefined(params),
    headers: toncenterHeaders(),
    ...TONCENTER_RETRY,
  }))
}

/** POST to `/api/v{version}/{path}` on toncenter. Returns the raw response body. */
export async function toncenterPost({ path, body = {}, version = 2 }: ToncenterPostOptions): Promise<any> {
  return paced('TON', () => httpPost(getToncenterEndpoints(), body, {
    path: toncenterPath(path, version),
    headers: toncenterHeaders(),
    ...TONCENTER_RETRY,
  }))
}

// ---------------------------------------------------------------------------
// toncenter: accounts & jettons
// ---------------------------------------------------------------------------

/** Full v3 account state: `{ balance, status, code, data, last_transaction_lt, last_transaction_hash, frozen_hash }` */
export async function getAccountState({ address }: { address: string }): Promise<any> {
  return toncenterGet({ path: 'account', params: { address } })
}

/** TON balance in nanoton, as a decimal string */
export async function getTonBalance({ address }: { address: string }): Promise<string> {
  const res = await getAccountState({ address })
  if (res?.balance === undefined || res?.balance === null) throw new Error(`toncenter account: no balance for ${address}`)
  return String(res.balance)
}

export interface JettonMaster {
  address: string
  total_supply: string
  mintable: boolean
  admin_address: string | null
  jetton_content: Record<string, any> | null
  jetton_wallet_code_hash: string
  code_hash: string
  data_hash: string
  last_transaction_lt: string
  [key: string]: any
}

/** v3 `jetton/masters` entry for one jetton. Throws when the address is not a jetton master. */
export async function getJettonMaster({ address }: { address: string }): Promise<JettonMaster> {
  const res = await toncenterGet({ path: 'jetton/masters', params: { address, limit: 1, offset: 0 } })
  const master = res?.jetton_masters?.[0]
  if (!master) throw new Error(`toncenter jetton/masters: ${address} is not a known jetton master`)
  return master
}

function parseDecimals(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/** `{ supply, decimals }` of a jetton from its v3 master record. `decimals` is undefined when the content is off-chain. */
export async function getJettonSupply({ address }: { address: string }): Promise<{ supply: string, decimals?: number }> {
  const master = await getJettonMaster({ address })
  return { supply: String(master.total_supply), decimals: parseDecimals(master.jetton_content?.decimals) }
}

export interface JettonWallet {
  address: string
  balance: string
  owner: string
  jetton: string
  last_transaction_lt: string
  code_hash: string
  data_hash: string
  [key: string]: any
}

export interface GetJettonWalletsOptions {
  /** owner address(es); several are sent comma separated */
  owner?: string | string[]
  /** jetton master address */
  jetton?: string
  /** page size, default 256 */
  limit?: number
  offset?: number
  /** fetch every page, default true */
  paginate?: boolean
  excludeZeroBalance?: boolean
}

/** v3 `jetton/wallets` filtered by owner and/or jetton, all pages by default */
export async function getJettonWallets({ owner, jetton, limit = 256, offset = 0, paginate = true, excludeZeroBalance }: GetJettonWalletsOptions): Promise<JettonWallet[]> {
  if (!owner && !jetton) throw new Error('getJettonWallets: owner or jetton is required')
  const owner_address = Array.isArray(owner) ? owner.join(',') : owner
  const all: JettonWallet[] = []
  for (let page = 0; ; page++) {
    const res = await toncenterGet({
      path: 'jetton/wallets',
      params: { owner_address, jetton_address: jetton, limit, offset: offset + page * limit, exclude_zero_balance: excludeZeroBalance },
    })
    const wallets: JettonWallet[] = res?.jetton_wallets ?? []
    all.push(...wallets)
    if (!paginate || wallets.length < limit) break
    debugLog(`[chains.ton] jetton/wallets page ${page + 1} (${all.length} so far)`)
  }
  return all
}

/** Balance (smallest units, decimal string) of `owner` in `jetton`; '0' when no wallet exists */
export async function getJettonWalletBalance({ owner, jetton }: { owner: string, jetton: string }): Promise<string> {
  const wallets = await getJettonWallets({ owner, jetton, limit: 16, paginate: false })
  let total = BigInt(0)
  wallets.forEach(w => { total += BigInt(w.balance ?? 0) })
  return total.toString()
}

// ---------------------------------------------------------------------------
// toncenter: get methods
// ---------------------------------------------------------------------------

/** toncenter v2 stack entry, e.g. `['num', '0x1']`, `['cell', { bytes }]`, `['tuple', ...]` */
export type StackItem = [string, any]

export interface RunGetMethodResult {
  exit_code: number
  gas_used: number
  stack: StackItem[]
  [key: string]: any
}

/** v2 `runGetMethod`; returns the unwrapped result `{ exit_code, gas_used, stack }` */
export async function runGetMethod({ address, method, stack = [] }: { address: string, method: string, stack?: any[] }): Promise<RunGetMethodResult> {
  const res = await toncenterPost({ path: 'runGetMethod', body: { address, method, stack }, version: 2 })
  return unwrapV2(res, `runGetMethod ${method}`)
}

function parseStackNumber(value: string): number | bigint {
  const s = String(value).trim()
  const big = s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s)
  const n = Number(big)
  return Number.isSafeInteger(n) ? n : big
}

function stackBytes(item: StackItem): string | undefined {
  const payload = item[1]
  if (typeof payload === 'string') return payload
  return payload?.bytes
}

/** Decode one runGetMethod stack entry: num -> number (bigint when unsafe), cell/slice holding an address -> friendly address, anything else is returned as-is */
export function decodeStackItem(item: StackItem): any {
  const [type] = item
  if (type === 'num') return parseStackNumber(item[1])
  if (type === 'cell' || type === 'slice' || type === 'tvm.Cell' || type === 'tvm.Slice') {
    const bytes = stackBytes(item)
    if (bytes) {
      const address = tryReadAddressFromSlice(bytes)
      if (address) return address
    }
  }
  return item
}

export interface CallOptions {
  target: string
  /** get method name (alias of `method`, kept from the adapters helper) */
  abi?: string
  method?: string
  params?: any[]
  /** return the untouched stack */
  rawStack?: boolean
}

/**
 * Call a get method and decode the stack. `num` entries become numbers (bigint when they do
 * not fit a safe integer, where the adapters helper silently lost precision), cells / slices
 * that hold a `MsgAddressInt` become friendly addresses, everything else stays raw.
 */
export async function call({ target, abi, method, params = [], rawStack = false }: CallOptions): Promise<any[]> {
  const name = method ?? abi
  if (!name) throw new Error('call: method (or abi) is required')
  const { exit_code, stack } = await runGetMethod({ address: target, method: name, stack: params })
  if (exit_code !== 0) throw new Error(`Expected a zero exit code, but got ${exit_code} (${name} on ${target})`)
  if (rawStack) return stack
  return stack.map(decodeStackItem)
}

// ---------------------------------------------------------------------------
// toncenter: transactions & messages
// ---------------------------------------------------------------------------

export interface GetTransactionsOptions {
  /** account address(es); several are sent comma separated */
  account: string | string[]
  /** inclusive lower bound (unix seconds) */
  startTimestamp?: number
  /** exclusive upper bound (unix seconds) */
  endTimestamp?: number
  /** page size, default 128 (toncenter max 1000) */
  limit?: number
  sort?: 'asc' | 'desc'
  /** drop transactions seen twice across pages, default true */
  dedupe?: boolean
  /** stop after this many pages */
  maxPages?: number
  /** extra v3 query params (e.g. `{ workchain, seqno, lt }`) */
  params?: Record<string, any>
}

function txTime(tx: any): number | undefined {
  const t = tx?.now ?? tx?.utime
  return t === undefined || t === null ? undefined : Number(t)
}

function inWindow(time: number | undefined, start?: number, end?: number) {
  if (time === undefined) return true
  if (start !== undefined && time < start) return false
  if (end !== undefined && time >= end) return false
  return true
}

/**
 * Every v3 transaction of `account` in `[startTimestamp, endTimestamp)`, paging through
 * `/transactions` (toncenter's `end_utime` is inclusive, so the last second is dropped to
 * keep consecutive windows disjoint).
 */
export async function getTransactions({ account, startTimestamp, endTimestamp, limit = 128, sort = 'desc', dedupe = true, maxPages, params }: GetTransactionsOptions): Promise<any[]> {
  const all: any[] = []
  const seen = new Set<string>()
  const accountParam = Array.isArray(account) ? account.join(',') : account
  for (let page = 0; ; page++) {
    const res = await toncenterGet({
      path: 'transactions',
      params: { account: accountParam, start_utime: startTimestamp, end_utime: endTimestamp, limit, offset: page * limit, sort, ...params },
    })
    // a body without a transactions array is a failure wearing a 200
    if (!Array.isArray(res?.transactions)) throw new Error(`Expected a transactions array from toncenter for ${accountParam}`)
    const txs: any[] = res.transactions
    for (const tx of txs) {
      if (dedupe) {
        const key = tx.hash ?? `${tx.lt}:${txTime(tx)}`
        if (seen.has(key)) continue
        seen.add(key)
      }
      if (!inWindow(txTime(tx), startTimestamp, endTimestamp)) continue
      all.push(tx)
    }
    if (txs.length < limit) break
    if (maxPages !== undefined && page + 1 >= maxPages) break
    debugLog(`[chains.ton] transactions page ${page + 1} for ${accountParam} (${all.length} so far)`)
  }
  return all
}

export interface GetMessagesOptions {
  source?: string
  destination?: string
  direction?: 'in' | 'out'
  /** message hash, body hash or opcode filters straight from the v3 api */
  opcode?: string
  bodyHash?: string
  /** inclusive lower bound (unix seconds) */
  startTimestamp?: number
  /** exclusive upper bound (unix seconds) */
  endTimestamp?: number
  /** page size, default 128 (toncenter max 1000) */
  limit?: number
  sort?: 'asc' | 'desc'
  dedupe?: boolean
  maxPages?: number
  params?: Record<string, any>
}

/** Every v3 message matching the filters in `[startTimestamp, endTimestamp)`, paging through `/messages` */
export async function getMessages({ source, destination, direction, opcode, bodyHash, startTimestamp, endTimestamp, limit = 128, sort = 'desc', dedupe = true, maxPages, params }: GetMessagesOptions): Promise<any[]> {
  if (!source && !destination && !bodyHash && !opcode) throw new Error('getMessages: source, destination, opcode or bodyHash is required')
  const all: any[] = []
  const seen = new Set<string>()
  const label = source ?? destination ?? bodyHash ?? opcode
  for (let page = 0; ; page++) {
    const res = await toncenterGet({
      path: 'messages',
      params: { source, destination, direction, opcode, body_hash: bodyHash, start_utime: startTimestamp, end_utime: endTimestamp, limit, offset: page * limit, sort, ...params },
    })
    if (!Array.isArray(res?.messages)) throw new Error(`Expected a messages array from toncenter for ${label}`)
    const messages: any[] = res.messages
    for (const message of messages) {
      if (dedupe && message.hash) {
        if (seen.has(message.hash)) continue
        seen.add(message.hash)
      }
      const created = message.created_at === undefined || message.created_at === null ? undefined : Number(message.created_at)
      if (!inWindow(created, startTimestamp, endTimestamp)) continue
      all.push(message)
    }
    if (messages.length < limit) break
    if (maxPages !== undefined && page + 1 >= maxPages) break
    debugLog(`[chains.ton] messages page ${page + 1} for ${label} (${all.length} so far)`)
  }
  return all
}

// ---------------------------------------------------------------------------
// toncenter: blocks
// ---------------------------------------------------------------------------

export const MASTERCHAIN_SHARD = '-9223372036854775808'

/** v3 `masterchainInfo`: `{ first: block, last: block }` where `last.seqno` is the current masterchain height */
export async function getMasterchainInfo(): Promise<{ first: any, last: any }> {
  return toncenterGet({ path: 'masterchainInfo' })
}

export interface LookupBlockOptions {
  workchain?: number
  shard?: string
  seqno?: number
  /** unix seconds; resolves the block at or before this time */
  utime?: number
  lt?: number | string
}

/** v2 `lookupBlock` by seqno, unixtime or lt. Returns `{ workchain, shard, seqno, root_hash, file_hash }` */
export async function lookupBlock({ workchain = -1, shard = MASTERCHAIN_SHARD, seqno, utime, lt }: LookupBlockOptions = {}): Promise<any> {
  if (seqno === undefined && utime === undefined && lt === undefined) throw new Error('lookupBlock: seqno, utime or lt is required')
  const res = await toncenterGet({ path: 'lookupBlock', params: { workchain, shard, seqno, unixtime: utime, lt }, version: 2 })
  return unwrapV2(res, 'lookupBlock')
}

/** Masterchain block at `timestamp`: `{ number: seqno, timestamp, block }` */
export async function getBlockAtTimestamp({ timestamp }: { timestamp: number }): Promise<{ number: number, timestamp: number, block: any }> {
  const block = await lookupBlock({ utime: timestamp })
  return { number: Number(block.seqno), timestamp, block }
}

/** Latest masterchain block: `{ number: seqno, timestamp: gen_utime, block }` */
export async function getLatestBlock(): Promise<{ number: number, timestamp: number, block: any }> {
  const { last } = await getMasterchainInfo()
  if (!last?.seqno) throw new Error('toncenter masterchainInfo: no last block')
  return { number: Number(last.seqno), timestamp: Number(last.gen_utime), block: last }
}

// ---------------------------------------------------------------------------
// tonapi
// ---------------------------------------------------------------------------

function tonapiPath(path: string) {
  return `/v2/${path.replace(/^\/+/, '')}`
}

/** GET `/v2/{path}` on tonapi */
export async function tonapiGet({ path, params }: { path: string, params?: Record<string, any> }): Promise<any> {
  return paced('TONAPI', () => httpGet(getTonapiEndpoints(), {
    path: tonapiPath(path),
    params: dropUndefined(params),
    headers: tonapiHeaders(),
    ...TONAPI_RETRY,
  }))
}

/** POST to `/v2/{path}` on tonapi */
export async function tonapiPost({ path, body = {} }: { path: string, body?: any }): Promise<any> {
  return paced('TONAPI', () => httpPost(getTonapiEndpoints(), body, {
    path: tonapiPath(path),
    headers: tonapiHeaders(),
    ...TONAPI_RETRY,
  }))
}

export interface TonapiJettonBalance {
  balance: string
  price?: { prices?: Record<string, number>, diff_24h?: Record<string, string> }
  wallet_address: { address: string, is_scam?: boolean, is_wallet?: boolean, name?: string }
  jetton: { address: string, name: string, symbol: string, decimals: number, image?: string, verification?: string }
  [key: string]: any
}

/**
 * Jetton balances of an account from tonapi `accounts/{address}/jettons`, with USD prices.
 * Returns the `balances` array (the adapters helper re-keyed it by jetton address; use
 * `jettonBalancesByAddress` for that shape). Addresses are in raw `0:...` form.
 */
export async function getJettonBalances({ address, currencies = 'usd' }: { address: string, currencies?: string }): Promise<TonapiJettonBalance[]> {
  const res = await tonapiGet({ path: `accounts/${encodeURIComponent(address)}/jettons`, params: { currencies } })
  if (!Array.isArray(res?.balances)) throw new Error(`tonapi accounts/${address}/jettons: no balances array`)
  return res.balances
}

/** `{ [rawJettonAddress]: { balance, price, decimals } }`, the shape the adapters helper returned */
export function jettonBalancesByAddress(balances: TonapiJettonBalance[], currency = 'USD'): Record<string, { balance: string, price?: number, decimals: number }> {
  const res: Record<string, { balance: string, price?: number, decimals: number }> = {}
  balances.forEach(b => {
    res[b.jetton.address] = { balance: b.balance, price: b.price?.prices?.[currency], decimals: b.jetton.decimals }
  })
  return res
}

/** tonapi `jettons/{address}`: `{ mintable, total_supply, metadata: { symbol, decimals, name, ... }, holders_count, ... }` */
export async function getJettonInfo({ address }: { address: string }): Promise<any> {
  return tonapiGet({ path: `jettons/${encodeURIComponent(address)}` })
}

/** tonapi `jettons/_bulk`, 100 addresses per request */
export async function getJettonsInfo({ addresses }: { addresses: string[] }): Promise<any[]> {
  const result: any[] = []
  for (const chunk of sliceIntoChunks(addresses, 100)) {
    const res = await tonapiPost({ path: 'jettons/_bulk', body: { account_ids: chunk } })
    result.push(...(res?.jettons ?? []))
  }
  return result
}

/** USD prices from tonapi `rates`, keyed by the token string that was passed in ('ton' or a jetton address) */
export async function getTokenRates({ tokens, currency = 'usd' }: { tokens: string[], currency?: string }): Promise<Record<string, number>> {
  if (!tokens.length) return {}
  const res = await tonapiGet({ path: 'rates', params: { tokens: tokens.join(','), currencies: currency } })
  const rates = res?.rates ?? {}
  const prices: Record<string, number> = {}
  const key = currency.toUpperCase()
  tokens.forEach(token => {
    const price = rates[token]?.prices?.[key]
    if (price !== undefined && price !== null) prices[token] = price
  })
  return prices
}

// ---------------------------------------------------------------------------
// codec: crc16 & Address
// ---------------------------------------------------------------------------

const BOUNCEABLE_TAG = 0x11
const NON_BOUNCEABLE_TAG = 0x51
const TEST_FLAG = 0x80

/** CRC-16/XMODEM (poly 0x1021, init 0), the checksum used by friendly TON addresses */
export function crc16(data: Buffer | Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8
    for (let j = 0; j < 8; j++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
    }
  }
  return crc
}

export interface AddressStringOptions {
  /** default true */
  urlSafe?: boolean
  /** default true */
  bounceable?: boolean
  /** default false */
  testOnly?: boolean
}

function base64ToBuffer(source: string): Buffer {
  return Buffer.from(source.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
}

function bufferToBase64(buffer: Buffer, urlSafe: boolean): string {
  const b64 = buffer.toString('base64')
  return urlSafe ? b64.replace(/\+/g, '-').replace(/\//g, '_') : b64
}

function parseFriendlyBuffer(data: Buffer, source: string) {
  // 1 byte tag + 1 byte workchain + 32 bytes hash + 2 bytes crc
  if (data.length !== 36) throw new Error(`Unknown address type: byte length is not equal to 36 (${source})`)
  const addr = data.subarray(0, 34)
  if (crc16(addr) !== data.readUInt16BE(34)) throw new Error(`Invalid checksum: ${source}`)
  let tag = addr[0]
  let isTestOnly = false
  if (tag & TEST_FLAG) {
    isTestOnly = true
    tag ^= TEST_FLAG
  }
  if (tag !== BOUNCEABLE_TAG && tag !== NON_BOUNCEABLE_TAG) throw new Error(`Unknown address tag ${tag} (${source})`)
  const workchain = addr.readInt8(1)
  return { isTestOnly, isBounceable: tag === BOUNCEABLE_TAG, workchain, hashPart: Buffer.from(addr.subarray(2, 34)) }
}

/**
 * TON address (workchain + 256 bit hash), ported from ton-core. Parses friendly
 * (`EQ...` / `UQ...`, base64 or base64url) and raw (`0:abcd...`) forms.
 */
export class Address {
  readonly workChain: number
  readonly hash: Buffer

  constructor(workChain: number, hash: Buffer) {
    if (hash.length !== 32) throw new Error(`Invalid address hash length: ${hash.length}`)
    this.workChain = workChain
    this.hash = hash
    Object.freeze(this)
  }

  static isAddress(src: any): src is Address {
    return src instanceof Address
  }

  /** shape check only (48 base64 chars); use `isAddress` to also verify the checksum */
  static isFriendly(source: string): boolean {
    return typeof source === 'string' && /^[A-Za-z0-9+/_-]{48}$/.test(source)
  }

  static isRaw(source: string): boolean {
    if (typeof source !== 'string') return false
    const parts = source.split(':')
    if (parts.length !== 2) return false
    const [wc, hash] = parts
    if (!/^-?\d+$/.test(wc)) return false
    return /^[a-fA-F0-9]{64}$/.test(hash)
  }

  static parse(source: string | Address): Address {
    if (Address.isAddress(source)) return source
    if (Address.isFriendly(source)) return Address.parseFriendly(source).address
    if (Address.isRaw(source)) return Address.parseRaw(source)
    throw new Error(`Unknown address type: ${source}`)
  }

  static parseRaw(source: string): Address {
    if (!Address.isRaw(source)) throw new Error(`Invalid raw address: ${source}`)
    const [wc, hash] = source.split(':')
    return new Address(parseInt(wc, 10), Buffer.from(hash, 'hex'))
  }

  static parseFriendly(source: string | Buffer): { isBounceable: boolean, isTestOnly: boolean, address: Address } {
    let data: Buffer
    if (Buffer.isBuffer(source)) data = source
    else {
      if (!Address.isFriendly(source)) throw new Error(`Unknown address type: ${source}`)
      data = base64ToBuffer(source)
    }
    const r = parseFriendlyBuffer(data, Buffer.isBuffer(source) ? source.toString('base64') : source)
    return { isBounceable: r.isBounceable, isTestOnly: r.isTestOnly, address: new Address(r.workchain, r.hashPart) }
  }

  /** friendly form of any address string (or Address), bounceable + url-safe by default */
  static normalize(source: string | Address, options?: AddressStringOptions): string {
    return Address.parse(source).toString(options)
  }

  toRawString(): string {
    return `${this.workChain}:${this.hash.toString('hex')}`
  }

  /** 36 bytes: hash followed by the workchain repeated 4 times (ton-core `toRaw`) */
  toRaw(): Buffer {
    const out = Buffer.alloc(36)
    out.set(this.hash)
    const wc = this.workChain & 0xff
    out.set([wc, wc, wc, wc], 32)
    return out
  }

  toStringBuffer({ bounceable = true, testOnly = false }: AddressStringOptions = {}): Buffer {
    let tag = bounceable ? BOUNCEABLE_TAG : NON_BOUNCEABLE_TAG
    if (testOnly) tag |= TEST_FLAG
    const out = Buffer.alloc(36)
    out[0] = tag
    out.writeInt8(this.workChain, 1)
    out.set(this.hash, 2)
    out.writeUInt16BE(crc16(out.subarray(0, 34)), 34)
    return out
  }

  toString(options: AddressStringOptions = {}): string {
    const { urlSafe = true } = options
    return bufferToBase64(this.toStringBuffer(options), urlSafe)
  }

  equals(src: Address): boolean {
    return src.workChain === this.workChain && src.hash.equals(this.hash)
  }
}

/** `Address.parse` */
export function parseAddress(source: string | Address): Address {
  return Address.parse(source)
}

/** Friendly form of any address string, bounceable + url-safe by default */
export function normalizeAddress(source: string | Address, { bounceable = true, urlSafe = true, testOnly = false }: AddressStringOptions = {}): string {
  return Address.parse(source).toString({ bounceable, urlSafe, testOnly })
}

/** `wc:hex` form of any address string */
export function toRawAddress(source: string | Address): string {
  return Address.parse(source).toRawString()
}

/** true when `source` parses as a friendly (checksum verified) or raw address */
export function isAddress(source: any): boolean {
  if (Address.isAddress(source)) return true
  if (typeof source !== 'string') return false
  try {
    Address.parse(source)
    return true
  } catch {
    return false
  }
}

/** 256 bit account hash as a bigint (the workchain is dropped) */
export function addressToInt(address: string | Address): bigint {
  return BigInt(`0x${Address.parse(address).hash.toString('hex')}`)
}

/** Inverse of `addressToInt`, workchain 0 by default */
export function convertIntToAddress(value: bigint | number | string, workChain = 0): Address {
  const hex = BigInt(value).toString(16).padStart(64, '0')
  if (hex.length !== 64) throw new Error(`convertIntToAddress: value does not fit 256 bits`)
  return Address.parseRaw(`${workChain}:${hex}`)
}

/** true when both parse and point at the same workchain + hash, false for anything unparsable */
export function compareAddress(a: string | Address | undefined | null, b: string | Address | undefined | null): boolean {
  if (!a || !b) return false
  try {
    return Address.parse(a).equals(Address.parse(b))
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// codec: BoC & bit reader
// ---------------------------------------------------------------------------

export function decodeBase64(source: string): Buffer {
  return base64ToBuffer(source)
}

/** MSB-first bit reader over a buffer */
export class BitReader {
  buffer: Buffer
  byteOffset: number
  bitOffset: number

  constructor(buffer: Buffer, startByte = 0, startBit = 0) {
    this.buffer = buffer
    this.byteOffset = startByte
    this.bitOffset = startBit
  }

  get remainingBits(): number {
    return (this.buffer.length - this.byteOffset) * 8 - this.bitOffset
  }

  readBit(): number {
    if (this.byteOffset >= this.buffer.length) throw new Error('Buffer overflow while reading bits')
    const bit = (this.buffer[this.byteOffset] >> (7 - this.bitOffset)) & 1
    this.bitOffset++
    if (this.bitOffset === 8) {
      this.bitOffset = 0
      this.byteOffset++
    }
    return bit
  }

  /** unsigned integer of `n` bits (n <= 53) */
  readBits(n: number): number {
    if (n > 53) throw new Error('readBits: use readBigUint for more than 53 bits')
    let value = 0
    for (let i = 0; i < n; i++) value = value * 2 + this.readBit()
    return value
  }

  readUint(n: number): number {
    return this.readBits(n)
  }

  /** two's complement signed integer of `n` bits */
  readInt(n: number): number {
    const value = this.readBits(n)
    return value >= 2 ** (n - 1) ? value - 2 ** n : value
  }

  readBigUint(n: number): bigint {
    let value = BigInt(0)
    for (let i = 0; i < n; i++) value = (value << BigInt(1)) | BigInt(this.readBit())
    return value
  }

  readBytes(n: number): Buffer {
    const out = Buffer.alloc(n)
    for (let i = 0; i < n; i++) out[i] = this.readBits(8)
    return out
  }

  skip(n: number) {
    for (let i = 0; i < n; i++) this.readBit()
  }
}

export interface ParsedBoc {
  hasIdx: boolean
  hasCrc32c: boolean
  hasCacheBits: boolean
  flags: number
  /** bytes used for cell counts */
  size: number
  /** bytes used for offsets */
  offBytes: number
  cells: number
  roots: number
  absent: number
  totalCellSize: number
  /** root cell indices */
  root: number[]
  index: Buffer | null
  /** serialized cells, starting with the first root's descriptors */
  cellData: Buffer
  /** byte offset right after the cell data */
  offset: number
}

/** Parse a serialized bag-of-cells header (`b5ee9c72` magic) and return the raw cell data */
export function parseBoc(buffer: Buffer): ParsedBoc {
  if (buffer.length < 4) throw new Error('Buffer is too short to contain magic bytes')
  if (buffer.readUInt32BE(0) !== 0xb5ee9c72) throw new Error('Invalid magic')
  let offset = 4
  const byte = buffer[offset++]
  const hasIdx = !!((byte >> 7) & 1)
  const hasCrc32c = !!((byte >> 6) & 1)
  const hasCacheBits = !!((byte >> 5) & 1)
  const flags = (byte >> 3) & 0b11
  const size = byte & 0b111
  const offBytes = buffer.readUInt8(offset++)
  const cells = buffer.readUIntBE(offset, size); offset += size
  const roots = buffer.readUIntBE(offset, size); offset += size
  const absent = buffer.readUIntBE(offset, size); offset += size
  const totalCellSize = buffer.readUIntBE(offset, offBytes); offset += offBytes
  const root: number[] = []
  for (let i = 0; i < roots; i++) {
    root.push(buffer.readUIntBE(offset, size))
    offset += size
  }
  let index: Buffer | null = null
  if (hasIdx) {
    index = buffer.subarray(offset, offset + cells * offBytes)
    offset += cells * offBytes
  }
  const cellData = buffer.subarray(offset, offset + totalCellSize)
  offset += totalCellSize
  return { hasIdx, hasCrc32c, hasCacheBits, flags, size, offBytes, cells, roots, absent, totalCellSize, root, index, cellData, offset }
}

/** Friendly address for a workchain + 32 byte hash (bounceable, url-safe by default) */
export function serializeAddress(wc: number, hash: Buffer, options: AddressStringOptions = {}): string {
  return new Address(wc, hash).toString(options)
}

/**
 * Read the `MsgAddressInt` (addr_std) stored at the start of the first cell of a base64
 * BoC, as returned in a runGetMethod `cell` / `slice` stack entry. Returns the friendly
 * bounceable address. Throws when the cell does not start with an addr_std.
 */
export function readAddressFromSlice(base64Boc: string): string {
  const { cellData } = parseBoc(decodeBase64(base64Boc))
  if (cellData.length < 2 + 33) throw new Error('Cell too short to hold an address')
  // cell layout: d1 (refs descriptor), d2 (data length descriptor), data bits
  const reader = new BitReader(cellData, 2, 0)
  const tag = reader.readBits(2)
  if (tag !== 0b10) throw new Error(`Not an addr_std (tag ${tag})`)
  const anycast = reader.readBit()
  if (anycast !== 0) throw new Error('Anycast addresses are not supported')
  const wc = reader.readInt(8)
  const hash = reader.readBytes(32)
  return serializeAddress(wc, hash)
}

/** `readAddressFromSlice` that returns null instead of throwing */
export function tryReadAddressFromSlice(base64Boc: string): string | null {
  try {
    return readAddressFromSlice(base64Boc)
  } catch {
    return null
  }
}
