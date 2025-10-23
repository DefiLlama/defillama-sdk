import { ethers, EventFragment, EventLog, id, Interface } from "ethers";
import { getLogs as getLogsV1 } from ".";
import { Address } from "../types";
import { getBlockNumber } from "./blocks";
import { readCache, writeCache } from "./cache";
import { DEBUG_LEVEL2, debugLog } from "./debugLog";
import {
  getLogs as getIndexerLogs,
  IndexerGetLogsOptions,
  isIndexerEnabled,
} from "./indexer";
import runInPromisePool from "./promisePool";
import { logGetLogsDebug } from "./env";
import { getHash, tronToEvmAddress } from "./common";

const currentVersion = "v3";

/* -------------------------------------------------------------------------- */
/*                                   Types                                    */
/* -------------------------------------------------------------------------- */

export type GetLogsOptions = {
  target?: Address;
  topic?: string;
  keys?: string[];
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
  noTarget?: boolean;
  parseLog?: boolean;
  processor?: (logs: any[]) => Promise<void> | void;
  maxBlockRange?: number;
  allowParseFailure?: boolean;
};

/* -------------------------------------------------------------------------- */
/*                                   getLogs                                  */
/* -------------------------------------------------------------------------- */

export async function getLogs(
  options: GetLogsOptions
): Promise<EventLog[] | EventLog[][] | any[]> {
  let {
    target,
    skipCache = false,
    skipCacheRead = false,
    cacheInCloud = false,
    keys = [],
    targets,
    flatten = true,
    skipIndexer = false,
    onlyIndexer = false,
    debugMode = false,
    processor,
    maxBlockRange,
  } = options;

  const { fromBlock, toBlock, topics, topic, transformLog, chain } =
    await getLogParams(options, false);

  /* ----------------------------- Indexer path ----------------------------- */

  // If the caller demands indexer only but it is disabled, fail fast
  if (onlyIndexer && !isIndexerEnabled(chain))
    throw new Error("onlyIndexer is true, but indexer is not enabled");

  if (!skipIndexer && isIndexerEnabled(chain)) {
    try {
      const response = await getIndexerLogs({
        ...options,
        all: true, // internal service – always fetch full set
        parseLog: options.parseLog,
        eventAbi: options.eventAbi,
        onlyArgs: options.onlyArgs,
      });
      return response;
    } catch (e) {
      debugLog("Error in indexer getLogs", (e as Error).message);
      // If caller insisted on indexer only, propagate the error
      if (onlyIndexer) throw e;
      // Otherwise continue with RPC fallback
    }
  }

  if (!debugMode) debugMode = DEBUG_LEVEL2 && logGetLogsDebug

  /* ----------------------- Split by maxBlockRange ------------------------- */

  const blockRange = toBlock - fromBlock;
  if (maxBlockRange && blockRange > maxBlockRange) {
    const results: any[][] = [];
    for (
      let currentFromBlock = fromBlock;
      currentFromBlock <= toBlock;
      currentFromBlock += maxBlockRange
    ) {
      const currentToBlock = Math.min(
        currentFromBlock + maxBlockRange - 1,
        toBlock
      );
      const chunk = await getLogs({
        ...options,
        fromBlock: currentFromBlock,
        toBlock: currentToBlock,
      });
      results.push(chunk);
    }
    return flatten ? results.flat() : results;
  }

  /* ------------------------ Multi-target parallel ------------------------- */

  if (targets?.length) {
    const baseOpts = { ...options, fromBlock, toBlock, skipIndexer: true };
    delete baseOpts.targets;

    const jobs = targets.map((address, idx) => ({ idx, address }));

    const proc = async (job: { idx: number; address: Address }) => {
      const logs = await getLogs({ ...baseOpts, target: job.address });
      return { idx: job.idx, logs };
    };

    const results = await runInPromisePool({ items: jobs, concurrency: 5, processor: proc });

    const ordered: any[][] = new Array(targets.length);
    for (const { idx, logs } of results) ordered[idx] = logs;

    return flatten ? ordered.flat() : ordered;
  }

  /* ----------------------------- RPC fallback ----------------------------- */

  if (chain === "tron") target = tronToEvmAddress(target!);

  let caches = (await _getCache()) as logCache[];
  const firstRun = !caches.length;

  if (firstRun || skipCacheRead) {
    await addLogsToCache(fromBlock!, toBlock!);
  } else {
    // try to fill gaps compared to what is already cached
    let _from = fromBlock;
    let _to = toBlock;
    const firstCache = caches[0];
    const lastCache = caches[caches.length - 1];

    for (const c of caches) {
      const { fromBlock: cStart, toBlock: cEnd } = c.metadata;

      if (_to < firstCache.metadata.fromBlock || _from > lastCache.metadata.toBlock) {
        await addLogsToCache(_from, _to);
        break;
      }

      if (_from >= cEnd) continue;
      if (_from <= cStart) {
        await addLogsToCache(_from, Math.min(_to, cStart - 1));
      }
      if (_to <= cEnd) {
        _from = cEnd;
        break;
      }
      _from = cEnd;
    }
    if (_from < _to) await addLogsToCache(_from, _to);
  }

  /* ---------------------------- Return result ----------------------------- */

  let out: any[] = [];
  for (const c of caches) {
    const { fromBlock: cStart, toBlock: cEnd } = c.metadata;
    if (fromBlock! > cEnd || toBlock! < cStart) continue;

    const filtered = c.logs
      .filter((i: EventLog) => i.blockNumber >= fromBlock! && i.blockNumber <= toBlock!)
      .map(transformLog);

    if (processor) await processor(filtered);
    // Always include filtered logs in the return value, even when a processor is provided
    out = out.concat(filtered); // use concat instead of ... to avoid running into issues with large arrays (RangeError: Maximum call stack size exceeded)
  }

  return out;

  /* ----------------------------------------------------------------------- */
  /*                         Internal helper functions                       */
  /* ----------------------------------------------------------------------- */

  async function addLogsToCache(fromBlock: number, toBlock: number) {
    const dbgKey = `getLogs-${chain}-${topic}-${target}_${Math.random()}-${fromBlock}-${toBlock}`;
    if (debugMode) debugLog("adding logs to cache:", fromBlock, toBlock);

    if (fromBlock > toBlock) return;
    fromBlock = Math.max(fromBlock - 10, 0); // avoid negative block
    toBlock = toBlock + 10;

    if (debugMode) console.time(dbgKey);

    const { output: newLogs } = await getLogsV1({
      chain,
      target: target!,
      topic: topic as string,
      keys,
      topics,
      fromBlock,
      toBlock,
    });

    if (debugMode) {
      console.timeEnd(dbgKey);
      debugLog("Logs pulled", chain, target, newLogs.length);
    }

    caches.push({ logs: newLogs, metadata: { fromBlock, toBlock } });
    caches.sort((a, b) => a.metadata.fromBlock - b.metadata.fromBlock);

    // merge overlapping ranges
    const merged: logCache[] = [caches[0]];
    caches.slice(1).forEach((c) => {
      const last = merged[merged.length - 1];
      if (last.metadata.toBlock + 1 > c.metadata.fromBlock) {
        last.metadata.toBlock = c.metadata.toBlock;
        last.logs = dedupLogs(last.logs, c.logs);
      } else merged.push(c);
    });
    caches = merged;

    if (!skipCache) {
      let storeCaches = caches;
      let randomLogLength = 0
      const totalLogCount = caches.reduce((acc, c) => {
        if (c.logs.length) randomLogLength = JSON.stringify(c.logs[0]).length
        return acc + c.logs.length
      }, 0);
      const fileSizeInMB = (totalLogCount * randomLogLength) / (1024 * 1024)
      if (fileSizeInMB > 300) { // if cache size is larger than ~300MB, trim it down
        console.log(`getLogs: large cache size detected ${totalLogCount} logs size: ${fileSizeInMB}MB, retaining only the latest 200k logs to limit memory usage target=${target} topic=${topic} fromBlock=${fromBlock} toBlock=${toBlock}`);

        // retain only the latest logs that fit within 300,000 logs
        if (caches.length > 1) {
          let cacheWithLatestFromBlock = caches[0]
          for (const c of caches) {
            if (c.metadata.fromBlock > cacheWithLatestFromBlock.metadata.fromBlock) {
              cacheWithLatestFromBlock = c
            }
          }

          storeCaches = [cacheWithLatestFromBlock]
        }

        storeCaches = storeCaches.map(c => {
          const clone: any = { logs: [], metadata: JSON.parse(JSON.stringify(c.metadata)) }
          if (c.logs.length > 200_000) {
            // sort the logs by block number descending and keep only the latest 200k logs
            c.logs.sort((a, b) => b.blockNumber - a.blockNumber)
            clone.logs = c.logs.slice(0, 200_000)
            const lastLog = clone.logs[clone.logs.length - 1]
            clone.metadata.fromBlock = lastLog.blockNumber
          }
          return clone
        })
      }

      // we are skipping compression by default, so reads & writes are faster
      await writeCache(getFile(), { caches: storeCaches, version: currentVersion }, { skipR2CacheWrite: !cacheInCloud, skipCompression: !cacheInCloud })
    }
  }

  function dedupLogs(...arr: EventLog[][]) {
    const seen = new Set();
    return arr.flat().filter((i: EventLog) => {
      const key = `${i.transactionHash}-${(i as any).logIndex ?? i.index}`;
      if (
        !(
          i.hasOwnProperty("logIndex") ||
          i.hasOwnProperty("index")
        ) ||
        !i.hasOwnProperty("transactionHash")
      ) {
        debugLog("Missing crucial field", i);
        throw new Error("Missing crucial field: logIndex/index");
      }
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  async function _getCache(): Promise<logCache[]> {
    const key = getFile();
    const def: logCache[] = [];
    if (skipCache) return def;

    let cache = await readCache(key, { skipR2Cache: !cacheInCloud, skipCompression: !cacheInCloud, })

    if (!cache.caches || !cache.caches.length || cache.version !== currentVersion)
      return def

    return cache.caches
  }

  function getFile() {
    let extraKey = topics?.join("-").toLowerCase();
    if (!extraKey) throw new Error("extraKey is required");
    if (keys.length) extraKey += "-" + keys.join("-").toLowerCase();
    let file = `${target?.toLowerCase() ?? null}-${extraKey}`

    const normalKeyLength = '0x27e5cb712334e101b3c232eb0be198baaa595f5f-0xe8137aa901976cc8eaf1cef5dec491873faadc99d9720ccaec95673294a9d7c5-uncompressed'.length

    // sometimes, there is a lot of topics and we hit the file name length limit
    if (file.length > normalKeyLength) 
      file = getHash(file)


    return `event-logs/${chain}/${file}`;
  }
}

/* -------------------------------------------------------------------------- */
/*                           Utility helpers exported                         */
/* -------------------------------------------------------------------------- */

export function toFilterTopic(topic: string): string {
  if (topic.startsWith("0x")) return topic;
  const fragment = EventFragment.from(topic);
  return id(fragment.format());
}

export type logCache = {
  logs: EventLog[];
  metadata: { fromBlock: number; toBlock: number };
};

export default getLogs;

/* -------------------------------------------------------------------------- */
/*                         getLogParams                                       */
/* -------------------------------------------------------------------------- */

type GetLogsParamsResponse = {
  chain: string;
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
};

export async function getLogParams(
  options: GetLogsOptions | IndexerGetLogsOptions,
  isIndexerCall = false
): Promise<GetLogsParamsResponse> {
  let {
    target,
    chain = "ethereum",
    fromBlock,
    toBlock,
    fromTimestamp,
    toTimestamp,
    eventAbi,
    topic,
    topics,
    extraTopics,
    entireLog = false,
    onlyArgs = false,
    targets = [],
    noTarget = false,
    parseLog = false,
    allowParseFailure = false,
    processor,
    flatten = false,
  } = options;

  if (eventAbi && !Object.prototype.hasOwnProperty.call(options, "parseLog"))
    parseLog = true;

  // keep raw log if entireLog=true
  if (entireLog) onlyArgs = false;

  if (processor && targets.length > 1 && !flatten)
    throw new Error("processor is not supported with multiple targets when flatten=false");

  if (!fromBlock && !fromTimestamp)
    throw new Error("fromBlock or fromTimestamp is required");
  if (!toBlock && !toTimestamp)
    throw new Error("toBlock or toTimestamp is required");

  if (!fromBlock) fromBlock = await getBlockNumber(chain, fromTimestamp);
  if (!toBlock) toBlock = await getBlockNumber(chain, toTimestamp);
  if (!fromBlock || !toBlock)
    throw new Error("fromBlock and toBlock must be > 0");

  if (!noTarget && !target && !targets.length)
    throw new Error(
      'target|targets is required or set the flag "noTarget" to true'
    );

  let iface: Interface | undefined;
  if (eventAbi) iface = new Interface([eventAbi]);

  if (!topics?.length) {
    if (topic) topic = toFilterTopic(topic);
    else if (eventAbi) topic = toFilterTopic(eventAbi);
    else
      throw new Error("eventAbi | topic | topics are required");
    topics = [topic];
    if (extraTopics) topics.push(...extraTopics);
  }
  if (topics?.length) topic = topics[0] as string;

  function transformLog(log: any) {
    // normalize indexer payload
    if (isIndexerCall) {
      log.address = log.source;
      log.logIndex = log.log_index;
      log.index = log.log_index;
      log.transactionHash = log.transaction_hash;
      log.blockNumber = parseInt(log.block_number);

      // Ensure topics are properly formatted
      const topics = [log.topic0, log.topic1, log.topic2, log.topic3]
        .filter(Boolean)
        .map((t: string) => {
          if (!t) return null;
          const topic = t.startsWith("0x") ? t : `0x${t}`;
          return ethers.zeroPadValue(topic, 32);
        });

      // Ensure first topic (event signature) is present
      if (!topics[0]) {
        return log;
      }

      log.topics = topics;

      // Store original topics for later use
      log._originalTopics = {
        topic0: log.topic0,
        topic1: log.topic1,
        topic2: log.topic2,
        topic3: log.topic3
      };

      // Store original transaction hash
      log._originalTransactionHash = log.transaction_hash;

      // Only delete fields that are not needed for parsing
      [
        "chain",
        "log_index",
      ].forEach((k) => delete log[k]);
    }

    if (log.blockNumber === undefined && log.block_number !== undefined)
      log.blockNumber = parseInt(log.block_number);

    if ((entireLog && !parseLog) || !iface) {
      return log;
    }

    // Restore topics if they were lost
    if (!log.topics && log._originalTopics) {
      log.topics = [log._originalTopics.topic0, log._originalTopics.topic1, log._originalTopics.topic2, log._originalTopics.topic3]
        .filter(Boolean)
        .map((t: string) => {
          if (!t) return null;
          const topic = t.startsWith("0x") ? t : `0x${t}`;
          return ethers.zeroPadValue(topic, 32);
        });
    }

    // Restore transaction hash if it was lost
    if (!log.transactionHash && log._originalTransactionHash) {
      log.transactionHash = log._originalTransactionHash;
    }

    const parsed = iface.parseLog(log);
    if (!parsed && !allowParseFailure)
      throw new Error(`Failed to parse log: ${JSON.stringify(log.transactionHash)}`);

    log.args = parsed?.args;
    if (entireLog) log.parsedLog = parsed;

    return onlyArgs ? log.args : log;
  }

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
  };
}
