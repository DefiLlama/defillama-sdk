type Indexer = typeof import("./indexer");

const enabled = !!(
  process.env.LLAMA_INDEXER_V2_ENDPOINT &&
  process.env.LLAMA_INDEXER_V2_API_KEY &&
  process.env.LLAMA_INDEXER_V4_ENDPOINT
);
const d = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn("[indexer.e2e] need LLAMA_INDEXER_V2_ENDPOINT + LLAMA_INDEXER_V2_API_KEY + LLAMA_INDEXER_V4_ENDPOINT - skipping");
}

let v2Routed: Indexer; // PREFER_V4 off  -> v2 chains hit v2, robinhood hits v4
let v4Routed: Indexer; // PREFER_V4 true -> everything hits v4

const savedPreferV4 = process.env.LLAMA_INDEXER_PREFER_V4;

beforeAll(() => {
  if (!enabled) return;

  delete process.env.LLAMA_INDEXER_PREFER_V4;
  jest.resetModules();
  v2Routed = require("./indexer");

  process.env.LLAMA_INDEXER_PREFER_V4 = "true";
  jest.resetModules();
  v4Routed = require("./indexer");

  if (savedPreferV4 === undefined) delete process.env.LLAMA_INDEXER_PREFER_V4;
  else process.env.LLAMA_INDEXER_PREFER_V4 = savedPreferV4;
});

/* ----------------------- canonical byte-to-byte compare ----------------------- */

// Stable stringify: sorted object keys, BigInt-safe. Two payloads with the same
// data always produce the same bytes regardless of key/row order.
function canonical(value: any): string {
  return JSON.stringify(sortKeys(value), (_k, v) => (typeof v === "bigint" ? `bigint:${v}` : v));
}

function sortKeys(value: any): any {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object" && value.constructor === Object) {
    const out: any = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

// Order-insensitive: each row serialized then sorted as strings.
function canonicalRows(rows: any[]): string[] {
  return rows.map(canonical).sort();
}

function expectSameRows(v4rows: any[], v2rows: any[], expectedCount?: number) {
  if (expectedCount !== undefined) expect(v2rows.length).toBe(expectedCount);
  expect(v4rows.length).toBe(v2rows.length);
  expect(canonicalRows(v4rows)).toEqual(canonicalRows(v2rows));
}

/* --------------------------------- fixtures ---------------------------------- */

const MARKET_CREATED_CONTRACT = "0xf33c13da4425629c3f10635e4f935d8020f97D1F";
const MARKET_CREATED_ABI =
  "event MarketCreated(uint256 indexed mIndex, address hedge, address risk, address token, string name, int256 strikePrice)";
const SWAP_EVENT =
  "event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)";
const UNIV2_PAIRS = ["0xDFC14d2Af169B0D36C4EFF567Ada9b2E0CAE044f", "0xBb2b8038a1640196FbE3e38816F3e67Cba72D940"].map((i) =>
  i.toLowerCase()
);

const RH_TOKEN = "0x0bd7d308f8e1639fab988df18a8011f41eacad73";
const RH_RECIPIENT = "0x8876789976decbfcbbbe364623c63652db8c0904";

/* ----------------------------------- tests ----------------------------------- */

d("indexer E2E - PREFER_V4=false (v2) vs PREFER_V4=true (v4), same data byte-to-byte", () => {
  test("routing sanity: the two instances route v2 chains differently, robinhood identically", () => {
    expect(v2Routed.getChainIndexerVersion("ethereum")).toBe("v2");
    expect(v4Routed.getChainIndexerVersion("ethereum")).toBe("v4");
    expect(v2Routed.getChainIndexerVersion("robinhood")).toBe("v4");
    expect(v4Routed.getChainIndexerVersion("robinhood")).toBe("v4");
  });

  test("getLogs - single target, entire logs (ethereum)", async () => {
    const params = {
      target: MARKET_CREATED_CONTRACT,
      eventAbi: MARKET_CREATED_ABI,
      fromBlock: 16310967,
      toBlock: 16610967,
      chain: "ethereum",
      entireLog: true,
    };
    const [v2res, v4res] = await Promise.all([v2Routed.getLogs(params), v4Routed.getLogs(params)]);
    expectSameRows(v4res, v2res, 2);
  }, 120_000);

  test("getLogs - multiple targets, decoded args (ethereum univ2 swaps)", async () => {
    const params = {
      targets: UNIV2_PAIRS,
      fromBlock: 22018452,
      toBlock: 22019085,
      chain: "ethereum",
      topic: SWAP_EVENT,
    };
    const [v2res, v4res] = await Promise.all([v2Routed.getLogs(params), v4Routed.getLogs(params)]);
    expectSameRows(v4res, v2res, 37);
  }, 120_000);

  test("getLogs - noTarget (ethereum)", async () => {
    const params = {
      fromBlock: 22280140,
      toBlock: 22280145,
      chain: "ethereum",
      topic: SWAP_EVENT,
      noTarget: true,
    };
    const [v2res, v4res] = await Promise.all([v2Routed.getLogs(params), v4Routed.getLogs(params)]);
    expectSameRows(v4res, v2res, 94);
  }, 120_000);

  test("getTokenTransfers (arbitrum)", async () => {
    const params = {
      targets: ["0x1B5e59759577fa0079e2a35bc89143bc0603d546", "0xD5aC6419635Aa6352EbaDe0Ab42d25FbFa570D21"],
      tokens: ["0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "0x09faeb69e29845f3326e4f004f45a31ceb0eedb9"],
      fromBlock: 119877801,
      toBlock: 119943935,
      chain: "arbitrum",
    };
    const [v2res, v4res] = await Promise.all([v2Routed.getTokenTransfers(params), v4Routed.getTokenTransfers(params)]);
    expectSameRows(v4res, v2res, 2);
  }, 120_000);

  test("getTransactions (ethereum)", async () => {
    const params = {
      chain: "ethereum",
      addresses: ["0x00a7227f026012459c218f0d9eaabd992bd48c56"],
      transaction_hashes: ["0x1d1a14b882adf9d9c078a9868b682eba7833ebfd59ee0a93aa477c990056aa79"],
      from_block: 19000067,
      to_block: 19001067,
    };
    const [v2res, v4res] = await Promise.all([v2Routed.getTransactions(params), v4Routed.getTransactions(params)]);
    expectSameRows(v4res ?? [], v2res ?? [], 1);
  }, 120_000);

  test("robinhood (v4-only) returns the same data through both instances", async () => {
    const params = {
      target: RH_RECIPIENT,
      tokens: [RH_TOKEN],
      fromBlock: 41_000_000,
      toBlock: 41_001_000,
      chain: "robinhood",
    };
    const [a, b] = await Promise.all([v2Routed.getTokenTransfers(params), v4Routed.getTokenTransfers(params)]);
    expectSameRows(b, a, 104);
  }, 120_000);
});
