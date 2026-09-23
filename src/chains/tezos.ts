/**
 * Tezos client over the TzKT indexer API (`TEZOS_TZKT`, default https://api.tzkt.io)
 * plus a few Tezos node RPC calls (`TEZOS_RPC`).
 *
 * Replaces the chain access parts of:
 *   - DefiLlama-Adapters  projects/helper/chain/tezos.js (getTokenBalances,
 *     getTezosBalance, getStorage, getBigMapById)
 *   - peggedassets-server src/adapters/peggedAssets/helper/tezos.ts (getTotalSupply,
 *     getBalance)
 *
 * TVL coupling (tokenBlacklist, transformAddress, sumTokens, addDexPosition,
 * resolveLPPosition) is intentionally left out; every function returns raw chain
 * values (mutez / raw token units as decimal strings).
 *
 * Usage: `sdk.chains.tezos.getToken({ contract: 'KT1...', tokenId: 0 })`
 */
import { debugLog } from "../util/debugLog";
import { getEndpoints, getLimiter, httpGet, httpPost, } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** TzKT indexer base url, overridable with `TEZOS_TZKT` (also `SDK_` / `LLAMA_SDK_` prefixed). */
export const DEFAULT_TZKT = 'https://api.tzkt.io'

/** Tezos node RPC endpoints, overridable with `TEZOS_RPC` (comma separated). */
export const DEFAULT_RPC_ENDPOINTS: string[] = [
  'https://mainnet.api.tez.ie',
  'https://rpc.tzkt.io/mainnet',
]

export const MUTEZ_PER_TEZ = 1_000_000
export const MAINNET_CHAIN_ID = 'NetXdQprcVkpaWU'

const CHAIN = 'tezos'
const DEFAULT_CONCURRENCY = 10
/** TzKT hard limit per request */
const TZKT_MAX_LIMIT = 10_000

/** All configured TzKT base urls (env `TEZOS_TZKT` wins, then `DEFAULT_TZKT`). */
export function getTzktEndpoints(): string[] {
  return getEndpoints(CHAIN, DEFAULT_TZKT, { envKey: 'TEZOS_TZKT' })
}

/** First configured TzKT base url. */
export function getTzktEndpoint(): string {
  return getTzktEndpoints()[0]
}

/** Node RPC endpoints (env `TEZOS_RPC` wins, then `DEFAULT_RPC_ENDPOINTS`). */
export function getRpcEndpoints(): string[] {
  return getEndpoints(CHAIN, DEFAULT_RPC_ENDPOINTS)
}

function limiter() {
  return getLimiter(CHAIN.toUpperCase(), DEFAULT_CONCURRENCY)
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type NumLike = string | number | bigint

export interface TzktOptions {
  /** path under the TzKT base url, e.g. `/v1/head` */
  path: string
  /** query string parameters (TzKT filter syntax, e.g. `{ 'balance.gt': 0 }`) */
  params?: Record<string, any>
  timeout?: number
  retries?: number
}

export interface TzktAllOptions extends TzktOptions {
  /** page size, default 1000 (TzKT max 10000) */
  limit?: number
  /** starting offset, default 0 */
  offset?: number
  /** stop after this many pages (safety valve), default unlimited */
  maxPages?: number
}

export interface TokenBalance {
  /** token contract address (`'tezos'` for the native balance when `includeTezos` is set) */
  contract: string
  /** token id within the contract as a decimal string (`'0'` for FA1.2) */
  tokenId: string
  /** raw balance in token base units */
  balance: string
  /** parsed from `token.metadata.decimals`; undefined when metadata is missing */
  decimals?: number
  symbol?: string
  name?: string
  /** `fa1.2` | `fa2` | `native` */
  standard: string
}

export interface TokenInfo {
  contract: string
  tokenId: string
  /** raw total supply in token base units */
  totalSupply: string
  decimals?: number
  symbol?: string
  name?: string
  standard: string
  /** TzKT internal token id */
  id?: number
  metadata?: Record<string, any>
}

export interface BlockInfo {
  /** block level */
  number: number
  /** unix timestamp in seconds */
  timestamp: number
  hash: string
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^(tz1|tz2|tz3|tz4|KT1)[1-9A-HJ-NP-Za-km-z]{33}$/
const CONTRACT_RE = /^KT1[1-9A-HJ-NP-Za-km-z]{33}$/

/** tz1 / tz2 / tz3 / tz4 implicit accounts and KT1 originated contracts (36 chars, base58). */
export function isTezosAddress(str: any): boolean {
  return typeof str === 'string' && str.length === 36 && ADDRESS_RE.test(str)
}

/** KT1 originated contract address. */
export function isContractAddress(str: any): boolean {
  return typeof str === 'string' && str.length === 36 && CONTRACT_RE.test(str)
}

/**
 * Coerce a decimal / hex / scientific-notation string, number or bigint to BigInt.
 * Fractional parts are truncated. Empty / null values become 0.
 */
export function toBigInt(value: NumLike | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return BigInt(0)
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`toBigInt: not a finite number: ${value}`)
    // BigInt accepts any integer-valued double, including those above MAX_SAFE_INTEGER
    return BigInt(Math.trunc(value))
  }
  const s = String(value).trim()
  if (/^-?\d+$/.test(s)) return BigInt(s)
  if (/^-?0x[0-9a-f]+$/i.test(s)) return s.startsWith('-') ? -BigInt(s.slice(1)) : BigInt(s)
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) throw new Error(`toBigInt: cannot parse ${s}`)
    return toBigInt(n)
  }
  throw new Error(`toBigInt: cannot parse ${s}`)
}

/** mutez (1e-6 tez) -> tez as a JS number. */
export function mutezToTez(mutez: NumLike): number {
  return Number(toBigInt(mutez)) / MUTEZ_PER_TEZ
}

/**
 * Parse `metadata.decimals` (string or number). Unlike the pegged-assets helper,
 * `0` is a valid result and is not replaced by the fallback.
 */
export function parseDecimals(value: any): number | undefined {
  if (value === undefined || value === null || value === '') return undefined
  const n = Number(value)
  return Number.isFinite(n) ? n : undefined
}

/**
 * Turn a TzKT big map key list into a `{ key: value }` object. Object keys
 * (pairs) are indexed by their `hash`, mirroring the adapters' getBigMapById.
 */
export function bigMapKeysToObject(keys: any[]): Record<string, any> {
  const res: Record<string, any> = {}
  for (const entry of keys) {
    const key = (typeof entry.key === 'object' && entry.hash) ? entry.hash : entry.key
    res[key] = entry.value
  }
  return res
}

function toIsoTimestamp(ts: number | string | Date): string {
  if (ts instanceof Date) return ts.toISOString()
  if (typeof ts === 'string') {
    if (/^\d+$/.test(ts)) return toIsoTimestamp(+ts)
    return new Date(ts).toISOString()
  }
  // accept seconds or milliseconds
  const ms = ts > 1e12 ? ts : ts * 1000
  return new Date(ms).toISOString()
}

function toBlockInfo(block: any): BlockInfo {
  return {
    number: block.level,
    timestamp: Math.floor(new Date(block.timestamp).getTime() / 1000),
    hash: block.hash,
  }
}

function pickFirst(res: any): any {
  if (Array.isArray(res)) return res[0]
  return res
}

// ---------------------------------------------------------------------------
// TzKT transport
// ---------------------------------------------------------------------------

/** Raw TzKT GET (rate limited, rotates configured base urls, retried). */
export async function tzkt({ path, params, timeout, retries }: TzktOptions): Promise<any> {
  return limiter()(() => httpGet(getTzktEndpoints(), { path, params, timeout, retries }))
}

/**
 * Fetch every page of a TzKT list endpoint using `offset` / `limit` paging.
 * Stops when a page comes back shorter than `limit` or `maxPages` is reached.
 */
export async function tzktAll({ path, params = {}, limit = 1000, offset = 0, maxPages, timeout, retries }: TzktAllOptions): Promise<any[]> {
  limit = Math.min(Math.max(1, limit), TZKT_MAX_LIMIT)
  const res: any[] = []
  let page = 0
  while (true) {
    const data = await tzkt({ path, params: { ...params, limit, offset }, timeout, retries })
    if (!Array.isArray(data)) throw new Error(`tzktAll: expected an array from ${path}`)
    res.push(...data)
    page++
    if (data.length < limit) break
    if (maxPages !== undefined && page >= maxPages) {
      debugLog(`[chains.tezos] tzktAll ${path}: stopped after ${maxPages} pages`)
      break
    }
    offset += limit
  }
  return res
}

// ---------------------------------------------------------------------------
// accounts & balances
// ---------------------------------------------------------------------------

/** `/v1/accounts/{address}` */
export async function getAccount({ address }: { address: string }): Promise<any> {
  return tzkt({ path: `/v1/accounts/${address}` })
}

/** Native tez balance in mutez as a decimal string. */
export async function getBalance({ address }: { address: string }): Promise<string> {
  const balance = await tzkt({ path: `/v1/accounts/${address}/balance` })
  return toBigInt(balance).toString()
}

export interface GetTokenBalancesOptions {
  address: string
  /** also append the native tez balance as `{ contract: 'tezos', standard: 'native' }`, default false */
  includeTezos?: boolean
  /** keep entries with a zero balance, default false */
  includeZero?: boolean
  /** extra TzKT filters, e.g. `{ 'token.standard': 'fa2' }` */
  filters?: Record<string, any>
  limit?: number
  maxPages?: number
}

/**
 * All FA1.2 / FA2 token balances held by `address` (every page), with
 * `decimals` / `symbol` parsed from the token metadata when available.
 */
export async function getTokenBalances({ address, includeTezos = false, includeZero = false, filters = {}, limit, maxPages }: GetTokenBalancesOptions): Promise<TokenBalance[]> {
  const params: Record<string, any> = { account: address, ...filters }
  if (!includeZero) params['balance.ne'] = '0'
  const rows = await tzktAll({ path: '/v1/tokens/balances', params, limit, maxPages })
  const res: TokenBalance[] = rows.map((row: any) => {
    const token = row.token ?? {}
    const metadata = token.metadata ?? {}
    return {
      contract: token.contract?.address ?? token.contract,
      tokenId: String(token.tokenId ?? '0'),
      balance: String(row.balance ?? '0'),
      decimals: parseDecimals(metadata.decimals),
      symbol: metadata.symbol,
      name: metadata.name,
      standard: token.standard,
    }
  })
  if (includeTezos) {
    const balance = await getBalance({ address })
    res.push({ contract: 'tezos', tokenId: '0', balance, decimals: 6, symbol: 'XTZ', name: 'Tezos', standard: 'native' })
  }
  return res
}

/** Raw balance of one token (`contract` + `tokenId`) held by `address`; `'0'` when not found. */
export async function getTokenBalance({ address, contract, tokenId = 0 }: { address: string, contract: string, tokenId?: NumLike }): Promise<string> {
  const rows = await tzkt({
    path: '/v1/tokens/balances',
    params: { account: address, 'token.contract': contract, 'token.tokenId': String(tokenId), select: 'balance', limit: 1 },
  })
  const first = pickFirst(rows)
  if (first === undefined || first === null) return '0'
  return String(typeof first === 'object' ? first.balance ?? '0' : first)
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

/** Token info from `/v1/tokens?contract=&tokenId=`; throws when TzKT does not know the token. */
export async function getToken({ contract, tokenId = 0 }: { contract: string, tokenId?: NumLike }): Promise<TokenInfo> {
  const rows = await tzkt({ path: '/v1/tokens', params: { contract, tokenId: String(tokenId), limit: 1 } })
  const token = pickFirst(rows)
  if (!token) throw new Error(`tezos: token ${contract}:${tokenId} not found on TzKT`)
  const metadata = token.metadata ?? {}
  return {
    contract: token.contract?.address ?? contract,
    tokenId: String(token.tokenId ?? tokenId),
    totalSupply: String(token.totalSupply ?? '0'),
    decimals: parseDecimals(metadata.decimals),
    symbol: metadata.symbol,
    name: metadata.name,
    standard: token.standard,
    id: token.id,
    metadata,
  }
}

/** Raw total supply of a token in base units. */
export async function getTokenTotalSupply({ contract, tokenId = 0 }: { contract: string, tokenId?: NumLike }): Promise<string> {
  const token = await getToken({ contract, tokenId })
  return token.totalSupply
}

// ---------------------------------------------------------------------------
// contracts & big maps
// ---------------------------------------------------------------------------

/** Decoded contract storage (`/v1/contracts/{contract}/storage`), optionally at a past `level`. */
export async function getContractStorage({ contract, level }: { contract: string, level?: number }): Promise<any> {
  const params: Record<string, any> = {}
  if (level !== undefined) params.level = level
  return tzkt({ path: `/v1/contracts/${contract}/storage`, params })
}

/** Big map descriptor by pointer (`/v1/bigmaps/{id}`). */
export async function getBigMap({ id }: { id: NumLike }): Promise<any> {
  return tzkt({ path: `/v1/bigmaps/${id}` })
}

export interface GetBigMapKeysOptions {
  id: NumLike
  limit?: number
  offset?: number
  maxPages?: number
  /** only active (non-removed) keys, default true */
  active?: boolean
  /** TzKT `select` clause, e.g. `'key,value'` */
  select?: string
  /** extra filters, e.g. `{ 'key.address': 'tz1...' }` or `{ value: '0' }` */
  filters?: Record<string, any>
}

/** All keys of a big map (every page). Use `bigMapKeysToObject` for a `{ key: value }` view. */
export async function getBigMapKeys({ id, limit, offset, maxPages, active = true, select, filters = {} }: GetBigMapKeysOptions): Promise<any[]> {
  const params: Record<string, any> = { ...filters }
  if (active) params.active = true
  if (select) params.select = select
  return tzktAll({ path: `/v1/bigmaps/${id}/keys`, params, limit, offset, maxPages })
}

/** One big map entry by key (`/v1/bigmaps/{id}/keys/{key}`); undefined when missing. */
export async function getBigMapKey({ id, key }: { id: NumLike, key: string }): Promise<any> {
  const res = await tzkt({ path: `/v1/bigmaps/${id}/keys/${encodeURIComponent(key)}` })
  if (res === '' || res === null) return undefined
  return res
}

/** Big map descriptor (including `ptr`) by storage path (`/v1/contracts/{contract}/bigmaps/{path}`). */
export async function getBigMapByPath({ contract, path }: { contract: string, path: string }): Promise<any> {
  return tzkt({ path: `/v1/contracts/${contract}/bigmaps/${path}` })
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

/** Current head: `{ number: level, timestamp (unix seconds), hash }`. */
export async function getHead(): Promise<BlockInfo> {
  const head = await tzkt({ path: '/v1/head' })
  return toBlockInfo(head)
}

/** Block by level. */
export async function getBlock({ level }: { level: number | string }): Promise<BlockInfo> {
  const block = await tzkt({ path: `/v1/blocks/${level}` })
  return toBlockInfo(block)
}

/** Latest block at or before `timestamp` (unix seconds, ms, ISO string or Date). */
export async function getBlockAtTimestamp({ timestamp }: { timestamp: number | string | Date }): Promise<BlockInfo> {
  const rows = await tzkt({
    path: '/v1/blocks',
    params: { 'timestamp.le': toIsoTimestamp(timestamp), 'sort.desc': 'level', limit: 1 },
  })
  const block = pickFirst(rows)
  if (!block) throw new Error(`tezos: no block at or before ${toIsoTimestamp(timestamp)}`)
  return toBlockInfo(block)
}

// ---------------------------------------------------------------------------
// operations
// ---------------------------------------------------------------------------

export interface GetOperationsOptions {
  address: string
  /** comma separated TzKT operation types, e.g. `'transaction'` or `'transaction,origination'` */
  type?: string
  /** inclusive lower bound (unix seconds, ms, ISO or Date) */
  from?: number | string | Date
  /** inclusive upper bound (unix seconds, ms, ISO or Date) */
  to?: number | string | Date
  /** `'asc'` (default) or `'desc'` */
  sort?: 'asc' | 'desc'
  /** page size, default 1000 */
  limit?: number
  maxPages?: number
  /** extra filters, e.g. `{ entrypoint: 'transfer', status: 'applied' }` */
  filters?: Record<string, any>
}

/**
 * Operations involving `address` (`/v1/accounts/{address}/operations`), every page.
 * This endpoint pages with the `lastId` cursor rather than `offset`.
 */
export async function getOperations({ address, type, from, to, sort = 'asc', limit = 1000, maxPages, filters = {} }: GetOperationsOptions): Promise<any[]> {
  limit = Math.min(Math.max(1, limit), 1000)
  const params: Record<string, any> = { ...filters, limit, sort }
  if (type) params.type = type
  if (from !== undefined) params['timestamp.ge'] = toIsoTimestamp(from)
  if (to !== undefined) params['timestamp.le'] = toIsoTimestamp(to)
  const res: any[] = []
  let lastId: any
  let page = 0
  while (true) {
    const data = await tzkt({ path: `/v1/accounts/${address}/operations`, params: lastId === undefined ? params : { ...params, lastId } })
    if (!Array.isArray(data)) throw new Error('getOperations: expected an array')
    res.push(...data)
    page++
    if (data.length < limit) break
    if (maxPages !== undefined && page >= maxPages) {
      debugLog(`[chains.tezos] getOperations ${address}: stopped after ${maxPages} pages`)
      break
    }
    lastId = data[data.length - 1].id
  }
  return res
}

// ---------------------------------------------------------------------------
// node RPC
// ---------------------------------------------------------------------------

/** Raw GET against the Tezos node RPC (rotates `TEZOS_RPC` endpoints, retried). */
export async function rpcGet({ path, params, timeout, retries }: TzktOptions): Promise<any> {
  return limiter()(() => httpGet(getRpcEndpoints(), { path, params, timeout, retries }))
}

/** Raw POST against the Tezos node RPC. */
export async function rpcPost({ path, body, timeout, retries }: { path: string, body: any, timeout?: number, retries?: number }): Promise<any> {
  return limiter()(() => httpPost(getRpcEndpoints(), body, { path, timeout, retries }))
}

/** Spendable balance in mutez straight from the node (`.../context/contracts/{address}/balance`). */
export async function getContractBalanceRpc({ address, block = 'head' }: { address: string, block?: string | number }): Promise<string> {
  const balance = await rpcGet({ path: `/chains/main/blocks/${block}/context/contracts/${address}/balance` })
  return toBigInt(balance).toString()
}

let cachedChainId: string | undefined

/** Chain id of the configured node (`/chains/main/chain_id`), cached. */
export async function getChainId(): Promise<string> {
  if (!cachedChainId) cachedChainId = await rpcGet({ path: '/chains/main/chain_id' })
  return cachedChainId!
}

export interface RunViewOptions {
  contract: string
  /** on-chain (TZIP-16 / Michelson) view name */
  view: string
  /** Micheline JSON input, e.g. `{ string: 'tz1...' }` or `{ int: '0' }` */
  input: any
  block?: string | number
  chainId?: string
}

/**
 * Execute an on-chain Michelson view via `run_script_view`. Returns the Micheline
 * JSON result (`data`).
 */
export async function runView({ contract, view, input, block = 'head', chainId }: RunViewOptions): Promise<any> {
  const chain_id = chainId ?? await getChainId()
  const res = await rpcPost({
    path: `/chains/main/blocks/${block}/helpers/scripts/run_script_view`,
    body: { contract, view, input, chain_id, unlimited_gas: true },
  })
  return res?.data ?? res
}
