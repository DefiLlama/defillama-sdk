import { debugLog } from './util/debugLog';
import { ethers, Provider } from "ethers";
import providerList from './providers.json'


function createProvider(name: string, rpcString: string, chainId: number = 2424242424242422): Provider | null {
  const networkish = { name, chainId }
  const rpcList = rpcString.split(',')
  if (process.env[`${name.toUpperCase()}_RPC_CHAIN_ID`])
    chainId = +process.env[`${name.toUpperCase()}_RPC_CHAIN_ID`]!

  if (process.env.HISTORICAL) {
    if (chainId === 1) {
      console.log("RPC providers set to historical, only the first RPC provider will be used")
    }
    return getProviderObject(rpcList[0])
  }
  else {
    try {
      return new ethers.FallbackProvider(
        rpcList.map((url, i) => ({ provider: (getProviderObject(url) as ethers.AbstractProvider), priority: i, chainId, })),
        networkish,
        { cacheTimeout: 5 * 1000 }
      )
    } catch (e) {
      // debugLog(`Error creating provider for ${name} with RPCs: ${rpcList.join(', ')}`)
      // we dont throw errors for chains not present in providers.json, these can be non-evm chains like solana
      if ((providerList as any)[name])
        throw e
      return null
    }
  }


  function getProviderObject(url: string): ethers.Provider {

    /**
     *  Options for configuring a [[JsonRpcApiProvider]]. Much of this
     *  is targetted towards sub-classes, which often will not expose
     *  any of these options to their consumers.
     *
     *  **``polling``** - use the polling strategy is used immediately
     *  for events; otherwise, attempt to use filters and fall back onto
     *  polling (default: ``false``)
     *
     *  **``staticNetwork``** - do not request chain ID on requests to
     *  validate the underlying chain has not changed (default: ``null``)
     *
     *  This should **ONLY** be used if it is **certain** that the network
     *  cannot change, such as when using INFURA (since the URL dictates the
     *  network). If the network is assumed static and it does change, this
     *  can have tragic consequences. For example, this **CANNOT** be used
     *  with MetaMask, since the used can select a new network from the
     *  drop-down at any time.
     *
     *  **``batchStallTime``** - how long (ms) to aggregate requests into a
     *  single batch. ``0`` indicates batching will only encompass the current
     *  event loop. If ``batchMaxCount = 1``, this is ignored. (default: ``10``)
     *
     *  **``batchMaxSize``** - target maximum size (bytes) to allow per batch
     *  request (default: 1Mb)
     *
     *  **``batchMaxCount``** - maximum number of requests to allow in a batch.
     *  If ``batchMaxCount = 1``, then batching is disabled. (default: ``100``)
     *
     *  **``cacheTimeout``** - passed as [[AbstractProviderOptions]].
      *  **``cacheTimeout``** - how long to cache a low-level ``_perform``
      *  for, based on input parameters. This reduces the number of calls
      *  to getChainId and getBlockNumber, but may break test chains which
      *  can perform operations (internally) synchronously. Use ``-1`` to
      *  disable, ``0`` will only buffer within the same event loop and
      *  any other value is in ms. (default: ``250``)
     */
    const batchMaxSize = 10 * (1024 * 1024) // 10Mb
    const jsonRpcApiProviderOptions = { staticNetwork: true, batchStallTime: 42, batchMaxSize, batchMaxCount: 1000, cacheTimeout: 5 * 1000 }
    if (url.startsWith('wss://')) {
      delete (jsonRpcApiProviderOptions as any).batchMaxCount
      return new ethers.WebSocketProvider(url, networkish, jsonRpcApiProviderOptions)
    }
    return new ethers.JsonRpcProvider(url, networkish, jsonRpcApiProviderOptions)
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
  if (providers[chain] && !getArchivalNode) return providers[chain]._provider

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
