import { debugLog} from './util/debugLog'
import { ethers, BigNumber } from "ethers"
import providerList from './providers.json'

function createProvider(name: string, rpcString: string, chainId: number) {
  const rpcList = rpcString.split(',')

  if (process.env.HISTORICAL) {
    if (chainId === 1) {
      console.log("RPC providers set to historical, only the first RPC provider will be used")
    }
    return new ethers.providers.StaticJsonRpcProvider(
      rpcList[0],
      {
        name,
        chainId,
      }
    )
  } else {
    try {
      return new ethers.providers.FallbackProvider(
        rpcList.map((url, i) => ({
          provider: new ethers.providers.StaticJsonRpcProvider(
            url,
            {
              name,
              chainId,
            }
          ),
          priority: i
        })),
        1
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

type Provider = ethers.providers.StaticJsonRpcProvider | ethers.providers.FallbackProvider

type ProviderWrapped = {
  rpcList: string;
  _provider: Provider;
}

export const providers = {} as {
  [chain: string]: ProviderWrapped;
};

export type Chain = string
export function getProvider(chain: Chain = "ethereum"): Provider {
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

export const TEN = BigNumber.from(10);

export function handleDecimals(num: BigNumber, decimals?: number): string {
  if (decimals === undefined) {
    return num.toString();
  } else {
    return num.div(TEN.pow(decimals)).toString();
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
