import { AbstractProvider, AddressLike, Block, BlockTag, FallbackProvider, Filter, FilterByBlockHash, JsonRpcProvider, Log, Provider, TransactionRequest, WebSocketProvider } from "ethers";
import providerList from '../providers.json'
import { getArchivalRPCs, getBatchMaxCount, getChainId, getChainRPCs, getEnvValue } from './env';
import { debugLog } from './debugLog';
import { Chain } from "../types";
import axios from "axios";

type ProviderWithURL = {
  url: string;
  provider: AbstractProvider;
}


export class LlamaProvider extends FallbackProvider {
  isCustomLlamaProvider = true
  rpcs: ProviderWithURL[];
  archivalRPCs: ProviderWithURL[];
  _isReady: Promise<void>
  chainName: string
  chainId: number

  constructor({
    providers, chainId, chainName, archivalRPCs,
  }: { providers: ProviderWithURL[], archivalRPCs: ProviderWithURL[], chainId: number, chainName: string }, fallbackConfig?: any) {
    const networkish = { name: chainName, chainId };
    super(providers.map(i => i.provider), networkish, fallbackConfig);
    this.rpcs = providers;
    this.archivalRPCs = archivalRPCs;
    this.chainName = chainName
    this.chainId = chainId
    this._isReady = this._ready()
  }

  getNetwork(): any {
    return { chainId: this.chainId, name: this.chainName }
  }

  _removeProvider(rpc: string) {
    this.rpcs = this.rpcs.filter(i => i.url !== rpc)
    this.archivalRPCs = this.archivalRPCs.filter(i => i.url !== rpc)
  }

  async _ready() {
    const outOfSyncLimit = 1000
    const _this = this
    const currentBlocks = {} as Record<string, number>
    await Promise.all(this.rpcs.map(checkRPCWorks))
    if (this.archivalRPCs.length) {
      await Promise.all(this.archivalRPCs.map(checkRPCWorks))
    }

    const highestBlock = Object.values(currentBlocks).reduce((highest, current) => Math.max(highest, current), 0)


    Object.entries(currentBlocks).forEach(([url, block]) => {
      if (highestBlock - block > outOfSyncLimit) {
        debugLog(`RPC ${url} is out of sync by ${highestBlock - block} blocks`)
        _this.rpcs = _this.rpcs.filter(i => i.url !== url)
        _this.archivalRPCs = _this.archivalRPCs.filter(i => i.url !== url)
      }
    })

    async function checkRPCWorks({ url, provider }: ProviderWithURL) {
      try {
        const block = await httpRPC.getBlockNumber(url)
        currentBlocks[url] = block
      } catch (e) {
        // debugLog(`${_this.chainName} skipping RPC ${url} is not working, error: ${(e as any).message}`)
        _this._removeProvider(url)
      }
    }
  }

  async call(_tx: TransactionRequest): Promise<string> {
    return this._performAction('call', [{ to: _tx.to, data: _tx.data }, _tx.blockTag ?? 'latest'])
  }

  async getBalance(address: AddressLike, blockTag: BlockTag = 'latest'): Promise<bigint> {
    return this._performAction('getBalance', [address, blockTag])
  }

  async getBlock(block: BlockTag, prefetchTxs?: boolean | undefined): Promise<Block | null> {
    return this._performAction('getBlock', [block, false])
  }

  async getLogs(_filter: Filter | FilterByBlockHash): Promise<Log[]> {
    return this._performAction('getLogs', [_filter], 3)
  }

  async _performAction(method: string, params: any, attempts = 7): Promise<any> {
    await this._isReady
    let runners = [...this.rpcs]
    if (method === 'getLogs') {
      runners = [...this.archivalRPCs]
      this.rpcs.filter(i => !runners.map(i => i.url).includes(i.url)).forEach(i => runners.push(i)) // ensure that there are no duplicates
    }
    let primaryRunner = runners[0]
    let errors = []
    runners = runners.slice(1).sort(() => Math.random() - 0.5) // randomize order of runners
    const isArchivalRequest = ['call', 'getBalance'].includes(method) && params[1] !== 'latest'
    let noPlayingAround = primaryRunner.url.includes('llama.fi') || method === 'getLogs' || isArchivalRequest

    if (noPlayingAround) {
      // if primary runner is llama.fi or alchemy, then try it first
      runners.unshift(primaryRunner)
    } else {
      // add it as second runner
      runners.splice(1, 0, primaryRunner);
    }

    runners = runners.slice(0, attempts)

    for (const runner of runners) {
      try {
        const result = await (httpRPC as any)[method](runner.url, params)
        return result
      } catch (e) {
        // console.log('failed', runner.url, (e as any).message)
        errors.push({ host: runner.url, error: e })
      }
    }

    throw { llamaRPCError: true, errors }
  }

}


function createProvider(name: string, rpcString: string, chainId = 400069, archivalRPCList: string[] = []): AbstractProvider | null {
  chainId = getChainId(name, chainId)
  const networkish = { name, chainId }
  const rpcList = rpcString.split(',')

  if (getEnvValue('HISTORICAL')) {
    if (chainId === 1) {
      debugLog("RPC providers set to historical, only the first RPC provider will be used")
    }
    return getProviderObject(rpcList[0], name)
  }
  else {
    try {
      const fallbackConfig = { cacheTimeout: 5 * 1000, quorum: 1, eventQuorum: 1, }
      const getProviderWithURL = (url: string) => ({ url, provider: getProviderObject(url, name) })
      const providers = rpcList.map(getProviderWithURL)
      const archivalRPCs = archivalRPCList.map(getProviderWithURL)
      return new LlamaProvider({ providers, archivalRPCs, chainId, chainName: name, }, fallbackConfig)
      // return new FallbackProvider(providers, networkish, fallbackConfig)
    } catch (e) {
      // debugLog(`Error creating provider for ${name} with RPCs: ${rpcList.join(', ')}`)
      // we dont throw errors for chains not present in providers.json, these can be non-evm chains like solana
      if ((providerList as any)[name])
        throw e
      return null
    }
  }

  function getProviderObject(url: string, chain: string): AbstractProvider {

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
    // const batchMaxSize = 10 * (1024 * 1024) // 10Mb
    // some rpcs throw error if batchMaxCount is set higher than 100
    const batchMaxCount = getBatchMaxCount(chain)
    const jsonRpcApiProviderOptions = { staticNetwork: true, batchMaxCount: 1, }
    if (url.startsWith('wss://')) {
      delete (jsonRpcApiProviderOptions as any).batchMaxCount
      return new WebSocketProvider(url, networkish, jsonRpcApiProviderOptions)
    }
    return new JsonRpcProvider(url, networkish, jsonRpcApiProviderOptions)
  }
}

export const providers = {} as {
  [chain: string]: AbstractProvider;
};

export function setProvider(
  chain: Chain,
  provider: AbstractProvider
) {
  providers[chain] = provider
}

export function getProvider(chain: Chain = "ethereum", _getArchivalNode = false): AbstractProvider {
  if (providers[chain]) return providers[chain]

  // use RPC from env variable if set else use RPC from providers.json
  let rpcList: (string | undefined) = getChainRPCs(chain, (providerList as any)[chain]?.rpc)
  let archivalRPCList: (string[] | undefined) = getArchivalRPCs(chain)
  if (!rpcList) {
    // @ts-ignore (throwing error here would alter function behavior and have side effects)
    return null
  }
  if (!providers[chain])
    providers[chain] = createProvider(chain, rpcList, (providerList as any)[chain]?.chainId, archivalRPCList) as any
  return providers[chain]
}


function toHex(n: number | string) {
  if (typeof n === 'string') return n
  return '0x' + n.toString(16)
}

const httpRPC = {
  getBlockNumber: async (rpc: string): Promise<number> => {
    const { data } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params: [],
      method: 'eth_blockNumber',
    }, {
      timeout: 3000
    })
    if (data.error) throw data.error
    return parseInt(data.result)
  },
  getBlock: async (rpc: string, params: any): Promise<any> => {
    params[0] = toHex(params[0])
    const { data: { result, error } } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params,
      method: 'eth_getBlockByNumber',
    }, {
      timeout: 3000
    })
    if (error) throw error
    result.number = parseInt(result.number)
    result.timestamp = parseInt(result.timestamp)
    return result;
  },
  getBalance: async (rpc: string, params: any): Promise<any> => {
    params[1] = toHex(params[1])
    const { data: { result, error } } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params,
      method: 'eth_getBalance',
    }, {
      timeout: 5000
    })
    if (error) throw error
    return BigInt(result).toString();
  },
  call: async (rpc: string, params: any): Promise<any> => {
    params[1] = toHex(params[1])
    const { data } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params,
      method: 'eth_call',
    }, {
      timeout: 5000
    })
    if (data.error) throw data.error
    return data.result;
  },
  getLogs: async (rpc: string, params: any): Promise<any> => {
    params[0].fromBlock = toHex(params[0].fromBlock)
    params[0].toBlock = toHex(params[0].toBlock)
    const { data: { result, error } } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params,
      method: 'eth_getLogs',
    })
    if (error) throw error
    result.forEach((i: any) => {
      i.blockNumber = parseInt(i.blockNumber)
      i.transactionIndex = parseInt(i.transactionIndex)
      i.logIndex = parseInt(i.logIndex)
      i.index = i.logIndex
    })
    return result;
  },
}