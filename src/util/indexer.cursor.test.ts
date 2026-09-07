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
  return routeCalls[key] === 1 ? firstPage : secondPage;
}

function loadIndexer(env: Record<string, string>) {
  requests = [];
  routeCalls = {};
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
          return Promise.resolve({
            data: {
              transfers: nextPage(
                version,
                path,
                [makeTransfer(10, 7, 1), makeTransfer(10, 7, 2)],
                [makeTransfer(10, 7, 3)]
              ),
            },
          });
        }

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

test("v4 single-page getLogs (all=false) keeps server-side offset", async () => {
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
  expect(logRequests).toHaveLength(1);
  expect(logRequests[0].params.offset).toBe(2);
  expect(logRequests[0].params.after_block).toBeUndefined();
  expect(logRequests[0].params.after_index).toBeUndefined();
});

test("v4 single-page getTokenTransfers (all=false) keeps server-side offset", async () => {
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
  expect(transferRequests).toHaveLength(1);
  expect(transferRequests[0].params.offset).toBe(2);
  expect(transferRequests[0].params.after_block).toBeUndefined();
});

test("v2 keeps legacy offset pagination", async () => {
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
  expect(logRequests).toHaveLength(2);
  expect(logRequests.map((request) => request.params.offset)).toEqual([0, 2]);
  expect(logRequests[1].params.after_block).toBeUndefined();
  expect(logRequests[1].params.after_index).toBeUndefined();
});