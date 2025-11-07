import axios from "axios";
import http from "http";
import https from "https";
import { Readable } from "stream";
import { parser as streamJsonParser } from "stream-json";
import { pick } from "stream-json/filters/Pick";
import { streamArray } from "stream-json/streamers/StreamArray";
import { sliceIntoChunks } from ".";
import { ETHER_ADDRESS } from "../general";
import { Address } from "../types";
import { getBlockNumber } from "./blocks";
import { readCache, writeCache } from "./cache";
import { formError, getUniqueAddresses } from "./common";
import { DEBUG_LEVEL2, debugLog } from "./debugLog";
import { ENV_CONSTANTS, getEnvValue } from "./env";
import { getLogParams, getLogs as getLogsParent } from "./logs";
import { createViemFastPathBatchDecoder, normalizeLog } from "./logs.decode.shared";
import { GetTransactionOptions } from "./transactions";

const indexerURL = getEnvValue("LLAMA_INDEXER_ENDPOINT");
const LLAMA_INDEXER_API_KEY = getEnvValue("LLAMA_INDEXER_API_KEY");
const LLAMA_INDEXER_V2_ENDPOINT = getEnvValue("LLAMA_INDEXER_V2_ENDPOINT");
const LLAMA_INDEXER_V2_API_KEY = getEnvValue("LLAMA_INDEXER_V2_API_KEY");
const addressChunkSize = +getEnvValue("LLAMA_INDEXER_ADDRESS_CHUNK_SIZE")! || 100;

// v1 chains (still used for balances endpoint)
const indexerChainIdChainMapping: { [key: number]: string } = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  100: "xdai",
  137: "polygon",
  204: "op_bnb",
  250: "fantom",
  324: "era",
  1101: "polygon_zkevm",
  8453: "base",
  34443: "mode",
  42170: "arbitrum_nova",
  42161: "arbitrum",
  43114: "avax",
  59144: "linea",
  81457: "blast",
  534352: "scroll",
  146: "sonic",
};

// v2 chains (superset of v1)
const indexer2ChainIdChainMapping: { [key: number]: string } = {
  ...indexerChainIdChainMapping,
  130: "unichain",
  1868: "soneium",
  80094: "berachain",
  999: "hyperliquid",
};

interface IndexerConfig {
  endpoint: string;
  apiKey: string;
  chainMapping: { [key: number]: string };
}

const indexerConfigs: Record<"v1" | "v2", IndexerConfig> = {
  v1: {
    endpoint: indexerURL,
    apiKey: LLAMA_INDEXER_API_KEY,
    chainMapping: indexerChainIdChainMapping,
  },
  v2: {
    endpoint: LLAMA_INDEXER_V2_ENDPOINT,
    apiKey: LLAMA_INDEXER_V2_API_KEY,
    chainMapping: indexer2ChainIdChainMapping,
  },
} as const;

// http agents for streaming (keep-alive)
const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });

const axiosInstances = {
  v1: axios.create({
    headers: { "x-api-key": indexerConfigs.v1.apiKey },
    baseURL: indexerConfigs.v1.endpoint,
    timeout: 180_000
  }),
  v2: axios.create({
    headers: { "x-api-key": indexerConfigs.v2.apiKey },
    baseURL: indexerConfigs.v2.endpoint,
    httpAgent,
    httpsAgent,
    timeout: 300_000
  }),
};

function checkIndexerConfig(version: "v1" | "v2") {
  const config = indexerConfigs[version];
  if (!config.endpoint || !config.apiKey) throw new Error(`Llama Indexer ${version} URL/api key is not set`);
}

function getChainId(chain: string, version: "v1" | "v2" = "v2"): number {
  const chainId = Object.entries(indexerConfigs[version].chainMapping).find(([, chainName]) => chainName === chain)?.[0];
  if (!chainId) throw new Error("Chain not supported");
  return +chainId;
}

function getSupportedChains(version: "v1" | "v2" = "v2"): Set<string> {
  return new Set(Object.values(indexerConfigs[version].chainMapping));
}

export const supportedChainSet = getSupportedChains("v1"); // legacy
export const supportedChainSet2 = getSupportedChains("v2");

const chainToIDMapping: Record<string, number> = {};
Object.entries(indexerConfigs.v1.chainMapping).forEach(([id, chain]) => {
  chainToIDMapping[chain] = +id;
});

type ChainIndexStatus = { [chain: string]: { block: number; timestamp: number } };
const state: { timestamp?: number; chainIndexStatus: ChainIndexStatus | Promise<ChainIndexStatus> } = { chainIndexStatus: {} };
const cacheTime = 1 * 60 * 1000; // 1 min

async function getChainIndexStatus(version: "v1" | "v2" = "v2"): Promise<ChainIndexStatus> {
  checkIndexerConfig(version);

  if (state.timestamp && Date.now() - state.timestamp < cacheTime) return state.chainIndexStatus;

  state.timestamp = Date.now();
  state.chainIndexStatus = (async () => {
    const {
      data: { syncStatus },
    } = await axiosInstances[version].get(`/sync`).catch(e => { throw formError(e) });

    const info: ChainIndexStatus = {};
    syncStatus.forEach((d: any) => {
      const chain = indexerConfigs[version].chainMapping[d.chain];
      if (chain) {
        info[chain] = {
          block: d.lastIndexedBlock,
          timestamp: +new Date(d.lastIndexedDate),
        };
      }
    });
    return (state.chainIndexStatus = info);
  })();

  return state.chainIndexStatus;
}

enum TokenTypes {
  ERC20 = "erc20",
  ERC721 = "erc721",
}

type Cache = {
  timestamp: number;
  tokens: { [chain: string]: string[] };
};

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
  noTarget?: boolean;
  collect?: boolean; // If false, don't accumulate results in memory (useful with processor). Default: true
  parseLog?: boolean;
  processor?: (logs: any[]) => Promise<void> | void;
  maxBlockRange?: number;
  allowParseFailure?: boolean;

  /** Feature flag: enable client-side streaming of /logs v2 */
  clientStreaming?: boolean;

  /** Decoder type: 'viem' (faster) or 'ethers' (fallback) */
  decoderType?: "viem" | "ethers";

  /** Metrics hooks (optional) */
  onWireStats?: (s: { chunkSize: number; bytesReceived: number; itemsProcessed: number }) => void;
  onDecodeStats?: (s: { batchSize: number; decodeTime: number; itemsDecoded: number }) => void;
};

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
  transferType?: "in" | "out" | "all";
  tokens?: string | string[];
  token?: string;
};

export async function getTokens(
  address: string | string[],
  {
    onlyWhitelisted = true,
    skipCacheRead = false,
    skipCache = false,
    chain,
    tokenType,
  }: {
    onlyWhitelisted?: boolean;
    skipCacheRead?: boolean;
    skipCache?: boolean;
    chain?: string;
    tokenType?: TokenTypes;
  } = {}
) {
  checkIndexerConfig("v1");

  if (!address) throw new Error("Address is required either as a string or an array of strings");
  if (Array.isArray(address) && !address.length) throw new Error("Address array cannot be empty");
  if (Array.isArray(address)) address = address.join(",");
  address = address.toLowerCase();

  let chainId;
  if (chain) chainId = chainToIDMapping[chain];

  const project = "llama-indexer-cache";
  const key = onlyWhitelisted ? address : `${address}/all`;
  const file = `${project}/${key}`;
  const timeNow = Math.floor(Date.now() / 1e3);
  const THREE_DAYS = 3 * 24 * 3600;
  let cache = {} as Cache;

  if (!skipCacheRead && !skipCache) {
    cache = (await readCache(file)) ?? ({} as Cache);
    if (cache.timestamp && timeNow - cache.timestamp < THREE_DAYS) return cache.tokens;
  }

  if (ENV_CONSTANTS.GET_LOGS_INDEXER)
    debugLog("[Indexer] Pulling tokens for " + address);

  const tokens = cache.tokens ?? {};
  const {
    data: { balances },
  } = await axiosInstances.v1(`/balances`, {
    params: {
      addresses: address,
      chainId,
      type: tokenType,
    },
  }).catch(e => { throw formError(e) })

  balances
    .filter((b: any) => +b.total_amount > 0)
    .forEach((b: any) => {
      const chain = indexerConfigs.v1.chainMapping[b.chain];
      if (!chain) return;
      if (!tokens[chain]) tokens[chain] = [];
      tokens[chain].push(b.address);
    });

  const tokenCache = { timestamp: timeNow, tokens };
  Object.entries(tokens).forEach(([chain, values]: any) => {
    values.push(ETHER_ADDRESS);
    tokens[chain] = getUniqueAddresses(values);
  });

  if (!skipCache) await writeCache(file, tokenCache);
  return tokens;
}

// ---------------------------------------------------------------------------
// Streaming support (disabled by default, opt-in via clientStreaming: true)
// ---------------------------------------------------------------------------

async function streamJsonArrayFromIndexer(opts: {
  path: string;
  arrayKey?: "logs";
  onItem: (obj: any) => void;
  onChunkStats?: (s: { chunkSize: number; bytesReceived: number; itemsProcessed: number }) => void;
  shouldStop?: () => boolean;
}) {
  const { path, arrayKey = "logs", onItem, onChunkStats, shouldStop } = opts;
  const controller = new AbortController();
  let bytesReceived = 0;
  let itemsProcessed = 0;

  const res = await axiosInstances.v2.get(path, {
    responseType: "stream",
    timeout: 0,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { Accept: "application/json", "Accept-Encoding": "gzip" },
    signal: controller.signal,
  }).catch((e) => {
    if (axios.isCancel(e) || (e as any)?.code === 'ERR_CANCELED') return { data: null } as any;
    throw formError(e);
  });

  if (!res?.data) return;

  await new Promise<void>((resolve, reject) => {
    const stream = res.data as Readable;

    const isCancellationError = (err: any): boolean =>
      err?.name === "CanceledError" ||
      err?.message?.includes("aborted") ||
      axios.isCancel(err) ||
      err?.code === 'ERR_CANCELED';

    const handleError = (err: any) => isCancellationError(err) ? resolve() : reject(err);

    stream.on('data', (chunk: Buffer) => {
      bytesReceived += chunk.length;
      onChunkStats?.({ chunkSize: chunk.length, bytesReceived, itemsProcessed });
    });

    const jsonParser = streamJsonParser();
    const pickFilter = pick({ filter: arrayKey });
    const arrayStream = streamArray();

    arrayStream.on('data', (data: { key: number; value: any }) => {
      if (shouldStop?.()) {
        controller.abort();
        stream.destroy();
        return;
      }
      try {
        onItem(data.value);
            itemsProcessed++;
        if (itemsProcessed % 100000 === 0) {
          onChunkStats?.({ chunkSize: 100000, bytesReceived, itemsProcessed });
        }
      } catch { }
    });

    const finish = () => {
      const rem = itemsProcessed % 100000;
      if (rem > 0) {
        onChunkStats?.({ chunkSize: rem, bytesReceived, itemsProcessed });
      }
      resolve();
    };

    arrayStream.on('end', finish);
    arrayStream.on('close', finish);

    arrayStream.on('error', handleError);
    jsonParser.on('error', handleError);
    pickFilter.on('error', handleError);
    stream.on('error', handleError);

    stream.pipe(jsonParser).pipe(pickFilter).pipe(arrayStream);
  });
}

// ---------------------------------------------------------------------------
// LOGS (v2) – streaming opt-in, legacy default
// ---------------------------------------------------------------------------

export async function getLogs(options: IndexerGetLogsOptions): Promise<any[]> {
  // Set collect=false by default when processor is provided AND collect is not explicitly set AND clientStreaming = true
  // if you pass processor without collect=true, you won't get results back
  
  let {
    all = true,
    limit = 1000,
    offset: initialOffset = 0,
    target,
    targets = [],
    flatten = true,
    debugMode = false,
    noTarget = false,
    maxBlockRange,
    processor,
    clientStreaming = false,   // default OFF to keep retro-compat
    decoderType = "viem" as "viem" | "ethers", // default to viem for performance
    onWireStats,
    onDecodeStats,
  } = options;

  if (processor && typeof options.collect === "undefined" && clientStreaming) {
    (options as IndexerGetLogsOptions).collect = false;
  }

  const {
    chain,
    fromBlock,
    toBlock,
    topic,
    topic1,
    topic2,
    topic3,
    transformLog,
  } = await getLogParams(options, true);

  const viemFastPath =
    decoderType === "viem" && options.eventAbi
      ? createViemFastPathBatchDecoder(options.eventAbi)
      : null;

  if (!debugMode) debugMode = DEBUG_LEVEL2 && !!ENV_CONSTANTS.GET_LOGS_INDEXER;

  // === Match logs.ts semantic regarding processor + multiple targets (flatten=false) ===
  if (processor && targets?.length > 1 && !flatten)
    throw new Error("processor is not supported with multiple targets when flatten=false");

  const blockRange = toBlock - fromBlock;
  const effectiveMaxBlockRange = maxBlockRange ?? (noTarget ? 10_000 : Infinity);

  if (noTarget && blockRange > 500_000) {
    throw new Error(
      "When noTarget is true, block range must be less than 500k blocks. Please narrow down your block range."
    );
  }

  // Ensure the indexer is synced far enough
  checkIndexerConfig("v2");
  const chainId = getChainId(chain, "v2");
  const chainIndexStatus = await getChainIndexStatus("v2");
  const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0;
  if (lastIndexedBlock < toBlock) {

    const percentageMissing = ((toBlock - lastIndexedBlock) / (toBlock - fromBlock)) * 100;

    if (percentageMissing > 50)
      throw new Error(
        `Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`
      );

    if (ENV_CONSTANTS.GET_LOGS_INDEXER)
      debugLog(`Indexer only partially up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}, missing ${Number(percentageMissing).toFixed(2)}%. Pulling part of the logs through RPC calls.`);

    const breakBlock = lastIndexedBlock - 50; // small buffer
    const indexerLogs = await getLogs({ ...options, fromBlock, toBlock: breakBlock });
    const rpcLogs = await getLogsParent({ ...options, fromBlock: breakBlock + 1, toBlock, skipIndexer: true });

    return indexerLogs.concat(rpcLogs);
  }

  // Re-curse if the requested range is too large
  if (blockRange > effectiveMaxBlockRange) {
    const results: any[][] = [];
    for (
      let currentFromBlock = fromBlock;
      currentFromBlock < toBlock;
      currentFromBlock += effectiveMaxBlockRange
    ) {
      const currentToBlock = Math.min(currentFromBlock + effectiveMaxBlockRange - 1, toBlock);
      const chunk = await getLogs({ ...options, fromBlock: currentFromBlock, toBlock: currentToBlock });
      results.push(chunk);
    }

    if (flatten || !targets?.length) return results.flat();
    return targets.map((_, i) => results.map((r) => r[i]).flat());
  }

  let address = target as string | undefined;
  if (typeof target === "string") targets = [target];
  if (Array.isArray(targets) && targets.length) address = targets.join(",");

  const hasAddressFilter = !!address?.length;
  if (address) address = address.toLowerCase();

  const addressSet = new Set((address ?? "").split(",").filter(Boolean));
  const addressChunks = sliceIntoChunks(address?.split(",") ?? [], addressChunkSize);
  if (noTarget && addressChunks.length === 0) addressChunks.push(undefined as any);

  // Safely push large arrays without stack overflow (avoid push.apply argument limits (~125k))
  const safePush = (target: any[], source: any[]) => {
    if (source.length === 0) return;
    // For very large arrays, split into chunks
    if (source.length > 100_000) {
      const CHUNK_SIZE = 50_000; // Safe chunk size well below push.apply limit
      for (let i = 0; i < source.length; i += CHUNK_SIZE) {
        const chunk = source.slice(i, i + CHUNK_SIZE);
        Array.prototype.push.apply(target, chunk);
      }
    } else {
      Array.prototype.push.apply(target, source);
    }
  };

  // -----------------------------------------------------------------------
  // Streaming (opt-in) — NO server-side parsing; mirror legacy semantics
  // -----------------------------------------------------------------------
  if (clientStreaming) {
    const useAll = options.all === true;
    const effectiveLimit = useAll ? Number.POSITIVE_INFINITY : (options.limit ?? limit);
    const shouldLimit = !useAll && Number.isFinite(effectiveLimit);
    const effectiveOffset = useAll ? 0 : (options.offset ?? initialOffset ?? 0);

    const outPairs: Array<{ raw: any; transformed: any }> = [];
    const start = debugMode ? Date.now() : 0;

    const MICRO_BATCH_SIZE = +(process.env.LLAMA_INDEXER_MICRO_BATCH || 10000);

    // Check if we need splitByAddress (mapping by target address)
    const splitByAddress = targets?.length && !flatten;

    // If splitByAddress, build buckets directly during flushBatch
    const addressBuckets: any[][] = splitByAddress ? targets.map(() => []) : [];
    const addressIndexMap: Record<string, number> = splitByAddress
      ? Object.fromEntries(targets.map((t, i) => [t.toLowerCase(), i]))
      : {};

    let remainingOffset = effectiveOffset;
    let remainingLimit = shouldLimit ? (effectiveLimit as number) : Number.POSITIVE_INFINITY;

    const flushBatch = async (batch: any[]): Promise<void> => {
      if (!batch.length) return;

      const t0 = Date.now();
      
      // Normalize logs before decoding (required for fast-path and consistency)
      for (const log of batch) {
        normalizeLog(log, true); // isIndexerCall = true
      }

      // Use fast-path if available, otherwise fallback to default
      const batchFn = viemFastPath ?? (transformLog as any).batch;
      let transformedLogs: any[];
      
      if (batchFn) {
        // Fast-path returns only args, need to reconstruct full log objects
        const decodedArgs = await batchFn(batch);
        transformedLogs = new Array(batch.length);
        for (let i = 0; i < batch.length; i++) {
          if (options.onlyArgs) {
            // If onlyArgs is true, return only the args (like transformLog does)
            transformedLogs[i] = decodedArgs[i];
          } else {

            transformedLogs[i] = {
              ...batch[i],
              args: decodedArgs[i]
            };

            if (!transformedLogs[i].transactionHash && transformedLogs[i]._originalTransactionHash) {
              transformedLogs[i].transactionHash = transformedLogs[i]._originalTransactionHash;
            }
          }
        }
      } else {
        transformedLogs = await Promise.all(batch.map((log: any) => transformLog(log)));
      }
      
      const decodeTime = Date.now() - t0;
      onDecodeStats?.({ batchSize: batch.length, decodeTime, itemsDecoded: batch.length });

      if (processor) await processor(transformedLogs);

      if (splitByAddress) {
        // Map directly to address buckets without storing pairs
        for (let i = 0; i < batch.length; i++) {
          const raw = batch[i];
          const transformed = transformedLogs[i];
          const idx = addressIndexMap[(raw.source ?? raw.address)?.toLowerCase?.()];
          if (idx !== undefined) {
            addressBuckets[idx].push(transformed);
          }
        }
      } else if (options.collect !== false) {
        // Build pairs if collect=true (needed for final return)
        const pairs = new Array(batch.length);
        for (let i = 0; i < batch.length; i++) {
          pairs[i] = { raw: batch[i], transformed: transformedLogs[i] };
        }
        Array.prototype.push.apply(outPairs, pairs);
      }
      // If collect=false and not splitByAddress, nothing to store (processor already handled it)
    };

    for (const chunk of addressChunks) {
      if (Array.isArray(chunk) && chunk.length === 0) throw new Error("Address chunk cannot be empty");

      const qs = new URLSearchParams();
      qs.set("chainId", String(chainId));
      qs.set("topic0", topic);
      if (topic1) qs.set("topic1", topic1);
      if (topic2) qs.set("topic2", topic2);
      if (topic3) qs.set("topic3", topic3);
      if (fromBlock != null) qs.set("from_block", String(fromBlock));
      if (toBlock != null) qs.set("to_block", String(toBlock));
      if (chunk && Array.isArray(chunk)) qs.set("addresses", chunk.join(",").toLowerCase());
      if (noTarget) qs.set("noTarget", "true");
      qs.set("limit", "all");
      qs.set("offset", "0");

      const transformBatch: any[] = [];
      let stopNow = false;
      let flushPromise: Promise<void> = Promise.resolve();

      // Chain flushes sequentially to avoid concurrent decoding (CPU/GC thrashing)
      const scheduleFlush = (batch: any[]) => {
        flushPromise = flushPromise.then(() => flushBatch(batch));
      };

      await streamJsonArrayFromIndexer({
        path: `/logs?${qs.toString()}`,
        arrayKey: "logs",
        onItem: (raw) => {
          if (stopNow) return;

          const okAddress = !addressSet.size || addressSet.has((raw.source ?? raw.address)?.toLowerCase?.());
          if (!okAddress) return;

          if (remainingOffset > 0) {
            remainingOffset--;
            return;
          }
          if (remainingLimit <= 0) {
            stopNow = true;
            return;
          }

          transformBatch.push(raw);
          remainingLimit--;

          if (transformBatch.length >= MICRO_BATCH_SIZE) {
            // Sequential flush: chain to avoid concurrent decoding
            const batch = transformBatch.splice(0, MICRO_BATCH_SIZE);
            scheduleFlush(batch);
          }
        },
        shouldStop: () => stopNow,
        onChunkStats: (s) => onWireStats?.(s),
      });

      if (transformBatch.length > 0) {
        scheduleFlush(transformBatch.splice(0, transformBatch.length));
      }
      await flushPromise;

      if (remainingLimit <= 0) break;
    }

    if (debugMode) {
      const ms = Date.now() - start;
      debugLog(`[Indexer] stream finished: ${outPairs.length} items in ${ms}ms`);
    }

    if (splitByAddress) {
      return addressBuckets;
    }

    return (options.collect !== false) ? outPairs.map(i => i.transformed) : [];
  }

  const allLogsPairs: Array<{ raw: any; transformed: any }> = [];
  const debugTimeKey = `Indexer-getLogs-${chain}-${topic}-${address}_${Math.random()}`;
  if (debugMode) {
    debugLog("[Indexer] Pulling logs " + debugTimeKey);
    console.time(debugTimeKey);
  }

  for (const chunk of addressChunks) {
    if (Array.isArray(chunk) && chunk.length === 0) throw new Error("Address chunk cannot be empty");

    let chunkOffset = initialOffset;
    let logCount = 0;
    let hasMore = true;

    do {
      const params: any = {
        addresses: hasAddressFilter ? chunk?.join(",") : undefined,
        chainId,
        topic0: topic,
        from_block: fromBlock,
        to_block: toBlock,
        topic1,
        topic2,
        topic3,
        limit,
        offset: chunkOffset,
        noTarget,
      };

      const {
        data: { logs: _logs, totalCount },
      } = await axiosInstances.v2(`/logs`, { params }).catch(e => { throw formError(e) })

      const filtered = _logs.filter((l: any) => {
        const isWhitelisted = !addressSet.size || addressSet.has((l.source ?? l.address)?.toLowerCase?.());
        return !!isWhitelisted;
      });

      const t0 = Date.now();
      
      // Normalize logs before decoding (required for consistency)
      for (const log of filtered) {
        normalizeLog(log, true); // isIndexerCall = true
      }
      
      // Legacy path: use transformLog batch if available, otherwise transform individually
      const transformBatchFn =
        (transformLog as any).batch || ((logs: any[]) => Promise.all(logs.map((log: any) => transformLog(log))));
      
      const transformedLogs = await transformBatchFn(filtered);
      
      const transformedPair = filtered.map((log: any, idx: number) => ({ raw: log, transformed: transformedLogs[idx] }));
      const decodeTime = Date.now() - t0;
      if (onDecodeStats && filtered.length > 0) onDecodeStats({ batchSize: filtered.length, decodeTime, itemsDecoded: filtered.length });

      if (processor) await processor(transformedPair.map((i: any) => i.transformed));

      // Safe push helper to avoid stack overflow on large arrays
      // Only accumulate if collect is enabled (default true for backward compatibility)
      const shouldCollect = (options.collect !== false);
      if (shouldCollect) {
        safePush(allLogsPairs, transformedPair);
      }

      logCount += _logs.length;
      chunkOffset += limit;
      if (_logs.length === 0) {
        hasMore = false;
      } else if (_logs.length < limit) {
        hasMore = false;
      } else if (typeof totalCount === 'number' && totalCount <= logCount) {
        hasMore = false;
      } else {
        hasMore = true;
      }
    } while (all && hasMore);
  }

  if (debugMode) {
    console.timeEnd(debugTimeKey);
    debugLog("Logs pulled " + chain, address, allLogsPairs.length);
  }

  const splitByAddress = targets?.length && !flatten;
  if (splitByAddress) {
    const mapped: any[] = targets.map(() => []);
    const indexMap: Record<string, number> = {};
    targets.forEach((t, i) => (indexMap[t.toLowerCase()] = i));

    allLogsPairs.forEach(({ raw, transformed }) => {
      const idx = indexMap[(raw.source ?? raw.address)?.toLowerCase?.()];
      if (idx === undefined) return; // ignore unknown sources
      mapped[idx].push(transformed);
    });
    return mapped;
  }

    // Return empty array if collect=false (processor handles results)
    const shouldCollect = (options.collect !== false);
    return shouldCollect ? allLogsPairs.map(i => i.transformed) : [];
}

export async function getTokenTransfers({
  chain = "ethereum",
  fromAddressFilter,
  fromBlock,
  toBlock,
  all = true,
  limit = 1000,
  offset = 0,
  target,
  targets = [],
  flatten = true,
  fromTimestamp,
  toTimestamp,
  debugMode = false,
  transferType = "in",
  token,
  tokens,
}: IndexerGetTokenTransfersOptions) {
  if (!debugMode) debugMode = DEBUG_LEVEL2 && !!ENV_CONSTANTS.GET_LOGS_INDEXER;

  checkIndexerConfig("v2");
  const chainId = getChainId(chain, "v2");

  const fromFilterEnabled = !!fromAddressFilter?.length;
  if (typeof fromAddressFilter === "string") fromAddressFilter = [fromAddressFilter];
  const fromFilterSet = new Set((fromAddressFilter ?? []).map((a) => a.toLowerCase()));

  if (!fromBlock && !fromTimestamp) throw new Error("fromBlock or fromTimestamp is required");
  if (!toBlock && !toTimestamp) throw new Error("toBlock or toTimestamp is required");

  if (!fromBlock) fromBlock = await getBlockNumber(chain, fromTimestamp);
  if (!toBlock) toBlock = await getBlockNumber(chain, toTimestamp);

  if (!fromBlock || !toBlock) throw new Error("fromBlock and toBlock must be > 0");

  if (token) tokens = [token];
  if (tokens) {
    if (typeof tokens === "string") tokens = [tokens];
    if (!Array.isArray(tokens)) throw new Error("tokens must be a string or an array of strings");
    tokens = tokens.join(",").toLowerCase();
  }

  if (target) targets = [target];
  if (!targets.length) throw new Error("target|targets is required");
  targets = targets.map((t) => t.toLowerCase());
  const addresses = targets.join(",");

  // Ensure v2 indexer is up-to-date
  const chainIndexStatus = await getChainIndexStatus("v2");
  const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0;
  if (lastIndexedBlock < toBlock) {
    throw new Error(
      `Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`
    );
  }

  const rawTransfers: any[] = [];
  const debugTimeKey = `Indexer-tokenTransfers-${chain}-${addresses}_${Math.random()}`;
  if (debugMode) {
    debugLog("[Indexer] Pulling token transfers " + debugTimeKey);
    console.time(debugTimeKey);
  }

  let currentOffset = offset;
  let hasMore = true;

  do {
    const params: any = {
      addresses,
      chainId,
      from_block: fromBlock,
      to_block: toBlock,
      limit,
      offset: currentOffset,
      tokens,
      from_address: false,
      to_address: false,
    };

    switch (transferType) {
      case "in":
        params.to_address = true;
        break;
      case "out":
        params.from_address = true;
        break;
      case "all":
        params.from_address = true;
        params.to_address = true;
        break;
      default:
        throw new Error("Invalid transferType");
    }

    const {
      data: { transfers: _logs },
    } = await axiosInstances.v2(`/token-transfers`, { params }).catch(e => { throw formError(e) })

    rawTransfers.push(..._logs);
    currentOffset += limit;

    hasMore = _logs.length === limit;
  } while (all && hasMore);

  const filteredTransfers = rawTransfers.filter((l: any) => {
    if (!fromFilterEnabled) return true;
    return fromFilterSet.has(l.from_address.toLowerCase());
  });

  if (debugMode) {
    console.timeEnd(debugTimeKey);
    debugLog("Token Transfers pulled " + chain, addresses, filteredTransfers.length);
  }

  const splitByAddress = targets?.length && !flatten;
  if (splitByAddress) {
    const mapped: any[] = targets.map(() => []);
    const indexMap: Record<string, number> = {};
    targets.forEach((t, i) => (indexMap[t.toLowerCase()] = i));

    filteredTransfers.forEach((log: any) => {
      const sourceField = transferType === "in" ? "to_address" : "from_address";
      const idx = indexMap[log[sourceField].toLowerCase()];
      if (idx !== undefined) mapped[idx].push(log);
    });

    return mapped;
  }

  return filteredTransfers;
}

export async function getTransactions({
  chain = "ethereum",
  addresses,
  transaction_hashes,
  from_block,
  to_block,
  all = true,
  limit = 1000,
  offset = 0,
  debugMode = false,
  transactionType = "from",
}: GetTransactionOptions) {
  if (!debugMode) debugMode = DEBUG_LEVEL2 && !!ENV_CONSTANTS.GET_LOGS_INDEXER;
  checkIndexerConfig("v2");
  const chainId = getChainId(chain, "v2");

  if ((!addresses || addresses.length === 0) && (!transaction_hashes || transaction_hashes.length === 0))
    throw new Error("You must provide at least 'addresses' or 'transaction_hashes'");
  if (!from_block || !to_block) throw new Error("'from_block' and 'to_block' are required to search for transactions");

  const chainIndexStatus = await getChainIndexStatus("v2");
  const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0;
  if (to_block > lastIndexedBlock) {
    throw new Error(
      `Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${to_block}`
    );
  }

  const params: any = { chainId };
  if (addresses) {
    params.addresses = Array.isArray(addresses)
      ? addresses.map((a: string) => a.toLowerCase()).join(",")
      : (addresses as string).toLowerCase();
  }
  if (transaction_hashes) {
    params.transaction_hashes = Array.isArray(transaction_hashes)
      ? transaction_hashes.map((h: string) => h.toLowerCase()).join(",")
      : (transaction_hashes as string).toLowerCase();
  }

  params.from_block = from_block;
  params.to_block = to_block;
  if (offset) params.offset = offset;

  params.from_address = transactionType !== "to";
  params.to_address = transactionType !== "from";

  if (all) params.limit = "all";
  else if (limit !== "all" && limit !== 0) params.limit = limit;

  const debugTimeKey = `Indexer-getTransactions-${chain}-${addresses || transaction_hashes}-${from_block}-${to_block}_${Math.random()}`;
  if (debugMode) {
    debugLog("[Indexer] Pulling transactions " + debugTimeKey);
    console.time(debugTimeKey);
  }

  const { data: { transactions } } = await axiosInstances.v2(`/transactions`, { params }).catch(e => { throw formError(e) })

  if (debugMode) {
    console.timeEnd(debugTimeKey);
    debugLog("Transactions pulled " + chain, addresses || transaction_hashes, transactions?.length || 0);
  }

  if (!transactions?.length) return null;

  return transactions.map((t: any) => ({
    hash: t.hash,
    blockNumber: +t.block_number,
    transactionIndex: +t.transaction_index,
    from: t.from_address,
    to: t.to_address,
    value: t.value,
    gasPrice: t.gas_price,
    gas: t.gas,
    input: t.input,
    nonce: +t.nonce,
    data: t.input,
    type: t.transaction_type,
    maxFeePerGas: t.max_fee_per_gas,
    maxPriorityFeePerGas: t.max_priority_fee_per_gas,
    baseFeePerGas: t.base_fee_per_gas,
    effectiveGasPrice: t.effective_gas_price,
    gasUsed: t.gas_used,
    cumulativeGasUsed: t.cumulative_gas_used,
    status: t.status === "success" ? 1 : 0,
    contractCreated: t.contract_created || undefined,
    timestamp: t.timestamp,
  }));
}

export function isIndexerEnabled(chain?: string) {
  if (!indexerConfigs.v2.endpoint) return false;
  if (chain && !supportedChainSet2.has(chain)) return false;
  return true;
}

export function isIndexer2Enabled(chain?: string) {
  return isIndexerEnabled(chain);
}
