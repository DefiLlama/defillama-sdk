/**
 * NEAR JSON-RPC client.
 *
 * Replaces (and unifies) the ad-hoc NEAR helpers spread across the llama repos:
 * - DefiLlama-Adapters   `projects/helper/chain/near.js` (endpoints, failover, view_account, call, getTokenBalance)
 * - dimension-adapters   `helpers/near.ts` (nearView: 8 attempts, exponential backoff + jitter, round-robin cursor, p-limit(3))
 * - peggedassets-server  `src/adapters/peggedAssets/helper/near.js` (call)
 * - server/coins         `src/adapters/yield/apiDerivs.ts` (inline `ft_price` call_function)
 *
 * TVL specific pieces of the adapters helper (coingecko `tokenMapping`, `transformAddress`,
 * `sumSingleBalance`, `sumTokens`, `addTokenBalances`) are intentionally NOT ported: this module
 * only talks to the chain and returns raw chain data.
 *
 * Transport: every request goes through a shared p-limit(3) limiter (`NEAR_RPC_CONCURRENCY`
 * overrides it), rotates over the endpoint list with a module level round-robin cursor and
 * retries transient failures up to 8 times with exponential backoff (400ms * 2^attempt + jitter).
 * `NEAR_RPC` (comma separated) overrides the default endpoint list.
 *
 * Usage: `sdk.chains.near.call({ contract: 'wrap.near', method: 'ft_metadata' })`
 */
import axios from "axios";
import { debugLog } from "../util/debugLog";
import { getEndpoints as resolveEndpoints, getLimiter, isRateLimitError, withRetry, JsonRpcError, shortUrl, toEndpointList, Endpoints, RetryOptions } from "./rpc";

export const CHAIN = 'near'

// rpc.mainnet.near.org is deprecated (429 heavy) and near.lava.build answers 410 (discontinued);
// both are kept last as a fallback only, the transport rotates past them on failure.
export const DEFAULT_ENDPOINTS: string[] = [
  'https://free.rpc.fastnear.com',
  'https://near.drpc.org',
  'https://rpc.mainnet.near.org',
  'https://near.lava.build',
]

const MAX_ATTEMPTS = 8
const BASE_DELAY = 400
const CONCURRENCY = 3
const DEFAULT_TIMEOUT = 30_000
const YOCTO_PER_NEAR = BigInt('1000000000000000000000000')

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type BlockId = number | string

export interface RpcOptions extends RetryOptions {
  /** explicit endpoint(s); overrides `NEAR_RPC` and the defaults */
  endpoints?: Endpoints
  /** axios timeout in ms, default 30s */
  timeout?: number
  /** skip the shared concurrency limiter */
  skipLimiter?: boolean
}

export interface QueryParams {
  request_type: 'view_account' | 'view_code' | 'view_state' | 'view_access_key' | 'view_access_key_list' | 'call_function' | string
  account_id?: string
  /** block height or hash; when set `finality` is not sent */
  block_id?: BlockId
  /** convenience alias for `block_id` */
  blockId?: BlockId
  finality?: 'final' | 'optimistic' | 'near-final'
  [key: string]: any
}

export interface AccountView {
  amount: string
  locked: string
  code_hash: string
  storage_usage: number
  storage_paid_at: number
  block_height: number
  block_hash: string
  [key: string]: any
}

export interface TokenMetadata {
  spec?: string
  name: string
  symbol: string
  icon?: string | null
  reference?: string | null
  reference_hash?: string | null
  decimals: number
  [key: string]: any
}

export interface Block {
  number: number
  /** unix seconds */
  timestamp: number
  /** raw nanosecond timestamp as string */
  timestampNs: string
  hash: string
  prevHash: string
  header: any
  chunks: any[]
  author: string
}

export interface AccessKey {
  public_key: string
  access_key: { nonce: number, permission: any }
}

export interface StateEntry {
  /** utf8 decoded key (lossy for binary keys) */
  key: string
  /** utf8 decoded value (lossy for binary/borsh values) */
  value: string
  keyBase64: string
  valueBase64: string
}

/**
 * Error returned by a NEAR node (`error` member of the JSON-RPC response, or the
 * `result.error` string of a failed `call_function`). Extends `JsonRpcError` so the
 * shared retry helper keeps it intact. `nodeError` is the raw error object, `cause`
 * mirrors NEAR's structured `error.cause.name` (e.g. `UNKNOWN_ACCOUNT`, `CONTRACT_EXECUTION_ERROR`).
 */
export class NearRpcError extends JsonRpcError {
  nodeError: any
  errorName?: string
  cause?: string
  endpoint?: string
  constructor(method: string, error: any, endpoint?: string, label?: string) {
    super(method, error)
    this.name = 'NearRpcError'
    this.nodeError = error
    this.errorName = error?.name
    this.cause = error?.cause?.name
    this.endpoint = endpoint
    this.message = `NEAR ${label ?? method} failed: ${formatNodeError(error)}`
  }
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/**
 * Encode `call_function` arguments to base64. Objects are JSON serialised, a
 * `Buffer`/`Uint8Array` is taken as raw bytes, a string is assumed to be base64 already
 * (pass `''` for methods without arguments), `undefined`/`null` become `{}`.
 */
export function encodeArgs(args?: any): string {
  if (args === undefined || args === null) args = {}
  if (typeof args === 'string') return args
  if (Buffer.isBuffer(args) || args instanceof Uint8Array) return Buffer.from(args).toString('base64')
  return Buffer.from(JSON.stringify(args)).toString('base64')
}

/**
 * Decode the `result` byte array of a `call_function` response. Returns the parsed JSON
 * when the payload is JSON, otherwise the utf8 string (empty payload -> `''`).
 */
export function decodeResult(bytes: number[] | Uint8Array | Buffer | undefined | null): any {
  if (!bytes) return ''
  const text = Buffer.from(bytes as any).toString('utf8')
  if (!text.length) return ''
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

// https://nomicon.io/DataStructures/Account#account-id-rules
const ACCOUNT_ID_REGEX = /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/

/** True for a syntactically valid NEAR account id (named accounts and 64-hex implicit accounts) */
export function isNearAccountId(str: any): boolean {
  if (typeof str !== 'string') return false
  if (str.length < 2 || str.length > 64) return false
  return ACCOUNT_ID_REGEX.test(str)
}

/** True for a 64 char hex implicit account id */
export function isImplicitAccountId(str: any): boolean {
  return typeof str === 'string' && /^[0-9a-f]{64}$/.test(str)
}

/** yoctoNEAR (string/bigint) -> NEAR as a number (loses precision below 1e-15 NEAR, fine for reporting) */
export function yoctoToNear(amount: string | bigint | number): number {
  const value = typeof amount === 'bigint' ? amount : BigInt(String(amount).split('.')[0] || '0')
  const whole = value / YOCTO_PER_NEAR
  const frac = value % YOCTO_PER_NEAR
  return Number(whole) + Number(frac) / 1e24
}

function formatNodeError(error: any): string {
  if (!error) return 'unknown error'
  if (typeof error === 'string') return error
  const parts: string[] = []
  if (error.message) parts.push(String(error.message))
  if (error.name && error.name !== error.message) parts.push(String(error.name))
  if (error.cause?.name) parts.push(String(error.cause.name))
  if (error.cause?.info && Object.keys(error.cause.info).length) parts.push(JSON.stringify(error.cause.info))
  if (error.data !== undefined && error.data !== null) parts.push(typeof error.data === 'string' ? error.data : JSON.stringify(error.data))
  return parts.join(' | ').slice(0, 1000)
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

/** Endpoint list: `NEAR_RPC` env (comma separated) or `DEFAULT_ENDPOINTS` */
export function getEndpoints(): string[] {
  return resolveEndpoints(CHAIN, DEFAULT_ENDPOINTS)
}

let rpcCursor = 0
let requestId = 0

// node side errors that another endpoint / a later attempt may resolve
const RETRYABLE_CAUSES = new Set(['INTERNAL_ERROR', 'TIMEOUT_ERROR', 'NO_SYNCED_BLOCKS', 'UNAVAILABLE_SHARD', 'UNKNOWN_BLOCK', 'GARBAGE_COLLECTED_BLOCK', 'NOT_SYNCED_YET'])

/**
 * Decide whether a failed attempt should be retried. Transport/HTTP level failures
 * (network errors, timeouts, 4xx/5xx from a gateway - e.g. the 410 of a discontinued
 * provider, 429 rate limits) always rotate to the next endpoint; node errors only when
 * another node might have the data (missing/garbage collected block, node not synced,
 * internal error). Contract level errors (unknown account, method not found, execution
 * failure) are deterministic and fail fast.
 */
export function shouldRetry(e: any): boolean {
  if (isRateLimitError(e)) return true
  if (e instanceof NearRpcError) {
    if (e.cause && RETRYABLE_CAUSES.has(e.cause)) return true
    if (e.errorName === 'INTERNAL_ERROR') return true
    // legacy (unstructured) error format: `Server error` + data string
    const data = typeof e.nodeError?.data === 'string' ? e.nodeError.data : ''
    if (/not synced|unavailable|timeout|internal error|garbage collected|unknown block|DB Not Found/i.test(data)) return true
    return false
  }
  if (e instanceof JsonRpcError) return false
  return true
}

/**
 * Raw NEAR JSON-RPC call. Returns `result`, throws `NearRpcError` when the node answers with
 * an `error`. Rotates endpoints (round-robin), retries with exponential backoff and runs
 * under the shared concurrency limiter.
 */
export async function rpc(method: string, params: any = {}, options: RpcOptions = {}): Promise<any> {
  const explicit = toEndpointList(options.endpoints)
  const endpoints = explicit.length ? explicit : getEndpoints()
  const start = rpcCursor++
  const body = { jsonrpc: '2.0', id: `llama-sdk-${++requestId}`, method, params }
  const timeout = options.timeout ?? DEFAULT_TIMEOUT
  const label = options.label ?? `${CHAIN} ${method}${params?.request_type ? `/${params.request_type}` : ''}`
  const run = () => withRetry(async (attempt) => {
    const endpoint = endpoints[(start + attempt) % endpoints.length]
    const { data } = await axios.post(endpoint, body, { timeout })
    if (data === undefined || data === null || typeof data !== 'object')
      throw new Error(`${label}: unexpected response from ${shortUrl(endpoint)}`)
    if (data.error) {
      const err = new NearRpcError(method, data.error, endpoint, label)
      debugLog(`[chains.near] ${label} node error from ${shortUrl(endpoint)}: ${err.message}`)
      throw err
    }
    return data.result
  }, {
    retries: options.retries ?? MAX_ATTEMPTS,
    delay: options.delay ?? BASE_DELAY,
    backoff: options.backoff ?? 2,
    maxDelay: options.maxDelay ?? 10_000,
    shouldRetry: options.shouldRetry ?? shouldRetry,
    label,
  })
  if (options.skipLimiter) return run()
  return getLimiter(CHAIN.toUpperCase(), CONCURRENCY)(run)
}

// ---------------------------------------------------------------------------
// query helpers
// ---------------------------------------------------------------------------

function blockParams(blockId?: BlockId, finality?: string): { block_id: BlockId } | { finality: string } {
  if (blockId !== undefined && blockId !== null && blockId !== '') return { block_id: normaliseBlockId(blockId) }
  return { finality: finality ?? 'final' }
}

function normaliseBlockId(blockId: BlockId): BlockId {
  if (typeof blockId === 'string' && /^\d+$/.test(blockId)) return +blockId
  return blockId
}

/**
 * The `query` RPC method. Defaults to `finality: 'final'`; when `block_id`/`blockId` is
 * given the finality is omitted (the node rejects requests carrying both).
 */
export async function query<T = any>(params: QueryParams, options?: RpcOptions): Promise<T> {
  const { blockId, block_id, finality, ...rest } = params
  const target = blockParams(block_id ?? blockId, finality)
  return rpc('query', { ...rest, ...target }, options)
}

/** `view_account`: raw account view (`amount` and `locked` are yoctoNEAR strings) */
export async function viewAccount({ account, blockId }: { account: string, blockId?: BlockId }, options?: RpcOptions): Promise<AccountView> {
  return query<AccountView>({ request_type: 'view_account', account_id: account, blockId }, options)
}

/** Native balance (`amount`, yoctoNEAR string, excludes `locked` stake) */
export async function getBalance({ account, blockId }: { account: string, blockId?: BlockId }, options?: RpcOptions): Promise<string> {
  const { amount } = await viewAccount({ account, blockId }, options)
  return amount
}

/**
 * View call (`call_function`). `args` are JSON serialised and base64 encoded, the returned
 * byte array is decoded to JSON (or a string). Throws `NearRpcError` carrying the node
 * error message on failure (unknown account/method, execution error, ...).
 */
export async function call<T = any>({ contract, method, args, blockId }: { contract: string, method: string, args?: any, blockId?: BlockId }, options?: RpcOptions): Promise<T> {
  const label = `${contract}.${method}`
  const res = await query({
    request_type: 'call_function',
    account_id: contract,
    method_name: method,
    args_base64: encodeArgs(args),
    blockId,
  }, { label: `${CHAIN} ${label}`, ...options })
  // older nodes report contract execution failures inside `result` with a 200 status
  if (res?.error) throw new NearRpcError('query', { message: 'Contract execution error', cause: { name: 'CONTRACT_EXECUTION_ERROR' }, data: res.error }, undefined, label)
  if (!Array.isArray(res?.result)) throw new Error(`NEAR ${label}: unexpected response shape`)
  return decodeResult(res.result)
}

/** Alias of `call` */
export const viewFunction = call

/**
 * `ft_balance_of` raw balance string. Mirrors the adapters helper: when the token
 * contract does not exist the balance is `'0'` instead of an error.
 */
export async function getTokenBalance({ token, account, blockId }: { token: string, account: string, blockId?: BlockId }, options?: RpcOptions): Promise<string> {
  try {
    const res = await call({ contract: token, method: 'ft_balance_of', args: { account_id: account }, blockId }, options)
    return String(res ?? '0')
  } catch (e: any) {
    if (isMissingAccountError(e)) {
      debugLog(`[chains.near] ${token}.ft_balance_of(${account}): token contract does not exist, returning 0`)
      return '0'
    }
    throw e
  }
}

/** `ft_metadata` (NEP-148) */
export async function getTokenMetadata({ token, blockId }: { token: string, blockId?: BlockId }, options?: RpcOptions): Promise<TokenMetadata> {
  return call<TokenMetadata>({ contract: token, method: 'ft_metadata', blockId }, options)
}

/** `ft_total_supply` raw string */
export async function getTokenTotalSupply({ token, blockId }: { token: string, blockId?: BlockId }, options?: RpcOptions): Promise<string> {
  const res = await call({ contract: token, method: 'ft_total_supply', blockId }, options)
  return String(res)
}

function isMissingAccountError(e: any) {
  if (e instanceof NearRpcError) {
    if (e.cause === 'UNKNOWN_ACCOUNT' || e.cause === 'NO_CONTRACT_CODE') return true
  }
  return /does not exist while viewing/i.test(String(e?.message ?? ''))
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

function toBlock(raw: any): Block {
  const header = raw?.header
  if (!header) throw new Error('NEAR block: unexpected response shape')
  const ns = String(header.timestamp_nanosec ?? header.timestamp)
  return {
    number: header.height,
    timestamp: Math.floor(Number(BigInt(ns) / BigInt(1_000_000_000))),
    timestampNs: ns,
    hash: header.hash,
    prevHash: header.prev_hash,
    header,
    chunks: raw.chunks ?? [],
    author: raw.author,
  }
}

/** `block` RPC: by height/hash (`blockId`) or by finality (default `final`) */
export async function getBlock({ blockId, finality }: { blockId?: BlockId, finality?: 'final' | 'optimistic' | 'near-final' } = {}, options?: RpcOptions): Promise<Block> {
  const raw = await rpc('block', blockParams(blockId, finality), options)
  return toBlock(raw)
}

export async function getLatestBlock(options?: RpcOptions): Promise<Block> {
  return getBlock({}, options)
}

function isUnknownBlockError(e: any) {
  if (e instanceof NearRpcError) {
    if (e.cause === 'UNKNOWN_BLOCK' || e.cause === 'GARBAGE_COLLECTED_BLOCK') return true
  }
  return /unknown block|DB Not Found|garbage collected/i.test(String(e?.message ?? ''))
}

/**
 * Fetch the block at `height`, or the next existing one (NEAR skips heights when a block
 * producer misses its slot). Returns `undefined` when nothing exists up to `maxHeight`.
 */
async function getBlockAtOrAfter(height: number, maxHeight: number, options?: RpcOptions): Promise<Block | undefined> {
  const maxSteps = 200
  for (let h = height, i = 0; h <= maxHeight && i < maxSteps; h++, i++) {
    try {
      return await getBlock({ blockId: h }, { ...options, retries: 2, shouldRetry: (e) => !isUnknownBlockError(e) && shouldRetry(e) })
    } catch (e) {
      if (!isUnknownBlockError(e)) throw e
    }
  }
  return undefined
}

/**
 * Last block produced at or before `timestamp` (unix seconds). Binary search on heights;
 * missing heights are skipped by stepping forward. Non archival nodes only keep ~5 epochs
 * (a few days) of history, older timestamps need an archival `NEAR_RPC`.
 */
export async function getBlockAtTimestamp({ timestamp }: { timestamp: number }, options?: RpcOptions): Promise<Block> {
  if (!timestamp || !Number.isFinite(timestamp)) throw new Error('NEAR getBlockAtTimestamp: invalid timestamp')
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000) // ms -> s
  const latest = await getLatestBlock(options)
  if (latest.timestamp <= timestamp) return latest

  // bracket: guess a lower bound assuming >= 0.5s per block, widen until it precedes the target
  let hi = latest
  let span = Math.max(100, Math.ceil((latest.timestamp - timestamp) * 2))
  let lo: Block | undefined
  while (true) {
    const loHeight = Math.max(1, hi.number - span)
    const candidate = await getBlockAtOrAfter(loHeight, hi.number, options)
    if (!candidate) throw new Error(`NEAR getBlockAtTimestamp: no block found around height ${loHeight}, node may not be archival`)
    if (candidate.timestamp <= timestamp) { lo = candidate; break }
    if (loHeight <= 1) throw new Error(`NEAR getBlockAtTimestamp: timestamp ${timestamp} predates the chain`)
    hi = candidate
    span *= 2
  }

  // binary search between lo (<= target) and hi (> target)
  while (hi.number - lo.number > 1) {
    const mid = lo.number + Math.floor((hi.number - lo.number) / 2)
    const block = await getBlockAtOrAfter(mid, hi.number - 1, options)
    if (!block) { hi = { ...hi, number: mid }; continue } // heights (mid, hi) are all missing; shrink from the top
    if (block.timestamp <= timestamp) lo = block
    else hi = block
  }
  debugLog(`[chains.near] getBlockAtTimestamp(${timestamp}) -> height ${lo.number} @ ${lo.timestamp}`)
  return lo
}

// ---------------------------------------------------------------------------
// keys / state
// ---------------------------------------------------------------------------

/** `view_access_key_list`: all access keys of an account */
export async function getAccessKeys({ account, blockId }: { account: string, blockId?: BlockId }, options?: RpcOptions): Promise<AccessKey[]> {
  const res = await query({ request_type: 'view_access_key_list', account_id: account, blockId }, options)
  return res?.keys ?? []
}

/**
 * `view_state`: contract storage entries whose key starts with `prefix` (utf8 string, or
 * raw bytes / base64 via `prefixBase64`). Keys and values are returned base64 and utf8 decoded.
 */
export async function viewState({ contract, prefix = '', prefixBase64, blockId }: { contract: string, prefix?: string, prefixBase64?: string, blockId?: BlockId }, options?: RpcOptions): Promise<StateEntry[]> {
  const prefix_base64 = prefixBase64 ?? Buffer.from(prefix, 'utf8').toString('base64')
  const res = await query({ request_type: 'view_state', account_id: contract, prefix_base64, blockId }, options)
  const values: any[] = res?.values ?? []
  return values.map((entry) => ({
    key: Buffer.from(entry.key, 'base64').toString('utf8'),
    value: Buffer.from(entry.value, 'base64').toString('utf8'),
    keyBase64: entry.key,
    valueBase64: entry.value,
  }))
}
