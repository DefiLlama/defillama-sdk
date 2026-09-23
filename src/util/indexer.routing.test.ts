const ENV_KEYS_routing = [
  "LLAMA_INDEXER_V2_ENDPOINT",
  "LLAMA_INDEXER_V2_API_KEY",
  "LLAMA_INDEXER_V4_ENDPOINT",
  "LLAMA_INDEXER_V4_API_KEY",
  "LLAMA_INDEXER_PREFER_V4",
  "LLAMA_INDEXER_V4_ONLY_CHAINS",
];

const savedEnv_routing: Record<string, string | undefined> = {};

beforeAll(() => {
  for (const key of ENV_KEYS_routing) savedEnv_routing[key] = process.env[key];
});

afterAll(() => {
  for (const key of ENV_KEYS_routing) {
    if (savedEnv_routing[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv_routing[key];
  }
});

function loadIndexer_routing(env: Record<string, string>) {
  for (const key of ENV_KEYS_routing) delete process.env[key];
  Object.assign(process.env, env);
  jest.resetModules();
  return require("./indexer") as typeof import("./indexer");
}

const V2_routing = "https://v2.example.com";
const V4_routing = "https://v4.example.com";
const KEY_routing = "test-key";

test("v2 + v4 configured, PREFER_V4 off: v2 chains stay on v2, robinhood goes to v4", () => {
  const indexer = loadIndexer_routing({
    LLAMA_INDEXER_V2_ENDPOINT: V2_routing,
    LLAMA_INDEXER_V2_API_KEY: KEY_routing,
    LLAMA_INDEXER_V4_ENDPOINT: V4_routing,
  });

  expect(indexer.getChainIndexerVersion("ethereum")).toBe("v2");
  expect(indexer.getChainIndexerVersion("arbitrum")).toBe("v2");
  expect(indexer.getChainIndexerVersion("base")).toBe("v2");
  expect(indexer.getChainIndexerVersion("robinhood")).toBe("v4");

  expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
  expect(indexer.isIndexerEnabled("robinhood")).toBe(true);
  expect(indexer.isIndexerEnabled("notachain")).toBe(false);
});

test("PREFER_V4=true routes everything to v4", () => {
  const indexer = loadIndexer_routing({
    LLAMA_INDEXER_V2_ENDPOINT: V2_routing,
    LLAMA_INDEXER_V2_API_KEY: KEY_routing,
    LLAMA_INDEXER_V4_ENDPOINT: V4_routing,
    LLAMA_INDEXER_PREFER_V4: "true",
  });

  expect(indexer.getChainIndexerVersion("ethereum")).toBe("v4");
  expect(indexer.getChainIndexerVersion("robinhood")).toBe("v4");
  expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
});

test("only v2 configured: v2 chains work, robinhood is disabled (falls back to RPC upstream)", () => {
  const indexer = loadIndexer_routing({
    LLAMA_INDEXER_V2_ENDPOINT: V2_routing,
    LLAMA_INDEXER_V2_API_KEY: KEY_routing,
  });

  expect(indexer.getChainIndexerVersion("ethereum")).toBe("v2");
  expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
  // robinhood is v4-only: without a v4 endpoint the indexer must report it as unsupported
  expect(indexer.isIndexerEnabled("robinhood")).toBe(false);
});

test("only v4 configured: everything routes to v4", () => {
  const indexer = loadIndexer_routing({
    LLAMA_INDEXER_V4_ENDPOINT: V4_routing,
    LLAMA_INDEXER_V4_API_KEY: KEY_routing,
  });

  expect(indexer.getChainIndexerVersion("ethereum")).toBe("v4");
  expect(indexer.getChainIndexerVersion("robinhood")).toBe("v4");
  expect(indexer.isIndexerEnabled("ethereum")).toBe(true);
  expect(indexer.isIndexerEnabled("robinhood")).toBe(true);
});

test("no indexer configured: everything disabled", () => {
  const indexer = loadIndexer_routing({});

  expect(indexer.isIndexerEnabled()).toBe(false);
  expect(indexer.isIndexerEnabled("ethereum")).toBe(false);
  expect(indexer.isIndexerEnabled("robinhood")).toBe(false);
});

test("LLAMA_INDEXER_V4_ONLY_CHAINS extends the v4-only set without a release", () => {
  const indexer = loadIndexer_routing({
    LLAMA_INDEXER_V2_ENDPOINT: V2_routing,
    LLAMA_INDEXER_V2_API_KEY: KEY_routing,
    LLAMA_INDEXER_V4_ENDPOINT: V4_routing,
    LLAMA_INDEXER_V4_ONLY_CHAINS: "4242:somechain",
  });

  expect(indexer.supportedChainSet2.has("somechain")).toBe(true);
  expect(indexer.getChainIndexerVersion("somechain")).toBe("v4");
  expect(indexer.isIndexerEnabled("somechain")).toBe(true);
  // existing chains keep their v2 routing
  expect(indexer.getChainIndexerVersion("ethereum")).toBe("v2");
});
