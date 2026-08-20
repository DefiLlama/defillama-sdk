import axios from "axios";
import { createHash } from "crypto";

const v2Endpoint = process.env.LLAMA_INDEXER_V2_ENDPOINT;
const v4Endpoint = process.env.LLAMA_INDEXER_V4_ENDPOINT || process.env.LLAMA_INDEXER_ENDPOINT;
const v2ApiKey = process.env.LLAMA_INDEXER_V2_API_KEY;
const v4ApiKey = process.env.LLAMA_INDEXER_V4_API_KEY || process.env.LLAMA_INDEXER_API_KEY || v2ApiKey;

const v2TimestampTz = process.env.LLAMA_INDEXER_V2_TIMESTAMP_TZ || "UTC";
const v4TransactionsTimestampTz = process.env.LLAMA_INDEXER_V4_TRANSACTIONS_TIMESTAMP_TZ || process.env.LLAMA_INDEXER_V4_TIMESTAMP_TZ || "UTC";
const v4LogsTimestampTz = process.env.LLAMA_INDEXER_V4_LOGS_TIMESTAMP_TZ || process.env.LLAMA_INDEXER_V4_TIMESTAMP_TZ || "UTC";
const v4TokenTransfersTimestampTz = process.env.LLAMA_INDEXER_V4_TOKEN_TRANSFERS_TIMESTAMP_TZ || process.env.LLAMA_INDEXER_V4_TIMESTAMP_TZ || "UTC";

const enabled = !!(v2Endpoint && v4Endpoint);
const d = enabled ? describe : describe.skip;
const TIMEOUT = 120_000;
const logTimings = process.env.LLAMA_INDEXER_PARITY_TIMINGS === "true";
const syncBlockTolerance = +(process.env.LLAMA_INDEXER_SYNC_BLOCK_TOLERANCE || 100);
const syncTimestampToleranceMs = +(process.env.LLAMA_INDEXER_SYNC_TIMESTAMP_TOLERANCE_MS || 10 * 60 * 1000);
const syncV4OnlyChains = new Set(
  (process.env.LLAMA_INDEXER_SYNC_V4_ONLY_CHAINS || "4663")
    .split(",")
    .map((chain) => chain.trim())
    .filter(Boolean)
);

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn("[indexerRest.parity] need LLAMA_INDEXER_V2_ENDPOINT + LLAMA_INDEXER_V4_ENDPOINT (or LLAMA_INDEXER_ENDPOINT) - skipping");
}

type QueryParams = Record<string, string | number | boolean | undefined>;

type RestCase = {
  name: string;
  path: "/sync" | "/logs" | "/transactions" | "/token-transfers";
  params: QueryParams;
  status?: number;
};

const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDC_WETH_UNIV2_PAIR = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc";
const TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAIR_CREATED_TOPIC0 = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const UNIV2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";

const restCases: RestCase[] = [
  {
    name: "sync all chains",
    path: "/sync",
    params: {},
  },
  {
    name: "sync one chain",
    path: "/sync",
    params: { chainId: 1 },
  },
  {
    name: "logs by address/topic/block range",
    path: "/logs",
    params: {
      chainId: 1,
      addresses: USDC,
      topic0: TRANSFER_TOPIC0,
      from_block: 18_000_000,
      to_block: 18_000_020,
      limit: "all",
      offset: 0,
      includeTotal: true,
    },
  },
  {
    name: "logs no address small range",
    path: "/logs",
    params: {
      chainId: 1,
      topic0: TRANSFER_TOPIC0,
      from_block: 18_000_000,
      to_block: 18_000_002,
      limit: "all",
      offset: 0,
      includeTotal: true,
    },
  },
  {
    name: "logs with topic1/topic2 filters",
    path: "/logs",
    params: {
      chainId: 1,
      addresses: UNIV2_FACTORY,
      topic0: PAIR_CREATED_TOPIC0,
      topic1: "0x000000000000000000000000a0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
      topic2: "0x000000000000000000000000c02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
      from_block: 10_000_000,
      to_block: 10_300_000,
      limit: 10,
      offset: 0,
    },
  },
  {
    name: "logs limit all on bounded range",
    path: "/logs",
    params: {
      chainId: 1,
      addresses: USDC,
      topic0: TRANSFER_TOPIC0,
      from_block: 18_000_000,
      to_block: 18_000_002,
      limit: "all",
      offset: 0,
      includeTotal: true,
    },
  },
  {
    name: "transactions to address",
    path: "/transactions",
    params: {
      chainId: 1,
      addresses: USDC,
      from_address: false,
      to_address: true,
      from_block: 18_000_000,
      to_block: 18_000_030,
      limit: 25,
      offset: 0,
    },
  },
  {
    name: "transactions from or to address",
    path: "/transactions",
    params: {
      chainId: 1,
      addresses: USDC,
      from_address: true,
      to_address: true,
      from_block: 18_000_000,
      to_block: 18_000_030,
      limit: 25,
      offset: 0,
    },
  },
  {
    name: "transactions multi-address pagination",
    path: "/transactions",
    params: {
      chainId: 1,
      addresses: `${USDC},${WETH}`,
      from_address: false,
      to_address: true,
      from_block: 18_000_000,
      to_block: 18_000_100,
      limit: 20,
      offset: 20,
    },
  },
  {
    name: "transactions limit all on bounded range",
    path: "/transactions",
    params: {
      chainId: 1,
      addresses: USDC,
      from_address: false,
      to_address: true,
      from_block: 18_000_000,
      to_block: 18_000_002,
      limit: "all",
      offset: 0,
    },
  },
  {
    name: "logs validation error missing topic0",
    path: "/logs",
    params: { chainId: 1 },
    status: 400,
  },
  {
    name: "transactions validation error missing address/hash",
    path: "/transactions",
    params: { chainId: 1 },
    status: 400,
  },
  {
    name: "token transfers validation error contradictory direction",
    path: "/token-transfers",
    params: {
      chainId: 1,
      addresses: USDC_WETH_UNIV2_PAIR,
      from_address: false,
      to_address: false,
    },
    status: 400,
  },
];

const smallTokenTransferCandidates: QueryParams[] = [
  {
    chainId: 1,
    addresses: USDC_WETH_UNIV2_PAIR,
    tokens: `${USDC},${WETH}`,
    from_address: false,
    to_address: true,
    from_block: 18_000_000,
    to_block: 18_000_020,
    limit: "all",
    offset: 0,
  },
  {
    chainId: 1,
    addresses: USDC_WETH_UNIV2_PAIR,
    tokens: `${USDC},${WETH}`,
    from_address: true,
    to_address: false,
    from_block: 18_000_000,
    to_block: 18_000_020,
    limit: "all",
    offset: 0,
  },
  {
    chainId: 1,
    addresses: USDC_WETH_UNIV2_PAIR,
    tokens: `${USDC},${WETH}`,
    from_address: true,
    to_address: true,
    from_block: 18_000_000,
    to_block: 18_000_020,
    limit: "all",
    offset: 0,
  },
  {
    chainId: 1,
    addresses: USDC_WETH_UNIV2_PAIR,
    tokens: `${USDC},${WETH}`,
    from_address: false,
    to_address: true,
    from_block: 18_000_000,
    to_block: 18_000_030,
    limit: "all",
    offset: 0,
  },
  {
    chainId: 1,
    addresses: USDC_WETH_UNIV2_PAIR,
    tokens: `${USDC},${WETH}`,
    from_address: true,
    to_address: false,
    from_block: 18_000_000,
    to_block: 18_000_030,
    limit: "all",
    offset: 0,
  },
];

const tokenTransfersPaginationExpectedDifferentParams: QueryParams = {
  chainId: 1,
  addresses: USDC_WETH_UNIV2_PAIR,
  tokens: `${USDC},${WETH}`,
  from_address: true,
  to_address: true,
  from_block: 18_000_000,
  to_block: 18_000_150,
  limit: 20,
  offset: 20,
};

const logsPaginationExpectedDifferentParams: QueryParams = {
  chainId: 1,
  addresses: USDC,
  topic0: TRANSFER_TOPIC0,
  from_block: 18_000_000,
  to_block: 18_000_100,
  limit: 10,
  offset: 10,
  includeTotal: true,
};

function endpointUrl(base: string, path: string) {
  return `${base.replace(/\/$/, "")}${path}`;
}

async function getJson(
  base: string,
  apiKey: string | undefined,
  path: string,
  params: QueryParams,
  expectedStatus = 200,
  label?: string
) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    search.set(key, String(value));
  }

  const url = `${endpointUrl(base, path)}${search.toString() ? `?${search.toString()}` : ""}`;
  const started = Date.now();
  const res = await axios.get(url, {
    headers: apiKey ? { "x-api-key": apiKey } : undefined,
    responseType: "text",
    transformResponse: (x) => x,
    decompress: true,
    validateStatus: () => true,
    timeout: TIMEOUT,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  const elapsedMs = Date.now() - started;
  if (logTimings || elapsedMs >= 10_000) {
    // eslint-disable-next-line no-console
    console.warn(`[indexerRest.parity] ${label || path} -> HTTP ${res.status} in ${elapsedMs}ms`);
  }

  expect(res.status).toBe(expectedStatus);
  return JSON.parse(String(res.data || "{}"));
}

function canonicalize(path: RestCase["path"], value: any, side: "v2" | "v4"): any {
  value = normalizeTimestamps(value, timestampTimezone(path, side));
  if (path === "/sync" && Array.isArray(value?.syncStatus)) {
    return {
      ...value,
      syncStatus: [...value.syncStatus].sort((a, b) => Number(a.chain) - Number(b.chain)),
    };
  }
  if (path === "/logs" && Array.isArray(value?.logs)) {
    return {
      ...value,
      logs: sortLogs(value.logs),
    };
  }
  if (path === "/transactions" && Array.isArray(value?.transactions)) {
    return {
      ...value,
      transactions: sortTransactions(value.transactions),
    };
  }
  if (path === "/token-transfers" && Array.isArray(value?.transfers)) {
    return {
      ...value,
      transfers: sortTokenTransfers(value.transfers),
    };
  }
  return value;
}

function assertSyncParity(v4: any, v2: any) {
  const v2Rows = canonicalize("/sync", v2, "v2").syncStatus ?? [];
  const rawV4Rows = canonicalize("/sync", v4, "v4").syncStatus ?? [];
  const v4Rows = rawV4Rows.filter((row: any) => !syncV4OnlyChains.has(String(row.chain)));
  const ignoredV4Rows = rawV4Rows.filter((row: any) => syncV4OnlyChains.has(String(row.chain)));

  if (ignoredV4Rows.length) {
    // eslint-disable-next-line no-console
    console.warn(
      `[indexerRest.parity] ignoring v4-only /sync chains: ${ignoredV4Rows
        .map((row: any) => `${row.name || row.chain} (${row.chain})`)
        .join(", ")}`
    );
  }

  expect(v4Rows.map(syncIdentity)).toEqual(v2Rows.map(syncIdentity));

  for (let i = 0; i < v2Rows.length; i++) {
    const expected = v2Rows[i];
    const received = v4Rows[i];
    const blockDiff = Math.abs(Number(received.lastIndexedBlock) - Number(expected.lastIndexedBlock));
    const timestampDiff = Math.abs(sqlDateTimeMs(received.lastIndexedDate) - sqlDateTimeMs(expected.lastIndexedDate));

    if (blockDiff > syncBlockTolerance) {
      throw new Error(
        `sync block drift too high for ${received.name} (${received.chain}): ` +
        `v2=${expected.lastIndexedBlock}, v4=${received.lastIndexedBlock}, ` +
        `diff=${blockDiff}, tolerance=${syncBlockTolerance}`
      );
    }
    if (timestampDiff > syncTimestampToleranceMs) {
      throw new Error(
        `sync timestamp drift too high for ${received.name} (${received.chain}): ` +
        `v2=${expected.lastIndexedDate}, v4=${received.lastIndexedDate}, ` +
        `diffMs=${timestampDiff}, toleranceMs=${syncTimestampToleranceMs}`
      );
    }
  }
}

function syncIdentity(row: any) {
  return {
    chain: String(row.chain),
    name: row.name,
  };
}

function sqlDateTimeMs(value: string): number {
  const ms = Date.parse(`${value.replace(" ", "T")}Z`);
  if (Number.isNaN(ms)) throw new Error(`Invalid sync lastIndexedDate: ${value}`);
  return ms;
}

function timestampTimezone(path: RestCase["path"], side: "v2" | "v4"): string {
  if (side === "v2") return v2TimestampTz;
  if (path === "/transactions") return v4TransactionsTimestampTz;
  if (path === "/logs") return v4LogsTimestampTz;
  if (path === "/token-transfers") return v4TokenTransfersTimestampTz;
  return "UTC";
}

function canonicalTokenTransfers(value: any, side: "v2" | "v4") {
  const normalized = canonicalize("/token-transfers", value, side);
  return {
    totalCount: normalized.totalCount,
    transfers: normalized.transfers ?? [],
  };
}

function canonicalLogs(value: any, side: "v2" | "v4") {
  const normalized = canonicalize("/logs", value, side);
  return {
    totalCount: normalized.totalCount,
    logs: normalized.logs ?? [],
  };
}

function logStats(value: any, side: "v2" | "v4") {
  const { logs } = canonicalLogs(value, side);
  const logIndexSum = logs.reduce((sum: bigint, log: any) => sum + BigInt(log.log_index ?? 0), BigInt(0));
  const fingerprint = createHash("sha256")
    .update(logs.map(logKey).join("\n"))
    .digest("hex");

  return {
    count: logs.length,
    logIndexSum: logIndexSum.toString(),
    fingerprint,
  };
}

function sortLogs(logs: any[]) {
  return [...logs].sort((a, b) => logKey(a).localeCompare(logKey(b)));
}

function logKey(log: any): string {
  return [
    numKey(log.block_number),
    numKey(log.log_index),
    log.transaction_hash ?? "",
    log.source ?? log.address ?? "",
    log.topic0 ?? "",
    log.topic1 ?? "",
    log.topic2 ?? "",
    log.topic3 ?? "",
    log.data ?? "",
  ].join("|");
}

function sortTransactions(transactions: any[]) {
  return [...transactions].sort((a, b) => transactionKey(a).localeCompare(transactionKey(b)));
}

function transactionKey(tx: any): string {
  return [
    numKey(tx.block_number),
    numKey(tx.transaction_index),
    tx.hash ?? tx.transaction_hash ?? "",
    tx.from_address ?? "",
    tx.to_address ?? "",
    tx.value ?? "",
  ].join("|");
}

function sortTokenTransfers(transfers: any[]) {
  return [...transfers].sort((a, b) => tokenTransferKey(a).localeCompare(tokenTransferKey(b)));
}

function tokenTransferKey(t: any): string {
  return [
    numKey(t.block_number),
    numKey(t.log_index),
    t.id ?? "",
    t.transaction_hash ?? "",
    t.token ?? "",
    t.from_address ?? "",
    t.to_address ?? "",
    t.value ?? "",
    t.type ?? "",
    t.operator ?? "",
  ].join("|");
}

function numKey(value: unknown): string {
  return value === undefined || value === null || value === "" ? "" : String(value).padStart(16, "0");
}

function normalizeTimestamps<T>(value: T, timezone: string): T {
  if (Array.isArray(value)) return value.map((v) => normalizeTimestamps(v, timezone)) as T;
  if (!value || typeof value !== "object") return value;

  const out: any = {};
  for (const [key, item] of Object.entries(value as Record<string, any>)) {
    out[key] = key === "timestamp" && typeof item === "string"
      ? toUtcTimestamp(item, timezone)
      : normalizeTimestamps(item, timezone);
  }
  return out;
}

function toUtcTimestamp(timestamp: string, timezone: string): string {
  if (timezone === "UTC") return timestamp;
  if (timezone !== "Europe/Paris") throw new Error(`Unsupported timestamp timezone in parity tests: ${timezone}`);

  const m = timestamp.match(/^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return timestamp;
  const [, y, mo, d, h, mi, s] = m.map(Number);
  const utcGuess = Date.UTC(y, mo - 1, d, h, mi, s);
  const offsetHours = isEuropeParisDst(utcGuess - 2 * 60 * 60 * 1000) ? 2 : 1;
  return new Date(utcGuess - offsetHours * 60 * 60 * 1000).toISOString().slice(0, 19).replace("T", " ");
}

function isEuropeParisDst(utcMs: number): boolean {
  const year = new Date(utcMs).getUTCFullYear();
  const start = Date.UTC(year, 2, lastSundayOfMonthUtcDay(year, 2), 1, 0, 0);
  const end = Date.UTC(year, 9, lastSundayOfMonthUtcDay(year, 9), 1, 0, 0);
  return utcMs >= start && utcMs < end;
}

function lastSundayOfMonthUtcDay(year: number, month: number): number {
  const d = new Date(Date.UTC(year, month + 1, 0));
  return d.getUTCDate() - d.getUTCDay();
}

async function getSeedTransactionHash(): Promise<string | undefined> {
  const body = await getJson(v2Endpoint!, v2ApiKey, "/transactions", {
    chainId: 1,
    addresses: USDC,
    from_address: false,
    to_address: true,
    from_block: 18_000_000,
    to_block: 18_000_100,
    limit: 1,
    offset: 0,
  });
  return body?.transactions?.[0]?.hash;
}

async function findSmallTokenTransferCase(): Promise<QueryParams | undefined> {
  let fallback: QueryParams | undefined;

  for (const params of smallTokenTransferCandidates) {
    const body = await getJson(v2Endpoint!, v2ApiKey, "/token-transfers", params);
    const count = body?.transfers?.length ?? 0;
    if (count >= 7 && count <= 8) return params;
    if (!fallback && count > 0 && count <= 12) fallback = params;
  }

  return fallback;
}

d("indexer REST v2 vs v4 response parity", () => {
  it.each(restCases)("$name", async ({ name, path, params, status = 200 }) => {
    const [v2, v4] = await Promise.all([
      getJson(v2Endpoint!, v2ApiKey, path, params, status, `v2 ${name}`),
      getJson(v4Endpoint!, v4ApiKey, path, params, status, `v4 ${name}`),
    ]);

    if (path === "/sync") {
      assertSyncParity(v4, v2);
    } else {
      expect(canonicalize(path, v4, "v4")).toEqual(canonicalize(path, v2, "v2"));
    }
  }, TIMEOUT);

  it("token-transfers complete small set has identical information ignoring order", async () => {
    const params = await findSmallTokenTransferCase();
    if (!params) {
      // eslint-disable-next-line no-console
      console.warn("[indexerRest.parity] no small token-transfer fixture found; skipping complete-set multiset parity case");
      return;
    }

    const [v2, v4] = await Promise.all([
      getJson(v2Endpoint!, v2ApiKey, "/token-transfers", params),
      getJson(v4Endpoint!, v4ApiKey, "/token-transfers", params),
    ]);

    expect(canonicalTokenTransfers(v4, "v4")).toEqual(canonicalTokenTransfers(v2, "v2"));
  }, TIMEOUT);

  it("EXPECTED DIFFERENT: logs offset page may differ, full content must still match", async () => {
    const fullParams = {
      ...logsPaginationExpectedDifferentParams,
      limit: "all",
      offset: 0,
      includeTotal: true,
    };
    const [fullV2, fullV4, pageV2, pageV4] = await Promise.all([
      getJson(v2Endpoint!, v2ApiKey, "/logs", fullParams),
      getJson(v4Endpoint!, v4ApiKey, "/logs", fullParams),
      getJson(v2Endpoint!, v2ApiKey, "/logs", logsPaginationExpectedDifferentParams),
      getJson(v4Endpoint!, v4ApiKey, "/logs", logsPaginationExpectedDifferentParams),
    ]);

    expect(logStats(fullV4, "v4")).toEqual(logStats(fullV2, "v2"));
    expect(canonicalLogs(fullV4, "v4")).toEqual(canonicalLogs(fullV2, "v2"));
    expect(Array.isArray(pageV2.logs)).toBe(true);
    expect(Array.isArray(pageV4.logs)).toBe(true);

    const canonicalPageV2 = canonicalize("/logs", pageV2, "v2");
    const canonicalPageV4 = canonicalize("/logs", pageV4, "v4");
    if (JSON.stringify(canonicalPageV4.logs) !== JSON.stringify(canonicalPageV2.logs)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[indexerRest.parity] EXPECTED DIFFERENT: /logs offset pages differ because pagination is applied before canonical sorting. " +
        `Full fetched content matches after canonical sorting. pageStats=${JSON.stringify({
          v2: logStats(pageV2, "v2"),
          v4: logStats(pageV4, "v4"),
        })}`
      );
    }
  }, TIMEOUT);

  it("EXPECTED DIFFERENT: token-transfers offset page order may differ, full content must still match", async () => {
    const fullParams = {
      ...tokenTransfersPaginationExpectedDifferentParams,
      limit: "all",
      offset: 0,
    };
    const [fullV2, fullV4, pageV2, pageV4] = await Promise.all([
      getJson(v2Endpoint!, v2ApiKey, "/token-transfers", fullParams),
      getJson(v4Endpoint!, v4ApiKey, "/token-transfers", fullParams),
      getJson(v2Endpoint!, v2ApiKey, "/token-transfers", tokenTransfersPaginationExpectedDifferentParams),
      getJson(v4Endpoint!, v4ApiKey, "/token-transfers", tokenTransfersPaginationExpectedDifferentParams),
    ]);

    expect(canonicalTokenTransfers(fullV4, "v4")).toEqual(canonicalTokenTransfers(fullV2, "v2"));
    expect(Array.isArray(pageV2.transfers)).toBe(true);
    expect(Array.isArray(pageV4.transfers)).toBe(true);

    const canonicalPageV2 = canonicalize("/token-transfers", pageV2, "v2");
    const canonicalPageV4 = canonicalize("/token-transfers", pageV4, "v4");
    if (JSON.stringify(canonicalPageV4.transfers) !== JSON.stringify(canonicalPageV2.transfers)) {
      // eslint-disable-next-line no-console
      console.warn(
        "[indexerRest.parity] EXPECTED DIFFERENT: /token-transfers offset pages differ because v2 orders by block/timestamp/tx_hash while v4 orders by block/log_index/id. Full fetched content matches after canonical sorting."
      );
    }
  }, TIMEOUT);

  it("transactions by transaction_hashes seeded from v2", async () => {
    const hash = await getSeedTransactionHash();
    if (!hash) {
      // eslint-disable-next-line no-console
      console.warn("[indexerRest.parity] no seed transaction found; skipping transaction_hashes parity case");
      return;
    }

    const params = {
      chainId: 1,
      transaction_hashes: hash,
      from_block: 18_000_000,
      to_block: 18_000_100,
      limit: "all",
      offset: 0,
    };
    const [v2, v4] = await Promise.all([
      getJson(v2Endpoint!, v2ApiKey, "/transactions", params),
      getJson(v4Endpoint!, v4ApiKey, "/transactions", params),
    ]);

    expect(canonicalize("/transactions", v4, "v4")).toEqual(canonicalize("/transactions", v2, "v2"));
  }, TIMEOUT);
});
