/**
 * Aptos-style Move REST client for `aptos` (default) and `move` (Movement).
 *
 * Replaces the scattered per-repo helpers:
 * - DefiLlama-Adapters `projects/helper/chain/aptos.js` (endpointMap, aQuery, getResources with
 *   `x-aptos-cursor` pagination, getResource, getBalance, getTableData, function_view, hexToString,
 *   timestampToVersion)
 * - DefiLlama-Adapters `projects/helper/env.js` (APTOS_RPC / MOVE_RPC defaults)
 * - defillama-server `defi/l2/utils.ts` (aptosFetch with 404-as-answer, getAptosSupplies resolution chain)
 * - defillama-server `coins/src/scripts/coingeckoUtils.ts` (CoinInfo metadata lookup)
 * - peggedassets-server `src/adapters/peggedAssets/helper/aptos.ts` (getTokenSupply FA branches, function_view)
 * - dimension-adapters `helpers/aptos.ts` (getResources, view, getCoinSupply, octasToApt, getVersionFromTimestamp)
 *
 * All endpoints resolve through `rpc.getEndpoints`, so `APTOS_RPC` / `MOVE_RPC` (comma separated
 * for fallbacks) override the defaults. An optional `<CHAIN>_API_KEY` (e.g. `APTOS_API_KEY`) is sent
 * as a bearer token. Requests the primary answers with 410 `block_pruned` / `version_pruned` are
 * retried on the archival endpoint (`<CHAIN>_ARCHIVAL_RPC`, default `archive.mainnet.aptoslabs.com`).
 * Timestamp -> version lookups use a REST binary search over block heights instead of the
 * aptoslabs indexer GraphQL API, so they work on any full node and on Movement.
 *
 * Usage: `sdk.chains.aptos.getResource({ account: '0x1', type: '0x1::coin::CoinInfo<0x1::aptos_coin::AptosCoin>' })`
 */
import axios from "axios";
import { getEnvValue } from "../util/env";
import { debugLog } from "../util/debugLog";
import { getEndpoints, getEndpoint as rpcGetEndpoint, joinUrl, withRetry, getLimiter, isRetryableError, shortUrl } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  aptos: 'https://fullnode.mainnet.aptoslabs.com',
  move: 'https://mainnet.movementnetwork.xyz',
}

/**
 * Archival nodes used when the primary answers 410 `block_pruned` / `version_pruned`
 * (the public aptos fullnode keeps only a few weeks of blocks). Override with `<CHAIN>_ARCHIVAL_RPC`.
 */
export const ARCHIVAL_ENDPOINTS: Record<string, string> = {
  aptos: 'https://archive.mainnet.aptoslabs.com',
}

export const aptosChains: string[] = Object.keys(DEFAULT_ENDPOINTS)

export const APT_COIN_TYPE = '0x1::aptos_coin::AptosCoin'
export const APT_DECIMALS = 8

const DEFAULT_TIMEOUT = 30_000
const RESOURCE_PAGE_SIZE = 9999
const MODULE_PAGE_SIZE = 1000
const EVENT_PAGE_SIZE = 100

export type AptosChain = 'aptos' | 'move' | string

export interface ChainOptions {
  /** chain key, default `aptos` */
  chain?: AptosChain
}

export interface RequestOptions extends ChainOptions {
  timeout?: number
  retries?: number
  /** send straight to the archival endpoint(s) instead of falling back to them on 410 */
  archival?: boolean
}

export interface LedgerInfo {
  chainId: number
  ledgerVersion: number
  /** unix seconds */
  ledgerTimestamp: number
  blockHeight: number
  oldestLedgerVersion: number
  oldestBlockHeight: number
  epoch: number
  raw: any
}

export interface AptosBlock {
  /** block height */
  number: number
  /** unix seconds */
  timestamp: number
  hash: string
  firstVersion: number
  lastVersion: number
  transactions?: any[]
  raw: any
}

export interface CoinInfo {
  decimals: number
  symbol: string
  name: string
  /** raw supply (only when directly available on the metadata resource) */
  supply?: string
}

export interface TypeTag {
  /** full type string as given */
  raw: string
  /** module address (`0x1`), empty for primitives */
  address: string
  /** module name (`coin`), empty for primitives */
  module: string
  /** struct / primitive name (`CoinInfo`, `u64`) */
  name: string
  /** generic type arguments, unparsed (`['0x1::aptos_coin::AptosCoin']`) */
  typeArgs: string[]
  /** true when the tag is a struct (`addr::module::Name`) */
  isStruct: boolean
}

export function isAptosChain(chain?: string): boolean {
  return !!chain && aptosChains.includes(chain)
}

function resolveChain(chain?: string): string {
  return chain ?? 'aptos'
}

/** All configured endpoints for the chain (env override first, then defaults). */
export function getEndpointList({ chain }: ChainOptions = {}): string[] {
  chain = resolveChain(chain)
  return getEndpoints(chain, DEFAULT_ENDPOINTS[chain])
}

/** First configured endpoint for the chain. */
export function getEndpoint({ chain }: ChainOptions = {}): string {
  chain = resolveChain(chain)
  return rpcGetEndpoint(chain, DEFAULT_ENDPOINTS[chain])
}

/** Archival endpoints for the chain (`<CHAIN>_ARCHIVAL_RPC` env, then built-in); empty when none. */
export function getArchivalEndpointList({ chain }: ChainOptions = {}): string[] {
  chain = resolveChain(chain)
  try {
    return getEndpoints(chain, ARCHIVAL_ENDPOINTS[chain], { envKey: `${chain.toUpperCase()}_ARCHIVAL_RPC` })
  } catch {
    return []
  }
}

function getHeaders(chain: string): Record<string, string> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = getEnvValue(`${chain.toUpperCase()}_API_KEY`)
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`
  return headers
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

const NOT_FOUND = Symbol('aptos:not-found')

function isNotFound(e: any): boolean {
  return e?.response?.status === 404
}

/** 410 `block_pruned` / `version_pruned`: the data exists but this node no longer has it. */
function isPruned(e: any): boolean {
  if (e?.response?.status === 410 || e?.status === 410) return true
  const code = String(e?.response?.data?.error_code ?? '')
  return code.includes('pruned')
}

interface InternalRequest extends RequestOptions {
  method: 'get' | 'post'
  path: string
  params?: Record<string, any>
  body?: any
  allowNotFound?: boolean
  withMetadata?: boolean
}

/**
 * Low level request: rotates through the configured endpoints, retries transient
 * failures, sends the optional bearer key and (when `allowNotFound`) turns a 404 into
 * `null` before the retry layer sees it (a 404 is a real answer for missing resources).
 * A 410 "pruned" answer from the primary is retried once against the archival endpoints.
 */
async function request(options: InternalRequest): Promise<any> {
  const chain = resolveChain(options.chain)
  const archivalEndpoints = getArchivalEndpointList({ chain })
  if (options.archival) {
    if (!archivalEndpoints.length) throw new Error(`[${chain}] no archival endpoint configured (env ${chain.toUpperCase()}_ARCHIVAL_RPC)`)
    return requestOn(archivalEndpoints, options)
  }
  try {
    return await requestOn(getEndpointList({ chain }), options)
  } catch (e) {
    if (!archivalEndpoints.length || !isPruned(e)) throw e
    debugLog(`[chains.aptos] ${chain} ${options.method.toUpperCase()} ${options.path} pruned on primary, retrying on archival`)
    return requestOn(archivalEndpoints, options)
  }
}

async function requestOn(endpoints: string[], options: InternalRequest): Promise<any> {
  const chain = resolveChain(options.chain)
  const limiter = getLimiter(chain.toUpperCase(), 10)
  const { method, path, params, body, allowNotFound, withMetadata, timeout = DEFAULT_TIMEOUT } = options
  const headers = getHeaders(chain)
  const config = { timeout, headers, params }

  const res = await withRetry(async (attempt) => {
    const base = endpoints[attempt % endpoints.length]
    const url = joinUrl(base, path)
    return limiter(async () => {
      try {
        const response = method === 'post'
          ? await axios.post(url, body, config)
          : await axios.get(url, config)
        return withMetadata ? response : response.data
      } catch (e: any) {
        if (allowNotFound && isNotFound(e)) {
          debugLog(`[chains.aptos] ${chain} ${method.toUpperCase()} ${path} -> 404 (treated as not found)`)
          return NOT_FOUND
        }
        // keep the error message helpful when the retry layer reformats it
        const status = e?.response?.status
        const detail = e?.response?.data?.message ?? e?.response?.data?.error_code ?? e?.message
        const err: any = new Error(`[${chain}] ${method.toUpperCase()} ${path} failed${status ? ` [${status}]` : ''}: ${String(detail ?? '').slice(0, 300)} (${shortUrl(url)})`)
        err.response = e?.response
        err.status = status
        err.errorCode = e?.response?.data?.error_code
        err._isCustomError = true // already formatted: keeps status/errorCode intact through withRetry/formError
        throw err
      }
    })
  }, {
    label: `${chain} ${method.toUpperCase()} ${path.split('?')[0].slice(0, 80)}`,
    retries: options.retries ?? Math.max(3, endpoints.length),
    shouldRetry: isRetryableError,
  })

  return res === NOT_FOUND ? null : res
}

function withLedgerVersion(params: Record<string, any> | undefined, ledgerVersion?: number | string): Record<string, any> | undefined {
  if (ledgerVersion === undefined || ledgerVersion === null) return params
  return { ...(params ?? {}), ledger_version: String(ledgerVersion) }
}

function encodeSegment(value: string): string {
  return encodeURIComponent(value)
}

/** GET `path` (relative to the node root, e.g. `/v1/accounts/0x1`). 404 -> `null` when `allowNotFound`. */
export async function get({ chain, path, params, allowNotFound, timeout, retries, archival }: RequestOptions & { path: string, params?: Record<string, any>, allowNotFound?: boolean }): Promise<any> {
  return request({ chain, method: 'get', path, params, allowNotFound, timeout, retries, archival })
}

/** POST `body` to `path` (relative to the node root, e.g. `/v1/view`). */
export async function post({ chain, path, body, params, allowNotFound, timeout, retries, archival }: RequestOptions & { path: string, body: any, params?: Record<string, any>, allowNotFound?: boolean }): Promise<any> {
  return request({ chain, method: 'post', path, body, params, allowNotFound, timeout, retries, archival })
}

// ---------------------------------------------------------------------------
// ledger / accounts / resources
// ---------------------------------------------------------------------------

function microsToSeconds(value: any): number {
  return Math.floor(Number(value) / 1e6)
}

export async function getLedgerInfo({ chain, archival }: ChainOptions & { archival?: boolean } = {}): Promise<LedgerInfo> {
  const raw = await get({ chain, path: '/v1', archival })
  return {
    chainId: Number(raw.chain_id),
    ledgerVersion: Number(raw.ledger_version),
    ledgerTimestamp: microsToSeconds(raw.ledger_timestamp),
    blockHeight: Number(raw.block_height),
    oldestLedgerVersion: Number(raw.oldest_ledger_version),
    oldestBlockHeight: Number(raw.oldest_block_height),
    epoch: Number(raw.epoch),
    raw,
  }
}

/** `{ sequence_number, authentication_key }` or `null` when the account does not exist. */
export async function getAccount({ chain, address, ledgerVersion }: ChainOptions & { address: string, ledgerVersion?: number | string }): Promise<any> {
  return get({ chain, path: `/v1/accounts/${address}`, params: withLedgerVersion(undefined, ledgerVersion), allowNotFound: true })
}

function extractPage(data: any): any[] {
  if (Array.isArray(data)) return data
  if (Array.isArray(data?.resources)) return data.resources
  if (Array.isArray(data?.data)) return data.data
  if (Array.isArray(data?.items)) return data.items
  return []
}

async function getPaginated({ chain, path, pageSize, ledgerVersion, label }: ChainOptions & { path: string, pageSize: number, ledgerVersion?: number | string, label: string }): Promise<any[]> {
  const items: any[] = []
  let cursor: string | undefined
  let pageLength = 0
  do {
    const params: Record<string, any> = { limit: pageSize }
    if (cursor) params.start = cursor
    const res = await request({ chain, method: 'get', path, params: withLedgerVersion(params, ledgerVersion), withMetadata: true })
    const page = extractPage(res?.data)
    items.push(...page)
    pageLength = page.length
    cursor = res?.headers?.['x-aptos-cursor']
    debugLog(`[chains.aptos] ${resolveChain(chain)} ${label}: fetched ${pageLength} (total ${items.length})${cursor ? ', more pages' : ''}`)
  } while (pageLength === pageSize && cursor)
  return items
}

/** Every resource of `account` (`{ type, data }[]`), following `x-aptos-cursor` pagination. */
export async function getResources({ chain, account, ledgerVersion }: ChainOptions & { account: string, ledgerVersion?: number | string }): Promise<any[]> {
  return getPaginated({ chain, path: `/v1/accounts/${account}/resources`, pageSize: RESOURCE_PAGE_SIZE, ledgerVersion, label: `resources ${account}` })
}

/** `data` of one resource, or `null` when the account does not hold it. */
export async function getResource({ chain, account, type, ledgerVersion }: ChainOptions & { account: string, type: string, ledgerVersion?: number | string }): Promise<any> {
  const res = await get({ chain, path: `/v1/accounts/${account}/resource/${encodeSegment(type)}`, params: withLedgerVersion(undefined, ledgerVersion), allowNotFound: true })
  if (res === null || res === undefined) return null
  return res.data ?? null
}

/** Every module published by `account`, following `x-aptos-cursor` pagination. */
export async function getAccountModules({ chain, account, ledgerVersion }: ChainOptions & { account: string, ledgerVersion?: number | string }): Promise<any[]> {
  return getPaginated({ chain, path: `/v1/accounts/${account}/modules`, pageSize: MODULE_PAGE_SIZE, ledgerVersion, label: `modules ${account}` })
}

/** Single module ABI/bytecode, or `null` when missing. */
export async function getAccountModule({ chain, account, name, ledgerVersion }: ChainOptions & { account: string, name: string, ledgerVersion?: number | string }): Promise<any> {
  return get({ chain, path: `/v1/accounts/${account}/module/${encodeSegment(name)}`, params: withLedgerVersion(undefined, ledgerVersion), allowNotFound: true })
}

/**
 * Read one table item. Returns the decoded value, or `null` when `allowNotFound` is set and the
 * key is missing (the node answers 404 for absent keys).
 */
export async function getTableItem({ chain, handle, keyType, valueType, key, ledgerVersion, allowNotFound }: ChainOptions & { handle: string, keyType: string, valueType: string, key: any, ledgerVersion?: number | string, allowNotFound?: boolean }): Promise<any> {
  return post({ chain, path: `/v1/tables/${handle}/item`, body: { key_type: keyType, value_type: valueType, key }, params: withLedgerVersion(undefined, ledgerVersion), allowNotFound })
}

/** Run a `#[view]` function. Returns the result array as the node encodes it (u64/u128 as strings). */
export async function view<T extends any[] = any[]>({ chain, function: fn, typeArguments = [], args = [], ledgerVersion }: ChainOptions & { function: string, typeArguments?: string[], args?: any[], ledgerVersion?: number | string }): Promise<T> {
  const res = await post({ chain, path: '/v1/view', body: { function: fn, type_arguments: typeArguments, arguments: args }, params: withLedgerVersion(undefined, ledgerVersion) })
  return (Array.isArray(res) ? res : [res]) as T
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/** Events of an event handle field, e.g. `{ eventHandle: '0x1::coin::CoinStore<...>', field: 'deposit_events' }`. */
export async function getEvents({ chain, account, eventHandle, field, start, limit = EVENT_PAGE_SIZE }: ChainOptions & { account: string, eventHandle: string, field: string, start?: number | string, limit?: number }): Promise<any[]> {
  const params: Record<string, any> = { limit }
  if (start !== undefined) params.start = String(start)
  const res = await get({ chain, path: `/v1/accounts/${account}/events/${encodeSegment(eventHandle)}/${encodeSegment(field)}`, params })
  return extractPage(res)
}

export async function getEventsByCreationNumber({ chain, account, creationNumber, start, limit = EVENT_PAGE_SIZE }: ChainOptions & { account: string, creationNumber: number | string, start?: number | string, limit?: number }): Promise<any[]> {
  const params: Record<string, any> = { limit }
  if (start !== undefined) params.start = String(start)
  const res = await get({ chain, path: `/v1/accounts/${account}/events/${creationNumber}`, params })
  return extractPage(res)
}

// ---------------------------------------------------------------------------
// blocks / time travel
// ---------------------------------------------------------------------------

function toBlock(raw: any): AptosBlock {
  return {
    number: Number(raw.block_height),
    timestamp: microsToSeconds(raw.block_timestamp),
    hash: raw.block_hash,
    firstVersion: Number(raw.first_version),
    lastVersion: Number(raw.last_version),
    transactions: raw.transactions,
    raw,
  }
}

/**
 * Block by height; `null` when it does not exist (yet). Heights pruned from the primary are
 * fetched from the archival endpoint when one is configured, otherwise the 410 error propagates.
 */
export async function getBlockByHeight({ chain, height, withTransactions = false, archival }: ChainOptions & { height: number | string, withTransactions?: boolean, archival?: boolean }): Promise<AptosBlock | null> {
  const raw = await get({ chain, path: `/v1/blocks/by_height/${height}`, params: { with_transactions: withTransactions }, allowNotFound: true, archival })
  return raw ? toBlock(raw) : null
}

/** Block containing ledger version `version`; `null` when unknown. Pruned versions fall back to archival like `getBlockByHeight`. */
export async function getBlockByVersion({ chain, version, withTransactions = false, archival }: ChainOptions & { version: number | string, withTransactions?: boolean, archival?: boolean }): Promise<AptosBlock | null> {
  const raw = await get({ chain, path: `/v1/blocks/by_version/${version}`, params: { with_transactions: withTransactions }, allowNotFound: true, archival })
  return raw ? toBlock(raw) : null
}

/** Latest block height + timestamp (seconds) from ledger info; `version` is the latest ledger version. */
export async function getLatestBlock({ chain }: ChainOptions = {}): Promise<{ number: number, timestamp: number, version: number }> {
  const info = await getLedgerInfo({ chain })
  return { number: info.blockHeight, timestamp: info.ledgerTimestamp, version: info.ledgerVersion }
}

/**
 * Binary search over block heights (REST only) for the last block whose timestamp is at or
 * before `timestamp` (unix seconds). Starts on the primary node; when the target predates the
 * primary's oldest block the search moves to the archival endpoint (the public aptos fullnode
 * keeps only a few weeks). Throws when `timestamp` predates all available history.
 */
export async function getBlockAtTimestamp({ chain, timestamp, minBlock }: ChainOptions & { timestamp: number, minBlock?: number }): Promise<AptosBlock> {
  chain = resolveChain(chain)
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000) // tolerate milliseconds
  const hasArchival = getArchivalEndpointList({ chain }).length > 0
  let archival = false
  let info = await getLedgerInfo({ chain })
  let lo = Math.max(minBlock ?? 0, info.oldestBlockHeight)
  let hi = info.blockHeight
  const cache = new Map<number, AptosBlock | null>()
  const fetchBlock = async (height: number) => {
    if (!cache.has(height)) cache.set(height, await getBlockByHeight({ chain, height, archival }))
    return cache.get(height)!
  }

  const latest = await fetchBlock(hi)
  if (latest && latest.timestamp <= timestamp) return latest

  let first = await fetchBlock(lo)
  if ((!first || first.timestamp > timestamp) && hasArchival) {
    debugLog(`[chains.aptos] ${chain} timestamp ${timestamp} predates primary history (oldest block ${lo}), searching archival`)
    archival = true
    info = await getLedgerInfo({ chain, archival: true })
    lo = Math.max(minBlock ?? 0, info.oldestBlockHeight)
    first = await fetchBlock(lo)
  }
  if (!first) throw new Error(`[${chain}] block ${lo} is not available on this node`)
  if (first.timestamp > timestamp) throw new Error(`[${chain}] timestamp ${timestamp} predates available history (oldest block ${lo} at ${first.timestamp})`)

  // invariant: block(lo).timestamp <= timestamp < block(hi).timestamp
  let steps = 0
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2)
    const block = await fetchBlock(mid)
    steps++
    if (!block || block.timestamp <= timestamp) lo = mid
    else hi = mid
  }
  debugLog(`[chains.aptos] ${chain} getBlockAtTimestamp(${timestamp}) -> block ${lo} in ${steps} steps`)
  const result = await fetchBlock(lo)
  if (!result) throw new Error(`[${chain}] block ${lo} is not available on this node`)
  return result
}

/**
 * Last ledger version at or before `timestamp` (unix seconds). Every transaction in a block
 * shares the block timestamp, so this is the `last_version` of the block found by `getBlockAtTimestamp`.
 */
export async function getVersionAtTimestamp({ chain, timestamp, minBlock }: ChainOptions & { timestamp: number, minBlock?: number }): Promise<number> {
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000)
  const info = await getLedgerInfo({ chain })
  if (info.ledgerTimestamp <= timestamp) return info.ledgerVersion
  const block = await getBlockAtTimestamp({ chain, timestamp, minBlock })
  return block.lastVersion
}

// ---------------------------------------------------------------------------
// token helpers
// ---------------------------------------------------------------------------

function optionValue(value: any): any {
  // Move `Option<T>` is encoded as `{ vec: [T] }`
  if (value && typeof value === 'object' && Array.isArray(value.vec)) return value.vec.length ? value.vec[0] : undefined
  return value
}

function coinModuleAddress(coinType: string): string {
  return coinType.substring(0, coinType.indexOf('::'))
}

/**
 * Raw balance of `account` for a coin type (`0x1::aptos_coin::AptosCoin`) or a fungible asset
 * metadata address. Coins: `CoinStore<T>` resource, falling back to the `0x1::coin::balance` view
 * (which also counts the paired FA store after a coin -> FA migration). FA: `0x1::primary_fungible_store::balance`.
 */
export async function getBalance({ chain, account, coinType = APT_COIN_TYPE, ledgerVersion }: ChainOptions & { account: string, coinType?: string, ledgerVersion?: number | string }): Promise<string> {
  if (isFungibleAssetAddress(coinType)) {
    const [balance] = await view({ chain, function: '0x1::primary_fungible_store::balance', typeArguments: ['0x1::fungible_asset::Metadata'], args: [account, coinType], ledgerVersion })
    return String(balance ?? '0')
  }
  const store = await getResource({ chain, account, type: `0x1::coin::CoinStore<${coinType}>`, ledgerVersion })
  if (store?.coin?.value !== undefined && store?.coin?.value !== null) return String(store.coin.value)
  const [balance] = await view({ chain, function: '0x1::coin::balance', typeArguments: [coinType], args: [account], ledgerVersion })
  return String(balance ?? '0')
}

/**
 * Token metadata: `0x1::coin::CoinInfo<T>` for coin types, `0x1::fungible_asset::Metadata` for
 * fungible asset addresses. Throws when the token is unknown.
 */
export async function getCoinInfo({ chain, coinType, ledgerVersion }: ChainOptions & { coinType: string, ledgerVersion?: number | string }): Promise<CoinInfo> {
  chain = resolveChain(chain)
  if (isFungibleAssetAddress(coinType)) {
    const data = await getResource({ chain, account: coinType, type: '0x1::fungible_asset::Metadata', ledgerVersion })
    if (!data) throw new Error(`[${chain}] no fungible asset metadata at ${coinType}`)
    return { decimals: Number(data.decimals), symbol: data.symbol, name: data.name }
  }
  const data = await getResource({ chain, account: coinModuleAddress(coinType), type: `0x1::coin::CoinInfo<${coinType}>`, ledgerVersion })
  if (!data) throw new Error(`[${chain}] no CoinInfo for ${coinType}`)
  const info: CoinInfo = { decimals: Number(data.decimals), symbol: data.symbol, name: data.name }
  const integer = optionValue(optionValue(data.supply)?.integer)
  if (integer?.value !== undefined) info.supply = String(integer.value)
  return info
}

async function getFungibleAssetSupply({ chain, metadata, ledgerVersion }: ChainOptions & { metadata: string, ledgerVersion?: number | string }): Promise<string | null> {
  // 1. view sums both supply variants and is a single request
  try {
    const [res] = await view({ chain, function: '0x1::fungible_asset::supply', typeArguments: ['0x1::fungible_asset::Metadata'], args: [metadata], ledgerVersion })
    const value = optionValue(res)
    if (value !== undefined && value !== null) return String(value)
  } catch (e) {
    debugLog(`[chains.aptos] fungible_asset::supply view failed for ${metadata}, falling back to resources: ${(e as any)?.message}`)
  }
  // 2. ConcurrentSupply (newer) then Supply resource; a 404 is a real answer here
  const concurrent = await getResource({ chain, account: metadata, type: '0x1::fungible_asset::ConcurrentSupply', ledgerVersion })
  if (concurrent?.current?.value !== undefined && concurrent?.current?.value !== null) return String(concurrent.current.value)
  const supply = await getResource({ chain, account: metadata, type: '0x1::fungible_asset::Supply', ledgerVersion })
  if (supply?.current !== undefined && supply?.current !== null) return String(supply.current)
  return null
}

/**
 * Raw total supply of a coin type or fungible asset address. Resolution order (ported from the
 * server l2 adapter):
 * 1. `0x1::coin::supply<T>` view: sums the legacy CoinInfo supply and the paired FA supply, which
 *    matters for coins that migrated to the FA standard (CoinInfo alone undercounts).
 * 2. `CoinInfo<T>.supply` integer value, or the aggregator table item it points at (native APT).
 * 3. The paired FA metadata (`0x1::coin::paired_metadata<T>`), then the FA branch.
 * 4. FA: `0x1::fungible_asset::supply` view -> `ConcurrentSupply` -> `Supply` resource.
 * Throws when nothing resolves (e.g. coins initialised with `monitor_supply = false`).
 */
export async function getCoinSupply({ chain, coinType, ledgerVersion }: ChainOptions & { coinType: string, ledgerVersion?: number | string }): Promise<string> {
  chain = resolveChain(chain)
  let metadata: string | undefined

  if (!isFungibleAssetAddress(coinType)) {
    try {
      const [res] = await view({ chain, function: '0x1::coin::supply', typeArguments: [coinType], ledgerVersion })
      const value = optionValue(res)
      if (value !== undefined && value !== null) return String(value)
    } catch (e) {
      debugLog(`[chains.aptos] coin::supply view failed for ${coinType}, falling back to CoinInfo: ${(e as any)?.message}`)
    }

    const info = await getResource({ chain, account: coinModuleAddress(coinType), type: `0x1::coin::CoinInfo<${coinType}>`, ledgerVersion })
    const supply = optionValue(info?.supply)
    const integer = optionValue(supply?.integer)
    if (integer?.value !== undefined && integer?.value !== null) return String(integer.value)
    const aggregator = optionValue(supply?.aggregator)
    if (aggregator?.handle) {
      const item = await getTableItem({ chain, handle: aggregator.handle, keyType: 'address', valueType: 'u128', key: aggregator.key, ledgerVersion, allowNotFound: true })
      if (typeof item === 'string' || typeof item === 'number') return String(item)
    }

    try {
      const [paired] = await view({ chain, function: '0x1::coin::paired_metadata', typeArguments: [coinType], ledgerVersion })
      metadata = optionValue(paired)?.inner
    } catch (e) {
      debugLog(`[chains.aptos] coin::paired_metadata view failed for ${coinType}: ${(e as any)?.message}`)
    }
    if (!metadata) throw new Error(`[${chain}] could not resolve supply for ${coinType}`)
  } else {
    metadata = coinType
  }

  const faSupply = await getFungibleAssetSupply({ chain, metadata, ledgerVersion })
  if (faSupply === null) throw new Error(`[${chain}] could not resolve supply for ${coinType}`)
  return faSupply
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

/** Decode a hex string (with or without `0x`) as UTF-8. */
export function hexToString(hex: string): string {
  if (typeof hex !== 'string') return ''
  let clean = hex.startsWith('0x') || hex.startsWith('0X') ? hex.slice(2) : hex
  if (clean.length % 2) clean = '0' + clean
  return Buffer.from(clean, 'hex').toString('utf8')
}

/** Octas (1e-8 APT) to APT as a JS number. */
export function octasToApt(octas: string | number | bigint): number {
  return Number(octas) / Math.pow(10, APT_DECIMALS)
}

/** Fungible asset tokens are identified by an object address (no `::`), coins by `addr::module::Name`. */
export function isFungibleAssetAddress(type: string): boolean {
  return typeof type === 'string' && !type.includes('::')
}

/** `0x1` -> `0x0000...0001` (64 hex chars, lowercase). Throws on non-hex input. */
export function normalizeAddress(address: string): string {
  if (typeof address !== 'string') throw new Error(`Invalid aptos address: ${address}`)
  let hex = address.trim()
  if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2)
  hex = hex.toLowerCase()
  if (!hex.length || hex.length > 64 || !/^[0-9a-f]+$/.test(hex)) throw new Error(`Invalid aptos address: ${address}`)
  return '0x' + hex.padStart(64, '0')
}

/** Depth-aware split of generic arguments: `A<B, C>, D` -> `['A<B, C>', 'D']`. */
function splitTypeArgs(inner: string): string[] {
  const parts: string[] = []
  let depth = 0
  let current = ''
  for (const ch of inner) {
    if (ch === '<') depth++
    else if (ch === '>') depth--
    if (ch === ',' && depth === 0) {
      parts.push(current.trim())
      current = ''
      continue
    }
    current += ch
  }
  if (current.trim()) parts.push(current.trim())
  return parts
}

/**
 * Parse `0x1::coin::CoinInfo<0x1::aptos_coin::AptosCoin>` into address / module / name / generics.
 * Primitive and vector types (`u64`, `vector<u8>`) parse with an empty address and module.
 */
export function parseTypeTag(type: string): TypeTag {
  const raw = type.trim()
  const open = raw.indexOf('<')
  let head = raw
  let typeArgs: string[] = []
  if (open !== -1) {
    if (!raw.endsWith('>')) throw new Error(`Invalid type tag: ${type}`)
    head = raw.slice(0, open).trim()
    typeArgs = splitTypeArgs(raw.slice(open + 1, -1))
  }
  const parts = head.split('::')
  if (parts.length === 1) return { raw, address: '', module: '', name: parts[0], typeArgs, isStruct: false }
  if (parts.length !== 3 || parts.some(p => !p)) throw new Error(`Invalid type tag: ${type}`)
  return { raw, address: parts[0], module: parts[1], name: parts[2], typeArgs, isStruct: true }
}
