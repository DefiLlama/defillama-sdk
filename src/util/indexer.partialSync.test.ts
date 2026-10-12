import http from "http";
import { Interface } from "ethers";

describe("partial-sync logs against the v4 HTTP contract", () => {
  const target = "0x00000000000000000000000000000000000000aa";
  const other = "0x00000000000000000000000000000000000000bb";
  const empty = "0x00000000000000000000000000000000000000cc";
  const eventAbi = "event Amount(uint256 value)";
  const iface = new Interface([eventAbi]);
  const topic = iface.getEvent("Amount")!.topicHash;
  const options = { chain: "ethereum", target, eventAbi, fromBlock: 1000, toBlock: 1080, limit: 2 };
  const env = { ...process.env };
  const emitter: import("events").EventEmitter = process;
  const events = ["exit", "SIGINT", "SIGTERM"];
  const listeners = new Map(events.map(e => [e, new Set(emitter.listeners(e))]));
  let server: http.Server;
  let sdk: typeof import("./indexer");
  let publicGetLogs: typeof import("./logs").getLogs;
  let rpc: jest.Mock;
  let requests: URL[];
  let logs: any[];
  let indexed: number;
  let clock = 1_800_000_000_000;
  let rpcFailure: boolean;
  let streamFailure: boolean;
  let leakIndexerBounds: boolean;
  let cachedLogs: any[];

  function fixture(block: number, index = 0, address = target) {
    const encoded = iface.encodeEventLog(iface.getEvent("Amount")!, [BigInt(block * 10 + index)]);
    return { blockNumber: block, logIndex: index, index, address,
      transactionHash: `0x${String(block).padStart(64, "0")}`, topics: encoded.topics, data: encoded.data };
  }
  const identities = (rows: any[]) => rows.map(l => `${l.blockNumber}:${l.transactionHash}:${l.logIndex ?? l.index}`);
  const expected = () => logs.filter(l => l.blockNumber >= 1000 && l.blockNumber <= 1080 && l.address === target);

  beforeAll(async () => {
    jest.resetModules();
    for (const key of Object.keys(process.env))
      if (/^(SDK_|LLAMA_SDK_)?LLAMA_INDEXER_/.test(key)) delete process.env[key];
    server = http.createServer((req, res) => {
      const url = new URL(req.url!, "http://fixture");
      res.setHeader("Content-Type", "application/json");
      if (url.pathname === "/sync") {
        res.end(JSON.stringify({ syncStatus: [{ chain: "1", lastIndexedBlock: String(indexed), lastIndexedDate: "2026-10-12" }] }));
        return;
      }
      requests.push(url);
      const q = url.searchParams;
      const from = Number(q.get("from_block")), to = Number(q.get("to_block"));
      if (from > to) { res.statusCode = 400; res.end('{"error":"from_block must be <= to_block"}'); return; }
      const addresses = q.get("addresses")?.split(",");
      let rows = logs.filter(l => (leakIndexerBounds || (l.blockNumber >= from && l.blockNumber <= to)) && (!addresses || addresses.includes(l.address)));
      if (q.has("after_block")) {
        const block = Number(q.get("after_block")), index = Number(q.get("after_index"));
        rows = rows.filter(l => l.blockNumber > block || (l.blockNumber === block && l.index > index));
      }
      const offset = Number(q.get("offset") ?? 0);
      const limit = q.get("limit") === "all" ? rows.length : Number(q.get("limit"));
      const wire = rows.slice(offset, offset + limit).map(l => ({ source: l.address, block_number: String(l.blockNumber),
        log_index: String(l.index), transaction_hash: l.transactionHash, topic0: topic, data: l.data }));
      if (streamFailure) { res.end('{"logs":[' + JSON.stringify(wire[0])); return; }
      const body = JSON.stringify({ logs: wire });
      res.write(body.slice(0, Math.floor(body.length / 2)));
      res.end(body.slice(Math.floor(body.length / 2)));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    process.env.LLAMA_INDEXER_V4_ENDPOINT = `http://127.0.0.1:${(server.address() as import("net").AddressInfo).port}`;
    process.env.LLAMA_INDEXER_V4_API_KEY = "fixture-key";
    // Also configure v2: any accidental routing to it fails, without external IO.
    process.env.LLAMA_INDEXER_V2_ENDPOINT = "http://127.0.0.1:1";
    process.env.LLAMA_INDEXER_V2_API_KEY = "fixture-v2-key";
    process.env.LLAMA_INDEXER_MICRO_BATCH = "2";
    jest.doMock("./cache", () => ({ ...jest.requireActual("./cache"),
      readCache: jest.fn(async () => ({ version: "v3", caches: cachedLogs.length
        ? [{ logs: cachedLogs.map(l => ({ ...l })), metadata: { fromBlock: 990, toBlock: 1100 } }] : [] })),
      writeCache: jest.fn(async () => {}) }));
    rpc = jest.fn(async (args: any) => {
      if (rpcFailure) throw new Error("RPC unavailable");
      return { output: logs.filter(l => l.blockNumber >= args.fromBlock && l.blockNumber <= args.toBlock &&
        (!args.target || l.address === args.target)).map(l => {
          const row = { ...l };
          // Match ethers Log objects: identity fields are readonly, args can be added.
          for (const key of ["address", "blockNumber", "index", "transactionHash"])
            Object.defineProperty(row, key, { writable: false });
          return row;
        }) };
    });
    jest.spyOn(require("."), "getLogs").mockImplementation(rpc);
    sdk = require("./indexer");
    publicGetLogs = require("./logs").getLogs;
    jest.spyOn(Date, "now").mockImplementation(() => clock);
  });

  beforeEach(() => {
    clock += 120_000; // expire the sync cache when changing the simulated head
    requests = []; rpc.mockClear(); indexed = 1045;
    rpcFailure = streamFailure = leakIndexerBounds = false;
    cachedLogs = [];
    logs = [996, 999, 1000, 1001, 1020, 1021, 1049, 1050, 1079, 1080, 1081].flatMap(block =>
      [fixture(block), fixture(block, 1, other)]);
  });

  afterAll(async () => {
    jest.restoreAllMocks(); jest.dontMock("./cache");
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of new Set([...Object.keys(process.env), ...Object.keys(env)])) {
      if (!/^(SDK_|LLAMA_SDK_)?LLAMA_INDEXER_/.test(key)) continue;
      if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
    for (const event of events) for (const listener of emitter.listeners(event))
      if (!listeners.get(event)!.has(listener)) emitter.removeListener(event, listener as (...args: any[]) => void);
  });

  test.each([false, true])("v4 clamp, boundaries and duplicates (streaming=%s)", async clientStreaming => {
    for (indexed of [1040, 1045, 1049, 1050, 1070, 1080]) {
      clock += 120_000; requests = []; rpc.mockClear();
      const result = await sdk.getLogs({ ...options, clientStreaming });
      expect(sdk.getChainIndexerVersion("ethereum")).toBe("v4");
      expect(identities(result)).toEqual(identities(expected()));
      expect(new Set(identities(result)).size).toBe(result.length);
      expect(requests.every(r => Number(r.searchParams.get("from_block")) <= Number(r.searchParams.get("to_block")))).toBe(true);
      if (indexed < 1050) expect(requests).toHaveLength(0);
      if (indexed === 1080) expect(rpc).not.toHaveBeenCalled();
    }
  });

  test.each([false, true])("single target, target lists and noTarget retain their shapes (streaming=%s)", async clientStreaming => {
    for (indexed of [1045, 1070]) {
      clock += 120_000;
      const single = await sdk.getLogs({ ...options, clientStreaming, flatten: false });
      expect(single).toHaveLength(1);
      expect(identities(single[0])).toEqual(identities(expected()));
      const buckets = await sdk.getLogs({ ...options, target: undefined, targets: [other, target, empty], clientStreaming, flatten: false });
      expect(buckets.map(b => b.length)).toEqual([8, 8, 0]);
      expect(buckets[0].every((l: any) => l.address === other)).toBe(true);
      expect(identities(buckets[1])).toEqual(identities(expected()));
      const unfiltered = await sdk.getLogs({ ...options, target: undefined, noTarget: true, clientStreaming, flatten: false });
      expect(unfiltered).toHaveLength(16);
      expect(unfiltered.every(l => l.blockNumber >= 1000 && l.blockNumber <= 1080)).toBe(true);
    }
  });

  test.each([false, true])("block chunks do not overlap, drop the last block or add nesting (streaming=%s)", async clientStreaming => {
    for (indexed of [1045, 1070, 1080]) {
      clock += 120_000;
      const flags = { flatten: false, maxBlockRange: 7, clientStreaming };
      const single = await sdk.getLogs({ ...options, ...flags });
      expect(single).toHaveLength(1);
      expect(identities(single[0])).toEqual(identities(expected()));
      const result = await sdk.getLogs({ ...options, target: undefined, targets: [target, other], ...flags });
      expect(result.map(b => b.length)).toEqual([8, 8]);
      expect(identities(result[0])).toEqual(identities(expected()));
      expect(new Set(identities(result.flat())).size).toBe(16);
    }
  });

  test.each([false, true])("offset and limit apply once across the indexer/RPC boundary (streaming=%s)", async clientStreaming => {
    indexed = 1070;
    for (const offset of [0, 2, 3, 4, 7, 8, 100_001]) {
      const result = await sdk.getLogs({ ...options, offset, all: false, clientStreaming });
      expect(identities(result)).toEqual(identities(expected().slice(offset, offset + 2)));
    }
    expect(requests.filter(r => r.searchParams.get("limit") !== "all").every(r => r.searchParams.get("offset") === "0")).toBe(true);
    expect(requests.some(r => r.searchParams.has("after_block"))).toBe(!clientStreaming);
  });

  test.each([false, true])("short fallback honors pagination and zero limit (streaming=%s)", async clientStreaming => {
    expect(identities(await sdk.getLogs({ ...options, clientStreaming, all: false, offset: 2, limit: 3 })))
      .toEqual(identities(expected().slice(2, 5)));
    expect(await sdk.getLogs({ ...options, clientStreaming, limit: 0 })).toEqual([]);
    expect(identities(await sdk.getLogs({ ...options, clientStreaming, all: true, offset: 2 })))
      .toEqual(identities(expected().slice(2)));
  });

  test.each([false, true])("collect=false and processor apply to both sources without duplicates (streaming=%s)", async clientStreaming => {
    indexed = 1070;
    const received: any[] = [];
    let active = false;
    const processor = async (batch: any[]) => {
      expect(active).toBe(false); active = true;
      await new Promise(resolve => setTimeout(resolve, 1));
      received.push(...batch); active = false;
    };
    expect(await sdk.getLogs({ ...options, clientStreaming, processor, collect: false, flatten: false })).toEqual([[]]);
    expect(identities(received)).toEqual(identities(expected()));
    expect(new Set(identities(received)).size).toBe(received.length);
  });

  test.each([false, true])("decoder flags keep ABI values and stream shape on both sources (streaming=%s)", async clientStreaming => {
    for (indexed of [1045, 1070]) {
      clock += 120_000;
      for (const decoderType of ["ethers", "viem"] as const) {
        const base = { ...options, clientStreaming, decoderType };
        const args = await sdk.getLogs({ ...base, onlyArgs: true });
        expect(args.map(a => a.value)).toEqual(expected().map(l => BigInt(l.blockNumber * 10)));
        const raw = await sdk.getLogs({ ...base, parseLog: false, entireLog: true });
        expect(raw.every(l => l.args === undefined)).toBe(true);
        const entire = await sdk.getLogs({ ...base, entireLog: true });
        expect(entire.map(l => l.args.value)).toEqual(expected().map(l => BigInt(l.blockNumber * 10)));
        expect(entire.every(l => !!l.parsedLog)).toBe(!clientStreaming || decoderType === "ethers");
      }
    }
  });

  test.each([false, true])("source duplicates are removed without dropping distinct logs in one transaction (streaming=%s)", async clientStreaming => {
    indexed = 1070;
    logs = [fixture(1000), fixture(1000), fixture(1000, 1), fixture(1000, 1),
      fixture(1020), fixture(1021), fixture(1021), fixture(1021, 1), fixture(1080)];
    const result = await sdk.getLogs({ ...options, clientStreaming });
    expect(result.map(l => [l.blockNumber, l.index])).toEqual([[1000, 0], [1000, 1], [1020, 0], [1021, 0], [1021, 1], [1080, 0]]);
    expect(new Set(identities(result)).size).toBe(result.length);
  });

  test("overlapping RPC caches and physical fetch buffers do not overlap the returned indexer prefix", async () => {
    indexed = 1070; cachedLogs = logs.filter(l => l.address === target);
    const result = await sdk.getLogs(options);
    expect(identities(result)).toEqual(identities(expected()));
    expect(rpc).not.toHaveBeenCalled();
  });

  test("public getLogs returns the same bounded result using v4", async () => {
    expect(identities(await publicGetLogs(options))).toEqual(identities(expected()));
  });

  test("lag above 50 percent and a single missing block still reject", async () => {
    indexed = 1039;
    await expect(sdk.getLogs(options)).rejects.toThrow("Indexer not up to date");
    await expect(sdk.getLogs({ ...options, fromBlock: 1080 })).rejects.toThrow("Indexer not up to date");
    expect(rpc).not.toHaveBeenCalled();
  });

  test("invalid bounds fail before sending an inverted query", async () => {
    await expect(sdk.getLogs({ ...options, fromBlock: 1081 })).rejects.toThrow("fromBlock <= toBlock");
    expect(requests).toHaveLength(0); expect(rpc).not.toHaveBeenCalled();
  });

  test.each([0, -1, 0.5, NaN])("invalid block chunk size %s cannot start a scan", async maxBlockRange => {
    await expect(sdk.getLogs({ ...options, maxBlockRange })).rejects.toThrow("maxBlockRange must be a positive integer");
    expect(requests).toHaveLength(0); expect(rpc).not.toHaveBeenCalled();
  });

  test.each([false, true])("a range of widths retains all events exactly once (streaming=%s)", async clientStreaming => {
    for (const width of [2, 49, 80, 99, 100, 200, 1000]) {
      clock += 120_000; indexed = 1000 + Math.ceil(width * 0.7);
      logs = [999, 1000, 1000 + Math.floor(width / 2), 1000 + width, 1001 + width].map(block => fixture(block));
      const result = await sdk.getLogs({ ...options, toBlock: 1000 + width, clientStreaming });
      expect(identities(result)).toEqual(identities(logs.slice(1, -1)));
      expect(new Set(identities(result)).size).toBe(result.length);
    }
  });

  test.each([false, true])("processor and transport failures propagate (streaming=%s)", async clientStreaming => {
    indexed = 1070;
    await expect(sdk.getLogs({ ...options, clientStreaming, processor: () => { throw Error("processor failed"); } })).rejects.toThrow("processor failed");
    expect(rpc).not.toHaveBeenCalled();
    rpcFailure = true;
    await expect(sdk.getLogs({ ...options, clientStreaming })).rejects.toThrow("RPC unavailable");
    if (clientStreaming) {
      streamFailure = true;
      await expect(sdk.getLogs({ ...options, clientStreaming })).rejects.toThrow();
    }
  });

  test("defensive bounds filtering runs before onlyArgs and processor", async () => {
    indexed = 1070; leakIndexerBounds = true;
    const values: bigint[] = [];
    await sdk.getLogs({ ...options, onlyArgs: true, collect: false, processor: batch => { values.push(...batch.map(a => a.value)); } });
    expect(values).toEqual(expected().map(l => BigInt(l.blockNumber * 10)));
  });
});
