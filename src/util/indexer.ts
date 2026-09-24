import axios from "axios";
import http from "http";
import https from "https";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { parser as streamJsonParser } from "stream-json";
import { pick } from "stream-json/filters/Pick";
import { streamArray } from "stream-json/streamers/StreamArray";
import { sliceIntoChunks } from ".";
import { Address } from "../types";
import { getBlockNumber } from "./blocks";
import { formError } from "./common";
import { DEBUG_LEVEL2, debugLog } from "./debugLog";
import { ENV_CONSTANTS, getEnvValue } from "./env";
import { getLogParams, getLogs as getLogsParent } from "./logs";
import { createViemFastPathBatchDecoder, normalizeLog } from "./logs.decode.shared";
import { GetTransactionOptions } from "./transactions";
import { normalizeV4Row, parseTransferResponse } from "./indexer.compatibility";

const LLAMA_INDEXER_V2_ENDPOINT = getEnvValue("LLAMA_INDEXER_V2_ENDPOINT");
const LLAMA_INDEXER_V2_API_KEY = getEnvValue("LLAMA_INDEXER_V2_API_KEY");
const LLAMA_INDEXER_V4_ENDPOINT = getEnvValue("LLAMA_INDEXER_V4_ENDPOINT");
const LLAMA_INDEXER_V4_API_KEY = getEnvValue("LLAMA_INDEXER_V4_API_KEY") ?? LLAMA_INDEXER_V2_API_KEY;
const LLAMA_INDEXER_PREFER_V4 = getEnvValue("LLAMA_INDEXER_PREFER_V4") !== "false"; // explicit false allows rollback
const addressChunkSize = +getEnvValue("LLAMA_INDEXER_ADDRESS_CHUNK_SIZE")! || 100;
const INDEXER_REQUEST_TIMEOUT_MS = +getEnvValue("LLAMA_INDEXER_TIMEOUT_MS")!;

const indexerChainIdChainMapping: { [key: number]: string } = {
  1: "ethereum",
  10: "optimism",
  56: "bsc",
  100: "xdai",
  137: "polygon",
  204: "op_bnb",
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
  130: "unichain",
  1868: "soneium",
  80094: "berachain",
  999: "hyperliquid",
  143: "monad",
  4326: "megaeth",
  196: "xlayer"
};

const v4OnlyChainIdChainMapping: { [key: number]: string } = {
  4663: "robinhood",
};

(getEnvValue("LLAMA_INDEXER_V4_ONLY_CHAINS") ?? "")
  .split(",")
  .map((entry) => entry.trim())
  .filter(Boolean)
  .forEach((entry) => {
    const [chainId, chainName] = entry.split(":").map((i) => i.trim());
    if (!chainId || !chainName || isNaN(+chainId)) throw new Error(`Invalid LLAMA_INDEXER_V4_ONLY_CHAINS entry: ${entry}`);
    v4OnlyChainIdChainMapping[+chainId] = chainName;
  });

const allChainIdChainMapping: { [key: number]: string } = { ...indexerChainIdChainMapping, ...v4OnlyChainIdChainMapping };
const v4OnlyChainSet = new Set(Object.values(v4OnlyChainIdChainMapping));

export type IndexerVersion = "v2" | "v4";

const indexerConfigs: { [version in IndexerVersion]: { endpoint?: string; apiKey?: string } } = {
  v2: { endpoint: LLAMA_INDEXER_V2_ENDPOINT, apiKey: LLAMA_INDEXER_V2_API_KEY },
  v4: { endpoint: LLAMA_INDEXER_V4_ENDPOINT, apiKey: LLAMA_INDEXER_V4_API_KEY },
};

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 256, maxFreeSockets: 64 });

function createIndexerClient(version: IndexerVersion) {
  const { endpoint, apiKey } = indexerConfigs[version];
  return axios.create({
    headers: { "x-api-key": apiKey },
    baseURL: endpoint,
    httpAgent,
    httpsAgent,
    timeout: INDEXER_REQUEST_TIMEOUT_MS,
  });
}

const axiosInstances = {
  v2: createIndexerClient("v2"),
  v4: createIndexerClient("v4"),
};

function checkIndexerConfig(version: IndexerVersion) {
  const { endpoint, apiKey } = indexerConfigs[version];
  if (!endpoint || !apiKey) throw new Error(`Llama Indexer (${version}) URL/api key is not set`);
}

// Prefer a configured v4 deployment; retain v2-only installations and explicit rollback.
export function getChainIndexerVersion(chain: string): IndexerVersion {
  if (v4OnlyChainSet.has(chain)) return "v4";
  if (!LLAMA_INDEXER_V4_ENDPOINT) return "v2";
  if (LLAMA_INDEXER_PREFER_V4 || !LLAMA_INDEXER_V2_ENDPOINT) return "v4";
  return "v2";
}

function getChainId(chain: string): number {
  const chainId = Object.entries(allChainIdChainMapping).find(([, chainName]) => chainName === chain)?.[0];
  if (!chainId) throw new Error("Chain not supported");
  return +chainId;
}

export const supportedChainSet2 = new Set(Object.values(allChainIdChainMapping));

type IndexerPage = "logs" | "transfers" | "transactions";
type CursorPaginationParams = { after_block: number; after_index: number; after_id?: string };
type GetCursor = (row: any) => CursorPaginationParams | undefined;

function getLogCursor(log: any): CursorPaginationParams | undefined {
  if (!log) return undefined;
  const afterBlock = log.block_number ?? log.blockNumber;
  const afterIndex = log.log_index ?? log.logIndex ?? log.index;
  if (afterBlock === undefined || afterIndex === undefined) return undefined;
  return { after_block: +afterBlock, after_index: +afterIndex };
}

function getTransferCursor(transfer: any): CursorPaginationParams | undefined {
  const cursor = getLogCursor(transfer);
  if (!cursor) return undefined;
  if (transfer.id !== undefined && transfer.id !== null) cursor.after_id = String(transfer.id);
  return cursor;
}

function getTransactionCursor(transaction: any): CursorPaginationParams | undefined {
  if (!transaction) return;
  return { after_block: +transaction.block_number, after_index: +transaction.transaction_index };
}

function safePush(target: any[], source: any[]) {
  for (const row of source) target.push(row);
}

function applyLocalOffset<T>(rows: T[], remainingOffset: number): { rows: T[]; remainingOffset: number } {
  if (remainingOffset <= 0) return { rows, remainingOffset };
  if (remainingOffset >= rows.length) return { rows: [], remainingOffset: remainingOffset - rows.length };
  return { rows: rows.slice(remainingOffset), remainingOffset: 0 };
}

function assertCursorAdvances(next: CursorPaginationParams | undefined, previous?: CursorPaginationParams) {
  if (!next || !Number.isSafeInteger(next.after_block) || !Number.isSafeInteger(next.after_index))
    throw new Error("Indexer v4 returned a page without a valid cursor");
  if (!previous) return;
  const advances = next.after_block > previous.after_block ||
    (next.after_block === previous.after_block && (next.after_index > previous.after_index ||
      (next.after_index === previous.after_index && next.after_id !== undefined && previous.after_id !== undefined &&
        BigInt(next.after_id) > BigInt(previous.after_id))));
  if (!advances) throw new Error("Indexer v4 pagination cursor did not advance");
}

// Translate the public offset/limit contract into keyset pagination. Even all=false
// may need several requests: the v4 server caps offsets, not the public SDK API.
async function* getV4Pages(
  path: string, key: IndexerPage, params: any, limit: number, offset: number, all: boolean,
  getCursor: GetCursor,
): AsyncGenerator<any[]> {
  if (!Number.isSafeInteger(limit) || limit < 0 || !Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Indexer pagination requires a non-negative integer limit and offset");
  if (limit === 0) return;
  let cursor: CursorPaginationParams | undefined;
  let remainingOffset = offset;
  let remainingLimit = all ? Infinity : limit;
  while (remainingLimit > 0) {
    const pageParams = { ...params, limit, offset: 0, includeTotal: false, ...cursor };
    const response = await axiosInstances.v4(path, {
      params: pageParams,
      ...(key === "transfers" ? { responseType: "text" as const, transformResponse: (data: any) => data } : {}),
    }).catch((e: any) => { throw formError(e) });
    const data = key === "transfers" && typeof response.data === "string"
      ? await parseTransferResponse(response.data) : response.data;
    const page = data[key];
    if (!Array.isArray(page)) throw new Error(`Indexer v4 returned an invalid ${key} response`);
    // Capture the cursor before consumers normalize/mutate the raw rows.
    const next = getCursor(page[page.length - 1]);
    const result = applyLocalOffset(page, remainingOffset);
    remainingOffset = result.remainingOffset;
    const rows = result.rows.slice(0, remainingLimit);
    remainingLimit -= rows.length;
    const hasMore = page.length >= limit && remainingLimit > 0;
    if (hasMore || (page.length && cursor)) assertCursorAdvances(next, cursor);
    if (rows.length) yield rows.map(row => normalizeV4Row(row, key));
    if (!hasMore) return;
    cursor = next;
  }
}

async function* getIndexerPages(version: IndexerVersion, path: string, key: IndexerPage, params: any,
  limit: number, offset: number, all: boolean, getCursor: GetCursor,
): AsyncGenerator<any[]> {
  if (version === "v4") {
    yield* getV4Pages(path, key, params, limit, offset, all, getCursor);
    return;
  }
  let count = 0;
  do {
    const { data } = await axiosInstances.v2(path, { params: { ...params, limit, offset } })
      .catch((e: any) => { throw formError(e) });
    const rows = data[key];
    yield rows;
    count += rows.length;
    if (!rows.length || rows.length < limit || (key === "logs" && typeof data.totalCount === "number" && data.totalCount <= count)) return;
    offset += limit;
  } while (all);
}

type ChainIndexStatus = { [chain: string]: { block: number; timestamp: number } };
const syncStates: { [version in IndexerVersion]: { timestamp?: number; chainIndexStatus: ChainIndexStatus | Promise<ChainIndexStatus> } } = {
  v2: { chainIndexStatus: {} },
  v4: { chainIndexStatus: {} },
};
const cacheTime = 1 * 60 * 1000; // 1 min

async function getChainIndexStatus(version: IndexerVersion): Promise<ChainIndexStatus> {
  checkIndexerConfig(version);
  const state = syncStates[version];

  if (state.timestamp && Date.now() - state.timestamp < cacheTime) return state.chainIndexStatus;

  state.timestamp = Date.now();
  state.chainIndexStatus = (async () => {
    const {
      data: { syncStatus },
    } = await axiosInstances[version].get(`/sync`).catch((e: any) => { throw formError(e) });

    const info: ChainIndexStatus = {};
    syncStatus.forEach((d: any) => {
      const chain = allChainIdChainMapping[d.chain];
      if (chain) {
        info[chain] = {
          block: d.lastIndexedBlock,
          timestamp: +new Date(d.lastIndexedDate),
        };
      }
    });
    return (state.chainIndexStatus = info);
  })().catch((error) => {
    state.timestamp = undefined;
    state.chainIndexStatus = {};
    throw error;
  });

  return state.chainIndexStatus;
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
  noTarget?: boolean;
  collect?: boolean; // If false, don't accumulate results in memory (useful with processor). Default: true
  parseLog?: boolean;
  processor?: (logs: any[]) => Promise<void> | void;
  maxBlockRange?: number;
  allowParseFailure?: boolean;

  /** Opt in to streaming /logs instead of paginated requests. */
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

async function streamLogs(opts: {
  path: string;
  version: IndexerVersion;
  onItem: (obj: any) => Promise<void> | void;
  onChunkStats?: (s: { chunkSize: number; bytesReceived: number; itemsProcessed: number }) => void;
  shouldStop?: () => boolean;
}) {
  const { path, version, onItem, onChunkStats, shouldStop } = opts;
  const controller = new AbortController();
  let bytesReceived = 0;
  let itemsProcessed = 0;

  const res = await axiosInstances[version].get(path, {
    responseType: "stream",
    timeout: INDEXER_REQUEST_TIMEOUT_MS,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
    headers: { Accept: "application/json", "Accept-Encoding": "gzip" },
    signal: controller.signal,
  }).catch((e) => { throw formError(e); });

  let stopped = false;
  let processingError: unknown;
  try {
    await pipeline(
      res.data as Readable,
      async function* (source: AsyncIterable<Buffer>) {
        for await (const chunk of source) {
          bytesReceived += chunk.length;
          onChunkStats?.({ chunkSize: chunk.length, bytesReceived, itemsProcessed });
          yield chunk;
        }
      },
      streamJsonParser(),
      pick({ filter: "logs" }),
      streamArray(),
      async (source: AsyncIterable<{ value: any }>) => {
        for await (const { value } of source) {
          try {
            await onItem(value);
          } catch (e) {
            processingError = e;
            throw e;
          }
          itemsProcessed++;
          if (shouldStop?.()) {
            stopped = true;
            controller.abort();
            break;
          }
        }
      },
    );
  } catch (e) {
    // Only our requested early stop is successful; remote truncation and decode
    // or processor errors must reject instead of returning incomplete results.
    if (!stopped) throw processingError ?? e;
  }
  onChunkStats?.({ chunkSize: 0, bytesReceived, itemsProcessed });
}

type LogDecoder = ((log: any) => Promise<any>) & { batch?: (logs: any[]) => Promise<any[]> };

async function decodeStreamingLogs(
  logs: any[], transformLog: LogDecoder, batchDecoder: LogDecoder["batch"], onlyArgs?: boolean,
) {
  for (const log of logs) normalizeLog(log, true);
  if (!batchDecoder) return Promise.all(logs.map(log => transformLog(log)));

  // The historical streaming fast path returns args without buffered parsedLog metadata.
  const args = await batchDecoder(logs);
  return logs.map((log, i) => {
    if (onlyArgs) return args[i];
    const decoded = { ...log, args: args[i] };
    if (!decoded.transactionHash && decoded._originalTransactionHash)
      decoded.transactionHash = decoded._originalTransactionHash;
    return decoded;
  });
}

export async function getLogs(options: IndexerGetLogsOptions): Promise<any[]> {
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
    clientStreaming = false,
    decoderType = "viem",
    onWireStats,
    onDecodeStats,
  } = options;

  if (processor && typeof options.collect === "undefined" && clientStreaming) {
    options = { ...options, collect: false };
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
    // Preserve the historical streaming shape, including entireLog: the viem
    // fast path exposes args without adding the buffered decoder's parsedLog.
    decoderType === "viem" && options.eventAbi && options.parseLog !== false && !options.allowParseFailure
      ? createViemFastPathBatchDecoder(options.eventAbi)
      : null;

  if (!debugMode) debugMode = DEBUG_LEVEL2 && !!ENV_CONSTANTS.GET_LOGS_INDEXER;

  // === Match logs.ts semantic regarding processor + multiple targets (flatten=false) ===
  if (processor && targets?.length > 1 && !flatten)
    throw new Error("processor is not supported with multiple targets when flatten=false");

  const blockRange = toBlock - fromBlock;
  const effectiveMaxBlockRange = maxBlockRange ?? (noTarget ? 10_000 : Infinity);
  if (!(effectiveMaxBlockRange > 0)) throw new Error("maxBlockRange must be greater than zero");

  if (noTarget && blockRange > 500_000) {
    throw new Error(
      "When noTarget is true, block range must be less than 500k blocks. Please narrow down your block range."
    );
  }

  // Ensure the indexer is synced far enough
  const indexerVersion = getChainIndexerVersion(chain);
  checkIndexerConfig(indexerVersion);
  const chainId = getChainId(chain);
  const chainIndexStatus = await getChainIndexStatus(indexerVersion);
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

    // When flatten=false, preserve per-target buckets: merge RPC logs into their corresponding indexer bucket so the result still maintains one element per target.
    if (!flatten) {
      return indexerLogs.map((bucket, i) => bucket.concat(rpcLogs[i]));
    }

    return indexerLogs.concat(rpcLogs);
  }

  // Re-curse if the requested range is too large
  if (blockRange > effectiveMaxBlockRange) {
    const results: any[][] = [];
    for (
      let currentFromBlock = fromBlock;
      currentFromBlock <= toBlock;
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

  if (clientStreaming) {
    const useAll = all === true;
    const effectiveLimit = useAll ? Number.POSITIVE_INFINITY : (options.limit ?? limit);
    const shouldLimit = !useAll && Number.isFinite(effectiveLimit);
    const effectiveOffset = options.offset ?? initialOffset;

    const collected: any[] = [];
    const start = debugMode ? Date.now() : 0;

    const MICRO_BATCH_SIZE = +(process.env.LLAMA_INDEXER_MICRO_BATCH || 10000);

    const splitByAddress = targets?.length && !flatten;

    const addressBuckets: any[][] = splitByAddress ? targets.map(() => []) : [];
    const addressIndexMap: Record<string, number> = splitByAddress
      ? Object.fromEntries(targets.map((t, i) => [t.toLowerCase(), i]))
      : {};

    let remainingOffset = effectiveOffset;
    let remainingLimit = shouldLimit ? (effectiveLimit as number) : Number.POSITIVE_INFINITY;

    const flushBatch = async (batch: any[]): Promise<void> => {
      if (!batch.length) return;

      const t0 = Date.now();

      const transformedLogs = await decodeStreamingLogs(
        batch, transformLog, viemFastPath ?? (transformLog as LogDecoder).batch, options.onlyArgs,
      );

      const decodeTime = Date.now() - t0;
      onDecodeStats?.({ batchSize: batch.length, decodeTime, itemsDecoded: batch.length });

      if (processor) await processor(transformedLogs);

      if (splitByAddress && options.collect !== false) {
        for (let i = 0; i < batch.length; i++) {
          const raw = batch[i];
          const transformed = transformedLogs[i];
          const idx = addressIndexMap[(raw.source ?? raw.address)?.toLowerCase?.()];
          if (idx !== undefined) {
            addressBuckets[idx].push(transformed);
          }
        }
      } else if (options.collect !== false) {
        safePush(collected, transformedLogs);
      }
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

      await streamLogs({
        path: `/logs?${qs.toString()}`,
        version: indexerVersion,
        onItem: async (raw) => {
          if (stopNow) return;
          if (indexerVersion === "v4") normalizeV4Row(raw, "logs");

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
          if (remainingLimit <= 0) stopNow = true;

          if (transformBatch.length >= MICRO_BATCH_SIZE) {
            const batch = transformBatch.splice(0, MICRO_BATCH_SIZE);
            await flushBatch(batch);
          }
        },
        shouldStop: () => stopNow,
        onChunkStats: onWireStats,
      });

      if (transformBatch.length > 0) {
        await flushBatch(transformBatch.splice(0, transformBatch.length));
      }

      if (remainingLimit <= 0) break;
    }

    if (debugMode) {
      const ms = Date.now() - start;
      debugLog(`[Indexer] stream finished: ${collected.length} items in ${ms}ms`);
    }

    if (splitByAddress) {
      return addressBuckets;
    }

    return collected;
  }

  const allLogsPairs: Array<{ raw: any; transformed: any }> = [];
  const debugTimeKey = `Indexer-getLogs-${chain}-${topic}-${address}_${Math.random()}`;
  if (debugMode) {
    debugLog("[Indexer] Pulling logs " + debugTimeKey);
    console.time(debugTimeKey);
  }

  for (const chunk of addressChunks) {
    if (Array.isArray(chunk) && chunk.length === 0) throw new Error("Address chunk cannot be empty");

    const params = {
      addresses: hasAddressFilter ? chunk?.join(",") : undefined,
      chainId, topic0: topic, from_block: fromBlock, to_block: toBlock,
      topic1, topic2, topic3, noTarget,
    };
    for await (const rows of getIndexerPages(indexerVersion, "/logs", "logs", params, limit, initialOffset, all, getLogCursor)) {
      const filtered = rows.filter((l: any) => {
        const isWhitelisted = !addressSet.size || addressSet.has((l.source ?? l.address)?.toLowerCase?.());
        return !!isWhitelisted;
      });

      const t0 = Date.now();

      for (const log of filtered) {
        normalizeLog(log, true);
      }

      const transformBatchFn =
        (transformLog as any).batch || ((logs: any[]) => Promise.all(logs.map((log: any) => transformLog(log))));

      const transformedLogs = await transformBatchFn(filtered);

      const transformedPair = filtered.map((log: any, idx: number) => ({ raw: log, transformed: transformedLogs[idx] }));
      const decodeTime = Date.now() - t0;
      if (onDecodeStats && filtered.length > 0) onDecodeStats({ batchSize: filtered.length, decodeTime, itemsDecoded: filtered.length });

      if (processor) await processor(transformedPair.map((i: any) => i.transformed));

      if (options.collect !== false) {
        safePush(allLogsPairs, transformedPair);
      }

    }
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

  return allLogsPairs.map(i => i.transformed);
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

  const indexerVersion = getChainIndexerVersion(chain);
  checkIndexerConfig(indexerVersion);
  const chainId = getChainId(chain);

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

  // Ensure the indexer is up-to-date
  const chainIndexStatus = await getChainIndexStatus(indexerVersion);
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

  const params: any = {
    addresses, chainId, from_block: fromBlock, to_block: toBlock, tokens,
    from_address: false, to_address: false,
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

  for await (const rows of getIndexerPages(indexerVersion, "/token-transfers", "transfers", params, limit, offset, all, getTransferCursor)) {
    safePush(rawTransfers, rows);
  }

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
  const indexerVersion = getChainIndexerVersion(chain);
  checkIndexerConfig(indexerVersion);
  const chainId = getChainId(chain);

  if ((!addresses || addresses.length === 0) && (!transaction_hashes || transaction_hashes.length === 0))
    throw new Error("You must provide at least 'addresses' or 'transaction_hashes'");
  if (!from_block || !to_block) throw new Error("'from_block' and 'to_block' are required to search for transactions");

  const chainIndexStatus = await getChainIndexStatus(indexerVersion);
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

  let transactions: any[];
  if (indexerVersion === "v4") {
    transactions = [];
    // all=false with limit=0 historically omitted limit (server default 1000).
    const requestedLimit = typeof limit === "number" && limit > 0 ? limit : 1000;
    // v2 ignores limit when all=true. Preserve that public contract without
    // turning a small caller limit into hundreds of v4 network round trips.
    const pageLimit = all ? Math.max(1000, requestedLimit) : requestedLimit;
    for await (const rows of getV4Pages("/transactions", "transactions", params, pageLimit, offset, all, getTransactionCursor)) {
      safePush(transactions, rows);
    }
  } else {
    const { data } = await axiosInstances.v2('/transactions', { params }).catch((e: any) => { throw formError(e) });
    transactions = data.transactions;
  }

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
  if (!LLAMA_INDEXER_V2_ENDPOINT && !LLAMA_INDEXER_V4_ENDPOINT) return false;
  if (!chain) return true;
  if (!supportedChainSet2.has(chain)) return false;
  return !!indexerConfigs[getChainIndexerVersion(chain)].endpoint;
}

export function isIndexer2Enabled(chain?: string) {
  return isIndexerEnabled(chain);
}
