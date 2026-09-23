/**
 * Cosmos-SDK LCD/REST client for every IBC chain (cosmos hub, osmosis, terra,
 * neutron, injective, sei, kava, ...). Raw values only: no token maps, no
 * balance sheets, no TVL coupling.
 *
 * Replaces / consolidates:
 *  - sdk/src/util/cosmos.ts (endpoint map, isCosmosChain, getCosmosBlock,
 *    getCosmosProvider - re-exported from there for backwards compat)
 *  - DefiLlama-Adapters/projects/helper/chain/cosmos.js (endPoints, chainSubpaths,
 *    highGasLimitEndpoints, multipleEndpoints, getEndpoint, query, queryV1Beta1,
 *    queryV1Beta1V2, getTokenBalance, getBalance, getDenomBalance, getBalance2,
 *    totalSupply, lpMinter, queryContract, queryContractWithRetries,
 *    queryManyContracts, queryContracts, queryContractStore)
 *  - peggedassets-server/src/adapters/peggedAssets/helper/getSupply.ts
 *    (cosmosEndpoints, cosmosSupply / osmosisSupply -> totalSupply)
 *  - server/defi/l2/utils.ts (provenance block time lookups,
 *    getProvenanceHeightForTimestamp -> getBlock / getBlockAtTimestamp,
 *    x-cosmos-block-height header usage)
 *  - server/coins/src/getBlock.ts (cosmosBlockProvider -> getCosmosProvider)
 *  - dimension-adapters/helpers/cosmosChainFees.ts (tendermint `status` / `block`
 *    JSON-RPC shape -> `tendermint` sub-API)
 *
 * Endpoint resolution (LCD / REST), first non-empty wins, comma separated values
 * are a fallback list rotated on failure:
 *  1. env `<CHAIN>_LCD` (also `SDK_<CHAIN>_LCD` / `LLAMA_SDK_<CHAIN>_LCD`)
 *  2. env `<CHAIN>_RPC` - ONLY when the chain is not an EVM chain. Chains such as
 *     kava, cronos, evmos, sei or injective use `<CHAIN>_RPC` for their EVM
 *     JSON-RPC, so it is never treated as an LCD url for them (backwards compat
 *     with the old util/cosmos.ts which honoured `<CHAIN>_RPC` for everything).
 *  3. `DEFAULT_ENDPOINTS[chain]`
 *  4. `https://rest.cosmos.directory/<chain>`
 *
 * Tendermint JSON-RPC (`tendermint.*`): env `<CHAIN>_TENDERMINT_RPC`, then
 * `https://rpc.cosmos.directory/<chain>`.
 *
 * Historical queries pass the height through the `x-cosmos-block-height` header
 * (the legacy `?height=` query param is not used anymore).
 */
import pLimit from "p-limit";
import { getEnvRPC, getEnvValue } from "../util/env";
import { isEvmChain } from "../util/LlamaProvider";
import { debugLog } from "../util/debugLog";
import { Endpoints, getEndpoints as resolveEndpoints, httpGet, jsonRpc, toEndpointList, isRetryableError } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

// where to find chain info
// https://wiki.f5nodes.com/quicksilver/endpoints/
// https://proxy.atomscan.com/chains.json
// https://cosmos-chain.directory/chains
// https://celestia.publicnode.com/
// https://api.axelarscan.io/api/getTVL
/** Default LCD endpoints. Comma separated values are fallbacks, tried in order. */
export const DEFAULT_ENDPOINTS: Record<string, string> = {
  crescent: "https://rest.cosmos.directory/crescent,https://mainnet.crescent.network:1317",
  osmosis: "https://rest-osmosis.ecostake.com,https://osmosis-api.polkachu.com,https://rest.cosmos.directory/osmosis",
  cosmos: "https://cosmos-api.polkachu.com,https://cosmoshub-lcd.stakely.io,https://rest.cosmos.directory/cosmoshub",
  kujira: "https://rest.cosmos.directory/kujira,https://kuji-api.kleomedes.network",
  comdex: "https://rest.cosmos.directory/comdex,https://rest.comdex.one",
  terra: "https://terra-classic-lcd.publicnode.com",
  terra2: "https://terra-lcd.publicnode.com",
  umee: "https://umee-api.polkachu.com",
  orai: "https://lcd.orai.io",
  juno: "https://juno.api.m.stavr.tech",
  cronos: "https://rest.mainnet.crypto.org",
  chihuahua: "https://rest.cosmos.directory/chihuahua",
  stargaze: "https://rest.stargaze-apis.com",
  quicksilver: "https://quicksilver.api.m.anode.team,https://rest.cosmos.directory/quicksilver",
  persistence: "https://rest.cosmos.directory/persistence",
  secret: "https://lcd-secret.keplr.app,https://lcd.secret.express",
  injective: "https://injective-rest.publicnode.com,https://sentry.lcd.injective.network:443",
  migaloo: "https://migaloo-api.polkachu.com",
  fxcore: "https://fx-rest.functionx.io",
  xpla: "https://dimension-lcd.xpla.dev",
  kava: "https://api2.kava.io",
  akash: "https://rest.cosmos.directory/akash",
  neutron: "https://neutron-rest.publicnode.com,https://rest-kralum.neutron-1.neutron.org",
  quasar: "https://quasar-api.polkachu.com",
  gravitybridge: "https://gravity-api.polkachu.com,https://gravitychain.io:1317",
  sei: "https://rest.sei-apis.com,https://sei-api.polkachu.com,https://sei-rest.publicnode.com,https://sei-rest.brocha.in,https://sei-m.api.n0ok.net,https://sei-api.lavenderfive.com,https://api-sei.stingray.plus",
  aura: "https://rest.cosmos.directory/aura,https://lcd.aura.network",
  archway: "https://api.mainnet.archway.io",
  sifchain: "https://sifchain-api.polkachu.com",
  nolus: "https://lcd.nolus.network,https://pirin-cl.nolus.network:1317",
  nibiru: "https://lcd.nibiru.fi",
  bostrom: "https://lcd.bostrom.cybernode.ai",
  joltify: "https://lcd.joltify.io",
  milkyway: "https://lcd.mainnet.milkyway.zone:443",
  kopi: "https://rest.kopi.money",
  noble: "https://noble-api.polkachu.com",
  mantra: "https://api.mantrachain.io",
  elys: "https://api.elys.network", // https://api.elys.network/#/Query/ElysAmmPoolAll
  pryzm: "https://api.pryzm.zone",
  agoric: "https://agoric-api.polkachu.com",
  allora: "https://allora-api.polkachu.com",
  band: "https://laozi1.bandchain.org/api",
  celestia: "https://celestia-rest.publicnode.com",
  dydx: "https://dydx-rest.publicnode.com",
  dungeon: "https://api.dungeongames.io",
  carbon: "https://api.carbon.network",
  evmos: "https://evmos-api.polkachu.com",
  fetchhub: "https://rest-fetchhub.fetch.ai",
  regen: "https://rest-regen.ecostake.com",
  sommelier: "https://rest.cosmos.directory/sommelier",
  stride: "https://stride-api.polkachu.com",
  babylon: "https://babylon-api.polkachu.com",
  milkyway_rollup: "https://archival-rest-moo-1.anvil.asia-southeast.initia.xyz",
  titan: "https://titan-lcd.titanlab.io",
  provenance: "https://api.provenance.io",
  xion: "https://api.xion-mainnet-1.burnt.com",
  embr: "https://rest-embrmainnet-1.anvil.asia-southeast.initia.xyz",
  civitia: "https://rest-civitia-1.anvil.asia-southeast.initia.xyz",
  echelon_initia: "https://rest-echelon-1.anvil.asia-southeast.initia.xyz",
  inertia: "https://rest.inrt.fi",
  union: "https://rest.union.build",
  zigchain: "https://public-zigchain-lcd.numia.xyz",
  axiome: "http://api-docs.axiomeinfo.org:1317",
}

/**
 * Module-specific REST prefix used by `queryV1Beta1` (e.g. `/osmosis/gamm/...`,
 * `/kava/hard/...`). Standard sdk modules (bank, staking, ...) always live under
 * `/cosmos/`, use `query` / `getBalances` / `totalSupply` for those.
 */
export const chainSubpaths: Record<string, string> = {
  crescent: "crescent",
  osmosis: "osmosis",
  provenance: "provenance",
  comdex: "comdex",
  umee: "umee",
  kava: "kava",
  joltify: "joltify",
}

/** Some contract calls need an endpoint with a higher gas limit. contract address -> endpoint */
export const highGasLimitEndpoints: Record<string, string> = {
  // 'sei1xr3rq8yvd7qplsw5yx90ftsr2zdhg4e9z60h5duusgxpv72hud3shh3qfl': "https://rest.sei-apis.com",
}

/**
 * Cosmos chains that also expose an EVM JSON-RPC. For these `<CHAIN>_RPC` is the
 * EVM url and is never used as LCD, and `isCosmosChain` stays false so block
 * lookups keep going through the EVM provider (same as before this module).
 */
export const EVM_COSMOS_CHAINS = ['kava', 'cronos', 'evmos', 'sei', 'aura', 'nibiru', 'dungeon', 'titan']

/**
 * Chains always treated as cosmos chains by `isCosmosChain` (legacy list from
 * util/cosmos.ts plus the pure cosmos chains of the adapters map).
 */
export const ibcChains = [
  'terra', 'terra2', 'crescent', 'osmosis', 'kujira', 'stargaze', 'juno', 'injective', 'cosmos', 'comdex', 'umee', 'orai',
  'persistence', 'fxcore', 'neutron', 'quasar', 'chihuahua', 'archway', 'migaloo', 'secret', 'xpla', 'bostrom',
  'akash', 'noble', 'celestia', 'dydx', 'stride', 'mantra', 'elys', 'pryzm', 'agoric', 'band', 'carbon', 'regen', 'sommelier', 'babylon', 'xion', 'union', 'zigchain', 'provenance', 'nolus', 'joltify', 'milkyway', 'quicksilver', 'gravitybridge', 'sifchain', 'kopi', 'allora', 'fetchhub',
]

/** bech32 human readable prefix per chain (falls back to the chain name) */
export const BECH32_PREFIXES: Record<string, string> = {
  cosmos: 'cosmos', osmosis: 'osmo', terra: 'terra', terra2: 'terra', injective: 'inj', secret: 'secret', neutron: 'neutron',
  kujira: 'kujira', sei: 'sei', stargaze: 'stars', juno: 'juno', archway: 'archway', migaloo: 'migaloo', xpla: 'xpla', orai: 'orai',
  persistence: 'persistence', chihuahua: 'chihuahua', comdex: 'comdex', umee: 'umee', crescent: 'cre', quasar: 'quasar', nolus: 'nolus',
  bostrom: 'bostrom', fxcore: 'fx', kava: 'kava', cronos: 'cro', evmos: 'evmos', akash: 'akash', gravitybridge: 'gravity', sifchain: 'sif',
  nibiru: 'nibi', joltify: 'jolt', milkyway: 'milk', noble: 'noble', mantra: 'mantra', elys: 'elys', pryzm: 'pryzm', agoric: 'agoric',
  band: 'band', celestia: 'celestia', dydx: 'dydx', carbon: 'swth', fetchhub: 'fetch', regen: 'regen', sommelier: 'somm', stride: 'stride',
  babylon: 'bbn', provenance: 'pb', xion: 'xion', quicksilver: 'quick', union: 'union', zigchain: 'zig', aura: 'aura', kopi: 'kopi',
  allora: 'allo', dungeon: 'dungeon', titan: 'titan', axiome: 'axm', inertia: 'init', embr: 'init', civitia: 'init', echelon_initia: 'init', milkyway_rollup: 'init',
}

const COSMOS_DIRECTORY_REST = 'https://rest.cosmos.directory'
const COSMOS_DIRECTORY_RPC = 'https://rpc.cosmos.directory'
const MAX_PAGES = 1000

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

function isEvmLikeChain(chain: string) {
  return EVM_COSMOS_CHAINS.includes(chain) || isEvmChain(chain)
}

export const isCosmosChain = (chain: string) => ibcChains.includes(chain) || (!!DEFAULT_ENDPOINTS[chain] && !isEvmLikeChain(chain))

/** Resolve the LCD endpoint list for a chain, see the module header for the order. */
export function getEndpoints({ chain }: { chain: string }): string[] {
  if (!chain) throw new Error('cosmos.getEndpoints: chain is required')
  const envKey = `${chain.toUpperCase()}_LCD`
  const fromLcdEnv = toEndpointList(getEnvValue(envKey))
  if (fromLcdEnv.length) return fromLcdEnv
  if (!isEvmLikeChain(chain)) {
    const fromRpcEnv = toEndpointList(getEnvRPC(chain))
    if (fromRpcEnv.length) return fromRpcEnv
  }
  return resolveEndpoints(chain, DEFAULT_ENDPOINTS[chain], { envKey, fallback: `${COSMOS_DIRECTORY_REST}/${chain}` })
}

/** First LCD endpoint. `contract` switches to a high gas limit endpoint when one is configured for it. */
export function getEndpoint({ chain, contract }: { chain: string, contract?: string }): string {
  if (contract && highGasLimitEndpoints[contract]) return highGasLimitEndpoints[contract]
  return getEndpoints({ chain })[0]
}

function resolveQueryEndpoints({ chain, contract, endpoint }: { chain: string, contract?: string, endpoint?: Endpoints }): string[] {
  const explicit = toEndpointList(endpoint)
  if (explicit.length) return explicit
  if (contract && highGasLimitEndpoints[contract]) return [highGasLimitEndpoints[contract]]
  return getEndpoints({ chain })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** base64 encode a cosmwasm query message (objects are JSON.stringified first) */
export function encodeQuery(data: any): string {
  const str = typeof data === 'string' ? data : JSON.stringify(data)
  return Buffer.from(str).toString('base64')
}

/**
 * Heuristic: cosmwasm contract addresses are 32 byte bech32 strings (~63 chars)
 * while accounts are 20 bytes (~43 chars).
 */
export function isContractAddress(chain: string, address: string): boolean {
  if (typeof address !== 'string' || address.length <= 50) return false
  const prefix = BECH32_PREFIXES[chain] ?? chain
  const re = new RegExp(`^${prefix}1[02-9ac-hj-np-z]{38,}$`)
  return re.test(address)
}

function blockHeaders(block?: number | string): Record<string, string> | undefined {
  if (block === undefined || block === null || block === 'latest') return undefined
  return { 'x-cosmos-block-height': String(block) }
}

function withQuery(path: string, params: Record<string, any> = {}): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null)
  if (!entries.length) return path
  const qs = entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')
  return path + (path.includes('?') ? '&' : '?') + qs
}

/** Cosmos block times carry nanosecond precision; trim to millis before parsing. */
export function parseBlockTime(iso: string): number {
  return Math.floor(Date.parse(String(iso).replace(/(\.\d{3})\d+/, '$1')) / 1000)
}

function isPrunedHeightError(e: any): boolean {
  const status = e?.response?.status ?? e?.status
  const message = String(e?.response?.data?.message ?? e?.message ?? e ?? '').toLowerCase()
  if (status === 404) return true
  return /not available|lowest height|pruned|height .* is not|not found|must be less than or equal to the current blockchain height|is greater than/.test(message)
}

// ---------------------------------------------------------------------------
// generic queries
// ---------------------------------------------------------------------------

export interface QueryOptions {
  chain: string
  /** path relative to the LCD root, e.g. `cosmos/bank/v1beta1/supply` */
  path: string
  /** height for historical state, sent as `x-cosmos-block-height` */
  block?: number | string
  /** query string params */
  params?: Record<string, any>
  /** explicit endpoint(s), overrides chain resolution */
  endpoint?: Endpoints
  /** used to pick a high gas limit endpoint */
  contract?: string
  timeout?: number
  retries?: number
}

/** GET `<lcd>/<path>`; rotates over the chain endpoints on failure. Returns the raw JSON body. */
export async function query({ chain, path, block, params, endpoint, contract, timeout, retries }: QueryOptions): Promise<any> {
  const endpoints = resolveQueryEndpoints({ chain, contract, endpoint })
  const fullPath = withQuery(path, params)
  const headers = blockHeaders(block)
  const options: any = { path: fullPath, label: `${chain} GET ${path.split('?')[0].slice(0, 80)}` }
  if (headers) options.headers = headers
  if (timeout !== undefined) options.timeout = timeout
  if (retries !== undefined) options.retries = retries
  return httpGet(endpoints, options)
}

/**
 * GET `<lcd>/<subpath>/<url>` where subpath is `chainSubpaths[chain]` or `cosmos`
 * (module specific queries such as `gamm/v1beta1/pools` on osmosis).
 */
export async function queryV1Beta1({ chain, url, block, paginationKey, subpath, endpoint }: { chain: string, url: string, block?: number | string, paginationKey?: string, subpath?: string, endpoint?: Endpoints }): Promise<any> {
  const prefix = subpath ?? chainSubpaths[chain] ?? 'cosmos'
  const path = withQuery(`${prefix}/${url.replace(/^\/+/, '')}`, paginationKey ? { 'pagination.key': paginationKey } : {})
  return query({ chain, path, block, endpoint })
}

/**
 * Follow `pagination.next_key` over `path` and return the concatenated `dataKey`
 * items. When `dataKey` is omitted the first array field of the response is used.
 */
export async function paginate({ chain, path, dataKey, limit = 100, block, endpoint }: { chain: string, path: string, dataKey?: string, limit?: number, block?: number | string, endpoint?: Endpoints }): Promise<any[]> {
  const pagedPath = withQuery(path, { 'pagination.limit': limit })
  let res = await query({ chain, path: pagedPath, block, endpoint })
  if (!dataKey) {
    dataKey = Object.keys(res ?? {}).find(k => k !== 'pagination' && Array.isArray(res[k]))
    if (!dataKey) throw new Error(`cosmos.paginate: no array field in response. Keys: ${Object.keys(res ?? {}).join(', ')}`)
  }
  let items: any[] = res[dataKey] ?? []
  let nextKey = res.pagination?.next_key
  let pages = 1
  while (nextKey) {
    if (++pages > MAX_PAGES) throw new Error(`cosmos.paginate: pagination exceeded ${MAX_PAGES} pages`)
    res = await query({ chain, path: withQuery(pagedPath, { 'pagination.key': nextKey }), block, endpoint })
    items = items.concat(res[dataKey] ?? [])
    nextKey = res.pagination?.next_key
  }
  return items
}

/** Auto-paginating `queryV1Beta1`; returns the concatenated `dataKey` items. */
export async function queryV1Beta1All({ chain, url, dataKey, limit = 100, block, subpath, endpoint }: { chain: string, url: string, dataKey?: string, limit?: number, block?: number | string, subpath?: string, endpoint?: Endpoints }): Promise<any[]> {
  const prefix = subpath ?? chainSubpaths[chain] ?? 'cosmos'
  return paginate({ chain, path: `${prefix}/${url.replace(/^\/+/, '')}`, dataKey, limit, block, endpoint })
}

// ---------------------------------------------------------------------------
// bank
// ---------------------------------------------------------------------------

export interface Coin { denom: string, amount: string }

/** All native balances of `owner` (every page). */
export async function getBalances({ chain, owner, block }: { chain: string, owner: string, block?: number | string }): Promise<Coin[]> {
  return paginate({ chain, path: `cosmos/bank/v1beta1/balances/${owner}`, dataKey: 'balances', limit: 1000, block })
}

/** Native balance of one denom, `"0"` when the account does not hold it. */
export async function getDenomBalance({ chain, denom, owner, block }: { chain: string, denom: string, owner: string, block?: number | string }): Promise<string> {
  try {
    const res = await query({ chain, path: `cosmos/bank/v1beta1/balances/${owner}/by_denom`, params: { denom }, block, retries: 1 })
    if (res?.balance?.amount !== undefined) return String(res.balance.amount)
  } catch (e) {
    debugLog(`[chains.cosmos] ${chain} by_denom failed for ${owner}, falling back to full balance list: ${(e as any)?.message ?? e}`)
  }
  const balances = await getBalances({ chain, owner, block })
  const found = balances.find(i => i.denom === denom)
  return found ? String(found.amount) : '0'
}

/** Balance of a cw20 contract (`token` looks like a contract address) or a native denom. */
export async function getBalance({ chain, token, owner, block }: { chain: string, token: string, owner: string, block?: number | string }): Promise<string> {
  if (isContractAddress(chain, token)) {
    const data = await queryContract({ chain, contract: token, data: { balance: { address: owner } }, block })
    return String(data?.balance ?? '0')
  }
  return getDenomBalance({ chain, denom: token, owner, block })
}

/** Balance for an astroport style asset info (`{ native_token: { denom } }` / `{ token: { contract_addr } }`) or a plain string. */
export async function getTokenBalance({ chain, token, owner, block }: { chain: string, token: any, owner: string, block?: number | string }): Promise<string> {
  const denomOrContract = typeof token === 'string' ? token : (token?.native_token?.denom ?? token?.token?.contract_addr)
  if (!denomOrContract) throw new Error(`cosmos.getTokenBalance: unrecognised token ${JSON.stringify(token)}`)
  return getBalance({ chain, token: denomOrContract, owner, block })
}

/** Total supply of a native denom via `bank/v1beta1/supply/by_denom`. */
export async function totalSupply({ chain, denom, block }: { chain: string, denom: string, block?: number | string }): Promise<string> {
  const res = await query({ chain, path: 'cosmos/bank/v1beta1/supply/by_denom', params: { denom }, block })
  const amount = res?.amount?.amount
  if (amount === undefined) throw new Error(`cosmos.totalSupply: no amount in response for ${chain} ${denom}`)
  return String(amount)
}

/** Total supply of every denom (all pages). */
export async function getSupplyAll({ chain, block }: { chain: string, block?: number | string }): Promise<Coin[]> {
  return paginate({ chain, path: 'cosmos/bank/v1beta1/supply', dataKey: 'supply', limit: 1000, block })
}

// ---------------------------------------------------------------------------
// cosmwasm
// ---------------------------------------------------------------------------

/** cosmwasm smart query; `data` is the query message (object or JSON string). Returns the `data` field. */
export async function queryContract({ chain, contract, data, block, endpoint }: { chain: string, contract: string, data: any, block?: number | string, endpoint?: Endpoints }): Promise<any> {
  const res = await query({ chain, contract, endpoint, block, path: `cosmwasm/wasm/v1/contract/${contract}/smart/${encodeQuery(data)}` })
  return res?.data
}

/** Same as `queryContract`; every configured endpoint is tried before giving up. */
export async function queryContractWithRetries({ chain, contract, data, block }: { chain: string, contract: string, data: any, block?: number | string }): Promise<any> {
  const endpoints = getEndpoints({ chain })
  let lastError: any
  for (const endpoint of endpoints) {
    try {
      return await queryContract({ chain, contract, data, block, endpoint })
    } catch (e) {
      lastError = e
      debugLog(`[chains.cosmos] ${chain} queryContract ${contract} failed on ${endpoint}: ${(e as any)?.message ?? e}`)
    }
  }
  throw lastError
}

/** Run the same smart query against many contracts. Results keep the input order; failures resolve to `undefined` when `permitFailure` is set. */
export async function queryManyContracts({ chain, contracts, data, block, permitFailure = false, concurrency = 25 }: { chain: string, contracts: string[], data: any, block?: number | string, permitFailure?: boolean, concurrency?: number }): Promise<any[]> {
  const limit = pLimit(Math.max(1, concurrency))
  return Promise.all(contracts.map(contract => limit(async () => {
    try {
      return await queryContract({ chain, contract, data, block })
    } catch (e) {
      if (permitFailure) return undefined
      throw e
    }
  })))
}

/** All contract addresses instantiated from `codeId` (all pages). */
export async function queryContracts({ chain, codeId, limit = 100 }: { chain: string, codeId: number | string, limit?: number }): Promise<string[]> {
  return paginate({ chain, path: `cosmwasm/wasm/v1/code/${codeId}/contracts`, dataKey: 'contracts', limit })
}

/** Legacy (terra classic) `/wasm/contracts/{contract}/store?query_msg=` query. Returns the `result` field. */
export async function queryContractStore({ chain, contract, queryParam, block }: { chain: string, contract: string, queryParam: any, block?: number | string }): Promise<any> {
  const msg = typeof queryParam === 'string' ? queryParam : JSON.stringify(queryParam)
  const res = await query({ chain, contract, block, path: `wasm/contracts/${contract}/store`, params: { query_msg: msg } })
  return res?.result
}

/** `/cosmwasm/wasm/v1/contract/{contract}` -> `contract_info` (code_id, creator, admin, label, ...). */
export async function getContractInfo({ chain, contract }: { chain: string, contract: string }): Promise<any> {
  const res = await query({ chain, contract, path: `cosmwasm/wasm/v1/contract/${contract}` })
  return res?.contract_info ?? res
}

/** cw20 `token_info` -> { name, symbol, decimals, total_supply } */
export async function getTokenInfo({ chain, contract, block }: { chain: string, contract: string, block?: number | string }): Promise<{ name: string, symbol: string, decimals: number, total_supply: string }> {
  return queryContract({ chain, contract, data: { token_info: {} }, block })
}

/** cw20 `minter` -> minter address (the pair contract for LP tokens) */
export async function getLpMinter({ chain, token, block }: { chain: string, token: string, block?: number | string }): Promise<string> {
  const data = await queryContract({ chain, contract: token, data: { minter: {} }, block })
  return data?.minter
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

export interface CosmosBlock { number: number, timestamp: number }

function parseBlockResponse(data: any, chain: string, height: number | string): CosmosBlock {
  const header = data?.block?.header ?? data?.sdk_block?.header
  if (!header?.height || !header?.time) throw new Error(`cosmos.getBlock: malformed block response for ${chain} ${height}`)
  return { number: Number(header.height), timestamp: parseBlockTime(header.time) }
}

/** Block header via `/cosmos/base/tendermint/v1beta1/blocks/{h}`, falling back to the legacy `/blocks/{h}` route. */
export async function getBlock({ chain, height = 'latest' }: { chain: string, height?: number | string }): Promise<CosmosBlock> {
  const h = height === undefined || height === null ? 'latest' : String(height)
  const shouldRetry = (e: any) => !isPrunedHeightError(e) && isRetryableError(e)
  try {
    const data = await httpGet(getEndpoints({ chain }), { path: `cosmos/base/tendermint/v1beta1/blocks/${h}`, shouldRetry, label: `${chain} block ${h}` } as any)
    return parseBlockResponse(data, chain, h)
  } catch (e) {
    if (isPrunedHeightError(e)) throw e
    debugLog(`[chains.cosmos] ${chain} v1beta1 blocks/${h} failed, trying legacy /blocks route: ${(e as any)?.message ?? e}`)
    const data = await httpGet(getEndpoints({ chain }), { path: `blocks/${h}`, shouldRetry, label: `${chain} legacy block ${h}` } as any)
    return parseBlockResponse(data, chain, h)
  }
}

export async function getLatestBlock({ chain }: { chain: string }): Promise<CosmosBlock> {
  return getBlock({ chain, height: 'latest' })
}

const blockTimeCache: Record<string, Map<number, number | null>> = {}

function getBlockTimeCache(chain: string) {
  if (!blockTimeCache[chain]) blockTimeCache[chain] = new Map()
  return blockTimeCache[chain]
}

/** "height 5 is not available, lowest height is 69555892" -> 69555892 */
function parseLowestHeight(e: any): number | undefined {
  const match = /lowest height is (\d+)/.exec(String(e?.response?.data?.message ?? e?.message ?? ''))
  return match ? Number(match[1]) : undefined
}

async function probeBlockTime(chain: string, height: number): Promise<{ time: number | null, lowestHeight?: number }> {
  const cache = getBlockTimeCache(chain)
  if (cache.has(height)) return { time: cache.get(height) ?? null }
  let time: number | null
  let lowestHeight: number | undefined
  try {
    time = (await getBlock({ chain, height })).timestamp
  } catch (e) {
    if (!isPrunedHeightError(e)) throw e
    time = null
    lowestHeight = parseLowestHeight(e)
  }
  if (cache.size > 100_000) cache.clear()
  cache.set(height, time)
  return { time, lowestHeight }
}

/** Block time in seconds, `null` when the height is pruned / unavailable. Cached per chain. */
export async function getBlockTime({ chain, height }: { chain: string, height: number }): Promise<number | null> {
  return (await probeBlockTime(chain, height)).time
}

/**
 * Largest height whose block time is <= `timestamp` (binary search over block
 * headers, pruned heights count as "too old"). Throws when every retained block is
 * newer than `timestamp`.
 */
export async function getBlockAtTimestamp({ chain, timestamp }: { chain: string, timestamp: number }): Promise<CosmosBlock> {
  const latest = await getLatestBlock({ chain })
  if (timestamp >= latest.timestamp) return latest
  getBlockTimeCache(chain).set(latest.number, latest.timestamp)
  let lo = 1
  let hi = latest.number
  let answer: CosmosBlock | undefined
  let calls = 0
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const { time, lowestHeight } = await probeBlockTime(chain, mid)
    calls++
    if (time === null) {
      // pruned: everything below is unavailable too, jump to the node's retention horizon when it tells us
      lo = lowestHeight && lowestHeight > mid ? lowestHeight : mid + 1
    } else if (time <= timestamp) {
      answer = { number: mid, timestamp: time }
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  debugLog(`[chains.cosmos] ${chain} block at ${timestamp}: ${answer?.number} (${calls} lookups)`)
  if (!answer) throw new Error(`cosmos.getBlockAtTimestamp: no block at or before ${timestamp} on ${chain} (node retention horizon)`)
  return answer
}

// legacy API (util/cosmos.ts), signatures kept verbatim ------------------------

export async function getCosmosBlock(block: number | string = 'latest', chain = 'cosmos') {
  try {
    return await getBlock({ chain, height: block })
  } catch (e) {
    const message = `Error fetching cosmos block -
       chain: ${chain}, block: ${block}, endPoint: ${getEndpoints({ chain }).join(',')}, error: ${(e as any)?.message ?? JSON.stringify(e)}`
    throw new Error(message)
  }
}

export function getCosmosProvider(chain: string) {
  return {
    getBlock: (block: number | string = 'latest') => getCosmosBlock(block, chain)
  }
}

// ---------------------------------------------------------------------------
// tendermint json-rpc
// ---------------------------------------------------------------------------

export const tendermint = {
  /** `<CHAIN>_TENDERMINT_RPC`, then `https://rpc.cosmos.directory/<chain>` */
  getEndpoints({ chain }: { chain: string }): string[] {
    return resolveEndpoints(chain, undefined, { envKey: `${chain.toUpperCase()}_TENDERMINT_RPC`, fallback: `${COSMOS_DIRECTORY_RPC}/${chain}` })
  },
  /** JSON-RPC `status` -> { node_info, sync_info: { latest_block_height, latest_block_time, earliest_block_height, ... } } */
  async getStatus({ chain }: { chain: string }): Promise<any> {
    return jsonRpc('status', {}, { chain, endpoints: tendermint.getEndpoints({ chain }) })
  },
  /** JSON-RPC `block` -> { block_id, block: { header, data, ... } } (latest when height is omitted) */
  async getTendermintBlock({ chain, height }: { chain: string, height?: number | string }): Promise<any> {
    const params = height !== undefined && height !== 'latest' ? { height: String(height) } : {}
    return jsonRpc('block', params, { chain, endpoints: tendermint.getEndpoints({ chain }) })
  },
  /** `{ number, timestamp }` from the tendermint `block` call */
  async getBlock({ chain, height }: { chain: string, height?: number | string }): Promise<CosmosBlock> {
    const res = await tendermint.getTendermintBlock({ chain, height })
    return parseBlockResponse(res, chain, height ?? 'latest')
  },
}
