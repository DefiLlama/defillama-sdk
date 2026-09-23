/**
 * Balance client for bitcoin-like UTXO chains via public explorer APIs
 * (esplora/blockstream, mempool.space, blockbook, blockcypher, tatum, insight,
 * whatsonchain, blockchair, kaspa REST, mvcapi).
 *
 * Replaces the chain access parts of:
 *   - DefiLlama-Adapters  projects/helper/chain/bitcoin.js (getBalanceNow,
 *     getBalance(addr, timestamp), getCachedBitcoinBalances / cachedBTCBalCall,
 *     blockchain.info multiaddr batching)
 *   - DefiLlama-Adapters  projects/helper/chain/litecoin.js, doge.js, dash.js,
 *     bsv.js, zcash.js, kaspa.js, mvc.js (per-chain getBalance)
 *   - defillama-server    coins/src/adapters/other/others2.ts getBtcBalanceSats
 *     (blockstream -> mempool.space failover)
 *
 * TVL coupling (sumTokens, Balances, getUniqueAddresses) is intentionally left
 * out; every balance is returned in base units (satoshis, litoshis, zatoshi,
 * sompi, ...) as a decimal string.
 *
 * Explorer base urls are overridable per chain with `<CHAIN>_EXPLORER_API`
 * (comma separated fallbacks, also `SDK_` / `LLAMA_SDK_` prefixed). Unknown
 * hosts are assumed to speak the chain's default provider dialect.
 *
 * Usage: `sdk.chains.utxo.getBalance({ chain: 'bitcoin', address: 'bc1q...' })`
 */
import { debugLog } from "../util/debugLog";
import { getEnvValue } from "../util/env";
import { getEndpoints as resolveEndpoints, getLimiter, httpGet, httpPost, runInChunks, sliceIntoChunks, sleep, } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export interface UtxoChainConfig {
  decimals: number
  /** explorer base urls in fallback order, overridable with `<CHAIN>_EXPLORER_API` */
  endpoints: string[]
  /** max parallel explorer requests, overridable with `<CHAIN>_RPC_CONCURRENCY` */
  concurrency: number
  /** pause before every request (free-tier rate limits), applied inside the limiter */
  sleepMs?: number
}

export const CHAINS: Record<string, UtxoChainConfig> = {
  bitcoin: {
    decimals: 8,
    endpoints: ['https://blockstream.info/api', 'https://mempool.space/api', 'https://rpc.ankr.com/http/btc_blockbook/api/v2'],
    concurrency: 5,
  },
  litecoin: {
    decimals: 8,
    endpoints: ['https://litecoinspace.org/api', 'https://api.blockchair.com/litecoin'],
    concurrency: 5,
  },
  doge: {
    decimals: 8,
    // blockcypher free tier: ~3 req/s, 100 req/h per IP
    endpoints: ['https://api.blockcypher.com/v1/doge/main', 'https://api.tatum.io/v3/dogecoin', 'https://api.blockchair.com/dogecoin'],
    concurrency: 1,
    sleepMs: 2000,
  },
  dash: {
    decimals: 8,
    endpoints: ['https://insight.dash.org/insight-api', 'https://api.blockchair.com/dash'],
    concurrency: 5,
  },
  bsv: {
    decimals: 8,
    // whatsonchain throttles aggressively and answers with a body missing `confirmed`
    endpoints: ['https://api.whatsonchain.com/v1/bsv/main'],
    concurrency: 1,
  },
  zcash: {
    decimals: 8,
    // blockchair free tier: ~30 req/min per IP
    endpoints: ['https://api.blockchair.com/zcash'],
    concurrency: 1,
    sleepMs: 5000,
  },
  kaspa: {
    decimals: 8,
    endpoints: ['https://api.kaspa.org'],
    concurrency: 5,
  },
  mvc: {
    decimals: 8,
    endpoints: ['https://mainnet.mvcapi.com'],
    concurrency: 5,
  },
}

export const utxoChains: string[] = Object.keys(CHAINS)

/** mempool.space base url, used for the timestamp -> block lookup (`BITCOIN_MEMPOOL_API`). */
export const DEFAULT_MEMPOOL_API = 'https://mempool.space/api'
/** blockchain.info multiaddr endpoint for bulk bitcoin balances (`BITCOIN_MULTIADDR_API`). */
export const DEFAULT_MULTIADDR_API = 'https://blockchain.info/multiaddr'
/** blockchain.info multiaddr accepts ~100 addresses per call */
export const MULTIADDR_CHUNK_SIZE = 100
/** pause between multiaddr chunks (blockchain.info rate limit), as in the adapters helper */
export const MULTIADDR_SLEEP_MS = 10_000
/** bitcoin cache api accepts up to 700 addresses per call */
export const CACHE_API_CHUNK_SIZE = 700

const DEFAULT_CHAIN = 'bitcoin'
/** UTXO snapshots newer than this are read from `/utxo`, older ones by replaying `/txs` */
const RECENT_WINDOW_SECONDS = 30 * 60

export function isUtxoChain(chain: any): boolean {
  return typeof chain === 'string' && Object.prototype.hasOwnProperty.call(CHAINS, chain)
}

function getConfig(chain: string): UtxoChainConfig {
  const config = CHAINS[chain]
  if (!config) throw new Error(`utxo: unsupported chain "${chain}" (known: ${utxoChains.join(', ')})`)
  return config
}

/** Explorer base urls for `chain`: env `<CHAIN>_EXPLORER_API` wins, then `CHAINS[chain].endpoints`. */
export function getEndpoints({ chain = DEFAULT_CHAIN }: { chain?: string } = {}): string[] {
  const config = getConfig(chain)
  return resolveEndpoints(chain, config.endpoints, { envKey: `${chain.toUpperCase()}_EXPLORER_API` })
}

function limiter(chain: string) {
  return getLimiter(chain.toUpperCase(), getConfig(chain).concurrency)
}

/** Run `fn` under the chain limiter, honouring the chain's `sleepMs` pause. */
async function throttled<T>(chain: string, fn: () => Promise<T>): Promise<T> {
  const { sleepMs } = getConfig(chain)
  return limiter(chain)(async () => {
    if (sleepMs) await sleep(sleepMs)
    return fn()
  })
}

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export type NumLike = string | number | bigint

export interface AddressStats {
  address?: string
  /** confirmed balance in base units */
  confirmed: string
  /** mempool (unconfirmed) delta in base units, may be negative */
  unconfirmed: string
  /** confirmed + unconfirmed */
  total: string
  /** confirmed tx count */
  txCount: number
}

export interface Utxo {
  txid: string
  vout: number
  /** value in base units */
  value: string
  status: { confirmed: boolean, block_height?: number, block_hash?: string, block_time?: number }
}

export interface BlockInfo {
  /** block height */
  number: number
  /** unix timestamp in seconds */
  timestamp: number
  hash: string
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const BECH32_RE = /^(bc1[ac-hj-np-z02-9]{25,87}|BC1[AC-HJ-NP-Z02-9]{25,87})$/
const BASE58_RE = /^[13][1-9A-HJ-NP-Za-km-z]{25,34}$/

/**
 * Basic shape check for a bitcoin mainnet address: bech32 / bech32m (`bc1...`,
 * single case) or base58 P2PKH / P2SH (`1...` / `3...`). No checksum validation.
 */
export function isBitcoinAddress(str: any): boolean {
  if (typeof str !== 'string') return false
  return BECH32_RE.test(str) || BASE58_RE.test(str)
}

/** Coerce integer-like values (decimal / bigint / integer number / integer string) to BigInt. */
export function toBigInt(value: NumLike | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return BigInt(0)
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`utxo.toBigInt: not a finite number: ${value}`)
    return BigInt(Math.trunc(value))
  }
  const s = String(value).trim()
  if (/^-?\d+$/.test(s)) return BigInt(s)
  if (/^-?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) throw new Error(`utxo.toBigInt: cannot parse ${s}`)
    return BigInt(Math.trunc(n))
  }
  throw new Error(`utxo.toBigInt: cannot parse ${s}`)
}

/**
 * Whole-coin amount (`'1.5'`, `1.5`, `'2e-3'`) -> base units as a decimal string,
 * using string arithmetic so 8-decimal values never go through float rounding.
 * Extra fractional digits are truncated.
 */
export function toBaseUnits(value: NumLike, decimals: number): string {
  if (typeof value === 'bigint') return (value * BigInt(10) ** BigInt(decimals)).toString()
  let s = String(value).trim()
  if (s === '') return '0'
  if (/e/i.test(s)) {
    const n = Number(s)
    if (!Number.isFinite(n)) throw new Error(`utxo.toBaseUnits: cannot parse ${value}`)
    s = n.toFixed(Math.min(decimals, 100))
  }
  const match = /^(-)?(\d*)(?:\.(\d*))?$/.exec(s)
  if (!match || (match[2] === '' && (match[3] === undefined || match[3] === ''))) throw new Error(`utxo.toBaseUnits: cannot parse ${value}`)
  const sign = match[1] ? '-' : ''
  const whole = match[2] || '0'
  const fraction = (match[3] || '').slice(0, decimals).padEnd(decimals, '0')
  const raw = BigInt(whole + fraction)
  if (raw === BigInt(0)) return '0'
  return sign + raw.toString()
}

/** Base units -> whole coins as a JS number (`fromBaseUnits('150000000', 8) === 1.5`). */
export function fromBaseUnits(raw: NumLike, decimals: number): number {
  return Number(toBigInt(raw)) / 10 ** decimals
}

/**
 * Parse an esplora `/address/{addr}` response (blockstream, mempool.space,
 * litecoinspace) into base-unit strings. `confirmed` is `chain_stats.funded - spent`,
 * matching the adapters' getBalanceNow and the coins server getBtcBalanceSats.
 */
export function parseBlockstreamAddressStats(json: any): AddressStats {
  const chainStats = json?.chain_stats
  if (!chainStats || chainStats.funded_txo_sum === undefined || chainStats.spent_txo_sum === undefined)
    throw new Error('utxo: malformed esplora address response (missing chain_stats)')
  const mempoolStats = json.mempool_stats ?? {}
  const confirmed = toBigInt(chainStats.funded_txo_sum) - toBigInt(chainStats.spent_txo_sum)
  const unconfirmed = toBigInt(mempoolStats.funded_txo_sum ?? 0) - toBigInt(mempoolStats.spent_txo_sum ?? 0)
  return {
    address: json.address,
    confirmed: confirmed.toString(),
    unconfirmed: unconfirmed.toString(),
    total: (confirmed + unconfirmed).toString(),
    txCount: Number(chainStats.tx_count ?? 0),
  }
}

/**
 * Confirmed balance in base units from any of the supported explorer dialects.
 * Shape detection is ordered so ambiguous `balance` fields (coins vs base units)
 * are only reached for providers that report base units (blockbook v2, kaspa).
 */
export function parseBalanceResponse(json: any, { address, decimals }: { address: string, decimals: number }): string {
  if (json === null || json === undefined || typeof json !== 'object') throw new Error('utxo: empty balance response')
  // esplora: blockstream / mempool.space / litecoinspace
  if (json.chain_stats) return parseBlockstreamAddressStats(json).confirmed
  // blockcypher (`final_balance` includes unconfirmed, `balance` is confirmed only)
  if (json.final_balance !== undefined) return toBigInt(json.balance ?? json.final_balance).toString()
  // insight (dash): `balance` is in coins, `balanceSat` in base units
  if (json.balanceSat !== undefined) return toBigInt(json.balanceSat).toString()
  // whatsonchain (bsv) / mvcapi: `{ confirmed, unconfirmed }` in base units
  if (json.confirmed !== undefined) {
    if (typeof json.confirmed !== 'number' && typeof json.confirmed !== 'string') throw new Error(`utxo: unexpected balance response for ${address}`)
    return toBigInt(json.confirmed).toString()
  }
  // blockchair dashboards
  const blockchair = json.data?.[address]?.address
  if (blockchair && blockchair.balance !== undefined) return toBigInt(blockchair.balance).toString()
  if (json.data && typeof json.data === 'object' && !Array.isArray(json.data) && Object.keys(json.data).length && json.data[address] === null)
    throw new Error(`utxo: blockchair has no data for ${address}`)
  // tatum: `{ incoming, outgoing }` in whole coins
  if (json.incoming !== undefined && json.outgoing !== undefined)
    return (BigInt(toBaseUnits(json.incoming, decimals)) - BigInt(toBaseUnits(json.outgoing, decimals))).toString()
  // blockbook v2 (string sats) / kaspa (`balance` in sompi)
  if (json.balance !== undefined) return toBigInt(json.balance).toString()
  throw new Error(`utxo: unrecognised balance response for ${address}: ${JSON.stringify(json).slice(0, 200)}`)
}

// ---------------------------------------------------------------------------
// providers (explorer dialects)
// ---------------------------------------------------------------------------

type ProviderKind = 'esplora' | 'blockbook' | 'blockcypher' | 'tatum' | 'insight' | 'whatsonchain' | 'blockchair' | 'kaspa' | 'mvc'

interface Provider {
  kind: ProviderKind
  match: RegExp
  balancePath: (address: string) => string
  headers?: () => Record<string, string> | undefined
}

const PROVIDERS: Provider[] = [
  { kind: 'blockchair', match: /blockchair\.com/i, balancePath: (a) => `/dashboards/address/${a}?limit=0` },
  { kind: 'tatum', match: /tatum\.io/i, balancePath: (a) => `/address/balance/${a}`, headers: tatumHeaders },
  { kind: 'blockcypher', match: /blockcypher\.com/i, balancePath: (a) => `/addrs/${a}/balance` },
  { kind: 'insight', match: /insight/i, balancePath: (a) => `/addr/${a}` },
  { kind: 'whatsonchain', match: /whatsonchain\.com/i, balancePath: (a) => `/address/${a}/balance` },
  { kind: 'kaspa', match: /kaspa/i, balancePath: (a) => `/addresses/${encodeURIComponent(a)}/balance` },
  { kind: 'mvc', match: /mvcapi\.com/i, balancePath: (a) => `/address/${a}/balance` },
  { kind: 'blockbook', match: /blockbook/i, balancePath: (a) => `/address/${a}` },
  { kind: 'esplora', match: /blockstream\.info|mempool\.space|litecoinspace\.org/i, balancePath: (a) => `/address/${a}` },
]

function tatumHeaders(): Record<string, string> | undefined {
  const key = getEnvValue('TATUM_API_KEY') ?? getEnvValue('TATUM_PUBLIC_API_KEY')
  if (!key) return undefined
  return { 'x-api-key': key, 'User-Agent': 'Thunder Client (https://www.thunderclient.com)' }
}

/** Provider dialect for an endpoint; unknown hosts use the chain's first default endpoint's dialect. */
function detectProvider(endpoint: string, chain: string): Provider {
  const found = PROVIDERS.find(p => p.match.test(endpoint))
  if (found) return found
  const fallback = PROVIDERS.find(p => p.match.test(getConfig(chain).endpoints[0]))
  return fallback ?? PROVIDERS[PROVIDERS.length - 1]
}

/** Endpoints of `chain` that speak esplora (needed for utxo / tx / block calls). */
function esploraEndpoints(chain: string): string[] {
  const list = getEndpoints({ chain }).filter(e => detectProvider(e, chain).kind === 'esplora')
  if (!list.length) throw new Error(`utxo: no esplora endpoint configured for ${chain} (set ${chain.toUpperCase()}_EXPLORER_API)`)
  return list
}

async function esploraGet(chain: string, path: string, { retries, timeout }: { retries?: number, timeout?: number } = {}): Promise<any> {
  return throttled(chain, () => httpGet(esploraEndpoints(chain), { path, retries, timeout }))
}

// ---------------------------------------------------------------------------
// balances
// ---------------------------------------------------------------------------

export interface GetBalanceOptions {
  chain?: string
  address: string
  /** attempts per endpoint before moving to the next one, default 2 */
  retries?: number
  timeout?: number
}

/**
 * Confirmed balance of `address` in base units. Tries every configured endpoint in
 * order (blockstream -> mempool.space -> blockbook for bitcoin) and throws only
 * when all of them fail.
 */
export async function getBalance({ chain = DEFAULT_CHAIN, address, retries = 2, timeout }: GetBalanceOptions): Promise<string> {
  const { decimals } = getConfig(chain)
  const endpoints = getEndpoints({ chain })
  const errors: string[] = []
  for (const endpoint of endpoints) {
    const provider = detectProvider(endpoint, chain)
    const headers = provider.headers ? provider.headers() : undefined
    if (provider.headers && !headers) {
      debugLog(`[chains.utxo] ${chain}: skipping ${endpoint}, no api key configured (TATUM_API_KEY)`)
      continue
    }
    try {
      const data = await throttled(chain, () => httpGet(endpoint, { path: provider.balancePath(address), headers, retries, timeout }))
      return parseBalanceResponse(data, { address, decimals })
    } catch (e: any) {
      const message = String(e?.message ?? e).slice(0, 200)
      errors.push(`${endpoint}: ${message}`)
      debugLog(`[chains.utxo] ${chain} balance error for ${address} via ${endpoint}: ${message}`)
    }
  }
  throw new Error(`utxo: all explorers failed for ${chain} ${address}: ${errors.join(' | ') || 'no usable endpoint'}`)
}

export interface GetBalancesOptions {
  chain?: string
  addresses: string[]
  /** bitcoin only: skip blockchain.info multiaddr and go per address, default false */
  skipMultiaddr?: boolean
  retries?: number
  timeout?: number
}

/**
 * Confirmed balances of many addresses as `{ [address]: baseUnits }`. Bitcoin
 * batches through blockchain.info `multiaddr` (100 per call, 10s between chunks)
 * and falls back to per-address explorer lookups; other chains go per address
 * under the chain limiter.
 */
export async function getBalances({ chain = DEFAULT_CHAIN, addresses, skipMultiaddr = false, retries, timeout }: GetBalancesOptions): Promise<Record<string, string>> {
  getConfig(chain)
  const unique = uniqueAddresses(addresses)
  if (!unique.length) return {}
  if (chain === 'bitcoin' && !skipMultiaddr && unique.length > 1) {
    try {
      return await getBitcoinBalancesMultiaddr({ addresses: unique })
    } catch (e: any) {
      debugLog(`[chains.utxo] bitcoin multiaddr failed, falling back to per-address lookups: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
  const res: Record<string, string> = {}
  await Promise.all(unique.map(async (address) => {
    res[address] = await getBalance({ chain, address, retries, timeout })
  }))
  return res
}

/** blockchain.info `multiaddr` base url (`BITCOIN_MULTIADDR_API` overrides). */
export function getMultiaddrEndpoints(): string[] {
  return resolveEndpoints('bitcoin', DEFAULT_MULTIADDR_API, { envKey: 'BITCOIN_MULTIADDR_API' })
}

/**
 * Bitcoin balances via blockchain.info `multiaddr?active=a|b|c` in chunks of 100.
 * `final_balance` includes unconfirmed outputs, as in the adapters helper.
 */
export async function getBitcoinBalancesMultiaddr({ addresses, chunkSize = MULTIADDR_CHUNK_SIZE, sleepMs = MULTIADDR_SLEEP_MS }: { addresses: string[], chunkSize?: number, sleepMs?: number }): Promise<Record<string, string>> {
  const unique = uniqueAddresses(addresses)
  const res: Record<string, string> = {}
  const endpoints = getMultiaddrEndpoints()
  await runInChunks(unique, async (chunk) => {
    const data = await httpGet(endpoints, { params: { active: chunk.join('|') } })
    if (!Array.isArray(data?.addresses)) throw new Error('utxo: malformed multiaddr response')
    for (const entry of data.addresses) res[entry.address] = toBigInt(entry.final_balance).toString()
    const missing = chunk.filter(a => res[a] === undefined)
    if (missing.length) throw new Error(`utxo: multiaddr returned no balance for ${missing.length} address(es): ${missing.slice(0, 3).join(', ')}`)
    return []
  }, { chunkSize, concurrency: 1, sleepTime: sleepMs })
  return res
}

/** `BITCOIN_CACHE_API` url when configured (bulk bitcoin balance cache used by the adapters). */
export function getBitcoinCacheApi(): string | undefined {
  return getEnvValue('BITCOIN_CACHE_API')
}

/**
 * Sum of bitcoin balances via the `BITCOIN_CACHE_API` bulk endpoint
 * (`POST { addresses, network: 'BTC' }` -> total sats, 700 addresses per call),
 * mirroring getCachedBitcoinBalances in the adapters. Throws when the env is not set.
 */
export async function getCachedBitcoinTotal({ addresses, chunkSize = CACHE_API_CHUNK_SIZE }: { addresses: string[], chunkSize?: number }): Promise<string> {
  const cacheApi = getBitcoinCacheApi()
  if (!cacheApi) throw new Error('utxo: BITCOIN_CACHE_API is not set')
  const unique = uniqueAddresses(addresses)
  const chunks = sliceIntoChunks(unique, chunkSize)
  debugLog(`[chains.utxo] bitcoin cache api call: ${unique.length} addresses, ${chunks.length} chunk(s)`)
  let sum = BigInt(0)
  for (const chunk of chunks) {
    const res = await httpPost(cacheApi, { addresses: chunk, network: 'BTC' }, { retries: 3 })
    const value = typeof res === 'object' && res !== null ? (res.balance ?? res.total ?? res.result) : res
    sum += toBigInt(value)
  }
  return sum.toString()
}

export interface GetTotalBalanceOptions extends GetBalancesOptions {
  /** bitcoin only: use `BITCOIN_CACHE_API` when set and there are more than this many addresses, default 51 */
  cacheThreshold?: number
  /** bitcoin only: throw instead of falling back when the cache api fails, default false (forced above 1000 addresses) */
  forceCacheUse?: boolean
}

/**
 * Sum of confirmed balances in base units. For bitcoin with `BITCOIN_CACHE_API`
 * set and more than `cacheThreshold` addresses the bulk cache is used first
 * (the adapters' `_sumTokensBlockchain` flow), then `getBalances` is summed.
 */
export async function getTotalBalance({ chain = DEFAULT_CHAIN, addresses, cacheThreshold = 51, forceCacheUse = false, ...rest }: GetTotalBalanceOptions): Promise<string> {
  const unique = uniqueAddresses(addresses)
  if (chain === 'bitcoin' && getBitcoinCacheApi() && unique.length > cacheThreshold) {
    if (unique.length > 1000) forceCacheUse = true
    try {
      return await getCachedBitcoinTotal({ addresses: unique })
    } catch (e: any) {
      if (forceCacheUse) throw e
      debugLog(`[chains.utxo] bitcoin cache error, falling back to explorers: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
  const balances = await getBalances({ chain, addresses: unique, ...rest })
  let sum = BigInt(0)
  for (const value of Object.values(balances)) sum += toBigInt(value)
  return sum.toString()
}

// ---------------------------------------------------------------------------
// esplora: utxos, txs, historical balance
// ---------------------------------------------------------------------------

/**
 * Unspent outputs of `address` (`/address/{addr}/utxo`), values as base-unit strings.
 * Blockstream answers 400 "Too many unspent outputs" for very large utxo sets
 * (e.g. the genesis address); use `getBalance` for those.
 */
export async function getUtxos({ chain = DEFAULT_CHAIN, address }: { chain?: string, address: string }): Promise<Utxo[]> {
  const utxos = await esploraGet(chain, `/address/${address}/utxo`)
  if (!Array.isArray(utxos)) throw new Error(`utxo: malformed utxo response for ${address}`)
  return utxos.map((u: any) => ({ txid: u.txid, vout: u.vout, value: toBigInt(u.value).toString(), status: u.status ?? { confirmed: false } }))
}

/**
 * One page of transactions for `address`: `/address/{addr}/txs` (up to 25 mempool
 * + 25 confirmed) or, with `lastSeenTxid`, `/address/{addr}/txs/chain/{txid}`
 * (next 25 confirmed). An empty array means no more pages.
 */
export async function getAddressTxs({ chain = DEFAULT_CHAIN, address, lastSeenTxid }: { chain?: string, address: string, lastSeenTxid?: string }): Promise<any[]> {
  const path = lastSeenTxid ? `/address/${address}/txs/chain/${lastSeenTxid}` : `/address/${address}/txs`
  const txs = await esploraGet(chain, path)
  if (!Array.isArray(txs)) throw new Error(`utxo: malformed txs response for ${address}`)
  return txs
}

/**
 * Bitcoin balance of `address` at `timestamp` (unix seconds) in base units, ported
 * from the adapters' archive getBalance: for timestamps within the last 30 minutes
 * the current utxo set is filtered by `block_time`; otherwise every confirmed tx is
 * replayed (vout adds, vin.prevout subtracts) until the page list is exhausted.
 * Unconfirmed txs (no `block_time`) are ignored.
 */
export async function getBitcoinBalanceAt({ chain = DEFAULT_CHAIN, address, timestamp, maxPages }: { chain?: string, address: string, timestamp: number, maxPages?: number }): Promise<string> {
  const now = Date.now() / 1e3
  let balance = BigInt(0)
  if (timestamp > now - RECENT_WINDOW_SECONDS) {
    const utxos = await getUtxos({ chain, address })
    for (const utxo of utxos) {
      const blockTime = utxo.status?.block_time
      if (blockTime !== undefined && blockTime <= timestamp) balance += BigInt(utxo.value)
    }
    return balance.toString()
  }
  let txs = await getAddressTxs({ chain, address })
  let page = 0
  while (txs.length) {
    for (const tx of txs) {
      const blockTime = tx.status?.block_time
      if (blockTime === undefined || blockTime > timestamp) continue
      for (const vin of tx.vin ?? [])
        if (vin.prevout?.scriptpubkey_address === address) balance -= toBigInt(vin.prevout.value)
      for (const vout of tx.vout ?? [])
        if (vout.scriptpubkey_address === address) balance += toBigInt(vout.value)
    }
    page++
    if (maxPages !== undefined && page >= maxPages) {
      debugLog(`[chains.utxo] getBitcoinBalanceAt ${address}: stopped after ${maxPages} pages`)
      break
    }
    txs = await getAddressTxs({ chain, address, lastSeenTxid: txs[txs.length - 1].txid })
  }
  return balance.toString()
}

// ---------------------------------------------------------------------------
// esplora: blocks
// ---------------------------------------------------------------------------

async function getBlockByHeight(chain: string, height: number): Promise<BlockInfo> {
  const hash = String(await esploraGet(chain, `/block-height/${height}`)).trim()
  if (!/^[0-9a-f]{64}$/i.test(hash)) throw new Error(`utxo: no block hash for ${chain} height ${height}`)
  const block = await esploraGet(chain, `/block/${hash}`)
  return { number: Number(block.height ?? height), timestamp: Number(block.timestamp), hash }
}

/** Chain tip via `/blocks/tip/height` + `/block-height/{h}` + `/block/{hash}`. */
export async function getLatestBlock({ chain = DEFAULT_CHAIN }: { chain?: string } = {}): Promise<BlockInfo> {
  const height = Number(await esploraGet(chain, '/blocks/tip/height'))
  if (!Number.isFinite(height)) throw new Error(`utxo: malformed tip height for ${chain}`)
  return getBlockByHeight(chain, height)
}

/** Block by height (`/block-height/{h}` then `/block/{hash}`). */
export async function getBlock({ chain = DEFAULT_CHAIN, height }: { chain?: string, height: number }): Promise<BlockInfo> {
  return getBlockByHeight(chain, height)
}

/** mempool.space base urls (`BITCOIN_MEMPOOL_API` overrides; falls back to any configured mempool endpoint). */
export function getMempoolEndpoints(): string[] {
  const configured = getEndpoints({ chain: 'bitcoin' }).filter(e => /mempool/i.test(e))
  return resolveEndpoints('bitcoin', configured.length ? configured : DEFAULT_MEMPOOL_API, { envKey: 'BITCOIN_MEMPOOL_API' })
}

/**
 * Latest block mined at or before `timestamp` (unix seconds). Bitcoin asks
 * mempool.space `/v1/mining/blocks/timestamp/{ts}` first (then walks back if the
 * returned block is newer than `timestamp`); otherwise / on failure a binary
 * search over `/block-height/{h}` is used.
 */
export async function getBlockAtTimestamp({ chain = DEFAULT_CHAIN, timestamp }: { chain?: string, timestamp: number }): Promise<BlockInfo> {
  timestamp = Math.floor(timestamp > 1e12 ? timestamp / 1000 : timestamp)
  if (chain === 'bitcoin') {
    try {
      const res = await throttled(chain, () => httpGet(getMempoolEndpoints(), { path: `/v1/mining/blocks/timestamp/${timestamp}` }))
      const height = Number(res?.height)
      if (!Number.isFinite(height)) throw new Error('malformed mempool response')
      let block = await getBlockByHeight(chain, height)
      // mempool returns the closest block, which may be just after the timestamp
      while (block.timestamp > timestamp && block.number > 0) block = await getBlockByHeight(chain, block.number - 1)
      return block
    } catch (e: any) {
      debugLog(`[chains.utxo] mempool timestamp lookup failed, falling back to binary search: ${String(e?.message ?? e).slice(0, 200)}`)
    }
  }
  const tip = await getLatestBlock({ chain })
  if (tip.timestamp <= timestamp) return tip
  let lo = 0
  let hi = tip.number
  let best: BlockInfo | undefined
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const block = await getBlockByHeight(chain, mid)
    if (block.timestamp <= timestamp) {
      best = block
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (!best) throw new Error(`utxo: no ${chain} block at or before ${timestamp}`)
  return best
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

function uniqueAddresses(addresses: string[]): string[] {
  const seen = new Set<string>()
  const res: string[] = []
  for (const address of addresses ?? []) {
    if (typeof address !== 'string') continue
    const trimmed = address.trim()
    if (!trimmed || seen.has(trimmed)) continue
    seen.add(trimmed)
    res.push(trimmed)
  }
  return res
}
