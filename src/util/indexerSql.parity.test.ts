import axios from "axios";
import { isIndexerSqlEnabled, queryClickhouse } from "./indexerSql";

const v2cfg = (() => {
  try {
    const c = JSON.parse(process.env.CLICKHOUSE_CONFIG || "");
    return c && c.host ? c : null;
  } catch {
    return null;
  }
})();
const enabled = isIndexerSqlEnabled() && !!v2cfg;
const d = enabled ? describe : describe.skip;
const TIMEOUT = 90_000;
const FORBIDDEN_SQL_RE =
  /\b(INSERT|ALTER|DROP|TRUNCATE|CREATE|DELETE|UPDATE|OPTIMIZE|SYSTEM|KILL|GRANT|REVOKE|ATTACH|DETACH|RENAME)\b/i;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn("[parity.test] need CLICKHOUSE_CONFIG (v2) + LLAMA_INDEXER_SQL_* (v4) — skipping");
}

// Query indexer v2 directly (the exact CH the adapters use today).
async function v2Query<T = any>(
  sql: string,
  params?: Record<string, unknown>,
  settings?: Record<string, string | number>
): Promise<T[]> {
  assertReadonlySql(sql);
  const search = new URLSearchParams({ default_format: "JSONEachRow" });
  for (const [k, v] of Object.entries(params ?? {})) search.set(`param_${k}`, String(v));
  for (const [k, v] of Object.entries(settings ?? {})) search.set(k, String(v));
  const url = `http://${v2cfg.host}:${v2cfg.port}/?${search.toString()}`;
  const { data } = await axios.post(url, sql, {
    auth: { username: v2cfg.username, password: v2cfg.password },
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    responseType: "text",
    transformResponse: (x) => x,
    timeout: TIMEOUT,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  });
  return String(data)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function v4Query<T = any>(
  sql: string,
  params?: Record<string, unknown>,
  settings?: Record<string, string | number>
): Promise<T[]> {
  assertReadonlySql(sql);
  return queryClickhouse<T>(sql, params, settings);
}

function assertReadonlySql(sql: string) {
  if (FORBIDDEN_SQL_RE.test(sql)) {
    throw new Error("Refusing to run non-readonly SQL in parity tests");
  }
}

// ── real contracts / topics on Ethereum mainnet ──
const USDC = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const UNIV2_FACTORY = "0x5c69bee701ef814a2b6a3edd4b1652cb9cc5aa6f";
const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const PAIR_CREATED = "0x0d3648bd0f6ba80134a33ba9275ac585d9d315f0ad8355cddefde31afa28d0e9";
const short = (a: string) => a.slice(0, 10);
const decVal = "reinterpretAsUInt256(reverse(unhex(substring(data, 3, 64))))";
const decAddr = (t: string) => `lower(concat('0x', substring(${t}, 27)))`;

const WETH = "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
const USDT = "0xdac17f958d2ee523a2206206994597c13d831ec7";
const DAI = "0x6b175474e89094c44da98b954eedeac495271d0f";
const WBTC = "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599";
const PAIR_CREATED_SHORT = "0x0d3648bd";
const pad32 = (addr: string) => "0x" + "0".repeat(24) + addr.replace(/^0x/, "").toLowerCase();

// uniswap-v2 discover-pairs shape: WITH [whitelist] + has(). Inflated to ~3.5 MB
// (real 4 MB path) with synthetic entries; real majors return real pairs.
const DISCOVER_WHITELIST = (() => {
  const real = [WETH, USDC, USDT, DAI, WBTC].map(pad32);
  const synth: string[] = [];
  for (let i = 1; i <= 50_000; i++) synth.push("0x" + i.toString(16).padStart(64, "0"));
  return [...real, ...synth];
})();
const BIG_DISCOVER_SQL = `
  WITH [${DISCOVER_WHITELIST.map((x) => `'${x}'`).join(", ")}] AS whitelist
  SELECT topic1 AS token0_padded, topic2 AS token1_padded,
         concat('0x', substring(data, 27, 40)) AS pair
  FROM evm_indexer.logs
  PREWHERE chain = 1 AND short_address = '${short(UNIV2_FACTORY)}'
    AND short_topic0 = '${PAIR_CREATED_SHORT}' AND address = '${UNIV2_FACTORY}'
    AND topic0 = '${PAIR_CREATED}'
  WHERE block_number >= 10000000 AND block_number < 10200000
    AND has(whitelist, topic1) AND has(whitelist, topic2)
  ORDER BY pair ASC LIMIT 50`;

interface Case {
  name: string;
  sql: string;
  params?: Record<string, unknown>;
  settings?: Record<string, string | number>;
}

const cases: Case[] = [
  {
    name: "raw USDC logs sample (rows, ordered)",
    sql: `SELECT block_number, log_index, topic0, topic1, topic2, data
          FROM evm_indexer.logs
          WHERE chain = 1 AND short_address = '${short(USDC)}' AND address = '${USDC}'
            AND block_number >= 18000000 AND block_number < 18000020
          ORDER BY block_number ASC, log_index ASC LIMIT 30`,
  },
  {
    name: "decoded USDC Transfer rows (from/to/value)",
    sql: `SELECT block_number, log_index,
             ${decAddr("topic1")} AS from_addr, ${decAddr("topic2")} AS to_addr,
             toString(${decVal}) AS value
          FROM evm_indexer.logs
          WHERE chain = 1 AND address = '${USDC}' AND topic0 = '${TRANSFER}'
            AND block_number >= 18000000 AND block_number < 18000020
          ORDER BY block_number ASC, log_index ASC LIMIT 30`,
  },
  {
    name: "SUM of decoded USDC transfer value over 1000 blocks (big number)",
    sql: `SELECT toString(sum(${decVal})) AS total, toString(count()) AS n
          FROM evm_indexer.logs
          WHERE chain = 1 AND short_address = '${short(USDC)}' AND address = '${USDC}'
            AND topic0 = '${TRANSFER}'
            AND block_number >= 18000000 AND block_number < 18001000`,
  },
  {
    name: "logs GROUP BY topic0 top-10 (ordered)",
    sql: `SELECT topic0, toString(count()) AS n FROM evm_indexer.logs
          WHERE chain = 1 AND block_number >= 18000000 AND block_number < 18000100
          GROUP BY topic0 ORDER BY n DESC, topic0 ASC LIMIT 10`,
  },
  {
    name: "distinct senders of USDC Transfer over a range",
    sql: `SELECT toString(uniqExact(${decAddr("topic1")})) AS distinct_senders
          FROM evm_indexer.logs
          WHERE chain = 1 AND address = '${USDC}' AND topic0 = '${TRANSFER}'
            AND block_number >= 18000000 AND block_number < 18000500`,
  },
  {
    name: "UniswapV2 PairCreated decode (dex adapter shape)",
    sql: `SELECT block_number, log_index, topic1 AS token0, topic2 AS token1,
             concat('0x', substring(data, 27, 40)) AS pair
          FROM evm_indexer.logs
          WHERE chain = 1 AND short_address = '${short(UNIV2_FACTORY)}' AND address = '${UNIV2_FACTORY}'
            AND short_topic0 = '${short(PAIR_CREATED)}' AND topic0 = '${PAIR_CREATED}'
            AND block_number >= 10000835 AND block_number < 10010000
          ORDER BY block_number ASC, log_index ASC LIMIT 25`,
  },
  {
    name: "transactions rows (hash/from/to/value/gas)",
    sql: `SELECT block_number, transaction_index, hash, from_address, to_address,
             toString(value) AS value, gas_used
          FROM evm_indexer.transactions
          WHERE chain = 1 AND block_number >= 18000000 AND block_number < 18000003
          ORDER BY block_number ASC, transaction_index ASC LIMIT 40`,
  },
  {
    name: "transactions gas-fees aggregate (dimension-adapters fees shape)",
    sql: `SELECT CAST(sum(toDecimal256(gas_used,0) * toDecimal256(effective_gas_price,0)) AS String) AS gas_fees_wei,
             toString(count()) AS n
          FROM evm_indexer.transactions
          WHERE chain = 1 AND block_number >= 18000000 AND block_number < 18000050`,
  },
  {
    name: "TIMESTAMP instant-parity (normalized to UTC on both sides)",
    // Instants are identical; server TZ render differs (v2=Paris, v4=UTC) so we normalize.
    sql: `SELECT toString(count()) AS n,
             toString(toTimeZone(min(timestamp), 'UTC')) AS min_ts,
             toString(toTimeZone(max(timestamp), 'UTC')) AS max_ts
          FROM evm_indexer.logs
          WHERE chain = 1 AND short_address = '${short(USDC)}' AND address = '${USDC}' AND topic0 = '${TRANSFER}'
            AND timestamp >= toDateTime(1693526400) AND timestamp < toDateTime(1693612800)`,
  },
  {
    name: "arbitrum logs decoded rows (cross-chain, historical)",
    sql: `SELECT block_number, log_index, topic0 FROM evm_indexer.logs
          WHERE chain = 42161 AND block_number >= 50000000 AND block_number < 50000200
          ORDER BY block_number ASC, log_index ASC LIMIT 30`,
  },
  {
    name: "base transactions rows (cross-chain, historical)",
    sql: `SELECT block_number, transaction_index, hash, toString(value) AS value
          FROM evm_indexer.transactions
          WHERE chain = 8453 AND block_number >= 5000000 AND block_number < 5000005
          ORDER BY block_number ASC, transaction_index ASC LIMIT 40`,
  },
  {
    name: "DEX discover pairs — real ~3.5 MB IN-list query (uniswap-v2 shape, 4 MB path)",
    sql: BIG_DISCOVER_SQL,
    settings: { max_query_size: 4194304 },
  },
  {
    name: "optimism logs sample (chain 10, historical)",
    sql: `SELECT block_number, log_index, topic0 FROM evm_indexer.logs
          WHERE chain = 10 AND block_number >= 10000000 AND block_number < 10000200
          ORDER BY block_number ASC, log_index ASC LIMIT 40`,
  },
  {
    name: "polygon logs sample (chain 137, historical)",
    sql: `SELECT block_number, log_index, topic0 FROM evm_indexer.logs
          WHERE chain = 137 AND block_number >= 30000000 AND block_number < 30000200
          ORDER BY block_number ASC, log_index ASC LIMIT 40`,
  },
  {
    name: "bsc transactions sample (chain 56, historical)",
    sql: `SELECT block_number, transaction_index, hash, toString(value) AS value
          FROM evm_indexer.transactions
          WHERE chain = 56 AND block_number >= 20000000 AND block_number < 20000005
          ORDER BY block_number ASC, transaction_index ASC LIMIT 60`,
  },
  {
    name: "large result set — 500 logs, 3-column ORDER BY",
    sql: `SELECT block_number, log_index, address, topic0
          FROM evm_indexer.logs
          WHERE chain = 1 AND block_number >= 18000000 AND block_number < 18000100
          ORDER BY block_number ASC, log_index ASC, address ASC LIMIT 500`,
  },
  {
    name: "pagination page 1 (LIMIT 100 OFFSET 0)",
    sql: `SELECT block_number, log_index, topic0 FROM evm_indexer.logs
          WHERE chain = 1 AND block_number >= 18000000 AND block_number < 18000100
          ORDER BY block_number ASC, log_index ASC LIMIT 100 OFFSET 0`,
  },
  {
    name: "pagination page 2 (LIMIT 100 OFFSET 100)",
    sql: `SELECT block_number, log_index, topic0 FROM evm_indexer.logs
          WHERE chain = 1 AND block_number >= 18000000 AND block_number < 18000100
          ORDER BY block_number ASC, log_index ASC LIMIT 100 OFFSET 100`,
  },
  {
    name: "token_transfers real rows (from/to/value/token)",
    sql: `SELECT block_number, log_index, from_address, to_address, toString(value) AS value, address AS token
          FROM evm_indexer.token_transfers
          WHERE chain = 1 AND address = '${USDC}' AND block_number >= 18000000 AND block_number < 18000020
          ORDER BY block_number ASC, log_index ASC, id ASC LIMIT 30`,
  },
];

d("indexer v2 vs v4 result parity", () => {
  it.each(cases)("$name  (v2 === v4)", async ({ sql, params, settings }) => {
    const [v2, v4] = await Promise.all([
      v2Query(sql, params, settings),
      v4Query(sql, params, settings),
    ]);
    // Surface size first for quick triage on mismatch.
    expect({ rows: v4.length }).toEqual({ rows: v2.length });
    expect(v4).toEqual(v2);
  }, TIMEOUT);
});

// ── error parity: the same bad SQL must fail the same way on v2 and v4 ──
const codeOf = (s: unknown): number | null => {
  const m = String(s ?? "").match(/Code:\s*(\d+)/);
  return m ? Number(m[1]) : null;
};
async function v4ErrCode(sql: string): Promise<number | null> {
  try {
    await v4Query(sql);
    return null;
  } catch (e: any) {
    return codeOf(e?.message);
  }
}
async function v2ErrCode(sql: string): Promise<number | null> {
  try {
    await v2Query(sql);
    return null;
  } catch (e: any) {
    return codeOf(e?.response?.data ?? e?.message);
  }
}

const errorCases: { name: string; sql: string; expectCode: number }[] = [
  { name: "unknown column", sql: `SELECT no_such_col FROM evm_indexer.logs WHERE chain = 1 LIMIT 1`, expectCode: 47 },
  { name: "unknown table", sql: `SELECT 1 FROM evm_indexer.no_such_table LIMIT 1`, expectCode: 60 },
  { name: "syntax error", sql: `SELECT FROM evm_indexer.logs`, expectCode: 62 },
  { name: "type mismatch (sum of String column)", sql: `SELECT sum(topic0) FROM evm_indexer.logs WHERE chain = 1 AND block_number < 100`, expectCode: 43 },
];

d("indexer v2 vs v4 error parity", () => {
  it.each(errorCases)("$name → same CH error code on v2 and v4", async ({ sql, expectCode }) => {
    const [v2c, v4c] = await Promise.all([v2ErrCode(sql), v4ErrCode(sql)]);
    expect(v4c).not.toBeNull(); // both must actually error
    expect(v4c).toBe(v2c); // identical failure
    expect(v4c).toBe(expectCode); // and it's the expected CH code
  }, TIMEOUT);
});
