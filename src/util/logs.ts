import { getLogs as getLogsV1 } from ".";
import { EventLog, Interface, id } from "ethers";
import { Address } from "../types";
import { getBlockNumber } from "./blocks";
import { readCache, writeCache } from "./cache";
import { debugLog } from "./debugLog";
import { hexifyTarget } from "../abi/tron";

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
}

export async function getLogs(options: GetLogsOptions): Promise<EventLog[] | EventLog[][] | any[]> {
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
    skipCache = false,
    skipCacheRead = false,
    entireLog = false,
    cacheInCloud = false,
    onlyArgs = false,
    keys = [], //  [Deprecated] This is just used to select only part of the logs
    targets,
    flatten = true,
  } = options

  // if (!target && !targets?.length) throw new Error('target|targets is required')
  if (!fromBlock && !fromTimestamp) throw new Error('fromBlock or fromTimestamp is required')
  if (!toBlock && !toTimestamp) throw new Error('toBlock or toTimestamp is required')

  if (!fromBlock)
    fromBlock = await getBlockNumber(chain, fromTimestamp)

  if (!toBlock)
    toBlock = await getBlockNumber(chain, toTimestamp)

  if (!fromBlock || !toBlock) throw new Error('fromBlock and toBlock must be > 0')

  if (targets?.length) {
    const newOptions = { ...options, fromBlock, toBlock }
    delete newOptions.targets
    const res = await Promise.all(targets.map(i => getLogs({ ...newOptions, target: i })))
    if (flatten) return res.flat()
    return res
  }

  if (chain === 'tron')
    target = hexifyTarget(target!)


  let iface: Interface | undefined
  if (eventAbi)
    iface = new Interface([eventAbi])


  if ((!topics || !topics.length)) {
    if (topic)
      topic = toFilterTopic(topic)
    else if (eventAbi)
      topic = toFilterTopic(iface!)
    else {
      throw new Error('eventAbi | topic | topics are required')
    }
    topics = [topic]
    if (extraTopics) topics.push(...extraTopics)
  }

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
    logs.push(...cacheData.logs.filter((i: EventLog) => i.blockNumber >= fromBlock! && i.blockNumber <= toBlock!))
  }

  if (!eventAbi || entireLog) return logs
  return logs.map((i: any) => iface!.parseLog(i)).map((i: any) => onlyArgs ? i.args : i)

  async function addLogsToCache(fromBlock: number, toBlock: number) {
    debugLog('adding logs to cache: ', fromBlock, toBlock, target, topic)
    if (fromBlock > toBlock) return; // no data to add
    fromBlock = fromBlock - 10
    toBlock = toBlock + 10

    let { output: logs } = await getLogsV1({
      chain, target: target!, topic: topic as string, keys, topics, fromBlock, toBlock,
    })
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

  // we need to form filter topic with indexed keyword, else it messes up generated topic string
  function toFilterTopic(topic: string | Interface) {
    if (typeof topic === 'string') {
      if (topic.startsWith('0x')) return topic
      topic = new Interface([topic])
    }

    const fragment: any = topic.fragments[0]
    return id(`${fragment.name}(${fragment.inputs.map((i: any) => i.type).join(',')})`)
  }
}

export type logCache = {
  logs: EventLog[],
  metadata: {
    fromBlock: number,
    toBlock: number,
  }
}

export default getLogs