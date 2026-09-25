/**
 * Tron helpers that are not part of the EVM-style ABI path.
 *
 * The EVM-style contract calls (`call`, `multiCall`, `getBalance`) live in
 * `src/abi/tron.ts` and are re-exported here so `sdk.chains.tron` is the single
 * entry point.
 *
 * Replaces:
 * - DefiLlama-Adapters projects/helper/chain/tron.js (getStakedTron, getTrxBalance)
 */
import { getEnvValue } from "../util/env";
import { evmToTronAddress, tronToEvmAddress } from "../util/common";
import { getEndpoints as resolveEndpoints, httpGet, httpPost } from "./rpc";

export { call, multiCall, getBalance, getBalances, unhexifyTarget, hexifyTarget } from "../abi/tron";
export { evmToTronAddress, tronToEvmAddress }

export const DEFAULT_WALLET_ENDPOINTS = 'https://api.trongrid.io'
export const DEFAULT_TRONSCAN_ENDPOINT = 'https://apilist.tronscanapi.com'

/** TronGrid style `wallet/*` REST endpoints, `TRON_WALLET_RPC` (comma separated) overrides */
export function getWalletEndpoints(): string[] {
  return resolveEndpoints('tron', DEFAULT_WALLET_ENDPOINTS, { envKey: 'TRON_WALLET_RPC' })
}

export function getTronscanEndpoint(): string {
  return resolveEndpoints('tron', DEFAULT_TRONSCAN_ENDPOINT, { envKey: 'TRONSCAN_API' })[0]
}

function walletHeaders() {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const apiKey = getEnvValue('TRON_PRO_API_KEY')
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey
  return headers
}

function tronscanHeaders() {
  const headers: Record<string, string> = {}
  const apiKey = getEnvValue('TRONSCAN_API_KEY')
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey
  return headers
}

/** POST to a `wallet/*` endpoint (e.g. `wallet/getaccount`) with endpoint rotation */
export async function walletPost({ path, body = {} }: { path: string, body?: any }): Promise<any> {
  return httpPost(getWalletEndpoints(), body, { path, headers: walletHeaders() })
}

/** Raw account record from `wallet/getaccount` (base58 `T...` or hex `41...` address) */
export async function getAccount({ address }: { address: string }): Promise<any> {
  return walletPost({ path: 'wallet/getaccount', body: { address, visible: !address.startsWith('41') } })
}

export async function getAccountResource({ address }: { address: string }): Promise<any> {
  return walletPost({ path: 'wallet/getaccountresource', body: { address, visible: !address.startsWith('41') } })
}

/**
 * TRX balance in SUN including frozen (v1 + v2) and delegated resources, as the
 * adapters helper did. Returns a string.
 */
export async function getTrxBalance({ address, includeFrozen = true }: { address: string, includeFrozen?: boolean }): Promise<string> {
  const data = await getAccount({ address })
  const free = Number(data?.balance ?? 0)
  if (!includeFrozen) return String(free)
  const frozen = (data?.frozen ?? []).reduce((t: number, i: any) => t + Number(i.frozen_balance ?? 0), 0)
  const frozenV2 = (data?.frozenV2 ?? []).reduce((t: number, i: any) => t + Number(i.amount ?? 0), 0)
  const delegatedBandwidth = Number(data?.delegated_frozenV2_balance_for_bandwidth ?? 0)
  const delegatedEnergy = Number(data?.account_resource?.delegated_frozenV2_balance_for_energy ?? 0)
  return String(free + frozen + frozenV2 + delegatedBandwidth + delegatedEnergy)
}

/** Total votes received by a super representative candidate (tronscan) */
export async function getStakedTron({ address }: { address: string }): Promise<number> {
  const data = await httpGet(getTronscanEndpoint(), { path: 'api/vote', params: { candidate: address }, headers: tronscanHeaders() })
  return Number(data?.totalVotes ?? 0)
}

export async function getLatestBlock(): Promise<{ number: number, timestamp: number, hash: string }> {
  const data = await walletPost({ path: 'wallet/getnowblock' })
  return {
    number: data.block_header.raw_data.number,
    timestamp: Math.floor(data.block_header.raw_data.timestamp / 1000),
    hash: data.blockID,
  }
}

export async function getBlock({ number }: { number: number }): Promise<{ number: number, timestamp: number, hash: string }> {
  const data = await walletPost({ path: 'wallet/getblockbynum', body: { num: number } })
  return {
    number: data.block_header.raw_data.number,
    timestamp: Math.floor(data.block_header.raw_data.timestamp / 1000),
    hash: data.blockID,
  }
}

export function isTronAddress(address: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(address) || /^41[0-9a-fA-F]{40}$/.test(address)
}
