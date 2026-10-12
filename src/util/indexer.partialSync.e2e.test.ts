const enabled = process.env.LLAMA_INDEXER_PARTIAL_SYNC_E2E === "true" &&
  !!process.env.LLAMA_INDEXER_V4_ENDPOINT &&
  !!(process.env.LLAMA_INDEXER_V4_API_KEY || process.env.LLAMA_INDEXER_V2_API_KEY);
const suite = enabled ? describe : describe.skip;

suite("v4 partial-sync results versus live historical logs", () => {
  const options = {
    chain: "ethereum", target: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48",
    eventAbi: "event Transfer(address indexed from, address indexed to, uint256 value)",
    fromBlock: 18000000, toBlock: 18000080, limit: 200, skipCache: true,
  };
  const saved = { ...process.env };
  const emitter: import("events").EventEmitter = process;
  const events = ["exit", "SIGINT", "SIGTERM"];
  const listeners = new Map(events.map(e => [e, new Set(emitter.listeners(e))]));
  let sdk: typeof import("./indexer");
  let head: number | undefined;
  let expected: any[];
  let provider: import("ethers").JsonRpcProvider;
  let clock = Date.now();
  const values = (logs: any[]) => logs.map(l => `${l.blockNumber}:${l.transactionHash.toLowerCase()}:${l.logIndex ?? l.index}:${l.args.value}`).sort();

  async function liveLogs(opts: typeof options & { clientStreaming?: boolean }) {
    try { return await sdk.getLogs(opts); }
    catch (error) {
      let message = String((error as any)?.message ?? "unknown transport error");
      for (const [key, value] of Object.entries(saved))
        if (value && /KEY|TOKEN|SECRET|PASSWORD|ENDPOINT|_RPC/.test(key)) message = message.split(value).join("[redacted]");
      throw new Error(`Live v4/RPC request failed: ${message}`);
    }
  }

  beforeAll(async () => {
    for (const prefix of ["", "SDK_", "LLAMA_SDK_"]) process.env[prefix + "LLAMA_INDEXER_PREFER_V4"] = "true";
    jest.resetModules();
    // The indexer's /logs requests still use the real Axios transport.
    jest.doMock("axios", () => {
      const real = jest.requireActual("axios");
      const create = (config: any) => {
        const client = real.default.create(config);
        const get = client.get.bind(client);
        client.get = (path: string, ...args: any[]) => path === "/sync" && head !== undefined
          ? Promise.resolve({ data: { syncStatus: [{ chain: "1", lastIndexedBlock: head, lastIndexedDate: "2026-10-12" }] } })
          : get(path, ...args);
        return client;
      };
      return { ...real, __esModule: true, default: { ...real.default, create } };
    });
    sdk = require("./indexer");

    const rpcUrl = require("./env").getEnvValue("ETHEREUM_RPC")?.split(",")[0] ?? "https://ethereum.drpc.org";
    const { FetchRequest, JsonRpcProvider } = require("ethers");
    const request: import("ethers").FetchRequest = new FetchRequest(rpcUrl);

    request.getUrlFunc = async (req, signal) => {
      const controller = new AbortController();
      signal?.addListener(() => controller.abort());
      const response = await jest.requireActual("axios").default.request({
        url: req.url, method: req.method, headers: req.headers,
        data: req.body ? Buffer.from(req.body) : undefined, responseType: "arraybuffer",
        signal: controller.signal, timeout: 30_000, validateStatus: () => true,
      });
      return { statusCode: response.status, statusMessage: response.statusText,
        headers: Object.fromEntries(Object.entries(response.headers).map(([k, v]) => [k, String(v)])), body: response.data };
    };
    provider = new JsonRpcProvider(request, 1, { staticNetwork: true, batchMaxCount: 1 });
    require("../general").setProvider("ethereum", provider);
    require("../general").setProvider("ethereum_historical", provider);
    jest.spyOn(Date, "now").mockImplementation(() => clock);
    expect(sdk.getChainIndexerVersion("ethereum")).toBe("v4");
    expected = await liveLogs(options);
    expect(expected.length).toBeGreaterThan(0);
  });

  afterAll(() => {
    jest.restoreAllMocks(); jest.dontMock("axios");
    provider?.destroy();
    for (const prefix of ["", "SDK_", "LLAMA_SDK_"]) {
      const key = prefix + "LLAMA_INDEXER_PREFER_V4";
      if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
    }
    for (const event of events) for (const listener of emitter.listeners(event))
      if (!listeners.get(event)!.has(listener)) emitter.removeListener(event, listener as (...args: any[]) => void);
  });

  test.each([false, true])("same events and ABI values with an empty or nonempty prefix (streaming=%s)", async clientStreaming => {
    for (head of [options.fromBlock + 45, options.fromBlock + 70]) {
      clock += 120_000;
      const received = await liveLogs({ ...options, clientStreaming });
      expect(values(received)).toEqual(values(expected));
      const identities = received.map(l => `${l.transactionHash}:${l.logIndex ?? l.index}`);
      expect(new Set(identities).size).toBe(received.length);
      expect(received.every(l => l.blockNumber >= options.fromBlock && l.blockNumber <= options.toBlock)).toBe(true);
    }
  });
});
