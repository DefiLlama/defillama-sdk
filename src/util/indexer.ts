import axios from "axios";
import { sliceIntoChunks } from ".";
import { ETHER_ADDRESS } from "../general";
import { formError, getUniqueAddresses } from "./common";
import { Address } from "../types";
import { getBlockNumber } from "./blocks";
import { readCache, writeCache } from "./cache";
import { DEBUG_LEVEL2, debugLog } from "./debugLog";
import { getEnvValue, ENV_CONSTANTS } from "./env";
import { getLogParams, getLogs as getLogsParent } from "./logs";
import { GetTransactionOptions } from "./transactions";

const indexerURL = getEnvValue("LLAMA_INDEXER_ENDPOINT");
const LLAMA_INDEXER_API_KEY = getEnvValue("LLAMA_INDEXER_API_KEY");
const LLAMA_INDEXER_V2_ENDPOINT = getEnvValue("LLAMA_INDEXER_V2_ENDPOINT");
const LLAMA_INDEXER_V2_API_KEY = getEnvValue("LLAMA_INDEXER_V2_API_KEY");
const addressChunkSize = +getEnvValue("LLAMA_INDEXER_ADDRESS_CHUNK_SIZE")! || 100;
const INDEXER_REQUEST_TIMEOUT_MS = +(getEnvValue("LLAMA_INDEXER_TIMEOUT_MS")) || 300_000;

// v1 chains (still used for balances endpoint) -------------------------------------------------
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

/**
 * Indexer configuration per version. We keep v1 **only** for legacy `/balances` endpoint.
 */
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

const axiosInstances = {
  v1: axios.create({
    headers: { "x-api-key": indexerConfigs.v1.apiKey },
    baseURL: indexerConfigs.v1.endpoint,
    timeout: INDEXER_REQUEST_TIMEOUT_MS,
  }),
  v2: axios.create({
    headers: { "x-api-key": indexerConfigs.v2.apiKey },
    baseURL: indexerConfigs.v2.endpoint,
    timeout: INDEXER_REQUEST_TIMEOUT_MS,
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

const chainToIDMapping2: Record<string, number> = {};
Object.entries(indexerConfigs.v2.chainMapping).forEach(([id, chain]) => {
  chainToIDMapping2[chain] = +id;
});

// ---------------------------------------------------------------------------
// In‑memory sync‑status cache helpers
// ---------------------------------------------------------------------------

type ChainIndexStatus = { [chain: string]: { block: number; timestamp: number } };
const state: { timestamp?: number; chainIndexStatus: ChainIndexStatus | Promise<ChainIndexStatus> } = {
  chainIndexStatus: {},
};
const cacheTime = 1 * 60 * 1000; // 1 min

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

// ---------------------------------------------------------------------------
// Utilities / Enums / Types
// ---------------------------------------------------------------------------

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
  parseLog?: boolean;
  processor?: (logs: any[]) => Promise<void> | void;
  maxBlockRange?: number;
  allowParseFailure?: boolean;
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

// ---------------------------------------------------------------------------
// Token helpers (still via v1 endpoint)
// ---------------------------------------------------------------------------

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
// LOGS (v2 only)
// ---------------------------------------------------------------------------

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
  } = options;

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

  if (!debugMode) debugMode = DEBUG_LEVEL2 && !!ENV_CONSTANTS.GET_LOGS_INDEXER;

  const blockRange = toBlock - fromBlock;
  const effectiveMaxBlockRange = maxBlockRange ?? (noTarget ? 10_000 : Infinity);

  if (noTarget && blockRange > 500_000) {
    throw new Error(
      "When noTarget is true, block range must be less than 500k blocks. Please narrow down your block range."
    );
  }

  // We now only support v2 for logs ---------------------------------------------------------
  checkIndexerConfig("v2");
  const chainId = getChainId(chain, "v2");

  // Ensure the indexer is synced far enough
  const chainIndexStatus = await getChainIndexStatus("v2");
  const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0;
  if (lastIndexedBlock < toBlock) {

    const percentageMissing = ((toBlock - lastIndexedBlock) / (toBlock - fromBlock)) * 100



    if (percentageMissing > 50)  // more than 50% of the requested range is missing, throw an error and so we pull the logs through rpc calls
      throw new Error(
        `Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`
      );

    if (ENV_CONSTANTS.GET_LOGS_INDEXER)
      debugLog(`Indexer only partially up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}, missing ${Number(percentageMissing).toFixed(2)}%. Pulling part of the logs through RPC calls.`);

    // now we split the request into two parts, one that goes to the indexer and one that goes through rpc calls

    const breakBlock = lastIndexedBlock - 50 // we add a small buffer to avoid missing logs due to reorgs

    const indexerLogs = await getLogs({ ...options, fromBlock, toBlock: breakBlock })
    const rpcLogs = await getLogsParent({ ...options, fromBlock: breakBlock + 1, toBlock, skipIndexer: true })


    return indexerLogs.concat(rpcLogs)
  }

  // Re‑curse if the requested range is too large ------------------------------------------------
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

  // -------------------------------------------------------------------------
  // Prepare address filters
  // -------------------------------------------------------------------------
  let address = target as string | undefined;
  if (typeof target === "string") targets = [target];
  if (Array.isArray(targets) && targets.length) address = targets.join(",");

  const hasAddressFilter = !!address?.length;
  if (address) address = address.toLowerCase();

  const addressSet = new Set((address ?? "").split(",").filter(Boolean));
  const addressChunks = sliceIntoChunks(address?.split(",") ?? [], addressChunkSize);
  if (noTarget && addressChunks.length === 0) addressChunks.push(undefined as any);

  // -------------------------------------------------------------------------
  // Pull logs
  // -------------------------------------------------------------------------
  const allLogs: any[] = [];
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
        eventAbi: options.eventAbi,
        parseLog: options.parseLog,
        onlyArgs: options.onlyArgs,
      };

      const {
        data: { logs: _logs, totalCount },
      } = await axiosInstances.v2(`/logs`, { params }).catch(e => { throw formError(e) })

      const filtered = _logs.filter((l: any) => {
        const isWhitelisted = !addressSet.size || addressSet.has(l.source.toLowerCase());
        if (!isWhitelisted) return false;
        if (l.block_number) {
          l.blockNumber = parseInt(l.block_number);
        }
        return true;
      });

      // we need to the { raw, transformed } structure to allow for post‑processing like clustering based on `source` field
      const transformed = filtered.map((log: any) => ({ raw: log, transformed: transformLog(log) }));

      if (processor) await processor(transformed.map((i: any) => i.transformed));

      allLogs.push(...transformed);

      logCount += _logs.length;
      chunkOffset += limit;
      if (_logs.length < limit || totalCount <= logCount || _logs.length === 0) hasMore = false;
    } while (all && hasMore);
  }

  if (debugMode) {
    console.timeEnd(debugTimeKey);
    debugLog("Logs pulled " + chain, address, allLogs.length);
  }

  // -------------------------------------------------------------------------
  // Map / transform result
  // -------------------------------------------------------------------------
  const splitByAddress = targets?.length && !flatten;
  if (splitByAddress) {
    const mapped: any[] = targets.map(() => []);
    const indexMap: Record<string, number> = {};
    targets.forEach((t, i) => (indexMap[t.toLowerCase()] = i));

    allLogs.forEach(({ raw, transformed }) => {
      const idx = indexMap[raw.source.toLowerCase()];
      if (idx === undefined) return; // ignore unknown sources
      mapped[idx].push(transformed);
    });
    return mapped;
  }

  return allLogs.map(i => i.transformed)
}

// ---------------------------------------------------------------------------
// TOKEN TRANSFERS (v2 only)
// ---------------------------------------------------------------------------

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

  // -----------------------------------------------------------------------
  // Input validation & pre‑processing
  // -----------------------------------------------------------------------
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

  // Ensure v2 indexer is up‑to‑date
  const chainIndexStatus = await getChainIndexStatus("v2");
  const lastIndexedBlock = chainIndexStatus[chain]?.block ?? 0;
  if (lastIndexedBlock < toBlock) {
    throw new Error(
      `Indexer not up to date for ${chain}. Last indexed block: ${lastIndexedBlock}, requested block: ${toBlock}`
    );
  }

  // -----------------------------------------------------------------------
  // Fetch transfers
  // -----------------------------------------------------------------------
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
      data: { transfers: _logs, totalCount },
    } = await axiosInstances.v2(`/token-transfers`, { params }).catch(e => { throw formError(e) })

    rawTransfers.push(..._logs);
    currentOffset += limit;

    if (_logs.length < limit || totalCount <= rawTransfers.length || _logs.length === 0) hasMore = false;
  } while (all && hasMore);

  const filteredTransfers = rawTransfers.filter((l: any) => {
    if (!fromFilterEnabled) return true;
    return fromFilterSet.has(l.from_address.toLowerCase());
  });

  if (debugMode) {
    console.timeEnd(debugTimeKey);
    debugLog("Token Transfers pulled " + chain, addresses, filteredTransfers.length);
  }

  // -----------------------------------------------------------------------
  // Split result if requested
  // -----------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// TRANSACTIONS (v2 only)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------
export function isIndexerEnabled(chain?: string) {
  // Legacy function kept for backward‑compat: return true if v2 is enabled
  if (!indexerConfigs.v2.endpoint) return false;
  if (chain && !supportedChainSet2.has(chain)) return false;
  return true;
}

export function isIndexer2Enabled(chain?: string) {
  // Alias – retained so external calls do not break
  return isIndexerEnabled(chain);
}
