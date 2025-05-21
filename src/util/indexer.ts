import axios from "axios"
import { Interface, ethers } from "ethers"
import { sliceIntoChunks } from "."
import { ETHER_ADDRESS } from "../general"
import { getUniqueAddresses } from "../generalUtil"
import { Address } from "../types"
import { getBlockNumber } from "./blocks"
import { readCache, writeCache } from "./cache"
import { DEBUG_LEVEL2, debugLog } from "./debugLog"
import { getEnvValue } from "./env"
import { toFilterTopic } from "./logs"

const indexerURL = getEnvValue('LLAMA_INDEXER_ENDPOINT')
const LLAMA_INDEXER_API_KEY = getEnvValue('LLAMA_INDEXER_API_KEY')
const LLAMA_INDEXER_V2_ENDPOINT = getEnvValue('LLAMA_INDEXER_V2_ENDPOINT')
const LLAMA_INDEXER_V2_API_KEY = getEnvValue('LLAMA_INDEXER_V2_API_KEY')
const addressChunkSize = +getEnvValue('LLAMA_INDEXER_ADDRESS_CHUNK_SIZE')!

const indexerChainIdChainMapping: { [key: number]: string } = {
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
  146: 'sonic',
};

const indexer2ChainIdChainMapping: { [key: number]: string } = {
  ...indexerChainIdChainMapping,
  130: 'unichain',
  1868: 'soneium',
  80094: 'berachain'
};

type ChainIndexStatus = { [chain: string]: { block: number, timestamp: number } };
const state: {
  timestamp?: number;
  chainIndexStatus: ChainIndexStatus | Promise<ChainIndexStatus>;
} = { chainIndexStatus: {} };

const cacheTime = 1 * 60 * 1000; // 1 minutes - we cache sync status for 1 minute

async function getChainIndexStatus(version: 'v1' | 'v2' = 'v1'): Promise<ChainIndexStatus> {
  checkIndexerConfig(version);

  if (state.timestamp && (Date.now() - state.timestamp) < cacheTime)
    return state.chainIndexStatus;

  state.timestamp = Date.now();
  state.chainIndexStatus = _getState();

  return state.chainIndexStatus;

  async function _getState() {
    const { data: { syncStatus } } = await axiosInstances[version].get(`/sync`);
    const syncInfo: ChainIndexStatus = {};

    syncStatus.forEach((d: any) => {
      const chain = indexerConfigs[version].chainMapping[d.chain];
      if (chain) {
        syncInfo[chain] = {
          block: d.lastIndexedBlock,
          timestamp: +new Date(d.lastIndexedDate)
        };
      }
    });

    state.chainIndexStatus = syncInfo;
    return syncInfo;
  }
}

interface IndexerConfig {
  endpoint: string;
  apiKey: string;
  chainMapping: { [key: number]: string };
}

const indexerConfigs: Record<'v1' | 'v2', IndexerConfig> = {
  v1: {
    endpoint: indexerURL,
    apiKey: LLAMA_INDEXER_API_KEY,
    chainMapping: indexerChainIdChainMapping
  },
  v2: {
    endpoint: LLAMA_INDEXER_V2_ENDPOINT,
    apiKey: LLAMA_INDEXER_V2_API_KEY,
    chainMapping: indexer2ChainIdChainMapping
  }
} as const;

const axiosInstances = {
  v1: axios.create({
    headers: { "x-api-key": indexerConfigs.v1.apiKey },
    baseURL: indexerConfigs.v1.endpoint,
  }),
  v2: axios.create({
    headers: { "x-api-key": indexerConfigs.v2.apiKey },
    baseURL: indexerConfigs.v2.endpoint,
  })
};

function checkIndexerConfig(version: 'v1' | 'v2') {
  const config = indexerConfigs[version];
  if (!config.endpoint || !config.apiKey) 
    throw new Error(`Llama Indexer ${version} URL/api key is not set`);
}

function getChainId(chain: string, version: 'v1' | 'v2' = 'v1'): number {
  const chainId = Object.entries(indexerConfigs[version].chainMapping)
    .find(([_, chainName]) => chainName === chain)?.[0];
  if (!chainId) throw new Error('Chain not supported');
  return +chainId;
}

function getSupportedChains(version: 'v1' | 'v2' = 'v1'): Set<string> {
  return new Set(Object.values(indexerConfigs[version].chainMapping));
}

export const supportedChainSet = getSupportedChains('v1');
export const supportedChainSet2 = getSupportedChains('v2');

const chainToIDMapping: any = {}
Object.entries(indexerConfigs.v1.chainMapping).forEach(([id, chain]: any) => {
  chainToIDMapping[chain] = id
})

const chainToIDMapping2: any = {}
Object.entries(indexerConfigs.v2.chainMapping).forEach(([id, chain]: any) => {
  chainToIDMapping2[chain] = id
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

  checkIndexerConfig('v1')
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
  const { data: { balances } } = await axiosInstances.v1(`/balances`, {
    params: {
      addresses: address,
      chainId,
      type: tokenType,
    },
  })
  balances.filter((b: any) => +b.total_amount > 0).forEach((b: any) => {
    const chain = indexerConfigs.v1.chainMapping[b.chain]
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

async function getIndexerVersionForBlock(chain: string, blockNumber: number): Promise<'v1' | 'v2'> {
  if (!isIndexer2Enabled(chain)) {
    if (!isIndexerEnabled(chain)) {
      throw new Error(`Indexer not enabled for chain ${chain}`)
    }
    return 'v1';
  }
  
  const syncStatus = await getChainIndexStatus('v2');
  const lastIndexedBlock = syncStatus[chain]?.block ?? 0;
  
  if (lastIndexedBlock >= blockNumber) {
    return 'v2';
  }

  if (!isIndexerEnabled(chain)) {
    throw new Error(`Indexer not enabled for chain ${chain}`)
  }
  return 'v1';
}

async function executeWithFallback<T>(
  chain: string,
  blockNumber: number,
  v2Fn: () => Promise<T>,
  v1Fn: () => Promise<T>
): Promise<T> {
  const version = await getIndexerVersionForBlock(chain, blockNumber);
  try {
    return version === 'v2' ? await v2Fn() : await v1Fn();
  } catch (error) {
    if (version === 'v2') {
      console.log(`Fallback to v1 for chain ${chain} due to error:`, error);
      return v1Fn();
    }
    throw error;
  }
}

export async function getLogs({ chain = 'ethereum', topic, topics, fromBlock, toBlock, all = true, limit = 1000, offset = 0, target, targets, eventAbi, entireLog = false, flatten = true, extraTopics, fromTimestamp, toTimestamp, debugMode = false, noTarget = false, parseLog = true, }: IndexerGetLogsOptions) {
  if (!debugMode) debugMode = DEBUG_LEVEL2

  const version = await getIndexerVersionForBlock(chain, toBlock ?? 0)
  checkIndexerConfig(version)
  const chainId = getChainId(chain, version)

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

  if (!noTarget && !target && !targets?.length)
    throw new Error('target|targets is required or set the flag "noTarget" to true')

  if (!fromBlock && !fromTimestamp) throw new Error('fromBlock or fromTimestamp is required')
  if (!toBlock && !toTimestamp) throw new Error('toBlock or toTimestamp is required')

  if (!fromBlock)
    fromBlock = await getBlockNumber(chain, fromTimestamp)

  if (!toBlock)
    toBlock = await getBlockNumber(chain, toTimestamp)

  if (!fromBlock || !toBlock) throw new Error('fromBlock and toBlock must be > 0')

  if (version === 'v1') {
    const chainIndexStatus = await getChainIndexStatus('v1')
    const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0

    if (lastIndexedBlock < toBlock)
      throw new Error(`Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`)
  }

  let address = target
  if (typeof target === 'string') targets = [target]
  if (Array.isArray(targets)) address = targets.join(',')

  const hasAddressFilter = address && address.length

  if (address) address = address.toLowerCase()

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
      const { data: { logs: _logs, totalCount } } = await executeWithFallback(
        chain,
        toBlock,
        () => axiosInstances.v2(`/logs`, { params }),
        () => axiosInstances.v1(`/logs`, { params })
      );

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
  if (!indexerConfigs.v1.endpoint) return false
  if (chain && !supportedChainSet.has(chain)) return false
  return true
}

export function isIndexer2Enabled(chain?: string) {
  if (!indexerConfigs.v2.endpoint) return false
  if (chain && !supportedChainSet2.has(chain)) return false
  return true
}

export async function getTokenTransfers({ chain = 'ethereum', fromAddressFilter, fromBlock, toBlock, all = true, limit = 1000, offset = 0, target, targets = [], flatten = true, fromTimestamp, toTimestamp, debugMode = false, transferType = 'in', token, tokens, }: IndexerGetTokenTransfersOptions) {
  if (!debugMode) debugMode = DEBUG_LEVEL2

  const version = await getIndexerVersionForBlock(chain, toBlock ?? 0)
  checkIndexerConfig(version)
  const chainId = getChainId(chain, version)

  const fromFilterEnabled = fromAddressFilter && fromAddressFilter.length
  if (fromAddressFilter && typeof fromAddressFilter === 'string') fromAddressFilter = [fromAddressFilter]
  const fromFilterSet = new Set((fromAddressFilter ?? [] as any).map((a: string) => a.toLowerCase()))

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

  if (version === 'v1') {
    const chainIndexStatus = await getChainIndexStatus('v1')
    const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0

    if (lastIndexedBlock < toBlock)
      throw new Error(`Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`)
  }

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

    const { data: { transfers: _logs, totalCount } } = await executeWithFallback(
      chain,
      toBlock,
      () => axiosInstances.v2(`/token-transfers`, { params }),
      () => axiosInstances.v1(`/token-transfers`, { params })
    );

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

export async function getTransaction(tx: string, chain: string = 'ethereum') {
  checkIndexerConfig('v2')
  const chainId = getChainId(chain, 'v2')

  const { data: { transactions } } = await axiosInstances.v2(`/transactions`, {
    params: {
      chainId,
      transaction_hashes: tx,
    },
  })

  if (!transactions?.length) return null

  const transaction = transactions[0]

  return {
    hash: transaction.hash,
    blockNumber: parseInt(transaction.block_number),
    transactionIndex: parseInt(transaction.transaction_index),
    from: transaction.from_address,
    to: transaction.to_address,
    value: transaction.value,
    gasPrice: transaction.gas_price,
    gas: transaction.gas,
    input: transaction.input,
    nonce: parseInt(transaction.nonce),
    data: transaction.input,
    type: transaction.transaction_type,
    maxFeePerGas: transaction.max_fee_per_gas,
    maxPriorityFeePerGas: transaction.max_priority_fee_per_gas,
    baseFeePerGas: transaction.base_fee_per_gas,
    effectiveGasPrice: transaction.effective_gas_price,
    gasUsed: transaction.gas_used,
    cumulativeGasUsed: transaction.cumulative_gas_used,
    status: transaction.status === 'success' ? 1 : 0,
    contractCreated: transaction.contract_created || undefined,
    timestamp: transaction.timestamp,
  }
}