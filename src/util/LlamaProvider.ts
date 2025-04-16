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

const rpcRequestCounter = {} as Record<string, number>


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
    if (process.env["SKIP_RPC_CHECK"] === "true") {
      return
    }
    const outOfSyncLimit = 1000
    const _this = this
    const currentBlocks = {} as Record<string, number>
    await Promise.all(this.rpcs.map(checkRPCWorks))
    if (this.archivalRPCs.length) {
      await Promise.all(this.archivalRPCs.map(checkRPCWorks))
    }

    // we are doing this because I noticed that one of the rpcs can go rouge and return very high block number
    const medianBlockValue = getMedianBlockValue(Object.values(currentBlocks))


    Object.entries(currentBlocks).forEach(([url, block]) => {
      if (medianBlockValue - block > outOfSyncLimit) {
        debugLog(`RPC ${url} is out of sync by ${medianBlockValue - block} blocks`)
        _this.rpcs = _this.rpcs.filter(i => i.url !== url)
        _this.archivalRPCs = _this.archivalRPCs.filter(i => i.url !== url)
      }
    })

    async function checkRPCWorks({ url, provider }: ProviderWithURL) {
      try {
        const block = await httpRPC.getBlockNumber(url)
        currentBlocks[url] = block
      } catch (e) {
        debugLog(`${_this.chainName} skipping RPC ${url} is not working, error: ${(e as any).message}`)
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
    return this._performAction('getLogs', [_filter], 7)
  }

  async getTransaction(_hash: string): Promise<any> {
    return this._performAction('getTransaction', [_hash])
  }

  async getTransactionReceipt(_hash: string): Promise<any> {
    return this._performAction('getTransactionReceipt', [_hash])
  }

  async _performAction(method: string, params: any, attempts = 7): Promise<any> {
    if (!rpcRequestCounter[this.chainName]) rpcRequestCounter[this.chainName] = 0
    rpcRequestCounter[this.chainName]++
    await this._isReady
    let runners = [...this.rpcs]
    if (method === 'getLogs') {
      runners = [...this.archivalRPCs]
      this.rpcs.filter(i => !runners.map(i => i.url).includes(i.url)).forEach(i => runners.push(i)) // ensure that there are no duplicates
      runners = runners.filter(i => !i.url.includes('llamarpc.com'));
    }
    if (!runners.length) throw new Error('No RPCs available for ' + this.chainName)
    let primaryRunner = runners[0]
    let errors = []
    if (method === 'getLogs') {
      runners = runners.slice(1).concat(this.rpcs)
      runners = runners.sort(() => Math.random() - 0.5) // randomize order of runners
    } else
      runners = runners.slice(1).sort(() => Math.random() - 0.5) // randomize order of runners
    const isArchivalRequest = ['call', 'getBalance'].includes(method) && params[1] !== 'latest'
    let noPlayingAround = getEnvValue('RPC_NO_PLAYING_AROUND') === 'true' || primaryRunner.url.includes('llama.fi') || method === 'getLogs' || isArchivalRequest

    if (noPlayingAround) {
      // if primary runner is llama.fi or alchemy, then try it first
      runners.unshift(primaryRunner)
    } else {
      // add it as second runner
      runners.splice(1, 0, primaryRunner);
    }

    runners = runners.slice(0, attempts)

    // if (this.chainName === 'rsk' && method === 'getLogs') {
    //   const hostString = getEnvValue('RSK_ARCHIVAL_RPC')
    //   if (!hostString) 
    //     throw new Error('RSK public nodes dont support getLogs. need to set RSK_ARCHIVAL_RPC');
    //   (runners as any) = hostString.split(',').map(host => ({ url: host  }))
    // }

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
  let rpcList = rpcString.split(',')

  if (getEnvValue('HISTORICAL')) {
    if (chainId === 1) {
      debugLog("RPC providers set to historical, only the first RPC provider will be used")
    }
    // return getProviderObject(rpcList[0], name)
    rpcList = [rpcList[0]]
  }
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

  function getProviderObject(url: string, chain: string): AbstractProvider {
    const jsonRpcApiProviderOptions = { staticNetwork: true, batchMaxCount: 1, }
    if (url.startsWith('wss://')) {
      return null as any; // websocket provider is not supported
      // return new WebSocketProvider(url, networkish, jsonRpcApiProviderOptions)
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
  const rpcKey = chain === 'tron' ? 'tron_evm' : chain
  if (providers[chain]) return providers[chain]

  // use RPC from env variable if set else use RPC from providers.json
  let rpcList: (string | undefined) = getChainRPCs(rpcKey, (providerList as any)[chain]?.rpc)
  let archivalRPCList: (string[] | undefined) = getArchivalRPCs(rpcKey)
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
    const getData = async () => {
      const data = (await axios.post(rpc, {
        jsonrpc: '2.0', id: 1, params: [],
        method: 'eth_blockNumber',
      }, {
        timeout: +(getEnvValue('LLAMA_PROVIDER_RPC_GET_BLOCKNUMBER_TIMEOUT', '30000') as any)
      })).data
      if (data.error) throw data.error
      return data.result
    }
    let data
    try {
      data = await getData()
    } catch (e) {
      // try again
      data = await getData()
    }
    return parseInt(data)
  },
  getBlock: async (rpc: string, params: any): Promise<any> => {
    params[0] = toHex(params[0])
    const { data: { result, error } } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params,
      method: 'eth_getBlockByNumber',
    }, {
      timeout: +(getEnvValue('LLAMA_PROVIDER_RPC_GET_BLOCK_TIMEOUT', '60000') as any)
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
      timeout: +(getEnvValue('LLAMA_PROVIDER_RPC_GET_BALANCE_TIMEOUT', '30000') as any)
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
      timeout: +(getEnvValue('LLAMA_PROVIDER_RPC_CALL_TIMEOUT', '30000') as any)
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
    }, {
      timeout: +(getEnvValue('LLAMA_PROVIDER_RPC_GET_LOGS_TIMEOUT', '30000') as any)
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
  getTransaction: async (rpc: string, params: any): Promise<any> => {
    const { data: { result, error } } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params,
      method: 'eth_getTransactionByHash',
    }, {
      timeout: +(getEnvValue('LLAMA_PROVIDER_RPC_GET_TRANSACTION_TIMEOUT', '180000') as any)
    })
    if (error) throw error
    if (!result) return null
    result.blockNumber = parseInt(result.blockNumber)
    result.transactionIndex = parseInt(result.transactionIndex)
    result.data = result.input
    return result;
  },
  getTransactionReceipt: async (rpc: string, params: any): Promise<any> => {
    const { data: { result, error } } = await axios.post(rpc, {
      jsonrpc: '2.0', id: 1, params,
      method: 'eth_getTransactionReceipt',
    }, {
      timeout: +(getEnvValue('LLAMA_PROVIDER_RPC_GET_TXN_RECEIPT_TIMEOUT', '180000') as any)
    })
    if (error) throw error
    if (!result) return null
    result.blockNumber = parseInt(result.blockNumber)
    result.transactionIndex = parseInt(result.transactionIndex)
    return result;
  }
}

function getMedianBlockValue(blocks: number[]) {
  blocks.sort((a, b) => a - b)
  const mid = Math.floor(blocks.length / 3)
  return blocks.length % 2 !== 0 ? blocks[mid] : (blocks[mid - 1] + blocks[mid]) / 2
}


process.on('exit', () => {
  if (Object.keys(rpcRequestCounter).length > 7) {
    debugLog('RPC request count per chain',)
    console.table(rpcRequestCounter)
  }
})