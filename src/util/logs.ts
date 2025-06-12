import { EventFragment, EventLog, Interface, ethers, id } from "ethers";
import { getLogs as getLogsV1 } from ".";
import { hexifyTarget } from "../abi/tron";
import { Address } from "../types";
import { getBlockNumber } from "./blocks";
import { readCache, writeCache } from "./cache";
import { DEBUG_LEVEL2, debugLog } from "./debugLog";
import { getLogs as getIndexerLogs, IndexerGetLogsOptions, isIndexerEnabled } from "./indexer";
import runInPromisePool from "./promisePool";

const currentVersion = 'v3'

export type GetLogsOptions = {
  target?: Address;
  topic?: string;
  keys?: string[]; // This is just used to select only part of the logs
  fromBlock?: number;
  toBlock?: number;
  topics?: (string | null)[];
  extraTopics?: string[];
  chain?: string;
  eventAbi?: string | any;
  fromTimestamp?: number;
  toTimestamp?: number;
  skipCache?: boolean;
  skipCacheRead?: boolean;
  entireLog?: boolean;
  cacheInCloud?: boolean;
  onlyArgs?: boolean;
  targets?: Address[];
  flatten?: boolean;
  skipIndexer?: boolean;
  onlyIndexer?: boolean;
  debugMode?: boolean;
  noTarget?: boolean;  // we sometimes want to query logs without a target, but it will an be expensive bug if target/targets were not passed by mistake, so this is a safety check
  parseLog?: boolean;
  processor?: (logs: any[]) => Promise<void> | void;  // if processor arg is provided, we return empty array as response
  maxBlockRange?: number;
  allowParseFailure?: boolean; // if true, it will not throw an error if parsing fails, but will return raw logs instead
}

export async function getLogs(options: GetLogsOptions): Promise<EventLog[] | EventLog[][] | any[]> {
  let {
    target,
    skipCache = false,
    skipCacheRead = false,
    cacheInCloud = false,
    keys = [], //  [Deprecated] This is just used to select only part of the logs
    targets,
    flatten = true,
    skipIndexer = false,
    onlyIndexer = false,
    debugMode = false,
    processor,
    maxBlockRange,
  } = options

  const { fromBlock, toBlock, topics, topic, transformLog, chain } = await getLogParams(options, false)

  if (!skipIndexer && isIndexerEnabled(chain)) {
    try {
      const response = await getIndexerLogs({
        ...options,
        all: true
      })
      return response
    } catch (e) {
      let message = (e as any)?.message
      debugLog('Error in  indexer getLogs', message)
    }
  }
  if (!debugMode) debugMode = DEBUG_LEVEL2

  if (onlyIndexer) throw new Error('onlyIndexer is true, but indexer is not enabled or threw an error')



  const blockRange = toBlock - fromBlock
  if (maxBlockRange && blockRange > maxBlockRange) {
    const results: any[][] = []
    for (let currentFromBlock = fromBlock; currentFromBlock <= toBlock; currentFromBlock += maxBlockRange) {
      const currentToBlock = Math.min(currentFromBlock + maxBlockRange - 1, toBlock)
      const chunk = await getLogs({ ...options, fromBlock: currentFromBlock, toBlock: currentToBlock })
      results.push(chunk)
    }
    return flatten ? results.flat() : results
  }

  if (targets?.length) {
    const newOptions = { ...options, fromBlock, toBlock }
    delete newOptions.targets
    const processor = (target: any) => getLogs({ ...newOptions, target, skipIndexer: true, })
    // we are using a promise pool to limit the number of concurrent requests
    // and not using @supercharge/promise-pool directly because it does not preserve the order of results
    const res = await runInPromisePool({ items: targets, concurrency: 5, processor })
    if (flatten) return res.flat()
    return res
  }

  if (chain === 'tron')
    target = hexifyTarget(target!)

  let caches = (await _getCache() as logCache[])

  const isFirstRun = !caches.length

  if (isFirstRun || skipCacheRead) {
    await addLogsToCache(fromBlock!, toBlock!)
  } else {
    let _fromBlock = fromBlock // we need to keep a copy of fromBlock as it will be modified
    let _toBlock = toBlock // we need to keep a copy of toBlock as it will be modified
    const firstCache = caches[0]
    const lastCache = caches[caches.length - 1]
    for (const cacheData of caches) {
      const { fromBlock: cFirstBlock, toBlock: cToBlock } = cacheData.metadata
      if (_toBlock < firstCache.metadata.fromBlock || _fromBlock > lastCache.metadata.toBlock) {  // no intersection with any cache
        await addLogsToCache(_fromBlock, _toBlock)
        break;
      }

      if (_fromBlock >= cToBlock) continue; // request is after cache end
      if (_fromBlock <= cFirstBlock) { // request is before cache start
        await addLogsToCache(_fromBlock, Math.min(_toBlock, cFirstBlock - 1))
      }
      if (_toBlock <= cToBlock) { // request ends before cache end
        _fromBlock = cToBlock;
        break;
      }
      _fromBlock = cToBlock
    }
    if (_fromBlock < _toBlock)
      await addLogsToCache(_fromBlock, _toBlock);
  }

  const logs = []
  for (const cacheData of caches) {
    const { fromBlock: cFirstBlock, toBlock: cToBlock } = cacheData.metadata
    if (fromBlock! > cToBlock || toBlock! < cFirstBlock) continue; // no intersection with cache
    const filteredLogs = cacheData.logs.filter((i: EventLog) => i.blockNumber >= fromBlock! && i.blockNumber <= toBlock!).map(transformLog)
    if (processor)
      await processor(filteredLogs)
    else
      logs.push(...filteredLogs)
  }

  return logs

  async function addLogsToCache(fromBlock: number, toBlock: number) {
    const debugTimeKey = `getLogs-${chain}-${topic}-${target}_${Math.random()}-${fromBlock}-${toBlock}`
    if (debugMode)
      debugLog('adding logs to cache: ', fromBlock, toBlock, target, topic, chain,)

    if (fromBlock > toBlock) return; // no data to add
    fromBlock = fromBlock - 10
    toBlock = toBlock + 10

    if (debugMode)
      console.time(debugTimeKey)

    let { output: logs } = await getLogsV1({
      chain, target: target!, topic: topic as string, keys, topics, fromBlock, toBlock,
    })

    if (debugMode) {
      console.timeEnd(debugTimeKey)
      debugLog('Logs pulled ' + chain, target, logs.length)
    }

    caches.push({
      logs,
      metadata: { fromBlock, toBlock, }
    })
    caches.sort((a, b) => a.metadata.fromBlock - b.metadata.fromBlock)
    const mergedCaches = [caches[0]] as logCache[]
    caches.slice(1).forEach(i => {
      const last = mergedCaches[mergedCaches.length - 1]
      if (last.metadata.toBlock + 1 > i.metadata.fromBlock) {
        last.metadata.toBlock = i.metadata.toBlock
        last.logs = dedupLogs(last.logs, i.logs)
      } else {
        mergedCaches.push(i)
      }
    })
    caches = mergedCaches

    if (!skipCache)
      await writeCache(getFile(), { caches, version: currentVersion }, { skipR2CacheWrite: !cacheInCloud })
  }

  function dedupLogs(...logs: EventLog[][]) {
    const logIndices = new Set()
    return logs.flat().filter((i: EventLog) => {
      let key = i.transactionHash + ((i as any).logIndex ?? i.index) // ethers v5 had logIndex, ethers v6 has index
      if (!(i.hasOwnProperty('logIndex') || i.hasOwnProperty('index')) || !i.hasOwnProperty('transactionHash')) {
        debugLog(i, (i as any).logIndex, i.index, i.transactionHash)
        throw new Error('Missing crucial field: logIndex/index')
      }
      if (logIndices.has(key)) return false
      logIndices.add(key)
      return true
    })
  }

  async function _getCache(): Promise<logCache[]> {
    const key = getFile()
    const defaultRes = [] as logCache[]

    if (skipCache) return defaultRes

    let cache = await readCache(key, { skipR2Cache: !cacheInCloud })

    if (!cache.caches || !cache.caches.length || cache.version !== currentVersion)
      return defaultRes

    return cache.caches
  }

  function getFile() {
    let extraKey = topics?.join('-').toLowerCase()
    if (!extraKey) throw new Error('extraKey is required')
    if (keys.length) extraKey += '-' + keys.join('-').toLowerCase()

    return `event-logs/${chain}/${target?.toLowerCase() ?? null}-${extraKey}`
  }

}

export function toFilterTopic(topic: string): string {
  if (typeof topic === 'string' && topic.startsWith('0x')) {
    return topic
  }

  const fragment = EventFragment.from(topic)
  return id(fragment.format())
}

export type logCache = {
  logs: EventLog[],
  metadata: {
    fromBlock: number,
    toBlock: number,
  }
}

export default getLogs



type GetLogsParamsResponse = {
  chain: string,
  fromBlock: number;
  toBlock: number;
  target?: Address;
  topic: string;
  iface?: Interface;
  transformLog: (log: any) => any;
  topics?: (string | null)[];
  topic1?: string;
  topic2?: string;
  topic3?: string;
}

// takes care of validation and formatting of the parameters
// logic is common for event log queries to both the indexer and the rpc
export async function getLogParams(options: GetLogsOptions | IndexerGetLogsOptions, isIndexerCall = false): Promise<GetLogsParamsResponse> {
  let {
    target,
    chain = 'ethereum',
    fromBlock,
    toBlock,
    fromTimestamp,
    toTimestamp,
    eventAbi,
    topic,
    topics,
    extraTopics, // can be passed as input as extra filter arguments
    entireLog = false,
    onlyArgs = false,
    targets = [],
    noTarget = false,  // we sometimes want to query logs without a target, but it will an be expensive bug if target/targets were not passed by mistake, so this is a safety check
    parseLog = false,    // if processor arg is provided, we return empty array as response
    allowParseFailure = false,
    processor,
    flatten = false,
  } = options

  // I think I was bit mad when I added entireLog field, but it needs to be maintained for backward compatibility
  // I think the purpose was to get the raw log along with transaction hash and block number and other metadata instead of just data & topics field
  if (entireLog) onlyArgs = false

  if (processor && targets.length > 1 && !flatten)
    throw new Error('processor is not supported with multiple targets and flatten is false')


  if (!fromBlock && !fromTimestamp) throw new Error('fromBlock or fromTimestamp is required')
  if (!toBlock && !toTimestamp) throw new Error('toBlock or toTimestamp is required')

  if (!fromBlock)
    fromBlock = await getBlockNumber(chain, fromTimestamp)

  if (!toBlock)
    toBlock = await getBlockNumber(chain, toTimestamp)

  if (!fromBlock || !toBlock) throw new Error('fromBlock and toBlock must be > 0')

  if (!noTarget && !target && !targets.length) {
    throw new Error('target|targets is required or set the flag "noTarget" to true')
  }


  let iface: Interface | undefined
  if (eventAbi)
    iface = new Interface([eventAbi])

  if ((!topics || !topics.length)) {
    if (topic)
      topic = toFilterTopic(topic)
    else if (eventAbi)
      topic = toFilterTopic(eventAbi)
    else {
      throw new Error('eventAbi | topic | topics are required')
    }
    topics = [topic]
    if (extraTopics) topics.push(...extraTopics)
  }
  if (topics?.length) topic = topics[0] as string

  return {
    chain,
    fromBlock,
    toBlock,
    target,
    topic: topic!,
    topic1: topics[1] as string,
    topic2: topics[2] as string,
    topic3: topics[3] as string,
    iface,
    transformLog,
    topics,
  }


  function transformLog(log: any) {
    if (isIndexerCall) {
      log.address = log.source
      log.logIndex = log.log_index
      log.index = log.log_index
      log.transactionHash = log.transaction_hash
      log.blockNumber = log.block_number
      log.topics = [log.topic0, log.topic1, log.topic2, log.topic3]
        .filter(Boolean)
        .map((i: string) => i.startsWith('0x') ? i : `0x${i}`)
        .map((i: string) => ethers.zeroPadValue(i, 32))


      // remove indexer specific keys
      const deleteKeys = ['chain', 'block_number', 'log_index', 'topic0', 'topic1', 'topic2', 'topic3', 'decodedArgs', 'transaction_hash',]
      deleteKeys.forEach(k => delete log[k])
    }

    if ((entireLog && !parseLog) || !iface) return log // if parseLog is false, we just return the raw log

    try {
      const parsedLog = iface.parseLog(log)
      if (!parsedLog && !allowParseFailure) throw new Error(`Failed to parse log: ${JSON.stringify(log.transactionHash)}`)
      log.args = (parsedLog ?? {}).args
      if (entireLog) log.parsedLog = parsedLog
    } catch (e) {
      if (allowParseFailure) {
        debugLog('Failed to parse log', e, log)
        log.args = log
      } else throw e
    }

    if (onlyArgs) return log.args;
    return log
  }
}
