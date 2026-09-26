import { Readable } from "stream";
import { Interface } from "ethers";
import { parseTransferResponse } from "./indexer.compatibility";

// resetModules reloads SDK modules that register process cleanup listeners.
const processEvents = ["exit", "SIGINT", "SIGTERM"] as const;
const processEmitter: import("events").EventEmitter = process;
const originalListeners = new Map(processEvents.map(event => [event, new Set(processEmitter.listeners(event))]));
afterEach(() => {
  for (const event of processEvents) {
    for (const listener of processEmitter.listeners(event)) {
      if (!originalListeners.get(event)!.has(listener))
        processEmitter.removeListener(event, listener as (...args: any[]) => void);
    }
  }
});

describe("routing", () => {
  const ENV_KEYS = [
    "LLAMA_INDEXER_V2_ENDPOINT",
    "LLAMA_INDEXER_V2_API_KEY",
    "LLAMA_INDEXER_V4_ENDPOINT",
    "LLAMA_INDEXER_V4_API_KEY",
    "LLAMA_INDEXER_PREFER_V4",
    "LLAMA_INDEXER_V4_ONLY_CHAINS",
  ];

  const savedEnv: Record<string, string | undefined> = {};

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  function loadIndexer(env: Record<string, string>) {
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);
    jest.resetModules();
    return require("./indexer") as typeof import("./indexer");
  }

  const V2 = "https://v2.example.com";
  const V4 = "https://v4.example.com";
  const KEY = "test-key";

  test("v2 + v4 configured: v4 is preferred by default", () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V2_ENDPOINT: V2,
      LLAMA_INDEXER_V2_API_KEY: KEY,
      LLAMA_INDEXER_V4_ENDPOINT: V4,
    });

    expect(indexer.getChainIndexerVersion("ethereum")).toBe("v4");
    expect(indexer.getChainIndexerVersion("arbitrum")).toBe("v4");
    expect(indexer.getChainIndexerVersion("base")).toBe("v4");
    expect(indexer.getChainIndexerVersion("robinhood")).toBe("v4");

    expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
    expect(indexer.isIndexerEnabled("robinhood")).toBe(true);
    expect(indexer.isIndexerEnabled("notachain")).toBe(false);
  });

  test("PREFER_V4=true routes everything to v4", () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V2_ENDPOINT: V2,
      LLAMA_INDEXER_V2_API_KEY: KEY,
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_PREFER_V4: "true",
    });

    expect(indexer.getChainIndexerVersion("ethereum")).toBe("v4");
    expect(indexer.getChainIndexerVersion("robinhood")).toBe("v4");
    expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
  });

  test("only v2 configured: v2 chains work, robinhood is disabled (falls back to RPC upstream)", () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V2_ENDPOINT: V2,
      LLAMA_INDEXER_V2_API_KEY: KEY,
    });

    expect(indexer.getChainIndexerVersion("ethereum")).toBe("v2");
    expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
    // robinhood is v4-only: without a v4 endpoint the indexer must report it as unsupported
    expect(indexer.isIndexerEnabled("robinhood")).toBe(false);
  });

  test("only v4 configured: everything routes to v4", () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_V4_API_KEY: KEY,
    });

    expect(indexer.getChainIndexerVersion("ethereum")).toBe("v4");
    expect(indexer.getChainIndexerVersion("robinhood")).toBe("v4");
    expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
    expect(indexer.isIndexerEnabled("robinhood")).toBe(true);
  });

  test("no indexer configured: everything disabled", () => {
    const indexer = loadIndexer({});

    expect(indexer.isIndexerEnabled()).toBe(false);
    expect(indexer.isIndexerEnabled("ethereum")).toBe(false);
    expect(indexer.isIndexerEnabled("robinhood")).toBe(false);
  });

  test("LLAMA_INDEXER_V4_ONLY_CHAINS extends the v4-only set without a release", () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V2_ENDPOINT: V2,
      LLAMA_INDEXER_V2_API_KEY: KEY,
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_V4_ONLY_CHAINS: "4242:somechain",
    });

    expect(indexer.supportedChainSet2.has("somechain")).toBe(true);
    expect(indexer.getChainIndexerVersion("somechain")).toBe("v4");
    expect(indexer.isIndexerEnabled("somechain")).toBe(true);
    expect(indexer.getChainIndexerVersion("ethereum")).toBe("v4");
  });

  test("PREFER_V4=false rolls legacy chains back to v2", () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V2_ENDPOINT: V2,
      LLAMA_INDEXER_V2_API_KEY: KEY,
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_PREFER_V4: "false",
    });
    expect(indexer.getChainIndexerVersion("ethereum")).toBe("v2");
    expect(indexer.getChainIndexerVersion("robinhood")).toBe("v4");
  });
});

describe("pagination", () => {
  const ENV_KEYS = [
    "LLAMA_INDEXER_V2_ENDPOINT",
    "LLAMA_INDEXER_V2_API_KEY",
    "LLAMA_INDEXER_V4_ENDPOINT",
    "LLAMA_INDEXER_V4_API_KEY",
    "LLAMA_INDEXER_PREFER_V4",
    "LLAMA_INDEXER_V4_ONLY_CHAINS",
  ];

  const savedEnv: Record<string, string | undefined> = {};
  const V2 = "https://v2.example.com";
  const V4 = "https://v4.example.com";
  const KEY = "test-key";
  const TARGET = "0x00000000000000000000000000000000000000aa";
  const TOPIC0 = `0x${"1".repeat(64)}`;

  let requests: Array<{ version: string; path: string; params?: any }> = [];
  let routeCalls: Record<string, number> = {};
  let pages: Record<string, any[][]> = {};
  let transferWireText = false;

  beforeAll(() => {
    for (const key of ENV_KEYS) savedEnv[key] = process.env[key];
  });

  afterAll(() => {
    for (const key of ENV_KEYS) {
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
  });

  afterEach(() => {
    jest.dontMock("axios");
  });

  function makeLog(block: number, index: number) {
    return {
      chain: 1,
      block_number: block,
      log_index: index,
      timestamp: "2026-09-07T00:00:00.000Z",
      transaction_hash: `0x${String(block).padStart(64, "0")}`,
      source: TARGET,
      topic0: TOPIC0,
      data: "0x",
    };
  }

  function makeTransfer(block: number, index: number, id: number) {
    return {
      chain: 1,
      value: "1",
      block_number: block,
      type: "erc1155",
      from_address: "0x00000000000000000000000000000000000000bb",
      to_address: TARGET,
      token: "0x00000000000000000000000000000000000000cc",
      transaction_hash: `0x${String(block).padStart(64, "0")}`,
      timestamp: "2026-09-07T00:00:00.000Z",
      log_index: index,
      id: String(id),
      operator: "0x00000000000000000000000000000000000000dd",
    };
  }

  function nextPage(version: string, path: string, firstPage: any[], secondPage: any[]) {
    const key = `${version}:${path}`;
    routeCalls[key] = (routeCalls[key] ?? 0) + 1;
    return pages[path] ? (pages[path][routeCalls[key] - 1] ?? []) : routeCalls[key] === 1 ? firstPage : routeCalls[key] === 2 ? secondPage : [];
  }

  function loadIndexer(env: Record<string, string>) {
    requests = [];
    routeCalls = {};
    pages = {};
    transferWireText = false;
    jest.resetModules();
    for (const key of ENV_KEYS) delete process.env[key];
    Object.assign(process.env, env);

    jest.doMock("axios", () => {
      const create = jest.fn((config: any) => {
        const version = config.baseURL === V4 ? "v4" : "v2";
        const instance: any = jest.fn((path: string, requestConfig: any = {}) => {
          requests.push({ version, path, params: { ...requestConfig.params } });

          if (path === "/logs") {
            return Promise.resolve({
              data: {
                logs: nextPage(version, path, [makeLog(10, 0), makeLog(11, 0)], [makeLog(12, 0)]),
              },
            });
          }

          if (path === "/token-transfers") {
            const data = {
              transfers: nextPage(
                version,
                path,
                [makeTransfer(10, 7, 1), makeTransfer(10, 7, 2)],
                [makeTransfer(10, 7, 3)]
              ),
            };
            return Promise.resolve({
              data: transferWireText
                ? JSON.stringify(data).replace(/"id":"(\d+)"/g, '"id":$1') : data
            });
          }

          if (path === "/transactions") return Promise.resolve({
            data: {
              transactions: nextPage(version, path, [], []),
            }
          });
          throw new Error(`Unexpected path: ${path}`);
        });

        instance.get = jest.fn((path: string) => {
          requests.push({ version, path });
          if (path !== "/sync") throw new Error(`Unexpected GET path: ${path}`);
          return Promise.resolve({
            data: {
              syncStatus: [
                { chain: 1, lastIndexedBlock: 100, lastIndexedDate: "2026-09-07T00:00:00.000Z" },
                { chain: 4663, lastIndexedBlock: 100, lastIndexedDate: "2026-09-07T00:00:00.000Z" },
              ],
            },
          });
        });

        return instance;
      });

      const mockedAxios = { create, isCancel: jest.fn(() => false) };
      return { __esModule: true, default: mockedAxios, ...mockedAxios };
    });

    return require("./indexer") as typeof import("./indexer");
  }

  test("v4 getLogs paginates with cursor without sending offset above limit", async () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_V4_API_KEY: KEY,
    });

    const logs = await indexer.getLogs({
      chain: "ethereum",
      target: TARGET,
      topic: TOPIC0,
      fromBlock: 1,
      toBlock: 20,
      limit: 2,
      offset: 1,
      all: true,
    });

    const logRequests = requests.filter((request) => request.path === "/logs");
    expect(logs).toHaveLength(2);
    expect(logRequests).toHaveLength(2);
    expect(logRequests.map((request) => request.params.offset)).toEqual([0, 0]);
    expect(logRequests[1].params.after_block).toBe(11);
    expect(logRequests[1].params.after_index).toBe(0);
    expect(logRequests.every((request) => request.params.offset <= request.params.limit)).toBe(true);
    expect(logRequests.every((request) => request.params.includeTotal === false)).toBe(true);
  });

  test("v4 getTokenTransfers cursor includes after_id tiebreaker", async () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_V4_API_KEY: KEY,
    });

    const transfers = await indexer.getTokenTransfers({
      chain: "ethereum",
      target: TARGET,
      fromBlock: 1,
      toBlock: 20,
      limit: 2,
      offset: 1,
      all: true,
      transferType: "in",
    });

    const transferRequests = requests.filter((request) => request.path === "/token-transfers");
    expect(transfers).toHaveLength(2);
    expect(transferRequests).toHaveLength(2);
    expect(transferRequests.map((request) => request.params.offset)).toEqual([0, 0]);
    expect(transferRequests[1].params.after_block).toBe(10);
    expect(transferRequests[1].params.after_index).toBe(7);
    expect(transferRequests[1].params.after_id).toBe("2");
    expect(transferRequests.every((request) => request.params.offset <= request.params.limit)).toBe(true);
    expect(transferRequests.every((request) => request.params.includeTotal === false)).toBe(true);
  });

  test("v4 all=false skips rows locally with cursors", async () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_V4_API_KEY: KEY,
    });

    await indexer.getLogs({
      chain: "ethereum",
      target: TARGET,
      topic: TOPIC0,
      fromBlock: 1,
      toBlock: 20,
      limit: 2,
      offset: 2,
      all: false,
    });

    const logRequests = requests.filter((request) => request.path === "/logs");
    expect(logRequests).toHaveLength(2);
    expect(logRequests.every(r => r.params.offset === 0)).toBe(true);
    expect(logRequests[0].params.after_block).toBeUndefined();
    expect(logRequests[0].params.after_index).toBeUndefined();
  });

  test("v4 all=false transfers skip rows locally with cursors", async () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V4_ENDPOINT: V4,
      LLAMA_INDEXER_V4_API_KEY: KEY,
    });

    await indexer.getTokenTransfers({
      chain: "ethereum",
      target: TARGET,
      fromBlock: 1,
      toBlock: 20,
      limit: 2,
      offset: 2,
      all: false,
      transferType: "in",
    });

    const transferRequests = requests.filter((request) => request.path === "/token-transfers");
    expect(transferRequests).toHaveLength(2);
    expect(transferRequests.every(r => r.params.offset === 0)).toBe(true);
    expect(transferRequests[0].params.after_block).toBeUndefined();
  });

  test("v2 getLogs with all=true fetches every log in one request instead of unstable offset pages", async () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V2_ENDPOINT: V2,
      LLAMA_INDEXER_V2_API_KEY: KEY,
    });

    await indexer.getLogs({
      chain: "ethereum",
      target: TARGET,
      topic: TOPIC0,
      fromBlock: 1,
      toBlock: 20,
      limit: 2,
      all: true,
    });

    const logRequests = requests.filter((request) => request.path === "/logs");
    expect(logRequests).toHaveLength(1);
    expect(logRequests[0].params).toMatchObject({ limit: "all", offset: 0 });
  });

  test("v2 getTokenTransfers keeps legacy offset pagination", async () => {
    const indexer = loadIndexer({
      LLAMA_INDEXER_V2_ENDPOINT: V2,
      LLAMA_INDEXER_V2_API_KEY: KEY,
    });

    await indexer.getTokenTransfers({ chain: "ethereum", target: TARGET, fromBlock: 1, toBlock: 20, limit: 2, all: true });

    const transferRequests = requests.filter((request) => request.path === "/token-transfers");
    expect(transferRequests.map((request) => request.params.offset)).toEqual([0, 2]);
  });

  const v4Env = { LLAMA_INDEXER_V4_ENDPOINT: V4, LLAMA_INDEXER_V4_API_KEY: KEY };
  const logOptions = { chain: "ethereum", target: TARGET, topic: TOPIC0, fromBlock: 1, toBlock: 20, limit: 2 };

  test("all=false preserves a full page when the offset cuts across cursor pages", async () => {
    const indexer = loadIndexer(v4Env);
    pages["/logs"] = [[makeLog(10, 0), makeLog(11, 0)], [makeLog(12, 0), makeLog(13, 0)], [makeLog(14, 0)]];
    const logs = await indexer.getLogs({ ...logOptions, offset: 3, all: false });
    expect(logs.map(l => l.blockNumber)).toEqual([13, 14]);
    expect(logs.every(l => l.logIndex === 0 && l.index === 0)).toBe(true);
    expect(requests.filter(r => r.path === "/logs").every(r => r.params.offset === 0)).toBe(true);
  });

  test("offset beyond the result returns an empty array", async () => {
    const indexer = loadIndexer(v4Env);
    expect(await indexer.getLogs({ ...logOptions, offset: 100001, all: false })).toEqual([]);
    expect(requests.filter(r => r.path === "/logs").every(r => r.params.offset === 0)).toBe(true);
  });

  test("a repeated cursor fails instead of looping or returning duplicates", async () => {
    const indexer = loadIndexer(v4Env);
    const page = [makeLog(10, 0), makeLog(11, 0)];
    pages["/logs"] = [page, page.map(l => ({ ...l }))];
    await expect(indexer.getLogs(logOptions)).rejects.toThrow(/did not advance/);
  });

  test("missing cursor rejects a full page rather than falling back to unsafe offset paging", async () => {
    const indexer = loadIndexer(v4Env);
    pages["/logs"] = [[{ ...makeLog(10, 0), log_index: undefined }, { ...makeLog(11, 0), log_index: undefined }]];
    await expect(indexer.getLogs(logOptions)).rejects.toThrow(/valid cursor/);
  });

  test("zero page size returns no logs without looping", async () => {
    const indexer = loadIndexer(v4Env);
    expect(await indexer.getLogs({ ...logOptions, limit: 0 })).toEqual([]);
  });

  test("block range splitting includes the last block", async () => {
    const indexer = loadIndexer(v4Env);
    await indexer.getLogs({ ...logOptions, fromBlock: 1, toBlock: 5, maxBlockRange: 2, all: false });
    expect(requests.filter(r => r.path === "/logs").map(r => [r.params.from_block, r.params.to_block]))
      .toEqual([[1, 2], [3, 4], [5, 5]]);
  });

  test("transaction pagination uses transaction_index and keeps the public shape", async () => {
    const indexer = loadIndexer(v4Env);
    const tx = (index: number) => ({
      hash: String(index), block_number: 10, transaction_index: index,
      from_address: TARGET, to_address: TARGET, value: "12345678901234567890", nonce: "7", input: "0x", status: "success"
    });
    pages["/transactions"] = [Array.from({ length: 1000 }, (_, i) => tx(i)), [tx(1000)]];
    const result = await indexer.getTransactions({ chain: "ethereum", addresses: [TARGET], from_block: 1, to_block: 20, limit: 2 });
    expect(result!.map(t => t.transactionIndex)).toEqual(Array.from({ length: 1001 }, (_, i) => i));
    expect(result![0]).toMatchObject({ blockNumber: 10, from: TARGET, value: Number("12345678901234567890"), nonce: 7, status: 1, data: "0x" });
    const calls = requests.filter(r => r.path === "/transactions");
    expect(calls).toHaveLength(2);
    expect(calls[0].params.limit).toBe(1000);
    expect(calls[1].params).toMatchObject({ after_block: 10, after_index: 999, includeTotal: false, offset: 0 });
  });

  test("all=false transactions retain the caller's small page limit", async () => {
    const indexer = loadIndexer(v4Env);
    pages["/transactions"] = [[0, 1, 2].map(transaction_index => ({
      hash: String(transaction_index),
      block_number: 10, transaction_index, from_address: TARGET, to_address: TARGET, status: "success"
    }))];
    const result = await indexer.getTransactions({ addresses: [TARGET], from_block: 1, to_block: 20, limit: 2, all: false });
    expect(result!.map(row => row.transactionIndex)).toEqual([0, 1]);
    expect(requests.filter(r => r.path === "/transactions")).toHaveLength(1);
    expect(requests.find(r => r.path === "/transactions")!.params.limit).toBe(2);
  });

  test("empty transactions still return null", async () => {
    const indexer = loadIndexer(v4Env);
    expect(await indexer.getTransactions({ addresses: [TARGET], from_block: 1, to_block: 20 })).toBeNull();
  });

  test("ERC1155 cursors retain UInt256 precision even for unquoted JSON ids", async () => {
    const indexer = loadIndexer(v4Env);
    transferWireText = true;
    const bigId = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    const previousId = String(BigInt(bigId) - BigInt(1));
    pages["/token-transfers"] = [[makeTransfer(10, 7, 2), makeTransfer(10, 7, 10)],
    [{ ...makeTransfer(10, 7, 11), id: previousId }, { ...makeTransfer(10, 7, 12), id: bigId }]];
    const result = await indexer.getTokenTransfers({ target: TARGET, fromBlock: 1, toBlock: 20, limit: 2 });
    // Public values keep v2's Number contract; the next request must use exact ids.
    expect(result.map(t => t.id)).toEqual([2, 10, Number(previousId), Number(bigId)]);
    expect(requests.filter(r => r.path === "/token-transfers")[1].params.after_id).toBe("10");
    expect(requests.filter(r => r.path === "/token-transfers")[2].params.after_id).toBe(bigId);
  });
});

describe("v2 response compatibility", () => {
  // Numeric types and empty fields match the v2 REST responses observed on
  // Ethereum blocks 18,000,000–18,000,005. Deliberately use leading-zero addresses.
  const address = `0x${"0".repeat(38)}aa`;
  const recipient = `0x${"0".repeat(38)}bb`;
  const hash = `0x${"0".repeat(62)}ab`;
  const eventAbi = "event Transfer(address indexed from, address indexed to, uint256 value)";
  const iface = new Interface([eventAbi]);
  const encoded = iface.encodeEventLog(iface.getEvent("Transfer")!, [address, recipient, BigInt(123)]);
  const timestamp = "2023-08-26 16:21:35";
  const legacy = {
    logs: [{
      chain: 1, block_number: 18000000, log_index: 0, timestamp,
      source: address, transaction_hash: hash, topic0: encoded.topics[0],
      topic1: encoded.topics[1], topic2: encoded.topics[2], topic3: "", data: encoded.data
    }],
    transfers: [{
      chain: 1, block_number: 18000000, log_index: 0, timestamp,
      from_address: address, to_address: recipient, token: address, transaction_hash: hash,
      type: "erc20", value: 95000000, id: 0, operator: ""
    }],
    transactions: [{
      chain: 1, block_number: 18000000, transaction_index: 0, timestamp,
      hash, from_address: address, to_address: recipient, value: 0, gas: 99226,
      gas_price: 21821091641, gas_used: 60813, effective_gas_price: 21821091641,
      max_fee_per_gas: 28694459494, max_priority_fee_per_gas: 100000000,
      base_fee_per_gas: 21721091641, nonce: 101, transaction_type: 2, status: "success",
      input: "0x000001", contract_created: "", cumulative_gas_used: 11329643
    }],
  };

  const savedEnv = { ...process.env };
  let payloads: typeof legacy;
  let v2: typeof import("./indexer");
  let v4: typeof import("./indexer");
  const requests: any[] = [];

  function wireRows(key: keyof typeof legacy, version: string) {
    return payloads[key].map(row => Object.fromEntries(Object.entries(row).map(([k, v]) => {
      if (version === "v4") {
        if (typeof v === "number") return [k, String(v)];
        if (typeof v === "string" && /^(source|token|.*address|hash|transaction_hash|topic\d)$/.test(k) && v.startsWith("0x"))
          return [k, `0x${v.slice(2).replace(/^0+/, "") || "0"}`];
      }
      return [k, v];
    })));
  }

  beforeAll(() => {
    for (const key of Object.keys(process.env))
      if (/^(SDK_|LLAMA_SDK_)?LLAMA_INDEXER_/.test(key)) delete process.env[key];
    Object.assign(process.env, {
      LLAMA_INDEXER_V2_ENDPOINT: "https://v2.example",
      LLAMA_INDEXER_V4_ENDPOINT: "https://v4.example", LLAMA_INDEXER_V2_API_KEY: "key"
    });
    const load = (prefer: string) => {
      process.env.LLAMA_INDEXER_PREFER_V4 = prefer;
      jest.resetModules();
      jest.doMock("axios", () => ({
        __esModule: true, default: {
          create: ({ baseURL }: any) => {
            const version = baseURL.includes("v4") ? "v4" : "v2";
            const request: any = async (path: string, config: any) => {
              requests.push({ version, path, ...config });
              const key = path === "/logs" ? "logs" : path === "/transactions" ? "transactions" : "transfers";
              const rows = wireRows(key, version);
              return {
                data: {
                  [key]: rows.slice(config.params.after_block === undefined ? 0 : 1000,
                    config.params.after_block === undefined && config.params.limit !== "all" ? config.params.limit : undefined)
                }
              };
            };
            request.get = async (path: string) => path === "/sync"
              ? { data: { syncStatus: [{ chain: "1", lastIndexedBlock: "19000000", lastIndexedDate: timestamp }] } }
              : { data: Readable.from([JSON.stringify({ logs: wireRows("logs", version) })]) };
            return request;
          },
        }
      }));
      return require("./indexer");
    };
    v2 = load("false");
    v4 = load("true");
  });
  beforeEach(() => { payloads = JSON.parse(JSON.stringify(legacy)); requests.length = 0; });
  afterAll(() => {
    for (const key of new Set([...Object.keys(process.env), ...Object.keys(savedEnv)])) {
      if (!/^(SDK_|LLAMA_SDK_)?LLAMA_INDEXER_/.test(key)) continue;
      if (savedEnv[key] === undefined) delete process.env[key];
      else process.env[key] = savedEnv[key];
    }
    jest.dontMock("axios");
  });

  const logOptions = { target: address, eventAbi, fromBlock: 18000000, toBlock: 18000005 };
  test.each([false, true])("raw log fields, ABI decoding and buckets match v2 (streaming=%s)", async clientStreaming => {
    for (const flags of [{}, { onlyArgs: true }, { entireLog: true }, { parseLog: false },
    { entireLog: true, onlyArgs: true }, { targets: [address], target: undefined, flatten: false }]) {
      const options = { ...logOptions, ...flags, clientStreaming };
      // resetModules creates distinct ethers class constructors; compare values,
      // including numeric types, without requiring prototype identity.
      expect(await v4.getLogs(options)).toEqual(await v2.getLogs(options));
    }
  });

  test.each([false, true])("processor receives v2-compatible records (streaming=%s)", async clientStreaming => {
    const expected: any[] = [], received: any[] = [];
    await v2.getLogs({ ...logOptions, clientStreaming, processor: rows => { expected.push(...rows); } });
    await v4.getLogs({ ...logOptions, clientStreaming, processor: rows => { received.push(...rows); } });
    expect(received.length).toBeGreaterThan(0);
    expect(received).toStrictEqual(expected);
  });

  test("transfers preserve v2 field types, padding and address-filter/bucket membership", async () => {
    for (const transferType of ["in", "out", "all"] as const) {
      const options = {
        targets: [recipient, address], fromAddressFilter: address, transferType,
        fromBlock: 18000000, toBlock: 18000005, flatten: false
      };
      expect(await v4.getTokenTransfers(options)).toStrictEqual(await v2.getTokenTransfers(options));
    }
  });

  test("transactions preserve all v2 public field types and empty contract address", async () => {
    const options = { addresses: [address], from_block: 18000000, to_block: 18000005 };
    expect(await v4.getTransactions(options)).toStrictEqual(await v2.getTransactions(options));
  });

  test("large transfer values keep the legacy Number representation", async () => {
    payloads.transfers[0].value = Number("57414644167788281");
    const options = { target: recipient, fromBlock: 18000000, toBlock: 18000005 };
    expect(await v4.getTokenTransfers(options)).toStrictEqual(await v2.getTokenTransfers(options));
  });

  test("empty results keep [] for logs/transfers and null for transactions", async () => {
    payloads = { logs: [], transfers: [], transactions: [] };
    for (const sdk of [v2, v4]) {
      expect(await sdk.getLogs(logOptions)).toEqual([]);
      expect(await sdk.getTokenTransfers({ ...logOptions, target: recipient })).toEqual([]);
      expect(await sdk.getTransactions({ addresses: [address], from_block: 18000000, to_block: 18000005 })).toBeNull();
    }
  });

  test.each(["failure", "unknown"])("transaction status=%s and nullable fields match v2", async status => {
    Object.assign(payloads.transactions[0], { status, to_address: null, contract_created: null, max_fee_per_gas: null });
    const options = { addresses: [address], from_block: 18000000, to_block: 18000005 };
    const expected = await v2.getTransactions(options);
    expect(expected![0]).toMatchObject({ status: 0, to: null, maxFeePerGas: null });
    expect(await v4.getTransactions(options)).toStrictEqual(expected);
  });

  test("lossless transfer parsing handles quoted ids and rejects truncated JSON", async () => {
    const id = "115792089237316195423570985008687907853269984665640564039457584007913129639935";
    expect(await parseTransferResponse(`{"transfers":[{"id":"${id}","value":123,"operator":""}]}`))
      .toEqual({ transfers: [{ id, value: 123, operator: "" }] });
    await expect(parseTransferResponse('{"transfers":[{"id":1}')).rejects.toThrow();
  });

  test("all=false with transaction limit='all' keeps the historical server-default page", async () => {
    payloads.transactions = Array.from({ length: 1001 }, (_, transaction_index) => ({ ...legacy.transactions[0], transaction_index }));
    const rows = await v4.getTransactions({ addresses: [address], from_block: 18000000, to_block: 18000005, all: false, limit: "all" });
    expect(rows).toHaveLength(1000);
    expect(requests).toHaveLength(1);
    expect(requests[0].params.limit).toBe(1000);
  });
});

describe("streaming transport", () => {
  const target = "0x00000000000000000000000000000000000000aa";
  const topic = `0x${"1".repeat(64)}`;
  const options = { chain: "ethereum", target, topic, fromBlock: 1, toBlock: 20, clientStreaming: true };
  let indexer: typeof import("./indexer");
  let rows: any[];
  let streamFactory: () => Readable;
  let syncFails = false;
  let versions: string[];
  const env = { ...process.env };

  beforeAll(() => {
    process.env.LLAMA_INDEXER_V4_ENDPOINT = "https://v4.example";
    process.env.LLAMA_INDEXER_V4_API_KEY = "key";
    process.env.LLAMA_INDEXER_MICRO_BATCH = "2";
    delete process.env.LLAMA_INDEXER_PREFER_V4;
    jest.resetModules();
    jest.doMock("axios", () => {
      const create = (config: any) => {
        const instance: any = async () => ({ data: { logs: rows.map(r => ({ ...r })) } });
        instance.get = async (path: string) => {
          versions.push(config.baseURL);
          if (path === "/sync") {
            if (syncFails) throw new Error("sync unavailable");
            return { data: { syncStatus: [{ chain: 1, lastIndexedBlock: 100, lastIndexedDate: "2026-01-01" }] } };
          }
          return { data: streamFactory() };
        };
        return instance;
      };
      return { __esModule: true, default: { create, isCancel: () => false } };
    });
    indexer = require("./indexer");
  });

  beforeEach(() => {
    versions = [];
    rows = [0, 1, 2, 3, 4].map(i => ({
      source: target, block_number: 10, log_index: i,
      topic0: topic, data: "0x", transaction_hash: `0x${String(i).padStart(64, "0")}`
    }));
    streamFactory = () => Readable.from([JSON.stringify({ logs: rows })]);
  });

  afterAll(() => {
    for (const key of ["LLAMA_INDEXER_V4_ENDPOINT", "LLAMA_INDEXER_V4_API_KEY", "LLAMA_INDEXER_MICRO_BATCH", "LLAMA_INDEXER_PREFER_V4"]) {
      if (env[key] === undefined) delete process.env[key];
      else process.env[key] = env[key];
    }
    jest.dontMock("axios");
  });

  test("failed sync lookup can be retried immediately", async () => {
    syncFails = true;
    await expect(indexer.getLogs(options)).rejects.toThrow("sync unavailable");
    syncFails = false;
    expect(await indexer.getLogs(options)).toHaveLength(5);
    expect(versions.every(v => v === "https://v4.example")).toBe(true);
  });

  test("streaming and buffered results preserve the same raw-log fields", async () => {
    const streamed = await indexer.getLogs(options);
    const buffered = await indexer.getLogs({ ...options, clientStreaming: false });
    expect(streamed).toEqual(buffered);
    expect(streamed.map(l => l.logIndex)).toEqual([0, 1, 2, 3, 4]);
  });

  test("processor batches are awaited in order and collect=false stays empty", async () => {
    let active = false;
    const indices: number[] = [];
    const processor = async (batch: any[]) => {
      expect(active).toBe(false);
      active = true;
      await new Promise(resolve => setTimeout(resolve, 1));
      indices.push(...batch.map(l => l.logIndex));
      active = false;
    };
    expect(await indexer.getLogs({ ...options, processor })).toEqual([]);
    expect(indices).toEqual([0, 1, 2, 3, 4]);
  });

  test("processor rejection aborts the stream and propagates", async () => {
    const processor = jest.fn(async () => { throw new Error("processor failed"); });
    await expect(indexer.getLogs({ ...options, processor })).rejects.toThrow("processor failed");
    expect(processor).toHaveBeenCalledTimes(1);
  });

  test("truncated JSON rejects instead of resolving partial data", async () => {
    streamFactory = () => Readable.from(['{"logs":[' + JSON.stringify(rows[0])]);
    await expect(indexer.getLogs(options)).rejects.toThrow();
  });

  test("remote disconnect rejects instead of treating abort as success", async () => {
    streamFactory = () => Readable.from((async function*() {
      yield '{"logs":[' + JSON.stringify(rows[0]) + ',';
      throw new Error("connection aborted remotely");
    })());
    await expect(indexer.getLogs(options)).rejects.toThrow("connection aborted remotely");
  });

  test("intentional limit stops successfully and applies offset", async () => {
    const result = await indexer.getLogs({ ...options, all: false, limit: 2, offset: 1 });
    expect(result.map(l => l.logIndex)).toEqual([1, 2]);
  });

  test("flatten=false keeps target buckets and ordering", async () => {
    const second = "0x00000000000000000000000000000000000000bb";
    rows[1].source = second;
    const result = await indexer.getLogs({ ...options, target: undefined, targets: [second, target], flatten: false });
    expect(result.map(bucket => bucket.map((l: any) => l.logIndex))).toEqual([[1], [0, 2, 3, 4]]);
  });

  test.each([
    { onlyArgs: true },
    { entireLog: true },
    { entireLog: true, onlyArgs: true },
    { entireLog: true, parseLog: false },
  ])("ABI decoding preserves legacy streaming shape: %j", async flags => {
    const eventAbi = "event Transfer(address indexed from, address indexed to, uint256 value)";
    const iface = new Interface([eventAbi]);
    const encoded = iface.encodeEventLog(iface.getEvent("Transfer")!, [target, target, BigInt("12345678901234567890")]);
    rows = rows.map(r => ({ ...r, data: encoded.data, topic0: encoded.topics[0], topic1: encoded.topics[1], topic2: encoded.topics[2] }));
    const opts = { ...options, topic: encoded.topics[0], eventAbi, ...flags };
    let expected = await indexer.getLogs({ ...opts, clientStreaming: false });
    if (flags.entireLog && flags.parseLog !== false) {
      expected = flags.onlyArgs ? expected.map(row => row.args)
        : expected.map(({ parsedLog, ...row }) => row);
    }
    expect(await indexer.getLogs(opts)).toEqual(expected);
  });

  test("all=true still honors offset in streaming mode", async () => {
    const opts = { ...options, all: true, offset: 2 };
    expect((await indexer.getLogs(opts)).map(l => l.logIndex)).toEqual([2, 3, 4]);
  });

  test("explicit collect=false keeps buckets empty", async () => {
    const result = await indexer.getLogs({ ...options, target: undefined, targets: [target], flatten: false, collect: false });
    expect(result).toEqual([[]]);
  });
});
