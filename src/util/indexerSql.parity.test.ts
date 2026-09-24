import axios from "axios";
import { isIndexerSqlEnabled, queryClickhouse } from "./indexerSql";

type Connection = { host: string; port?: number; database?: string; username: string; password: string };
function readConnection(key: string): Connection | undefined {
  if (!process.env[key]) return;
  try {
    const c = JSON.parse(process.env[key]!);
    if (!c.host || !c.username || !c.password) throw new Error();
    return c;
  } catch { throw new Error(`Invalid ${key}; expected a ClickHouse connection object`); }
}
const v2cfg = readConnection("CLICKHOUSE_CONFIG");
const directV4 = readConnection("CLICKHOUSE_CONFIG_V4");
const enabled = isIndexerSqlEnabled() && !!v2cfg;
const paritySuite = enabled ? describe : describe.skip;
const TIMEOUT = 90_000;
const FORBIDDEN_SQL_RE =
  /\b(INSERT|ALTER|DROP|TRUNCATE|CREATE|DELETE|UPDATE|OPTIMIZE|SYSTEM|KILL|GRANT|REVOKE|ATTACH|DETACH|RENAME)\b/i;

// Query indexer v2 directly (the exact CH the adapters use today).
async function directQuery<T = any>(
  config: Connection,
  sql: string,
  params?: Record<string, unknown>,
  settings?: Record<string, string | number>
): Promise<T[]> {
  assertReadonlySql(sql);
  const endpoint = new URL(config.host.startsWith("http") ? config.host : `http://${config.host}`);
  if (config.port) endpoint.port = String(config.port);
  const search = endpoint.searchParams;
  search.set("default_format", "JSONEachRow");
  if (config.database) search.set("database", config.database);
  for (const [k, v] of Object.entries(params ?? {})) search.set(`param_${k}`, String(v));
  for (const [k, v] of Object.entries(settings ?? {})) search.set(k, String(v));
  const { data } = await axios.post(endpoint.toString(), sql, {
    auth: { username: config.username, password: config.password },
    headers: { "Content-Type": "text/plain; charset=utf-8" },
    responseType: "text",
    transformResponse: (x) => x,
    timeout: TIMEOUT,
    maxContentLength: Infinity,
    maxBodyLength: Infinity,
  }).catch((error) => {
    // Never leak Axios's request config (including credentials) into Jest output.
    const code = String(error.response?.data ?? "").match(/Code:\s*(\d+)/)?.[1];
    throw new Error(`ClickHouse reference HTTP ${error.response?.status ?? "unknown"}; Code: ${code ?? "unknown"}`);
  });
  return String(data)
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function v2Query(sql: string, params?: Record<string, unknown>, settings?: Record<string, string | number>) {
  return directQuery(v2cfg!, sql, params, settings);
}

function rowMultiset(rows: any[]) {
  return rows.map(row => JSON.stringify(Object.fromEntries(Object.keys(row).sort().map(key => [key, row[key]])))).sort();
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

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const short = (address: string) => address.slice(0, 10);
interface Case { name: string; sql: string; params?: Record<string, unknown>; settings?: Record<string, string | number>; verify?: (rows: any[]) => void; }
const cases: Case[] = [
  {
    name: "raw JSON scalar types without casts or SDK normalization",
    sql: `SELECT toUInt32(42) AS small, toUInt64('18446744073709551615') AS large,
          toUInt256('115792089237316195423570985008687907853269984665640564039457584007913129639935') AS uint256,
          CAST(NULL AS Nullable(UInt64)) AS absent, [toUInt64(1), toUInt64(2)] AS items`,
  },
  {
    name: "Ethereum total fees with production parameter types",
    sql: `SELECT CAST(sum(toDecimal256(effective_gas_price, 0) * toDecimal256(gas_used, 0)) AS String) AS total_fees_wei
          FROM evm_indexer.transactions WHERE chain = {chain:UInt64}
          AND block_number >= {fromBlock:UInt32} AND block_number < {toBlock:UInt32}`,
    params: { chain: 1, fromBlock: 18000000, toBlock: 18000020 },
  },
  {
    name: "Ethereum burned fees with production parameter types",
    sql: `SELECT CAST(sum(toDecimal256(base_fee, 0) * toDecimal256(total_gas_used, 0)) AS String) AS base_burn_wei
          FROM (SELECT min(effective_gas_price) AS base_fee, sum(gas_used) AS total_gas_used
          FROM evm_indexer.transactions WHERE chain = {chain:UInt64}
          AND block_number >= {fromBlock:UInt32} AND block_number < {toBlock:UInt32}
          AND block_number >= 12965000 GROUP BY block_number)`,
    params: { chain: 1, fromBlock: 18000000, toBlock: 18000020 },
  },
  {
    name: "raw USDC logs sample (rows, ordered)",
    sql: `SELECT block_number, log_index, topic0, topic1, topic2, data
          FROM evm_indexer.logs
          WHERE chain = 1 AND short_address = '${short(USDC)}' AND address = '${USDC}'
            AND block_number >= 18000000 AND block_number < 18000020
          ORDER BY block_number ASC, log_index ASC LIMIT 30`,
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
    name: "token_transfers real rows (from/to/value/token)",
    sql: `SELECT block_number, log_index, from_address, to_address, toString(value) AS value, address AS token
          FROM evm_indexer.token_transfers
          WHERE chain = 1 AND address = '${USDC}' AND block_number >= 18000000 AND block_number < 18000020
          ORDER BY block_number ASC, log_index ASC, id ASC LIMIT 30`,
  }
];
const consumerCases: Case[] = [
  {
    name: "Flap per-token trade volume from packed event data",
    sql: `SELECT concat('0x', substring(data, 91, 40)) AS token,
      toString(SUM(reinterpretAsUInt256(reverse(unhex(substring(data, 259, 64)))))) AS volume
    FROM evm_indexer.logs PREWHERE chain = 56 AND short_address = '0xe2ce6ab8'
      AND short_topic0 IN ('0xa800a203', '0x03a4693e')
      AND address = '0xe2ce6ab80874fa9fa2aae65d277dd6b8e65c9de0'
      AND topic0 IN ('0xa800a2038683844fac66747f771bfdfae862eb28b16bcfa387afa9fbacce8ff7',
        '0x03a4693e592f5e75dc7c136acb39b146d2b4966c0e509c34f362dee02b3b861a')
      AND block_number >= 123723214 AND block_number <= 123724214 GROUP BY token`,
    verify: rows => rows.forEach(row => {
      expect(row.token).toMatch(/^0x[0-9a-f]{40}$/);
      expect(typeof row.volume).toBe("string");
    }),
  },
];

paritySuite("indexer v2 vs v4 result parity", () => {
  beforeAll(() => {
    // Prevent accidentally treating the same configured connection as a v2 reference.
    if (directV4) expect([v2cfg!.host, v2cfg!.port]).not.toEqual([directV4.host, directV4.port]);
  });
  it.each([...cases, ...consumerCases])("$name  (v2 === v4)", async ({ sql, params, settings, verify }) => {
    const [v2, v4] = await Promise.all([v2Query(sql, params, settings), v4Query(sql, params, settings)]);
    expect({ rows: v4.length }).toEqual({ rows: v2.length });
    expect(v2.length).toBeGreaterThan(0);
    expect(rowMultiset(v4)).toEqual(rowMultiset(v2));
    verify?.(v4);
  }, TIMEOUT);
});

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

paritySuite("indexer v2 vs v4 error parity", () => {
  it.each(errorCases)("$name → same CH error code on v2 and v4", async ({ sql, expectCode }) => {
    const [v2c, v4c] = await Promise.all([v2ErrCode(sql), v4ErrCode(sql)]);
    expect(v4c).not.toBeNull(); // both must actually error
    expect(v4c).toBe(v2c); // identical failure
    expect(v4c).toBe(expectCode); // and it's the expected CH code
  }, TIMEOUT);
});

(isIndexerSqlEnabled() ? describe : describe.skip)('SQL gateway integration', () => {
  const text = "quote' slash\\ tab\t newline\n carriage\r zéro 雪";
  const maxUInt256 = (BigInt(1) << BigInt(256)) - BigInt(1);
  it.each([
    { name: "escaped Unicode scalar", sql: "SELECT {v:String} AS value", params: { v: text }, expected: text },
    { name: "string array", sql: "SELECT {v:Array(String)} AS value", params: { v: [text, "", "NULL"] }, expected: [text, "", "NULL"] },
    { name: "nullable scalar", sql: "SELECT {v:Nullable(String)} AS value", params: { v: null }, expected: null },
    { name: "literal NULL is a string", sql: "SELECT {v:Nullable(String)} AS value", params: { v: "NULL" }, expected: "NULL" },
    { name: "nullable array", sql: "SELECT {v:Array(Nullable(String))} AS value", params: { v: [null, text] }, expected: [null, text] },
    { name: "nested numeric array", sql: "SELECT {v:Array(Array(Int32))} AS value", params: { v: [[1, -2], []] }, expected: [[1, -2], []] },
    { name: "UInt256 precision", sql: "SELECT toString({v:UInt256}) AS value", params: { v: maxUInt256 }, expected: String(maxUInt256) },
    { name: "boolean", sql: "SELECT if({v:Bool}, 'yes', 'no') AS value", params: { v: true }, expected: "yes" },
    { name: "DateTime64 milliseconds", sql: "SELECT toString({v:DateTime64(3, 'UTC')}) AS value", params: { v: new Date("2020-01-01T00:00:00.123Z") }, expected: "2020-01-01 00:00:00.123" },
    { name: "Map parameter", sql: "SELECT {v:Map(String,String)} AS value", params: { v: new Map([["a'b", text]]) }, expected: { "a'b": text } },
    { name: "object map parameter", sql: "SELECT {v:Map(String,String)} AS value", params: { v: { key: text } }, expected: { key: text } },
  ])("round-trips $name through the real gateway", async ({ sql, params, expected }) => {
    expect(await queryClickhouse(sql, params)).toEqual([{ value: expected }]);
  }, TIMEOUT);
  test('empty result', async () => { expect(await queryClickhouse('SELECT 1 WHERE 0')).toEqual([]); });
  test('large query is accepted by the configured gateway', async () => {
    const text = 'x'.repeat(4_000_000);
    expect(await queryClickhouse(`SELECT toString(length('${text}')) AS n`)).toEqual([{ n: '4000000' }]);
  }, TIMEOUT);
  test('server errors reject', async () => {
    await expect(queryClickhouse('SELECT this is not valid sql')).rejects.toThrow(/sql query failed/i);
  });
});
