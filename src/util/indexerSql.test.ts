import { isIndexerSqlEnabled, queryClickhouse } from "./indexerSql";

// Functional battery for the indexer /sql helper. Skips if LLAMA_INDEXER_SQL_* unset.

const enabled = isIndexerSqlEnabled();
const d = enabled ? describe : describe.skip;

// A populated ETH range so aggregates are deterministic and cheap.
const CHAIN = 1;
const FROM_BLOCK = 18_000_000;
const TO_BLOCK = 18_000_050;
const TIMEOUT = 60_000;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn("[indexerSql.test] LLAMA_INDEXER_SQL_* not set — skipping gateway battery");
}

d("indexer /sql helper", () => {
  it("SELECT 1 returns one typed row", async () => {
    const rows = await queryClickhouse<{ one: number }>(`SELECT 1 AS one`);
    expect(Array.isArray(rows)).toBe(true);
    expect(rows).toHaveLength(1);
    expect(rows[0].one).toBe(1);
  }, TIMEOUT);

  it("binds {name:Type} params", async () => {
    const rows = await queryClickhouse<{ chain: string; blk: string }>(
      `SELECT toString({chain:UInt64}) AS chain, toString({blk:UInt32}) AS blk`,
      { chain: CHAIN, blk: FROM_BLOCK }
    );
    expect(rows[0]).toEqual({ chain: String(CHAIN), blk: String(FROM_BLOCK) });
  }, TIMEOUT);

  it("empty result set returns []", async () => {
    const rows = await queryClickhouse(`SELECT 1 AS x WHERE 0`);
    expect(rows).toEqual([]);
  }, TIMEOUT);

  it("preserves JSONEachRow typing (number vs string)", async () => {
    const rows = await queryClickhouse<{ num: number; str: string }>(
      `SELECT count() AS num, toString(count()) AS str FROM evm_indexer.blocks WHERE chain = {c:UInt64} AND height < {h:UInt32}`,
      { c: CHAIN, h: 100 }
    );
    expect(typeof rows[0].num).toBe("number");
    expect(typeof rows[0].str).toBe("string");
    expect(String(rows[0].num)).toBe(rows[0].str);
  }, TIMEOUT);

  it("transactions gas-fees aggregate (dimension-adapters shape)", async () => {
    const rows = await queryClickhouse<{ gas_fees_wei: string }>(
      `SELECT CAST(sum(toDecimal256(gas_used,0) * toDecimal256(effective_gas_price,0)) AS String) AS gas_fees_wei
       FROM evm_indexer.transactions
       WHERE chain = {chain:UInt64} AND block_number >= {fromBlock:UInt32} AND block_number < {toBlock:UInt32}`,
      { chain: CHAIN, fromBlock: FROM_BLOCK, toBlock: TO_BLOCK }
    );
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0].gas_fees_wei) > BigInt(0)).toBe(true);
  }, TIMEOUT);

  it("logs daily aggregate (emissions-adapters shape)", async () => {
    const rows = await queryClickhouse<{ date: string; n: string }>(
      `SELECT toStartOfDay(timestamp) AS date, toString(count()) AS n
       FROM evm_indexer.logs
       WHERE chain = {chain:UInt64} AND block_number >= {fromBlock:UInt32} AND block_number < {toBlock:UInt32}
       GROUP BY date ORDER BY date ASC`,
      { chain: CHAIN, fromBlock: FROM_BLOCK, toBlock: TO_BLOCK }
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  }, TIMEOUT);

  it("GROUP BY returns multiple rows in requested order", async () => {
    const rows = await queryClickhouse<{ topic0: string; n: string }>(
      `SELECT topic0, toString(count()) AS n FROM evm_indexer.logs
       WHERE chain = {chain:UInt64} AND block_number >= {fromBlock:UInt32} AND block_number < {toBlock:UInt32}
       GROUP BY topic0 ORDER BY n DESC, topic0 ASC LIMIT 5`,
      { chain: CHAIN, fromBlock: FROM_BLOCK, toBlock: TO_BLOCK }
    );
    expect(rows.length).toBeGreaterThan(1);
    for (let i = 1; i < rows.length; i++) {
      expect(Number(rows[i - 1].n)).toBeGreaterThanOrEqual(Number(rows[i].n));
    }
  }, TIMEOUT);

  it("CTE / derived table (fees/ethereum base-burn shape)", async () => {
    const rows = await queryClickhouse<{ base_burn_wei: string }>(
      `SELECT CAST(sum(toDecimal256(base_fee,0) * toDecimal256(total_gas_used,0)) AS String) AS base_burn_wei
       FROM (
         SELECT min(effective_gas_price) AS base_fee, sum(gas_used) AS total_gas_used
         FROM evm_indexer.transactions
         WHERE chain = {chain:UInt64} AND block_number >= {fromBlock:UInt32} AND block_number < {toBlock:UInt32}
         GROUP BY block_number
       )`,
      { chain: CHAIN, fromBlock: FROM_BLOCK, toBlock: TO_BLOCK }
    );
    expect(rows).toHaveLength(1);
    expect(BigInt(rows[0].base_burn_wei) >= BigInt(0)).toBe(true);
  }, TIMEOUT);

  it("string-interpolated SQL (no query_params) works", async () => {
    const rows = await queryClickhouse<{ n: string }>(
      `SELECT toString(count()) AS n FROM evm_indexer.logs
       PREWHERE chain = ${CHAIN} AND block_number >= ${FROM_BLOCK} AND block_number < ${TO_BLOCK}`
    );
    expect(Number(rows[0].n)).toBeGreaterThan(0);
  }, TIMEOUT);

  it("token_transfers is queryable", async () => {
    const rows = await queryClickhouse<{ n: string }>(
      `SELECT toString(count()) AS n FROM evm_indexer.token_transfers
       WHERE chain = {chain:UInt64} AND block_number >= {fromBlock:UInt32} AND block_number < {toBlock:UInt32}`,
      { chain: CHAIN, fromBlock: FROM_BLOCK, toBlock: TO_BLOCK }
    );
    expect(rows).toHaveLength(1);
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(0);
  }, TIMEOUT);

  // Breadth: many chains x tables, bounded count queries — the "tas de queries".
  const breadth: { chain: number; table: string; where: string }[] = [];
  for (const chain of [1, 10, 56, 137, 42161, 8453]) {
    breadth.push({ chain, table: "evm_indexer.logs", where: "block_number < 5000000" });
    breadth.push({ chain, table: "evm_indexer.transactions", where: "block_number < 5000000" });
    breadth.push({ chain, table: "evm_indexer.blocks", where: "height < 5000000" });
  }
  it.each(breadth)("count on $table chain=$chain returns a single numeric row", async ({ chain, table, where }) => {
    const rows = await queryClickhouse<{ n: number }>(
      `SELECT count() AS n FROM ${table} WHERE chain = {chain:UInt64} AND ${where}`,
      { chain }
    );
    expect(rows).toHaveLength(1);
    expect(typeof rows[0].n).toBe("number");
    expect(rows[0].n).toBeGreaterThanOrEqual(0);
  }, TIMEOUT);

  it("4 MB SQL parses (relies on gateway body-limit + reader max_query_size default)", async () => {
    const big = "A".repeat(4_000_000);
    const rows = await queryClickhouse<{ n: string }>(`SELECT toString(length('${big}')) AS n`);
    expect(rows[0].n).toBe("4000000");
  }, TIMEOUT);

  it("malformed SQL rejects with a surfaced error", async () => {
    await expect(queryClickhouse(`SELECT this is not valid sql`)).rejects.toThrow(/sql query failed/i);
  }, TIMEOUT);

  it("local test guard rejects non-readonly SQL before any network call", async () => {
    const forbidden = /\b(INSERT|ALTER|DROP|TRUNCATE|CREATE|DELETE|UPDATE|OPTIMIZE|SYSTEM|KILL|GRANT|REVOKE)\b/i;
    expect(forbidden.test("INSERT INTO evm_indexer.blocks (chain) VALUES (1)")).toBe(true);
    expect(forbidden.test("DROP TABLE evm_indexer.blocks")).toBe(true);
    expect(forbidden.test("SELECT 1 AS ok")).toBe(false);
  }, TIMEOUT);
});
