/**
 * Algorand indexer / algod client plus the address codec.
 *
 * Replaces (and consolidates) these per-repo copies:
 *  - DefiLlama-Adapters   projects/helper/chain/algorand.js (client, lookups, asset/account/global-state helpers, boxes)
 *  - DefiLlama-Adapters   projects/helper/chain/algorandUtils/address.js (encodeAddress, getApplicationAddress, encodeUint64, genericHash)
 *  - peggedassets-server  src/adapters/peggedAssets/helper/algorand.js and helper/getSupply.ts (algorandGetAssetParams / TotalSupply / Balance)
 *  - coins server         src/scripts/coingeckoUtils.ts (algorand asset symbol / decimals lookup)
 *  - dimension-adapters   fees/folks-finance.ts (global state key / uint64 decoding idiom)
 *
 * Endpoints: `ALGORAND_INDEXER` (default https://mainnet-idx.algonode.cloud) and `ALGORAND_RPC` for algod
 * (default https://mainnet-api.algonode.cloud), both comma separated lists with rotation on failure.
 * Every request goes through the shared `algorand` limiter (10 concurrent, `ALGORAND_RPC_CONCURRENCY` overrides).
 *
 * Responses are parsed with a uint64-safe JSON parser: integer literals that do not fit in a JS number
 * (asset totals such as 2^64-1, large 0-decimal amounts) are returned as decimal strings instead of
 * being rounded. Everything that is documented as returning a string amount is normalised with `String()`.
 *
 * Deliberately not ported: `sumTokens`, `resolveTinymanLp`, `getPriceFromAlgoFiLP` and the `tokens` id map
 * (TVL bookkeeping that belongs to the adapters repo).
 */
import { createHash } from "crypto";
import { getEndpoints, getLimiter, httpGet } from "./rpc";
import { debugLog } from "../util/debugLog";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const DEFAULT_INDEXER = 'https://mainnet-idx.algonode.cloud'
export const DEFAULT_ALGOD = 'https://mainnet-api.algonode.cloud'

const INDEXER_ENV_KEY = 'ALGORAND_INDEXER'
const LIMITER_KEY = 'algorand'
const LIMITER_CONCURRENCY = 10

/** Indexer endpoint list: `ALGORAND_INDEXER` env (comma separated) or the default. */
export function getIndexerEndpoints(): string[] {
  return getEndpoints('algorand', DEFAULT_INDEXER, { envKey: INDEXER_ENV_KEY })
}

/** First indexer endpoint. */
export function getIndexerEndpoint(): string {
  return getIndexerEndpoints()[0]
}

/** Algod endpoint list: `ALGORAND_RPC` env (comma separated) or the default. */
export function getAlgodEndpoints(): string[] {
  return getEndpoints('algorand', DEFAULT_ALGOD)
}

/** First algod endpoint. */
export function getAlgodEndpoint(): string {
  return getAlgodEndpoints()[0]
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type AlgoAmount = number | string

export interface GlobalStateEntry {
  key: string
  value: { type: number, bytes?: string, uint?: AlgoAmount }
}

export interface AlgorandApplication {
  id: number
  'created-at-round'?: number
  deleted?: boolean
  params: {
    creator: string
    'global-state'?: GlobalStateEntry[]
    [key: string]: any
  }
  [key: string]: any
}

export interface AlgorandAssetHolding {
  'asset-id': AlgoAmount
  amount: AlgoAmount
  'is-frozen'?: boolean
  [key: string]: any
}

export interface AlgorandAccount {
  address: string
  amount: AlgoAmount
  assets?: AlgorandAssetHolding[]
  'created-apps'?: AlgorandApplication[]
  round?: number
  status?: string
  [key: string]: any
}

/** `getAccountInfo` result: the indexer account with string asset ids and an `assetMapping` index. */
export interface AlgorandAccountInfo extends AlgorandAccount {
  assets: AlgorandAssetHolding[]
  /** holdings keyed by asset id (string); the native ALGO balance is also exposed under the pseudo id '1' */
  assetMapping: { [assetId: string]: AlgorandAssetHolding }
}

export interface AlgorandAssetParams {
  creator: string
  decimals: number
  total: AlgoAmount
  name?: string
  'unit-name'?: string
  reserve?: string
  manager?: string
  freeze?: string
  clawback?: string
  url?: string
  'default-frozen'?: boolean
  [key: string]: any
}

/** `getAssetInfo` result: asset params flattened next to the asset metadata (`id`, `created-at-round`, ...) */
export interface AlgorandAssetInfo extends AlgorandAssetParams {
  id: number
  params: AlgorandAssetParams
  'created-at-round'?: number
  deleted?: boolean
}

export interface AlgorandAssetSupply {
  total: string
  decimals: number
  reserve: string | undefined
  /** total minus the reserve account's holding (equals total when there is no reserve) */
  circulating: string
}

export interface AlgorandBox {
  name: string
  value: string
  round?: number
}

export interface AlgorandBlock {
  round: number
  timestamp: number
  [key: string]: any
}

export interface BlockRef {
  number: number
  timestamp: number
}

export type GlobalStateValue = number | string
export type DecodedGlobalState = { [key: string]: GlobalStateValue }

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

function limiter() {
  return getLimiter(LIMITER_KEY, LIMITER_CONCURRENCY)
}

/**
 * JSON.parse that keeps integers too large for a JS number as decimal strings.
 * Only integer literals outside of strings that fail `Number.isSafeInteger` are quoted.
 */
export function parseJsonSafe(text: string): any {
  let out = ''
  let last = 0
  let inString = false
  const n = text.length
  let i = 0
  while (i < n) {
    const ch = text[i]
    if (inString) {
      if (ch === '\\') { i += 2; continue }
      if (ch === '"') inString = false
      i++
      continue
    }
    if (ch === '"') { inString = true; i++; continue }
    if ((ch >= '0' && ch <= '9') || ch === '-') {
      let j = i
      if (text[j] === '-') j++
      const start = j
      while (j < n && text[j] >= '0' && text[j] <= '9') j++
      const next = text[j]
      const isInteger = next !== '.' && next !== 'e' && next !== 'E'
      const digits = j - start
      if (isInteger && digits > 15 && !Number.isSafeInteger(Number(text.slice(i, j)))) {
        out += text.slice(last, i) + '"' + text.slice(i, j) + '"'
        last = j
      }
      i = Math.max(j, i + 1)
      continue
    }
    i++
  }
  return JSON.parse(last ? out + text.slice(last) : text)
}

interface RequestOptions {
  path: string
  params?: Record<string, any>
  /** resolve to `undefined` instead of throwing on a 404 */
  allow404?: boolean
}

function stripUndefined(params?: Record<string, any>) {
  if (!params) return undefined
  const res: Record<string, any> = {}
  Object.keys(params).forEach(k => { if (params[k] !== undefined && params[k] !== null) res[k] = params[k] })
  return res
}

async function getJson(urls: string[], { path, params, allow404 }: RequestOptions): Promise<any> {
  return limiter()(async () => {
    const res = await httpGet(urls, {
      path,
      params: stripUndefined(params),
      withMetadata: true,
      axiosConfig: {
        transformResponse: [(data: any) => data],
        validateStatus: (status: number) => (status >= 200 && status < 300) || (!!allow404 && status === 404),
      },
    })
    if (res.status === 404) {
      debugLog(`[chains.algorand] 404 ${path}`)
      return undefined
    }
    const data = res.data
    if (typeof data !== 'string') return data
    if (!data) return undefined
    return parseJsonSafe(data)
  })
}

/** Raw GET against the indexer (`/v2/...`), parsed with the uint64-safe parser. */
export async function indexerGet({ path, params }: { path: string, params?: Record<string, any> }): Promise<any> {
  return getJson(getIndexerEndpoints(), { path, params })
}

/** Raw GET against algod (`/v2/...`), parsed with the uint64-safe parser. */
export async function algodGet({ path, params }: { path: string, params?: Record<string, any> }): Promise<any> {
  return getJson(getAlgodEndpoints(), { path, params })
}

// ---------------------------------------------------------------------------
// applications / accounts
// ---------------------------------------------------------------------------

/** `/v2/applications/{appId}` -> the `application` object (id, params, global-state, ...) */
export async function lookupApplication({ appId }: { appId: number | string }): Promise<AlgorandApplication> {
  const res = await indexerGet({ path: `/v2/applications/${appId}` })
  return res.application
}

/**
 * `/v2/accounts/{address}` -> the `account` object. `includeAll` also returns closed-out / deleted holdings.
 * Resolves to `undefined` when the indexer has never seen the account (404).
 */
export async function lookupAccount({ address, includeAll, params }: { address: string, includeAll?: boolean, params?: Record<string, any> }): Promise<AlgorandAccount | undefined> {
  const query: Record<string, any> = { ...params, 'include-all': includeAll ? true : undefined }
  try {
    const res = await getJson(getIndexerEndpoints(), { path: `/v2/accounts/${address}`, params: query, allow404: true, })
    return res?.account
  } catch (e: any) {
    // accounts with > 10k created assets/apps or local states are rejected with 400 "max-results";
    // retry without the large collections so holdings (`assets`) are still returned
    if (query.exclude || !isMaxResultsError(e)) throw e
    debugLog(`[chains.algorand] account ${address} exceeds max-results, retrying with exclude`)
    try {
      const res = await getJson(getIndexerEndpoints(), {
        path: `/v2/accounts/${address}`,
        params: { ...query, exclude: 'created-assets,created-apps,apps-local-state' },
        allow404: true,
      })
      return res?.account
    } catch (e2: any) {
      if (!isMaxResultsError(e2)) throw e2
      // even the holdings are too many, return the bare account (amount, round, status...)
      debugLog(`[chains.algorand] account ${address} holdings exceed max-results, returning account without assets`)
      const res = await getJson(getIndexerEndpoints(), { path: `/v2/accounts/${address}`, params: { ...query, exclude: 'all' }, allow404: true, })
      return res?.account
    }
  }
}

function isMaxResultsError(e: any): boolean {
  return String(e?.message ?? '').includes('max-results')
}

const accountInfoCache: { [address: string]: Promise<AlgorandAccountInfo> } = {}

/**
 * Account with holdings indexed by asset id. Memoised per process (same address -> same promise), like the
 * adapters helper it replaces. A numeric `address` is treated as an application id and resolved to its escrow address.
 * The ALGO balance is added to `assets` / `assetMapping` under the pseudo asset id '1'.
 */
export function getAccountInfo({ address }: { address: string | number }): Promise<AlgorandAccountInfo> {
  const key = typeof address === 'number' ? getApplicationAddress(address) : address
  if (!accountInfoCache[key]) {
    accountInfoCache[key] = _getAccountInfo(key).catch((e) => {
      delete accountInfoCache[key] // do not cache failures
      throw e
    })
  }
  return accountInfoCache[key]
}

async function _getAccountInfo(address: string): Promise<AlgorandAccountInfo> {
  const account = await lookupAccount({ address })
  if (!account) throw new Error(`[chains.algorand] account not found: ${address}`)
  const assets: AlgorandAssetHolding[] = (account.assets ?? []).map(i => ({ ...i, 'asset-id': String(i['asset-id']) }))
  if (account.amount) assets.push({ amount: account.amount, 'asset-id': '1' })
  const assetMapping: { [assetId: string]: AlgorandAssetHolding } = {}
  assets.forEach(i => { assetMapping[String(i['asset-id'])] = i })
  return { ...account, assets, assetMapping }
}

/** Drop the memoised `getAccountInfo` entries (all, or one address). */
export function clearAccountInfoCache(address?: string) {
  if (address) delete accountInfoCache[address]
  else Object.keys(accountInfoCache).forEach(k => delete accountInfoCache[k])
}

export interface SearchAccountsOptions {
  /** only accounts opted into this application */
  appId?: number | string
  /** only accounts holding this asset */
  assetId?: number | string
  limit?: number
  nextToken?: string
  /** extra indexer query params (`currency-greater-than`, `include-all`, `exclude`, ...) */
  params?: Record<string, any>
}

/** `/v2/accounts` search, one page -> `{ accounts, 'next-token', 'current-round' }` */
export async function searchAccounts({ appId, assetId, limit = 1000, nextToken, params }: SearchAccountsOptions): Promise<{ accounts: AlgorandAccount[], 'next-token'?: string, [key: string]: any }> {
  return indexerGet({
    path: '/v2/accounts',
    params: {
      ...params,
      'application-id': appId,
      'asset-id': assetId,
      limit,
      next: nextToken,
    },
  })
}

/** All pages of `searchAccounts`. `onPage` is called with every page as it arrives. */
export async function searchAccountsAll({ appId, assetId, limit = 1000, params, onPage }: Omit<SearchAccountsOptions, 'nextToken'> & { onPage?: (accounts: AlgorandAccount[], page: number) => void | Promise<void> }): Promise<AlgorandAccount[]> {
  const accounts: AlgorandAccount[] = []
  let nextToken: string | undefined
  let page = 0
  do {
    const res = await searchAccounts({ appId, assetId, limit, nextToken, params })
    nextToken = res['next-token']
    const pageAccounts = res.accounts ?? []
    accounts.push(...pageAccounts)
    if (onPage) await onPage(pageAccounts, page)
    page++
    debugLog(`[chains.algorand] searchAccountsAll app=${appId ?? '-'} asset=${assetId ?? '-'} page=${page} total=${accounts.length}`)
  } while (nextToken)
  return accounts
}

/** `/v2/accounts/{address}/created-applications` -> `{ applications, 'next-token', ... }` */
export async function lookupApplicationsCreatedByAccount({ address, params }: { address: string, params?: Record<string, any> }): Promise<{ applications: AlgorandApplication[], [key: string]: any }> {
  return indexerGet({ path: `/v2/accounts/${address}/created-applications`, params })
}

// ---------------------------------------------------------------------------
// assets / balances
// ---------------------------------------------------------------------------

/** `/v2/assets/{assetId}` -> asset params (total, decimals, reserve, unit-name, ...) flattened with the asset metadata. */
export async function getAssetInfo({ assetId }: { assetId: number | string }): Promise<AlgorandAssetInfo> {
  const res = await indexerGet({ path: `/v2/assets/${assetId}` })
  const asset = res.asset
  return { ...asset.params, ...asset }
}

/** Amount of `assetId` held by `address` as a base-unit string; '0' when the account is not opted in or unknown. */
export async function getAssetBalance({ address, assetId }: { address: string, assetId: number | string }): Promise<string> {
  const res = await getJson(getIndexerEndpoints(), {
    path: `/v2/accounts/${address}/assets`,
    params: { 'asset-id': assetId },
    allow404: true,
  })
  const holding = (res?.assets ?? []).find((i: AlgorandAssetHolding) => String(i['asset-id']) === String(assetId))
  return holding ? String(holding.amount) : '0'
}

/** Native ALGO balance of `address` in microalgos as a string; '0' for unknown accounts. */
export async function getAlgoBalance({ address }: { address: string }): Promise<string> {
  const account = await lookupAccount({ address, params: { exclude: 'all' } })
  return account ? String(account.amount ?? 0) : '0'
}

/**
 * Supply figures for an ASA, all in base units. `circulating` is `total` minus the reserve account's holding,
 * which is how Algorand issuers (USDC, USDt, ...) signal the un-issued part of a fixed total.
 */
export async function getAssetSupply({ assetId }: { assetId: number | string }): Promise<AlgorandAssetSupply> {
  const info = await getAssetInfo({ assetId })
  const total = String(info.total)
  const reserve = info.reserve || undefined
  let circulating = total
  if (reserve) {
    const reserveHolding = await getAssetBalance({ address: reserve, assetId })
    const diff = BigInt(total) - BigInt(reserveHolding)
    circulating = (diff < BigInt(0) ? BigInt(0) : diff).toString()
  }
  return { total, decimals: Number(info.decimals ?? 0), reserve, circulating }
}

// ---------------------------------------------------------------------------
// global state
// ---------------------------------------------------------------------------

/** Global state key: base64 -> utf8 string. */
export function decodeGlobalStateKey(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8')
}

/**
 * Global state value: uint (type 2) -> number (or decimal string when above 2^53), bytes (type 1) -> base64
 * string as delivered by the indexer. Use `bytesAsAddress` / `bytesAsUint64s` / `bytesAsUtf8` to interpret bytes.
 */
export function decodeGlobalStateValue(value: GlobalStateEntry['value']): GlobalStateValue {
  if (value.type === 1) return value.bytes ?? ''
  const uint = value.uint ?? 0
  if (typeof uint === 'string') {
    const asNumber = Number(uint)
    return Number.isSafeInteger(asNumber) ? asNumber : uint
  }
  return uint
}

/** Decode an indexer `global-state` (or `local-state`) key/value list into a plain object. */
export function decodeGlobalState(entries: GlobalStateEntry[] = []): DecodedGlobalState {
  const res: DecodedGlobalState = {}
  entries.forEach(entry => { res[decodeGlobalStateKey(entry.key)] = decodeGlobalStateValue(entry.value) })
  return res
}

/** Decoded global state of an application: `{ [utf8 key]: number | string }`. */
export async function getAppGlobalState({ appId }: { appId: number | string }): Promise<DecodedGlobalState> {
  const app = await lookupApplication({ appId })
  return decodeGlobalState(app?.params?.['global-state'] ?? [])
}

/** Interpret a 32 byte base64 state value as an Algorand address. */
export function bytesAsAddress(b64: string): string {
  const bytes = Buffer.from(b64, 'base64')
  if (bytes.length !== PUBLIC_KEY_LENGTH) throw new Error(`[chains.algorand] expected 32 bytes for an address, got ${bytes.length}`)
  return encodeAddress(new Uint8Array(bytes))
}

/** Interpret a base64 state value as consecutive big-endian uint64s (packed structs used by Folks, Tinyman, ...). */
export function bytesAsUint64s(b64: string): bigint[] {
  const buf = Buffer.from(b64, 'base64')
  const out: bigint[] = []
  for (let i = 0; i + 8 <= buf.length; i += 8) out.push(buf.readBigUInt64BE(i))
  return out
}

/** Interpret a base64 state value as utf8 text. */
export function bytesAsUtf8(b64: string): string {
  return Buffer.from(b64, 'base64').toString('utf8')
}

// ---------------------------------------------------------------------------
// boxes / transactions
// ---------------------------------------------------------------------------

/** `/v2/applications/{appId}/boxes`, one page -> `{ boxes: [{ name }], 'next-token' }` */
export async function getApplicationBoxes({ appId, limit = 1000, nextToken }: { appId: number | string, limit?: number, nextToken?: string }): Promise<{ boxes: { name: string }[], 'next-token'?: string, [key: string]: any }> {
  return indexerGet({ path: `/v2/applications/${appId}/boxes`, params: { limit, next: nextToken } })
}

/** All box names of an application (base64 encoded). */
export async function getApplicationBoxesAll({ appId, limit = 1000 }: { appId: number | string, limit?: number }): Promise<{ name: string }[]> {
  const boxes: { name: string }[] = []
  let nextToken: string | undefined
  do {
    const res = await getApplicationBoxes({ appId, limit, nextToken })
    nextToken = res['next-token']
    boxes.push(...(res.boxes ?? []))
  } while (nextToken)
  return boxes
}

/**
 * Encode a box name for the `name` query param. Strings already prefixed with `b64:` / `str:` / `int:` are passed
 * through, raw bytes are base64 encoded, plain strings are sent as `str:`.
 */
export function encodeBoxName(name: string | Uint8Array): string {
  if (typeof name !== 'string') return 'b64:' + Buffer.from(name).toString('base64')
  if (/^(b64|str|int):/.test(name)) return name
  return 'str:' + name
}

/** `/v2/applications/{appId}/box?name=...` -> `{ name, value, round }` (base64 encoded name/value). */
export async function getApplicationBox({ appId, name }: { appId: number | string, name: string | Uint8Array }): Promise<AlgorandBox> {
  return indexerGet({ path: `/v2/applications/${appId}/box`, params: { name: encodeBoxName(name) } })
}

/** `/v2/transactions` search with raw indexer params (`address`, `asset-id`, `min-round`, `after-time`, `next`, ...). */
export async function lookupTransactions({ params = {} }: { params?: Record<string, any> } = {}): Promise<{ transactions: any[], 'next-token'?: string, [key: string]: any }> {
  return indexerGet({ path: '/v2/transactions', params })
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

/** `/v2/blocks/{round}` -> block header (round, timestamp, transactions, ...) */
export async function getBlock({ round }: { round: number }): Promise<AlgorandBlock> {
  return indexerGet({ path: `/v2/blocks/${round}`, params: { 'header-only': true } })
}

/** Latest round the indexer has ingested (from `/health`) with its timestamp. */
export async function getLatestBlock(): Promise<BlockRef> {
  const health = await indexerGet({ path: '/health' })
  const round = Number(health.round)
  if (!round) throw new Error('[chains.algorand] indexer /health returned no round')
  const block = await getBlock({ round })
  return { number: round, timestamp: Number(block.timestamp) }
}

/**
 * First block whose timestamp is >= `timestamp` (unix seconds). Fast path: the first transaction after that time
 * (indexer `after-time`); falls back to a binary search over block headers.
 */
export async function getBlockAtTimestamp({ timestamp }: { timestamp: number }): Promise<BlockRef> {
  const latest = await getLatestBlock()
  if (timestamp >= latest.timestamp) return latest

  try {
    const res = await lookupTransactions({ params: { 'after-time': new Date(timestamp * 1000).toISOString(), limit: 1 } })
    const round = Number(res?.transactions?.[0]?.['confirmed-round'])
    if (round) {
      const block = await getBlock({ round })
      const blockTime = Number(block.timestamp)
      if (blockTime >= timestamp) {
        // make sure the previous block is really before the timestamp, otherwise refine with the binary search
        const prev = round > 1 ? await getBlock({ round: round - 1 }) : undefined
        if (!prev || Number(prev.timestamp) < timestamp) return { number: round, timestamp: blockTime }
      }
    }
  } catch (e) {
    debugLog(`[chains.algorand] getBlockAtTimestamp fast path failed: ${(e as any)?.message ?? e}`)
  }

  let lo = 1
  let hi = latest.number
  let best: BlockRef = latest
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const block = await getBlock({ round: mid })
    const blockTime = Number(block.timestamp)
    if (blockTime >= timestamp) {
      best = { number: mid, timestamp: blockTime }
      hi = mid - 1
    } else {
      lo = mid + 1
    }
  }
  return best
}

// ---------------------------------------------------------------------------
// codec: base32 (RFC 4648), sha512/256, addresses, uint64
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const BASE32_LOOKUP: { [ch: string]: number } = {}
for (let i = 0; i < BASE32_ALPHABET.length; i++) BASE32_LOOKUP[BASE32_ALPHABET[i]] = i

const ALGORAND_CHECKSUM_BYTE_LENGTH = 4
const ALGORAND_ADDRESS_LENGTH = 58
const PUBLIC_KEY_LENGTH = 32
const APP_ID_PREFIX = new Uint8Array(Buffer.from('appID'))
const MAX_UINT64 = BigInt('0xffffffffffffffff')

/** RFC 4648 base32 with `=` padding. */
export function base32Encode(bytes: Uint8Array): string {
  let out = ''
  let bits = 0
  let value = 0
  for (let i = 0; i < bytes.length; i++) {
    value = ((value << 8) | bytes[i]) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31]
  while (out.length % 8 !== 0) out += '='
  return out
}

/** RFC 4648 base32 decode; padding optional, case insensitive, throws on invalid characters. */
export function base32Decode(str: string): Uint8Array {
  const clean = str.replace(/=+$/, '').toUpperCase()
  const out = new Uint8Array(Math.floor(clean.length * 5 / 8))
  let bits = 0
  let value = 0
  let index = 0
  for (let i = 0; i < clean.length; i++) {
    const v = BASE32_LOOKUP[clean[i]]
    if (v === undefined) throw new Error(`[chains.algorand] invalid base32 character "${clean[i]}"`)
    value = ((value << 5) | v) & 0xffff
    bits += 5
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff
      bits -= 8
    }
  }
  return out
}

/** SHA-512/256 digest (Algorand's "genericHash"). */
export function sha512_256(bytes: Uint8Array | Buffer): Uint8Array {
  return new Uint8Array(createHash('sha512-256').update(bytes).digest())
}

export function concatArrays(...arrs: Uint8Array[]): Uint8Array {
  const size = arrs.reduce((sum, arr) => sum + arr.length, 0)
  const c = new Uint8Array(size)
  let offset = 0
  for (const arr of arrs) {
    c.set(arr, offset)
    offset += arr.length
  }
  return c
}

/** 32 byte public key -> 58 char address (base32 of key + 4 byte sha512/256 checksum, padding stripped). */
export function encodeAddress(publicKey: Uint8Array): string {
  if (publicKey.length !== PUBLIC_KEY_LENGTH) throw new Error(`[chains.algorand] public key must be ${PUBLIC_KEY_LENGTH} bytes, got ${publicKey.length}`)
  const checksum = sha512_256(publicKey).slice(PUBLIC_KEY_LENGTH - ALGORAND_CHECKSUM_BYTE_LENGTH, PUBLIC_KEY_LENGTH)
  return base32Encode(concatArrays(publicKey, checksum)).slice(0, ALGORAND_ADDRESS_LENGTH)
}

/** 58 char address -> `{ publicKey, checksum }`; throws when the length or the checksum is wrong. */
export function decodeAddress(address: string): { publicKey: Uint8Array, checksum: Uint8Array } {
  if (typeof address !== 'string' || address.length !== ALGORAND_ADDRESS_LENGTH) throw new Error(`[chains.algorand] address must be ${ALGORAND_ADDRESS_LENGTH} characters: ${address}`)
  const decoded = base32Decode(address)
  const publicKey = decoded.slice(0, PUBLIC_KEY_LENGTH)
  const checksum = decoded.slice(PUBLIC_KEY_LENGTH, PUBLIC_KEY_LENGTH + ALGORAND_CHECKSUM_BYTE_LENGTH)
  const expected = sha512_256(publicKey).slice(PUBLIC_KEY_LENGTH - ALGORAND_CHECKSUM_BYTE_LENGTH, PUBLIC_KEY_LENGTH)
  for (let i = 0; i < ALGORAND_CHECKSUM_BYTE_LENGTH; i++) {
    if (checksum[i] !== expected[i]) throw new Error(`[chains.algorand] address checksum mismatch: ${address}`)
  }
  return { publicKey, checksum }
}

export function isValidAddress(address: string): boolean {
  try {
    decodeAddress(address)
    return true
  } catch {
    return false
  }
}

/** Big-endian 8 byte encoding of an unsigned 64-bit integer. */
export function encodeUint64(num: number | bigint | string): Uint8Array {
  let value: bigint
  try {
    if (typeof num === 'number' && !Number.isInteger(num)) throw new Error('not an integer')
    value = BigInt(num)
  } catch {
    throw new Error(`[chains.algorand] Input is not a 64-bit unsigned integer: ${num}`)
  }
  if (value < BigInt(0) || value > MAX_UINT64) throw new Error(`[chains.algorand] Input is not a 64-bit unsigned integer: ${num}`)
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(value)
  return new Uint8Array(buf)
}

/** Escrow address of an application: encodeAddress(sha512_256("appID" || uint64(appId))). */
export function getApplicationAddress(appId: number | bigint | string): string {
  const toBeSigned = concatArrays(APP_ID_PREFIX, encodeUint64(appId))
  return encodeAddress(sha512_256(toBeSigned))
}
