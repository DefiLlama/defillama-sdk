import axios from "axios"
import { getEnvValue } from "./env"
import { readCache, writeCache } from "./cache"
import { debugLog } from "./debugLog"
import { getUniqueAddresses } from "../generalUtil"
import { ETHER_ADDRESS } from "../general"
import { Interface } from "ethers"
import { toFilterTopic } from "./logs"
import { Address } from "../types"
import { getBlockNumber } from "./blocks"

const indexerURL = getEnvValue('LLAMA_INDEXER_ENDPOINT')

const state: any = { chainIndexStatus: {} }
const cacheTime = 1 * 60 * 1000 // 1 minutes - we cache sync status for 1 minute

async function getChainIndexStatus() {

  if (!indexerURL) throw new Error('Llama Indexer URL not set')

  if (state.timestamp && (Date.now() - state.timestamp) < cacheTime)
    return state.data

  state.timestamp = Date.now()
  state.chainIndexStatus = _getState()

  return state.chainIndexStatus

  async function _getState() {
    const { data } = await axios.get(`${indexerURL}/syncStatus`)
    const syncInfo: any = {}

    data.forEach((d: any) => {
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
  43114: 'avalanche',
  59144: 'linea',
  81457: 'blast',
  534352: 'scroll',
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

export async function getTokens(address: string, { onlyWhitelisted = true, skipCacheRead = false, skipCache = false, chain, tokenType, }: {
  onlyWhitelisted?: boolean,
  skipCacheRead?: boolean,
  skipCache?: boolean,
  chain?: string,
  tokenType?: TokenTypes,
} = {}) {

  if (!indexerURL) throw new Error('Llama Indexer URL not set')


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
  debugLog('Pulling tokens for ' + address)

  const tokens = cache.tokens ?? {}
  const { data: { balances } } = await axios.get(`${indexerURL}/balances?address=${address}`, {
    params: {
      chain: chain,
      type: tokenType,
    }
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
}

export async function getLogs({ chain = 'ethereum', topic, topics, fromBlock, toBlock, all = true, limit = 1000, offset = 0, target, targets, eventAbi, entireLog = true, flatten = true, extraTopics, fromTimestamp, toTimestamp, }: IndexerGetLogsOptions) {
  if (!indexerURL) throw new Error('Llama Indexer URL not set')
  const chainId = chainToIDMapping[chain]
  if (!chainId) throw new Error('Chain not supported')
  
  if (topics?.length || extraTopics?.length)  throw new Error('TODO: topics and extraTopics part are not yet imeplemented')
  

  // if (!target && !targets?.length) throw new Error('target|targets is required')
  if (!fromBlock && !fromTimestamp) throw new Error('fromBlock or fromTimestamp is required')
  if (!toBlock && !toTimestamp) throw new Error('toBlock or toTimestamp is required')

  if (!fromBlock)
    fromBlock = await getBlockNumber(chain, fromTimestamp)

  if (!toBlock)
    toBlock = await getBlockNumber(chain, toTimestamp)

  if (!fromBlock || !toBlock) throw new Error('fromBlock and toBlock must be > 0')


  let address = target
  if (typeof target === 'string') targets = [target]
  if (Array.isArray(targets)) address = targets.join(',')

  if (address) address = address.toLowerCase()

  const chainIndexStatus = await getChainIndexStatus()
  const lastIndexedBlock = chainIndexStatus[chain].block

  if (lastIndexedBlock < toBlock)
    throw new Error(`Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`)

  debugLog('Pulling logs for ' + address)
  // Create an Interface object
  let iface: Interface
  if (eventAbi)
    iface = new Interface([eventAbi])

  if (topic)
    topic = toFilterTopic(topic)
  else if (eventAbi)
    topic = toFilterTopic(iface!)

  let hasMore = true
  let logs: any[] = []
  do {
    const params = {
      address,
      chain: chainId,
      topic0: topic,
      from_block: fromBlock,
      to_block: toBlock,
      limit,
      offset,
    }
    const { data: { logs: _logs, totalCount } } = await axios.get(`${indexerURL}/logs`, { params })

    logs.push(..._logs)
    offset += limit

    // If we have all the logs, or we have reached the limit, or there are no logs, we stop
    if (_logs.length < limit || totalCount <= logs.length || _logs.length === 0) hasMore = false

  } while (all && hasMore)

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
    log.logIndex = log.log_index
    log.index = log.log_index
    log.transactionHash = log.transaction_hash
    log.topics = [log.topic0, log.topic1, log.topic2, log.topic3,]
    const deleteKeys = ['chain', 'address', 'block_number', 'log_index', 'topic0', 'topic1', 'topic2', 'topic3', 'decodedArgs', 'transaction_hash',]
    deleteKeys.forEach(k => delete log[k])
    const parsedLogs = iface?.parseLog(log)
    log.args = parsedLogs?.args
    log = !entireLog ? log.args : log
    if (splitByAddress) {
      const index = addressIndexMap[log.source.toLowerCase()]
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