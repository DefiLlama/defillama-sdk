import { debugLog } from './util/debugLog';
import { ethers, Provider } from "ethers";
import providerList from './providers.json'

function createProvider(name: string, rpcString: string, chainId: number = 2424242424242422): Provider | null {
  const rpcList = rpcString.split(',')
  if (process.env[`${name.toUpperCase()}_RPC_CHAIN_ID`])
    chainId = +process.env[`${name.toUpperCase()}_RPC_CHAIN_ID`]!

  if (process.env.HISTORICAL) {
    if (chainId === 1) {
      console.log("RPC providers set to historical, only the first RPC provider will be used")
    }
    return new ethers.JsonRpcProvider(rpcList[0], { name, chainId, }, { staticNetwork: true })
  }
  else {
    try {
      return new ethers.FallbackProvider(
        rpcList.map((url, i) => ({
          provider: new ethers.JsonRpcProvider(url, { name, chainId, }, { staticNetwork: true }),
          priority: i,
          chainId,
        })),
        chainId,
      )
    } catch (e) {
      debugLog(`Error creating provider for ${name} with RPCs: ${rpcList.join(', ')}`)
      // we dont throw errors for chains not present in providers.json, these can be non-evm chains like solana
      if ((providerList as any)[name])
        throw e
      return null
    }
  }
}


type ProviderWrapped = {
  rpcList: string;
  _provider: Provider;
}

export const providers = {} as {
  [chain: string]: ProviderWrapped;
};

export type Chain = string
export function getProvider(chain: Chain = "ethereum", getArchivalNode = false): Provider {
  if (providers[chain]) return providers[chain]._provider

  const chainArchivalpcEnv = process.env[chain.toUpperCase() + "_ARCHIVAL_RPC"]
  if (getArchivalNode && typeof chainArchivalpcEnv === 'string' && chainArchivalpcEnv.length > 0) {
    let rpcList = chainArchivalpcEnv?.split(',')
    // shuffle rpcList
    rpcList = rpcList!.sort(() => Math.random() - 0.5)
    return (createProvider(chain, rpcList.join(','), (providerList as any)[chain]?.chainId) as Provider)
  }
  // use RPC from env variable if set else use RPC from providers.json
  let rpcList: (string | undefined) = process.env[chain.toUpperCase() + "_RPC"]
  if (!rpcList) rpcList = (providerList as any)[chain]?.rpc.join(',')
  if (!rpcList) {
    // in case provider was set using `setProvider` function
    if (providers[chain]) return providers[chain]._provider
    // @ts-ignore (throwing error here would alter function behavior and have side effects)
    return null
  }
  if (!providers[chain] || providers[chain].rpcList !== rpcList) {
    providers[chain] = {
      rpcList,
      _provider: (createProvider(chain, rpcList, (providerList as any)[chain]?.chainId) as Provider)
    }
  }
  return providers[chain]._provider
}

export const TEN = BigInt(10);

export function handleDecimals(num: any, decimals?: number): string {
  if (typeof num !== 'number') num = num.toString()
  if (decimals === undefined) {
    return num.toString();
  } else {
    return Number(num / (10 ** decimals)).toString();
  }
}

export const ETHER_ADDRESS = "0x0000000000000000000000000000000000000000";

export function setProvider(
  chain: Chain,
  provider: Provider
) {
  providers[chain] = {
    rpcList: "",
    _provider: provider
  }
}
