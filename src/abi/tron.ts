
import { Address } from "../types";
import { handleDecimals } from "../general";
import pLimit from 'p-limit';
import { getEnvValue } from "../util/env";
import { evmToTronAddress, postJson, shortenString, sleepRandom, tronToEvmAddress } from "../util/common";
import * as evmAbi from "./index";

const limitRPCCalls = pLimit(+getEnvValue('TRON_RPC_CONCURRENCY_LIMIT', '5')!);

const getEndpoint = () => getEnvValue('TRON_WALLET_RPC')
const balanceCache: { [address: string]: any } = {}

type CallParams = any;

type CallOptions = {
  target: Address;
  abi: string | any;
  params?: CallParams;
  isMulticall?: boolean;
}

export async function call(options: CallOptions) {
  return evmAbi.call({ ...options, chain: 'tron', })
}

export async function multiCall(
  _functionABI: any,
  _calls: { contract: string; params: any[]; }[]
) {
  return evmAbi.multiCall({
    abi: _functionABI,
    calls: _calls.map(c => ({ target: c.contract, params: c.params })),
    chain: 'tron',
  })
}


export async function getBalance(params: {
  target: Address;
  decimals?: number;
}) {

  if (!params.target) throw new Error('getBalance: target is required')

  const data = await limitRPCCalls(() => {
    if (!balanceCache[params.target]) balanceCache[params.target] = post({ address: params.target, visible: true, }, '/wallet/getaccount')
    return balanceCache[params.target]
  })

  const frozenBalance = data.frozen?.reduce((t: any, { frozen_balance }: any) => t + frozen_balance, 0) ?? 0
  const frozenBalanceV2 = data.frozenV2?.reduce((t: any, { amount = 0 }: any) => t + amount, 0) ?? 0
  const freeBalance = data.balance ?? 0
  const delegatedBandwidthBalance = data.delegated_frozenV2_balance_for_bandwidth ?? 0
  const delegatedEnergyBalance = data.account_resource?.delegated_frozenV2_balance_for_energy ?? 0
  let balance = (freeBalance + frozenBalance + frozenBalanceV2 + delegatedBandwidthBalance + delegatedEnergyBalance).toString()

  return {
    output: handleDecimals(balance, params.decimals),
  };
}

export async function getBalances(params: {
  targets: Address[];
  block?: number;
  decimals?: number;
}) {
  const { targets, decimals } = params
  const res = await Promise.all(targets.map(i => getBalance({ target: i, decimals })))
  return {
    output: res.map((v: any, i: number) => ({ target: targets[i], balance: v.output })),
  };
}

export const unhexifyTarget = evmToTronAddress
export const hexifyTarget = tronToEvmAddress

async function post(body = {}, endpoint = '/wallet/triggerconstantcontract') {
  await sleepRandom(3000)   // sleep random time to avoid rate limit
  const hosts = (getEndpoint()).split(',')

  hosts.sort(() => Math.random() - 0.5) // shuffle hosts

  const errors = []

  for (const host of hosts) {
    try {
      const headers: any = { 'Content-Type': 'application/json' }
      const apiKey = getEnvValue('TRON_PRO_API_KEY')
      if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey

      const res = await postJson(host + endpoint, body, { headers, })
      return res
    } catch (e: any) {
      // debugLog('Tron RPC error', e.message)
      errors.push(e)
    }
  }

  throw new Error(shortenString(`All TRON RPCs are not working. Errors: ${errors.map((i) => i.message).join('; ')}`, 1500))
}
