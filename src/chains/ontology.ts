/**
 * Ontology (non-EVM) balances and token info over the Ontology explorer REST API.
 *
 * Replaces the chain access parts of:
 *   - DefiLlama-Adapters  projects/helper/chain/ontology.js (getNativeBalances)
 *   - peggedassets-server src/adapters/peggedAssets/helper/ontology.ts (getTotalSupply, getBalance)
 *
 * Endpoints: `ONTOLOGY_EXPLORER` (comma separated) overrides `DEFAULT_EXPLORER`. There is no
 * public JSON-RPC that answers balance queries for OEP-4 / ORC-20 tokens without running a
 * node, so the explorer is the source. `ontology_evm` is a separate EVM chain and is not
 * handled here.
 *
 * The explorer already divides balances and supplies by the token decimals, so every
 * amount here is in WHOLE units as a decimal string (unlike the other chain modules).
 *
 * Usage: `sdk.chains.ontology.getTokenBalance({ address: 'A...', tokenType: 'oep4', contract: '061a...' })`
 */
import { getEndpoints as resolveEndpoints, httpGet, HttpOptions } from "./rpc";

export const CHAIN = 'ontology'
export const DEFAULT_EXPLORER = 'https://explorer.ont.io'

export type TokenType = 'native' | 'oep4' | 'oep5' | 'oep8' | 'orc20' | 'orc721' | 'orc1155'

/** Configured explorer base urls (env `ONTOLOGY_EXPLORER` first, then `DEFAULT_EXPLORER`). */
export function getEndpoints(): string[] {
  return resolveEndpoints(CHAIN, DEFAULT_EXPLORER, { envKey: 'ONTOLOGY_EXPLORER' })
}

export interface NativeBalance {
  /** `ont`, `ong`, `unboundong`, `waitboundong` */
  asset_name: string
  /** whole units */
  balance: string
  asset_type: string
  contract_hash: string
}

export interface TokenBalance {
  /** whole units */
  balance: string
  asset_name: string
  asset_type: string
  contract_hash: string
  [key: string]: any
}

export interface TokenInfo {
  contract_hash: string
  name?: string
  symbol?: string
  decimals?: number
  /** whole units */
  total_supply: string
  [key: string]: any
}

/** bare lowercase contract hash (the explorer ignores a `0x` prefix in paths but not in comparisons) */
export function normalizeContract(contract: string): string {
  return contract.trim().replace(/^0x/i, '').toLowerCase()
}

/**
 * GET `path` on the explorer and unwrap `{ code, msg, result }`. The explorer answers
 * HTTP 200 with `code != 0` on failure, so that is turned into an error here.
 */
export async function explorerGet({ path, params, ...options }: { path: string, params?: Record<string, any> } & HttpOptions): Promise<any> {
  const res = await httpGet(getEndpoints(), { path, params, ...options })
  if (!res || typeof res !== 'object') throw new Error(`ontology explorer: empty response for ${path}`)
  if (res.code !== 0) throw new Error(`ontology explorer: ${res.msg ?? 'request failed'} (code ${res.code}) for ${path}`)
  return res.result
}

// ---------------------------------------------------------------------------
// balances
// ---------------------------------------------------------------------------

/** ONT / ONG (+ unbound / waitbound ONG) balances of `address`, whole units. */
export async function getNativeBalances({ address }: { address: string }): Promise<NativeBalance[]> {
  const res = await explorerGet({ path: `/v2/addresses/${address}/native/balances` })
  return Array.isArray(res) ? res : []
}

/** One native asset balance (`ont` or `ong`) in whole units, `'0'` when absent. */
export async function getNativeBalance({ address, asset }: { address: string, asset: 'ont' | 'ong' }): Promise<string> {
  const row = (await getNativeBalances({ address })).find(i => i.asset_name === asset)
  return String(row?.balance ?? '0')
}

/** Every `tokenType` balance held by `address`, whole units. */
export async function getTokenBalances({ address, tokenType }: { address: string, tokenType: TokenType }): Promise<TokenBalance[]> {
  const res = await explorerGet({ path: `/v2/addresses/${address}/${tokenType}/balances` })
  return Array.isArray(res) ? res : []
}

/** Balance of one token (`contract` hash) held by `address`, whole units; `'0'` when not held. */
export async function getTokenBalance({ address, tokenType, contract }: { address: string, tokenType: TokenType, contract: string }): Promise<string> {
  const hash = normalizeContract(contract)
  const row = (await getTokenBalances({ address, tokenType })).find(i => normalizeContract(i.contract_hash ?? '') === hash)
  return String(row?.balance ?? '0')
}

// ---------------------------------------------------------------------------
// tokens
// ---------------------------------------------------------------------------

/** Token details (`/v2/tokens/{type}/{hash}`); throws when the explorer does not know it. */
export async function getToken({ tokenType, contract }: { tokenType: TokenType, contract: string }): Promise<TokenInfo> {
  return explorerGet({ path: `/v2/tokens/${tokenType}/${normalizeContract(contract)}` })
}

/** Total supply in whole units as a decimal string. */
export async function getTokenTotalSupply({ tokenType, contract }: { tokenType: TokenType, contract: string }): Promise<string> {
  const token = await getToken({ tokenType, contract })
  if (token?.total_supply === undefined || token.total_supply === null) throw new Error(`ontology: no total_supply for ${tokenType} ${contract}`)
  return String(token.total_supply)
}
