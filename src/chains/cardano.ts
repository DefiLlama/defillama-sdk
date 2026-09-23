/**
 * Cardano client over the Blockfrost REST API (mainnet by default).
 *
 * Replaces the chain access parts of:
 *   - DefiLlama-Adapters  projects/helper/chain/cardano/blockfrost.js (getAssets, getAddressesUTXOs,
 *     getTxUtxos, getTxsRedeemers, getTxsMetadata, assetsAddresses, addressesUtxosAssetAll,
 *     getTokensMinted, getScriptsDatum, getAccountAddresses)
 *   - DefiLlama-Adapters  projects/helper/chain/cardano.js (getAda, getAdaInAddress, getTokenBalance)
 *   - peggedassets-server src/adapters/peggedAssets/helper/cardano.ts (getAsset, getTotalSupply,
 *     getTokenBalance, addressesUtxosAssetAll, getScriptsDatum)
 *   - dimension-adapters  helpers/cardano.ts (blockfrost(path), getAdaReceived -> address transactions
 *     in a time window + tx utxos)
 *   - defillama-server    coins/src/adapters/markets/minswap.ts (Blockfrost axios client shape)
 *
 * TVL coupling (sumTokens / Balances / Minswap GraphQL pricing) is intentionally left out;
 * every function returns raw chain values (lovelace / asset quantities as strings).
 *
 * Configuration:
 *   - `BLOCKFROST_PROJECT_ID` (required, also `SDK_` / `LLAMA_SDK_` prefixed): Blockfrost api key.
 *     No key is embedded in the sdk.
 *   - `CARDANO_BLOCKFROST` (optional, comma separated): api base url(s), default
 *     `https://cardano-mainnet.blockfrost.io/api/v0`.
 *   - `CARDANO_RPC_CONCURRENCY` (optional): max parallel requests, default 5.
 *
 * Usage: `sdk.chains.cardano.getAdaBalance({ address })`
 */
import axios from "axios";
import { getEnvValue } from "../util/env";
import { debugLog } from "../util/debugLog";
import { getEndpoints, getLimiter, isRetryableError, joinUrl, shortUrl, withRetry } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const DEFAULT_ENDPOINT = "https://cardano-mainnet.blockfrost.io/api/v0"
const ENDPOINT_ENV_KEY = 'CARDANO_BLOCKFROST'
const PROJECT_ID_ENV_KEY = 'BLOCKFROST_PROJECT_ID'
const LIMITER_KEY = 'cardano'
const CONCURRENCY = 5
const DEFAULT_TIMEOUT = 120_000
/** Blockfrost hard limit for `count` */
export const MAX_PAGE_SIZE = 100

/**
 * Shelley era (mainnet) started at slot 4492800 / unix 1596059091 with 1s slots, so
 * `slot = timestamp - SHELLEY_SLOT_OFFSET`. Byron blocks (before that) use 20s slots and
 * are not covered by the formula.
 */
export const SHELLEY_START_TIME = 1596059091
export const SHELLEY_START_SLOT = 4492800
export const SHELLEY_SLOT_OFFSET = SHELLEY_START_TIME - SHELLEY_START_SLOT // 1591566291

/** Base url list: `CARDANO_BLOCKFROST` env (comma separated) wins, then `DEFAULT_ENDPOINT`. */
export function getEndpointList(): string[] {
  return getEndpoints('cardano', DEFAULT_ENDPOINT, { envKey: ENDPOINT_ENV_KEY })
}

/** First configured base url. */
export function getEndpoint(): string {
  return getEndpointList()[0]
}

/** Blockfrost project id from `BLOCKFROST_PROJECT_ID`; throws when unset. */
export function getProjectId(): string {
  const value = getEnvValue(PROJECT_ID_ENV_KEY)
  if (!value) throw new Error(`[chains.cardano] missing Blockfrost api key: set the ${PROJECT_ID_ENV_KEY} env var (https://blockfrost.io)`)
  return value
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface AssetAmount {
  /** `lovelace` or `<policyId><assetNameHex>` */
  unit: string
  quantity: string
}

export interface AddressInfo {
  address: string
  amount: AssetAmount[]
  stake_address: string | null
  type: string
  script: boolean
}

export interface Utxo {
  address: string
  tx_hash: string
  output_index: number
  amount: AssetAmount[]
  block: string
  data_hash: string | null
  inline_datum: string | null
  reference_script_hash: string | null
}

export interface AddressTransaction {
  tx_hash: string
  tx_index: number
  block_height: number
  block_time: number
}

export interface TxUtxos {
  hash: string
  inputs: (Utxo & { collateral: boolean, reference: boolean })[]
  outputs: (Utxo & { collateral: boolean, consumed_by_tx?: string | null })[]
}

export interface Asset {
  asset: string
  policy_id: string
  asset_name: string | null
  fingerprint: string
  quantity: string
  initial_mint_tx_hash: string
  mint_or_burn_count: number
  onchain_metadata: Record<string, any> | null
  onchain_metadata_standard?: string | null
  metadata: { name?: string, description?: string, ticker?: string | null, url?: string | null, logo?: string | null, decimals?: number | null } | null
}

export interface Block {
  /** block height */
  number: number
  /** unix seconds */
  timestamp: number
  hash: string
  slot: number
  epoch: number
  /** raw Blockfrost block record */
  raw: any
}

export interface BlockfrostOptions {
  /** path relative to the api root, e.g. `/addresses/addr1...` */
  path: string
  params?: Record<string, any>
  /** return `null` on 404 instead of throwing */
  allowNotFound?: boolean
  timeout?: number
  retries?: number
}

export interface PagedOptions {
  path: string
  params?: Record<string, any>
  /** page size, max 100 (Blockfrost limit) */
  count?: number
  /** stop after this many pages (safety cap) */
  maxPages?: number
}

// ---------------------------------------------------------------------------
// client
// ---------------------------------------------------------------------------

const NOT_FOUND = Symbol('not-found')

function isNotFound(e: any) {
  return e?.response?.status === 404
}

/**
 * GET `path` from Blockfrost. Rotates through configured base urls, retries transient
 * failures (5xx / 429) and, when `allowNotFound`, turns a 404 into `null` before the retry
 * layer sees it.
 */
export async function blockfrost({ path, params, allowNotFound = false, timeout = DEFAULT_TIMEOUT, retries }: BlockfrostOptions): Promise<any> {
  const endpoints = getEndpointList()
  const headers = { project_id: getProjectId(), 'Content-Type': 'application/json' }
  const config = { timeout, headers, params }
  const limiter = getLimiter(LIMITER_KEY, CONCURRENCY)

  const res = await withRetry(async (attempt) => {
    const base = endpoints[attempt % endpoints.length]
    const url = joinUrl(base, path)
    return limiter(async () => {
      try {
        const response = await axios.get(url, config)
        return response.data
      } catch (e: any) {
        if (allowNotFound && isNotFound(e)) {
          debugLog(`[chains.cardano] GET ${path} -> 404 (treated as not found)`)
          return NOT_FOUND
        }
        const status = e?.response?.status
        const detail = e?.response?.data?.message ?? e?.response?.data?.error ?? e?.message
        const err: any = new Error(`[cardano] GET ${path} failed${status ? ` [${status}]` : ''}: ${String(detail ?? '').slice(0, 300)} (${shortUrl(url)})`)
        err.response = e?.response
        err.status = status
        throw err
      }
    })
  }, {
    label: `cardano GET ${path.split('?')[0].slice(0, 80)}`,
    retries: retries ?? Math.max(3, endpoints.length),
    shouldRetry: isRetryableError,
  })

  return res === NOT_FOUND ? null : res
}

/**
 * Walk every page of a list endpoint (`count` per page, `page` 1..n) and concatenate the
 * results. Stops on the first short / empty page or after `maxPages`.
 */
export async function blockfrostAll<T = any>({ path, params, count = MAX_PAGE_SIZE, maxPages }: PagedOptions): Promise<T[]> {
  if (count < 1 || count > MAX_PAGE_SIZE) throw new Error(`[chains.cardano] blockfrostAll: count must be between 1 and ${MAX_PAGE_SIZE}`)
  const results: T[] = []
  let page = 1
  while (true) {
    const res = await blockfrost({ path, params: { ...(params ?? {}), count, page } })
    if (!Array.isArray(res)) throw new Error(`[chains.cardano] GET ${path}: expected an array on page ${page}`)
    results.push(...res)
    if (res.length < count) break
    if (maxPages !== undefined && page >= maxPages) {
      debugLog(`[chains.cardano] GET ${path}: stopped after maxPages=${maxPages}, result may be truncated`)
      break
    }
    page++
  }
  return results
}

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

/** `/addresses/{address}`: balances (`amount`), stake address, type. `null` for unused addresses (404). */
export async function getAddress({ address }: { address: string }): Promise<AddressInfo | null> {
  return blockfrost({ path: `/addresses/${address}`, allowNotFound: true })
}

/** All assets held by `address` as `{ unit, quantity }[]` (`lovelace` included). Empty for unused addresses. */
export async function getAddressAssets({ address }: { address: string }): Promise<AssetAmount[]> {
  const info = await getAddress({ address })
  return info?.amount ?? []
}

/** ADA balance of `address` in lovelace (string). `'0'` for unused addresses. */
export async function getAdaBalance({ address }: { address: string }): Promise<string> {
  return getTokenBalance({ address, asset: 'lovelace' })
}

/** Balance of `asset` (`<policyId><assetNameHex>` or `lovelace`) held by `address`, as a string. */
export async function getTokenBalance({ address, asset }: { address: string, asset: string }): Promise<string> {
  const assets = await getAddressAssets({ address })
  return assets.find(i => i.unit === asset)?.quantity ?? '0'
}

/** Every utxo at `address` (all pages). */
export async function getAddressUtxos({ address, maxPages }: { address: string, maxPages?: number }): Promise<Utxo[]> {
  return blockfrostAll<Utxo>({ path: `/addresses/${address}/utxos`, maxPages })
}

/** Every utxo at `address` containing `asset` (all pages). */
export async function getAddressUtxosByAsset({ address, asset, maxPages }: { address: string, asset: string, maxPages?: number }): Promise<Utxo[]> {
  return blockfrostAll<Utxo>({ path: `/addresses/${address}/utxos/${asset}`, maxPages })
}

/**
 * Transactions involving `address` (all pages). `from` / `to` are block heights or
 * `height:txIndex` strings, inclusive, as accepted by Blockfrost. `order` defaults to `asc`.
 */
export async function getAddressTransactions({ address, from, to, order, maxPages }: { address: string, from?: number | string, to?: number | string, order?: 'asc' | 'desc', maxPages?: number }): Promise<AddressTransaction[]> {
  const params: Record<string, any> = {}
  if (from !== undefined) params.from = String(from)
  if (to !== undefined) params.to = String(to)
  if (order) params.order = order
  return blockfrostAll<AddressTransaction>({ path: `/addresses/${address}/transactions`, params, maxPages })
}

// ---------------------------------------------------------------------------
// transactions / scripts
// ---------------------------------------------------------------------------

/** `/txs/{hash}/utxos`: inputs and outputs of a transaction. */
export async function getTxUtxos({ txHash }: { txHash: string }): Promise<TxUtxos> {
  return blockfrost({ path: `/txs/${txHash}/utxos` })
}

/** `/txs/{hash}/redeemers` */
export async function getTxRedeemers({ txHash }: { txHash: string }): Promise<any[]> {
  return blockfrost({ path: `/txs/${txHash}/redeemers` })
}

/** `/txs/{hash}/metadata` */
export async function getTxMetadata({ txHash }: { txHash: string }): Promise<any[]> {
  return blockfrost({ path: `/txs/${txHash}/metadata` })
}

/** `/scripts/datum/{hash}`: `{ json_value }`, or `null` when unknown. */
export async function getScriptDatum({ datumHash }: { datumHash: string }): Promise<{ json_value: any } | null> {
  return blockfrost({ path: `/scripts/datum/${datumHash}`, allowNotFound: true })
}

// ---------------------------------------------------------------------------
// assets
// ---------------------------------------------------------------------------

/** `/assets/{assetId}` record, or `null` when the asset was never minted. */
export async function getAsset({ assetId }: { assetId: string }): Promise<Asset | null> {
  return blockfrost({ path: `/assets/${assetId}`, allowNotFound: true })
}

/**
 * Circulating supply (`quantity`, string) and decimals of an asset. Decimals come from the
 * off-chain token registry (`metadata.decimals`) or CIP-68 on-chain metadata
 * (`onchain_metadata.decimals`); `undefined` when neither is set.
 */
export async function getAssetSupply({ assetId }: { assetId: string }): Promise<{ supply: string, decimals: number | undefined }> {
  const asset = await getAsset({ assetId })
  if (!asset) throw new Error(`[chains.cardano] asset ${assetId} not found`)
  return { supply: String(asset.quantity ?? '0'), decimals: getAssetDecimals(asset) }
}

export function getAssetDecimals(asset: Asset | null | undefined): number | undefined {
  const candidates = [asset?.metadata?.decimals, asset?.onchain_metadata?.decimals]
  for (const value of candidates) {
    if (value === undefined || value === null || value === '') continue
    const n = Number(value)
    if (Number.isInteger(n) && n >= 0) return n
  }
  return undefined
}

/** `/assets/{assetId}/addresses`: every `{ address, quantity }` holding the asset (all pages). */
export async function getAssetAddresses({ assetId, maxPages }: { assetId: string, maxPages?: number }): Promise<{ address: string, quantity: string }[]> {
  return blockfrostAll({ path: `/assets/${assetId}/addresses`, maxPages })
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

/** `/accounts/{stakeAddress}/addresses`: every payment address controlled by a stake key (all pages). */
export async function getAccountAddresses({ stakeAddress, maxPages }: { stakeAddress: string, maxPages?: number }): Promise<string[]> {
  const rows = await blockfrostAll<{ address: string }>({ path: `/accounts/${stakeAddress}/addresses`, maxPages })
  return rows.map(i => i.address)
}

// ---------------------------------------------------------------------------
// blocks / epochs
// ---------------------------------------------------------------------------

function toBlock(raw: any): Block {
  return { number: raw.height, timestamp: raw.time, hash: raw.hash, slot: raw.slot, epoch: raw.epoch, raw }
}

/** `/blocks/latest` as `{ number, timestamp, hash, slot, epoch, raw }`. */
export async function getLatestBlock(): Promise<Block> {
  return toBlock(await blockfrost({ path: '/blocks/latest' }))
}

/** `/blocks/{hashOrNumber}`; `null` when unknown. */
export async function getBlock({ hashOrNumber }: { hashOrNumber: string | number }): Promise<Block | null> {
  const raw = await blockfrost({ path: `/blocks/${hashOrNumber}`, allowNotFound: true })
  return raw ? toBlock(raw) : null
}

/** `/blocks/slot/{slot}`; `null` when no block was minted in that slot. */
export async function getBlockBySlot({ slot }: { slot: number }): Promise<Block | null> {
  const raw = await blockfrost({ path: `/blocks/slot/${slot}`, allowNotFound: true })
  return raw ? toBlock(raw) : null
}

/**
 * Last block with `time <= timestamp` (unix seconds). For Shelley-era timestamps the slot is
 * derived directly (`slot = timestamp - SHELLEY_SLOT_OFFSET`) and `/blocks/slot/{slot}` is
 * tried first; otherwise (or when that slot is empty) an interpolation search over block
 * heights, seeded from the latest block, converges in a handful of requests.
 */
export async function getBlockAtTimestamp({ timestamp }: { timestamp: number }): Promise<Block> {
  if (!timestamp || !Number.isFinite(timestamp)) throw new Error('[chains.cardano] getBlockAtTimestamp: invalid timestamp')
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000) // tolerate milliseconds

  const latest = await getLatestBlock()
  if (latest.timestamp <= timestamp) return latest

  let steps = 0
  if (timestamp >= SHELLEY_START_TIME) {
    const exact = await getBlockBySlot({ slot: timestamp - SHELLEY_SLOT_OFFSET })
    steps++
    if (exact && exact.timestamp === timestamp) {
      debugLog(`[chains.cardano] getBlockAtTimestamp(${timestamp}) -> block ${exact.number} via slot lookup`)
      return exact
    }
  }

  const cache = new Map<number, Block>()
  cache.set(latest.number, latest)
  const fetchBlock = async (height: number): Promise<Block> => {
    if (!cache.has(height)) {
      const block = await getBlock({ hashOrNumber: height })
      if (!block) throw new Error(`[chains.cardano] block ${height} not found`)
      cache.set(height, block)
      steps++
    }
    return cache.get(height)!
  }

  let hi = latest
  let lo = await fetchBlock(1)
  if (lo.timestamp > timestamp) throw new Error(`[chains.cardano] timestamp ${timestamp} predates the chain (block 1 at ${lo.timestamp})`)

  // invariant: lo.timestamp <= timestamp < hi.timestamp
  while (hi.number - lo.number > 1) {
    const span = hi.timestamp - lo.timestamp
    let guess = span > 0
      ? lo.number + Math.floor((hi.number - lo.number) * (timestamp - lo.timestamp) / span)
      : Math.floor((lo.number + hi.number) / 2)
    // keep the guess strictly inside (lo, hi); alternate with bisection when interpolation stalls
    if (guess <= lo.number || guess >= hi.number || steps % 4 === 3) guess = Math.floor((lo.number + hi.number) / 2)
    const block = await fetchBlock(guess)
    if (block.timestamp <= timestamp) lo = block
    else hi = block
    if (steps > 200) throw new Error(`[chains.cardano] getBlockAtTimestamp(${timestamp}): search did not converge`)
  }
  debugLog(`[chains.cardano] getBlockAtTimestamp(${timestamp}) -> block ${lo.number} in ${steps} requests`)
  return lo
}

/** `/epochs/{epoch}` (or `/epochs/latest`). */
export async function getEpoch({ epoch = 'latest' }: { epoch?: number | 'latest' } = {}): Promise<any> {
  return blockfrost({ path: `/epochs/${epoch}` })
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const POLICY_ID_LENGTH = 56
const HEX_RE = /^([0-9a-fA-F]{2})*$/

export interface ParsedAssetId {
  policyId: string
  assetNameHex: string
  /** utf8 decoded asset name when it is printable ascii/utf8, otherwise the hex */
  assetName: string
}

/** Split `<policyId><assetNameHex>` (or `lovelace`) into its parts. */
export function parseAssetId(assetId: string): ParsedAssetId {
  if (assetId === 'lovelace') return { policyId: '', assetNameHex: '', assetName: 'lovelace' }
  if (typeof assetId !== 'string' || assetId.length < POLICY_ID_LENGTH || !HEX_RE.test(assetId))
    throw new Error(`[chains.cardano] invalid asset id: ${assetId}`)
  const policyId = assetId.slice(0, POLICY_ID_LENGTH).toLowerCase()
  const assetNameHex = assetId.slice(POLICY_ID_LENGTH).toLowerCase()
  return { policyId, assetNameHex, assetName: decodeAssetName(assetNameHex) }
}

/** Hex asset name -> utf8 when it round-trips and is printable, else the hex itself. */
export function decodeAssetName(assetNameHex: string): string {
  if (!assetNameHex) return ''
  const buf = Buffer.from(assetNameHex, 'hex')
  const utf8 = buf.toString('utf8')
  const roundTrips = Buffer.from(utf8, 'utf8').toString('hex') === assetNameHex.toLowerCase()
  // printable: no control chars (0x00-0x1f, 0x7f) and no replacement char
  const printable = roundTrips && !/[\u0000-\u001f\u007f�]/.test(utf8)
  return printable ? utf8 : assetNameHex.toLowerCase()
}

/**
 * `policyId + assetNameHex`. `assetName` is taken as hex when it is a valid even-length hex
 * string, otherwise utf8 encoded; pass `encoding` to force one.
 */
export function buildAssetId(policyId: string, assetName: string = '', encoding?: 'hex' | 'utf8'): string {
  if (typeof policyId !== 'string' || policyId.length !== POLICY_ID_LENGTH || !HEX_RE.test(policyId))
    throw new Error(`[chains.cardano] invalid policy id: ${policyId}`)
  const isHex = encoding === 'hex' || (encoding === undefined && HEX_RE.test(assetName))
  const nameHex = isHex ? assetName.toLowerCase() : Buffer.from(assetName, 'utf8').toString('hex')
  return policyId.toLowerCase() + nameHex
}

/** `stake1...` (mainnet) / `stake_test1...` bech32 reward addresses. */
export function isStakeAddress(address: string): boolean {
  return typeof address === 'string' && /^stake(_test)?1[a-z0-9]+$/.test(address)
}

/** lovelace (string | number | bigint) -> ADA as a number. */
export function lovelaceToAda(lovelace: string | number | bigint): number {
  return Number(lovelace) / 1e6
}
