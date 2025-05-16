import axios from "axios"
import { Interface, ethers } from "ethers"
import { ETHER_ADDRESS } from "../general"
import { getUniqueAddresses } from "../generalUtil"
import { Address } from "../types"
import { getBlockNumber } from "./blocks"
import { readCache, writeCache } from "./cache"
import { DEBUG_LEVEL2, debugLog } from "./debugLog"
import { getEnvValue } from "./env"
import { toFilterTopic } from "./logs"
import { sliceIntoChunks } from "."

const indexerURL = getEnvValue('LLAMA_INDEXER_ENDPOINT')
const LLAMA_INDEXER_API_KEY = getEnvValue('LLAMA_INDEXER_API_KEY')
const addressChunkSize = +getEnvValue('LLAMA_INDEXER_ADDRESS_CHUNK_SIZE')!

const axiosIndexer = axios.create({
  headers: {
    "x-api-key": LLAMA_INDEXER_API_KEY,
  },
  baseURL: indexerURL,
})

function checkIndexerConfig() {
  if (!indexerURL || !LLAMA_INDEXER_API_KEY) throw new Error('Llama Indexer URL/api key is not set')
}

type ChainIndexStatus = { [chain: string]: { block: number, timestamp: number } }
const state: {
  timestamp?: number
  chainIndexStatus: ChainIndexStatus | Promise<ChainIndexStatus>
} = { chainIndexStatus: {} }

const cacheTime = 1 * 60 * 1000 // 1 minutes - we cache sync status for 1 minute

async function getChainIndexStatus() {

  checkIndexerConfig()

  if (state.timestamp && (Date.now() - state.timestamp) < cacheTime)
    return state.chainIndexStatus

  state.timestamp = Date.now()
  state.chainIndexStatus = _getState()

  return state.chainIndexStatus

  async function _getState() {
    const { data: { syncStatus } } = await axiosIndexer.get(`/sync`);
    const syncInfo: any = {}

    syncStatus.forEach((d: any) => {
      const chain = indexerChainIdChainMapping[d.chain]
      syncInfo[chain] = {
        block: d.lastIndexedBlock,
        timestamp: +new Date(d.lastIndexedDate)
      }
    })

    state.chainIndexStatus = syncInfo
    return syncInfo
  }

}

const indexerChainIdChainMapping: any = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  100: 'xdai',
  137: 'polygon',
  204: 'op_bnb',
  250: 'fantom',
  324: 'era',
  1101: 'polygon_zkevm',
  8453: 'base',
  34443: 'mode',
  42170: 'arbitrum_nova',
  42161: 'arbitrum',
  43114: 'avax',
  59144: 'linea',
  81457: 'blast',
  534352: 'scroll',
  146: 'sonic'
}

export const supportedChainSet = new Set(Object.values(indexerChainIdChainMapping))
const chainToIDMapping: any = {}
Object.entries(indexerChainIdChainMapping).forEach(([id, chain]: any) => {
  chainToIDMapping[chain] = id
})


enum TokenTypes {
  ERC20 = 'erc20',
  ERC721 = 'erc721',
}

type Cache = {
  timestamp: number
  tokens: {
    [chain: string]: string[]
  }
}

export async function getTokens(address: string | string[], { onlyWhitelisted = true, skipCacheRead = false, skipCache = false, chain, tokenType, }: {
  onlyWhitelisted?: boolean,
  skipCacheRead?: boolean,
  skipCache?: boolean,
  chain?: string,
  tokenType?: TokenTypes,
} = {}) {

  checkIndexerConfig()
  if (!address) throw new Error('Address is required either as a string or an array of strings')
  if (Array.isArray(address) && !address.length) throw new Error('Address array cannot be empty')
  if (Array.isArray(address)) address = address.join(',')
  address = address.toLowerCase()
  let chainId
  if (chain) chainId = chainToIDMapping[chain]

  const project = 'llama-indexer-cache'
  const key = onlyWhitelisted ? address : `${address}/all`
  const file = `${project}/${key}`
  const timeNow = Math.floor(Date.now() / 1e3)
  const THREE_DAYS = 3 * 24 * 3600
  let cache = {} as Cache
  if (!skipCacheRead && !skipCache) {
    cache = (await readCache(file)) ?? {}
    if (cache.timestamp && (timeNow - cache.timestamp) < THREE_DAYS)
      return cache.tokens
  }
  debugLog('[Indexer] Pulling tokens for ' + address)

  const tokens = cache.tokens ?? {}
  const { data: { balances } } = await axiosIndexer(`/balances`, {
    params: {
      addresses: address,
      chainId,
      type: tokenType,
    },
  })
  balances.filter((b: any) => +b.total_amount > 0).forEach((b: any) => {
    const chain = indexerChainIdChainMapping[b.chain]
    if (!chain) {
      return;
    }
    if (!tokens[chain]) tokens[chain] = []
    tokens[chain].push(b.address)
  })
  const tokenCache = { timestamp: timeNow, tokens, }
  Object.entries(tokens).forEach(([chain, values]: any) => {
    values.push(ETHER_ADDRESS)
    tokens[chain] = getUniqueAddresses(values)
  })

  if (!skipCache)
    await writeCache(file, tokenCache)
  return tokens
}

export type IndexerGetLogsOptions = {
  target?: Address;
  topic?: string;
  fromBlock?: number;
  toBlock?: number;
  topics?: (string | null)[];
  extraTopics?: string[];
  chain?: string;
  eventAbi?: string | any;
  fromTimestamp?: number;
  toTimestamp?: number;
  entireLog?: boolean;
  cacheInCloud?: boolean;
  onlyArgs?: boolean;
  targets?: Address[];
  flatten?: boolean;
  all?: boolean;
  limit?: number;
  offset?: number;
  debugMode?: boolean;
  noTarget?: boolean;  // we sometimes want to query logs without a target, but it will an be expensive bug if target/targets were not passed by mistake, so this is a safety check
  parseLog?: boolean;
}

export type IndexerGetTokenTransfersOptions = {
  target?: Address;
  targets?: Address[];
  fromBlock?: number;
  toBlock?: number;
  chain?: string;
  fromTimestamp?: number;
  toTimestamp?: number;
  flatten?: boolean;
  all?: boolean;
  limit?: number;
  offset?: number;
  debugMode?: boolean;
  fromAddressFilter?: string | string[];
  transferType?: 'in' | 'out' | 'all';
  tokens?: string | string[];
  token?: string;
}

export async function getLogs({ chain = 'ethereum', topic, topics, fromBlock, toBlock, all = true, limit = 1000, offset = 0, target, targets, eventAbi, entireLog = false, flatten = true, extraTopics, fromTimestamp, toTimestamp, debugMode = false, noTarget = false, parseLog = true, }: IndexerGetLogsOptions) {
  checkIndexerConfig()

  const chainId = chainToIDMapping[chain]
  if (!chainId) throw new Error('Chain not supported')
  if (!debugMode) debugMode = DEBUG_LEVEL2
  let topic1: string | undefined
  let topic2: string | undefined
  let topic3: string | undefined

  if ((topics?.length && topics.length > 1)) {
    if (topics?.length) {
      topic1 = topics[1] as string
      topic2 = topics[2] as string
      topic3 = topics[3] as string
    }
  } else if (extraTopics?.length) {
    topic1 = extraTopics[0] as string
    topic2 = extraTopics[1] as string
    topic3 = extraTopics[2] as string
  }
  if (topics?.length) topic = topics[0] as string

  if (!eventAbi) entireLog = true


  // if (!target && !targets?.length) throw new Error('target|targets is required')
  if (!fromBlock && !fromTimestamp) throw new Error('fromBlock or fromTimestamp is required')
  if (!toBlock && !toTimestamp) throw new Error('toBlock or toTimestamp is required')

  if (!noTarget && !target && !targets?.length)
    throw new Error('target|targets is required or set the flag "noTarget" to true')


  if (!fromBlock)
    fromBlock = await getBlockNumber(chain, fromTimestamp)

  if (!toBlock)
    toBlock = await getBlockNumber(chain, toTimestamp)

  if (!fromBlock || !toBlock) throw new Error('fromBlock and toBlock must be > 0')


  let address = target
  if (typeof target === 'string') targets = [target]
  if (Array.isArray(targets)) address = targets.join(',')

  const hasAddressFilter = address && address.length

  if (address) address = address.toLowerCase()

  const chainIndexStatus = await getChainIndexStatus()
  const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0

  if (lastIndexedBlock < toBlock)
    throw new Error(`Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`)

  // Create an Interface object
  let iface: Interface
  if (eventAbi)
    iface = new Interface([eventAbi])

  if (topic)
    topic = toFilterTopic(topic)
  else if (eventAbi)
    topic = toFilterTopic(eventAbi)

  let hasMore = true
  let logs: any[] = []

  const debugTimeKey = `Indexer-getLogs-${chain}-${topic}-${address}_${Math.random()}`
  if (debugMode) {
    debugLog('[Indexer] Pulling logs ' + debugTimeKey)
    console.time(debugTimeKey)
  }
  const addressSet = new Set(address?.split(','))
  const addressChunks = sliceIntoChunks(address?.split(',') ?? [], addressChunkSize)

  // to ensure that we have at least one chunk to process if no target is provided
  if (noTarget && addressChunks.length === 0) addressChunks.push(undefined as any)

  for (const chunk of addressChunks) {
    if (Array.isArray(chunk) && chunk.length === 0) {
      throw new Error('Address chunk cannot be empty')
    }

    let logCount = 0
    do {
      const params: any = {
        addresses: hasAddressFilter ? chunk.join(',') : undefined,
        chainId,
        topic0: topic,
        from_block: fromBlock,
        to_block: toBlock,
        topic1, topic2, topic3,
        limit, offset,
        noTarget,
      }
      const { data: { logs: _logs, totalCount } } = await axiosIndexer(`/logs`, { params, })

      // getLogs uses 'address' field to return log source, so we add the field here to make it compatible
      _logs.forEach((l: any) => {
        l.address = l.source
        const iswhitelisted = !addressSet.size || addressSet.has(l.source.toLowerCase())
        if (iswhitelisted) {
          logs.push(l)
        }
      })
      logCount += _logs.length

      offset += limit

      // If we have all the logs, or we have reached the limit, or there are no logs, we stop
      if (_logs.length < limit || totalCount <= logCount || _logs.length === 0) hasMore = false

    } while (all && hasMore)

  }


  if (debugMode) {
    console.timeEnd(debugTimeKey)
    debugLog('Logs pulled ' + chain, address, logs.length)
  }

  const mappedLogs = [] as any[]
  let addressIndexMap: any = {}
  const splitByAddress = targets?.length && !flatten
  if (splitByAddress) {
    for (let i = 0; i < targets!.length; i++) {
      addressIndexMap[targets![i].toLowerCase()] = i
      mappedLogs.push([])
    }
  }

  logs = logs.map((log: any) => {
    const source = log.source.toLowerCase()
    log.logIndex = log.log_index
    log.index = log.log_index
    log.transactionHash = log.transaction_hash
    log.blockNumber = log.block_number
    log.topics = [log.topic0, log.topic1, log.topic2, log.topic3,].filter(t => t !== '').map(i => ethers.zeroPadValue(i, 32))

    const deleteKeys = ['chain', 'block_number', 'log_index', 'topic0', 'topic1', 'topic2', 'topic3', 'decodedArgs', 'transaction_hash',]
    deleteKeys.forEach(k => delete log[k])
    const parsedLog = iface?.parseLog({ data: log.data, topics: log.topics, });

    log.args = parsedLog?.args
    log = !entireLog ? log.args : log
    if (entireLog && parseLog) log.parsedLog = parsedLog


    if (splitByAddress) {
      const index = addressIndexMap[source]
      mappedLogs[index].push(log)
    }
    return log
  })

  if (splitByAddress) return mappedLogs
  return logs
}

export function isIndexerEnabled(chain?: string) {
  if (!indexerURL) return false
  if (chain && !supportedChainSet.has(chain)) return false
  return true
}


export async function getTokenTransfers({ chain = 'ethereum', fromAddressFilter, fromBlock, toBlock, all = true, limit = 1000, offset = 0, target, targets = [], flatten = true, fromTimestamp, toTimestamp, debugMode = false, transferType = 'in', token, tokens, }: IndexerGetTokenTransfersOptions) {
  checkIndexerConfig()

  const chainId = chainToIDMapping[chain]
  if (!chainId) throw new Error('Chain not supported')
  if (!debugMode) debugMode = DEBUG_LEVEL2


  const fromFilterEnabled = fromAddressFilter && fromAddressFilter.length
  if (fromAddressFilter && typeof fromAddressFilter === 'string') fromAddressFilter = [fromAddressFilter]
  const fromFilterSet = new Set((fromAddressFilter ?? [] as any).map((a: string) => a.toLowerCase()))

  // if (!target && !targets?.length) throw new Error('target|targets is required')
  if (!fromBlock && !fromTimestamp) throw new Error('fromBlock or fromTimestamp is required')
  if (!toBlock && !toTimestamp) throw new Error('toBlock or toTimestamp is required')

  if (!fromBlock)
    fromBlock = await getBlockNumber(chain, fromTimestamp)

  if (!toBlock)
    toBlock = await getBlockNumber(chain, toTimestamp)

  if (!fromBlock || !toBlock) throw new Error('fromBlock and toBlock must be > 0')

  if (token) tokens = [token]

  if (tokens) {
    if (typeof tokens === 'string') tokens = [tokens]
    tokens = tokens.join(',').toLowerCase()
  }

  if (target) targets = [target]
  if (!targets.length) throw new Error('target|targets is required')
  targets = targets.map(t => t.toLowerCase())


  let addresses = targets.join(',')

  const chainIndexStatus = await getChainIndexStatus()
  const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0

  if (lastIndexedBlock < toBlock)
    throw new Error(`Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`)

  let hasMore = true
  let logs: any[] = []

  const debugTimeKey = `Indexer-tokenTransfers-${chain}-${addresses}_${Math.random()}`
  if (debugMode) {
    debugLog('[Indexer] Pulling token transfers ' + debugTimeKey)
    console.time(debugTimeKey)
  }

  do {
    const params: any = {
      addresses,
      chainId,
      from_block: fromBlock,
      to_block: toBlock,
      limit,
      offset,
      tokens,
      from_address: false,
      to_address: false,
    }

    switch (transferType) {
      case 'in':
        params.to_address = true
        break
      case 'out':
        params.from_address = true
        break
      case 'all':
        params.from_address = true
        params.to_address = true
        break
      default:
        throw new Error('Invalid transferType')
    }

    const { data: { transfers: _logs, totalCount } } = await axiosIndexer(`/token-transfers`, { params, })

    logs.push(..._logs)
    offset += limit

    // If we have all the logs, or we have reached the limit, or there are no logs, we stop
    if (_logs.length < limit || totalCount <= logs.length || _logs.length === 0) hasMore = false

  } while (all && hasMore)

  logs = logs.filter((l: any) => {
    if (!fromFilterEnabled) return true
    return fromFilterSet.has(l?.from_address.toLowerCase())
  })

  if (debugMode) {
    console.timeEnd(debugTimeKey)
    debugLog('Token Transfers pulled ' + chain, addresses, logs.length)
  }

  const mappedLogs = [] as any[]
  let addressIndexMap: any = {}
  const splitByAddress = targets?.length && !flatten
  if (splitByAddress) {
    for (let i = 0; i < targets!.length; i++) {
      addressIndexMap[targets![i]] = i
      mappedLogs.push([])
    }
  }

  if (splitByAddress) {
    logs.forEach((log: any) => {
      const sourceField = transferType === 'in' ? 'to_address' : 'from_address'
      const source = log[sourceField].toLowerCase()
      const index = addressIndexMap[source]
      mappedLogs[index].push(log)
    })
    return mappedLogs
  }

  return logs
}