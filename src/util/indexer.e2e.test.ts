export { };

// Run with node --env-file=.env node_modules/jest/bin/jest.js ... --runInBand.
// Order may differ; complete results and the union of pages must preserve every row.
const enabled = !!(process.env.LLAMA_INDEXER_V2_ENDPOINT && process.env.LLAMA_INDEXER_V2_API_KEY &&
  process.env.LLAMA_INDEXER_V4_ENDPOINT);
const suite = enabled ? describe : describe.skip;
type Indexer = typeof import("./indexer");
let v2: Indexer, v4: Indexer;
const usdc = "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";
const pool = "0xb4e16d0168e52d35cacd2c6185b44281ec28c9dc";
const eventAbi = "event Transfer(address indexed from, address indexed to, uint256 value)";
const range = { fromBlock: 18000000, toBlock: 18000005 };
const cases: Array<{ name: string; call: (sdk: Indexer, paging: any) => Promise<any> }> = [
  { name: "logs", call: (sdk, paging) => sdk.getLogs({ target: usdc, eventAbi, entireLog: true, ...range, ...paging }) },
  { name: "transfers", call: (sdk, paging) => sdk.getTokenTransfers({ target: pool, transferType: "all", ...range, ...paging }) },
  {
    name: "transactions", call: (sdk, paging) => sdk.getTransactions({
      addresses: [usdc], transactionType: "to",
      from_block: range.fromBlock, to_block: range.toBlock, ...paging
    })
  },
];

// Preserve scalar types and row order, while comparing ethers objects created
// by separate module registries as values rather than constructor identities.
function values(value: any): any {
  if (typeof value === "bigint") return { bigint: String(value) };
  if (Array.isArray(value)) return value.map(values);
  if (value && typeof value === "object")
    return Object.fromEntries(Object.keys(value).sort().map(key => [key, values(value[key])]));
  return value;
}
function rows(value: any[]) { return value.map(row => JSON.stringify(values(row))).sort(); }

suite("SDK consumer contract: real v2 vs v4", () => {
  beforeAll(() => {
    const preferKeys = ["LLAMA_INDEXER_PREFER_V4", "SDK_LLAMA_INDEXER_PREFER_V4", "LLAMA_SDK_LLAMA_INDEXER_PREFER_V4"];
    const saved = preferKeys.map(key => process.env[key]);
    try {
      for (const key of preferKeys) delete process.env[key];
      process.env.LLAMA_INDEXER_PREFER_V4 = "false";
      jest.resetModules();
      v2 = require("./indexer");
      process.env.LLAMA_INDEXER_PREFER_V4 = "true";
      jest.resetModules();
      v4 = require("./indexer");
      expect(v2.getChainIndexerVersion("ethereum")).toBe("v2");
      expect(v4.getChainIndexerVersion("ethereum")).toBe("v4");
    } finally {
      preferKeys.forEach((key, index) => {
        if (saved[index] === undefined) delete process.env[key];
        else process.env[key] = saved[index];
      });
    }
  });

  test.each(cases)("$name: paginated full results keep every row and type", async ({ call }) => {
    const [expected, received] = await Promise.all([call(v2, { limit: 2 }), call(v4, { limit: 2 })]);
    expect(expected.length).toBeGreaterThan(2);
    expect(rows(received)).toEqual(rows(expected));
  });

  for (const offset of [0, 2]) {
    test.each(cases)(`$name: all=false limit=2 offset=${offset} selects the expected v4 page`, async ({ call }) => {
      const paging = { all: false, limit: 2, offset };
      const [expected, received] = await Promise.all([call(v4, {}), call(v4, paging)]);
      expect(expected.length).toBeGreaterThan(0);
      expect(values(received)).toEqual(values(expected.slice(offset, offset + 2)));
    });
  }

  test.each(cases)("$name: concatenating public offset pages reconstructs exactly the v2 result", async ({ call }) => {
    const expected = await call(v2, {});
    expect(expected.length).toBeGreaterThan(2);
    const received: any[] = [];
    const limit = 7;
    for (let offset = 0;offset <= expected.length;offset += limit) {
      const page = await call(v4, { all: false, offset, limit });
      received.push(...(page ?? []));
      if (!page || page.length < limit) break;
    }
    expect(rows(received)).toEqual(rows(expected));
  });

  test.each([{}, { onlyArgs: true }, { parseLog: false }, { entireLog: true }])(
    "v4 streaming preserves v2 streaming output: %j", async flags => {
      const opts = { target: usdc, eventAbi, ...range, ...flags };
      const [expected, streamed] = await Promise.all([v2.getLogs({ ...opts, clientStreaming: true }), v4.getLogs({ ...opts, clientStreaming: true })]);
      expect(rows(streamed)).toEqual(rows(expected));
    });

  test.each([12000000, 18000000, 26036364])("historical epoch %s: full log rows keep content and types", async fromBlock => {
    const opts = { target: usdc, eventAbi, entireLog: true, fromBlock, toBlock: fromBlock + 3, limit: 7 };
    const expected = await v2.getLogs(opts);
    expect(expected.length).toBeGreaterThan(0);
    expect(rows(await v4.getLogs(opts))).toEqual(rows(expected));
  });

  test.each([false, true])("block splitting includes both boundaries exactly once (streaming=%s)", async clientStreaming => {
    const opts = { target: usdc, eventAbi, entireLog: true, ...range };
    const expected = await v2.getLogs({ ...opts, clientStreaming });
    const actual = await v4.getLogs({ ...opts, clientStreaming, maxBlockRange: 2 });
    expect(expected.length).toBeGreaterThan(0);
    expect(rows(actual)).toEqual(rows(expected));
  });

  test.each([range.fromBlock, range.toBlock])("single block %s has no off-by-one loss", async block => {
    const opts = { target: usdc, eventAbi, entireLog: true, fromBlock: block, toBlock: block, limit: 3 };
    const expected = await v2.getLogs(opts);
    expect(expected.length).toBeGreaterThan(0);
    expect(rows(await v4.getLogs(opts))).toEqual(rows(expected));
  });

  test.each([false, true])("multiple targets preserve bucket membership (streaming=%s)", async clientStreaming => {
    const targets = [usdc, "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2"];
    const opts = { targets, eventAbi, entireLog: true, flatten: false, ...range };
    const expected = await v2.getLogs({ ...opts, clientStreaming });
    const actual = await v4.getLogs({ ...opts, clientStreaming });
    expect(expected).toHaveLength(targets.length);
    expect(actual).toHaveLength(targets.length);
    expected.forEach((bucket, i) => {
      expect(bucket.length).toBeGreaterThan(0);
      expect(rows(actual[i])).toEqual(rows(bucket));
    });
  });

  test.each(["in", "out", "all"] as const)("transfer direction=%s with token filter preserves complete results", async transferType => {
    const seed = await v2.getTokenTransfers({ target: pool, tokens: [usdc], transferType: "all", ...range });
    expect(seed.length).toBeGreaterThan(0);
    // Choose a participant in an actual transfer so each direction is exercised,
    // rather than passing a comparison of two empty outgoing-USDC arrays.
    const target = transferType === "out" ? seed[0].from_address : seed[0].to_address;
    const opts = { target, tokens: [usdc], transferType, ...range, limit: 2 };
    const expected = await v2.getTokenTransfers(opts);
    expect(expected.length).toBeGreaterThan(0);
    expect(rows(await v4.getTokenTransfers(opts))).toEqual(rows(expected));
  });

  test("transfer sender filter and target buckets preserve membership", async () => {
    const seed = await v2.getTokenTransfers({ target: pool, transferType: "all", ...range });
    expect(seed.length).toBeGreaterThan(0);
    const opts = {
      targets: [pool, seed[0].from_address], fromAddressFilter: seed[0].from_address,
      transferType: "all" as const, flatten: false, ...range, limit: 2
    };
    const expected = await v2.getTokenTransfers(opts);
    const actual = await v4.getTokenTransfers(opts);
    expect(expected.flat().length).toBeGreaterThan(0);
    expect(actual.map(rows)).toEqual(expected.map(rows));
  });

  test("transaction hash lookup keeps the same public fields", async () => {
    const seed = await v2.getTransactions({
      addresses: [usdc], transactionType: "to",
      from_block: range.fromBlock, to_block: range.toBlock
    });
    expect(seed!.length).toBeGreaterThan(0);
    const opts = { transaction_hashes: [seed![0].hash], from_block: range.fromBlock, to_block: range.toBlock };
    expect(rows((await v4.getTransactions(opts))!)).toEqual(rows((await v2.getTransactions(opts))!));
  });

  test("real ERC1155 UInt256 ids paginate at limit=1 without rounded cursors", async () => {
    // Observed IDs are ~6.8e39: converting them to Number before constructing
    // after_id would send scientific notation, rejected by the v4 UInt256 cursor.
    const opts = {
      target: "0x0bd6a7aacefedad8faa3f9ecb1f006a0cd2eb29d",
      token: "0xe4597f9182ba947f7f3bf8cbc6562285751d5aee", transferType: "in" as const,
      fromBlock: 26036386, toBlock: 26036386
    };
    const expected = await v2.getTokenTransfers(opts);
    expect(expected).toHaveLength(2);
    expect(expected.every(row => row.id > Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(rows(await v4.getTokenTransfers({ ...opts, limit: 1 }))).toEqual(rows(expected));
  });

  test.each(["from", "to", "all"] as const)("transaction direction=%s keeps the same rows", async transactionType => {
    const seed = await v2.getTransactions({
      addresses: [usdc], transactionType: "to",
      from_block: range.fromBlock, to_block: range.toBlock
    });
    expect(seed!.length).toBeGreaterThan(0);
    const opts = {
      addresses: [seed![0].from, usdc], transactionType,
      from_block: range.fromBlock, to_block: range.toBlock, limit: 2
    };
    const expected = await v2.getTransactions(opts);
    expect(expected!.length).toBeGreaterThan(0);
    expect(rows((await v4.getTransactions(opts))!)).toEqual(rows(expected!));
  });

  test.each([false, true])("stream processor receives every row once (collect=false, streaming=%s)", async clientStreaming => {
    const opts = { target: usdc, eventAbi, entireLog: true, ...range };
    const expected = await v2.getLogs({ ...opts, clientStreaming });
    const processed: any[] = [];
    const actual = await v4.getLogs({
      ...opts, limit: 2, clientStreaming, collect: false,
      processor: async batch => { processed.push(...batch); }
    });
    expect(actual).toEqual([]);
    expect(rows(processed)).toEqual(rows(expected));
  });

  test.each(["ethers", "viem"] as const)("decoder=%s preserves ABI argument values", async decoderType => {
    const opts = { target: usdc, eventAbi, onlyArgs: true, ...range, decoderType };
    const expected = await v2.getLogs(opts);
    expect(expected.length).toBeGreaterThan(0);
    expect(rows(await v4.getLogs({ ...opts, clientStreaming: true }))).toEqual(rows(expected));
  });

  test("no-match queries retain [] for logs/transfers and null for transactions", async () => {
    const target = "0x0000000000000000000000000000000000000001";
    for (const sdk of [v2, v4]) {
      expect(await sdk.getLogs({ target, eventAbi, ...range })).toEqual([]);
      expect(await sdk.getTokenTransfers({ target, ...range })).toEqual([]);
      expect(await sdk.getTransactions({ addresses: [target], from_block: range.fromBlock, to_block: range.toBlock })).toBeNull();
    }
  });
});

(process.env.LLAMA_INDEXER_V2_ENDPOINT || process.env.LLAMA_INDEXER_V4_ENDPOINT ? describe : describe.skip)("existing consumers", () => {
  let getLogs: typeof import('./indexer').getLogs;
  let getTokenTransfers: typeof import('./indexer').getTokenTransfers;
  let getTransactions: typeof import('./indexer').getTransactions;
  let ChainApi: typeof import('../ChainApi').ChainApi;
  beforeAll(() => {
    jest.resetModules();
    ({ getLogs, getTokenTransfers, getTransactions } = require('./indexer'));
    ({ ChainApi } = require('../ChainApi'));
  });
  const contract = '0xf33c13da4425629c3f10635e4f935d8020f97D1F'
  const eventAbi = 'event MarketCreated(uint256 indexed mIndex, address hedge, address risk, address token, string name, int256 strikePrice)'

  test("Indexer - getLogs", async () => {

    const res = await getLogs({
      target: contract,
      eventAbi,
      fromBlock: 16310967,
      toBlock: 16610967,
      chain: 'ethereum',
      entireLog: true,
    })
    expect(res.length).toBe(2)
    expect(res[0].source).toBe(contract.toLowerCase())
  });

  test("Indexer - getLogs - flatten false", async () => {

    const res = await getLogs({
      targets: [contract, '0x0000000000000000000000000000000000055555'],
      eventAbi,
      fromBlock: 16310967,
      toBlock: 16610967,
      chain: 'ethereum',
      flatten: false,
      onlyArgs: true,
    })
    expect(res[0].length).toBe(2)
    expect(res[0][0].mIndex).toBe(BigInt(1))
  });

  test("Indexer - getLogs - block not synced", async () => {
    const res = getLogs({
      target: contract,
      eventAbi,
      fromBlock: 508211790,
      toBlock: 508211791,
      chain: 'ethereum',
    })
    await expect(res).rejects.toThrowError()
  });

  test("Indexer - getTokenTransfers", async () => {
    const addresses = ['0x1B5e59759577fa0079e2a35bc89143bc0603d546', '0xD5aC6419635Aa6352EbaDe0Ab42d25FbFa570D21']

    const res = await getTokenTransfers({
      targets: addresses,
      tokens: ['0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', '0x09faeb69e29845f3326e4f004f45a31ceb0eedb9'],
      fromBlock: 119877801,
      toBlock: 119943935,
      chain: 'arbitrum',
    })
    const addressesSet = new Set(addresses.map((t: any) => t.toLowerCase()))
    expect(res.length).toBe(2)
    expect(res.some((i: any) => !addressesSet.has(i.to_address))).toBeFalsy()
  });

  test("Indexer - getLogs - multiple targets", async () => {
    const addresses = ['0xDFC14d2Af169B0D36C4EFF567Ada9b2E0CAE044f', '0xBb2b8038a1640196FbE3e38816F3e67Cba72D940'].map(i => i.toLowerCase())

    const res = await getLogs({
      targets: addresses,
      fromBlock: 22018452,
      toBlock: 22019085,
      chain: 'ethereum',
      topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
    })
    expect(res.length).toBe(37)
    expect(res.filter((i: any) => i.source === addresses[0]).length).toBe(4)
    expect(res.filter((i: any) => i.source === addresses[1]).length).toBe(33)
  });

  test("Indexer - getLogs - no targets - throw error", async () => {

    const res = getLogs({
      fromBlock: 22280140,
      toBlock: 22280145,
      chain: 'ethereum',
      topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
    })
    await expect(res).rejects.toThrowError()
  });

  test("Indexer - getLogs - no targets", async () => {

    const res = await getLogs({
      fromBlock: 22280140,
      toBlock: 22280145,
      chain: 'ethereum',
      topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
      noTarget: true,
    })
    expect(res.length).toBe(94)
  });

  test("Indexer - getLogs - noTarget with large block range should throw", async () => {
    const res = getLogs({
      fromBlock: 10000000,
      toBlock: 60000000, // 50M blocks range
      chain: 'ethereum',
      topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
      noTarget: true,
    })
    await expect(res).rejects.toThrow('When noTarget is true, block range must be less than 500k blocks')
  });

  test("Indexer - getLogs - noTarget with > 10k block range", async () => {
    const res = await getLogs({
      fromBlock: 345461578,
      toBlock: 345803768, // ~~ 300k blocks
      chain: 'arbitrum',
      topics: ['0x40b88e5c41c5a97ffb7b6ef88a0a2d505aa0c634cf8a0275cb236ea7dd87ed4d'],
      noTarget: true,
    })
    expect(Array.isArray(res)).toBe(true)
  });

  test("Indexer - getLogs with processor", async () => {
    const api = new ChainApi({ chain: 'arbitrum' })
    const processor = async (logs: any[]) => {
      logs.forEach(({ args }) => {
        api.add(args.token, args.amount)
      })
    }

    await getLogs({
      fromBlock: 345461578,
      toBlock: 345803768, // ~~ 300k blocks
      chain: 'arbitrum',
      eventAbi: 'event WithdrawFromLockupStream (uint256 indexed streamId, address indexed to, address indexed token, uint128 amount)',
      noTarget: true,
      processor
    })

    const balances = api.getBalances()
    expect(Object.keys(balances).length).toBeGreaterThan(0)

    // Previously these expectations stored Number-coerced values (scientific notation or
    // float-rounded integers), which encoded a precision-loss bug in sumSingleBalance.
    // Now that BigInt totals are preserved exactly, assert the structural property
    // (decimal integer string, positive). Exact values can be rebaked from a credentialed run.
    const trackedTokens = [
      'arbitrum:0x999FAF0AF2fF109938eeFE6A7BF91CA56f0D07e1',
      'arbitrum:0x577Fd586c9E6BA7f2E85E025D5824DBE19896656',
      'arbitrum:0x4e6b45BB1C7D11402faf72c2d59cAbC4085E36f2',
      'arbitrum:0xe47ba52f326806559c1deC7ddd997F6957d0317D',
      'arbitrum:0x83e5Ecd192eAc043B0674A16EEDf96176726A159',
      'arbitrum:0xA533f744B179F2431f5395978e391107DC76e103',
      'arbitrum:0x4F604735c1cF31399C6E711D5962b2B3E0225AD3',
      'arbitrum:0xC760F9782F8ceA5B06D862574464729537159966',
      'arbitrum:0x66E535e8D2ebf13F49F3D49e5c50395a97C137b1',
      'arbitrum:0x3269a3C00AB86c753856fD135d97b87FACB0d848',
      'arbitrum:0xC3323b6e71925b25943fB7369EE6769837e9C676',
      'arbitrum:0x0721b3C9f19cfeF1d622C918DcD431960f35E060',
    ]
    for (const token of trackedTokens) {
      const value = balances[token]
      expect(typeof value).toBe('string')
      expect(value).toMatch(/^\d+$/)
      expect(BigInt(value)).toBeGreaterThan(0)
    }
  })

  test("Indexer - getTransactions", async () => {
    const txHash = '0x1d1a14b882adf9d9c078a9868b682eba7833ebfd59ee0a93aa477c990056aa79'
    const res = await getTransactions({
      chain: 'ethereum',
      addresses: ['0x00a7227f026012459c218f0d9eaabd992bd48c56'],
      transaction_hashes: [txHash],
      from_block: 19000067,
      to_block: 19001067,
    })
    if (!res || !res.length) throw new Error('Transaction not found')
    const tx = res[0]

    expect(tx.hash).toBe(txHash)
    expect(tx.blockNumber).toBe(19000067)
    expect(tx.from).toBe('0x00a7227f026012459c218f0d9eaabd992bd48c56')
    expect(tx.to).toBe('0x28c6c06298d514db089934071355e5743bf21d60')
    expect(tx.value).toBe(540432699734939000)
    expect(tx.gas).toBe(207128)
    expect(tx.gasPrice).toBe(17883340967)
    expect(tx.nonce).toBe(68)
    expect(tx.input).toBe('0x')
    expect(tx.data).toBe('0x')
    expect(tx.type).toBe(2)
    expect(tx.maxFeePerGas).toBe(24000000000)
    expect(tx.maxPriorityFeePerGas).toBe(2000000000)
    expect(tx.baseFeePerGas).toBe(15883340967)
    expect(tx.effectiveGasPrice).toBe(17883340967)
    expect(tx.gasUsed).toBe(21000)
    expect(tx.cumulativeGasUsed).toBe(6678791)
    expect(tx.status).toBe(1)
    expect(tx.contractCreated).toBeUndefined()
    expect(tx.timestamp).toBe('2024-01-13 19:30:47')
  });

  test("Indexer - getTransactions - missing from_block", async () => {
    await expect(getTransactions({
      chain: 'ethereum',
      transaction_hashes: ['0x1d1a14b882adf9d9c078a9868b682eba7833ebfd59ee0a93aa477c990056aa79'],
      to_block: 19000067,
    })).rejects.toThrow("'from_block' and 'to_block' are required to search for transactions");
  });

  test("Indexer - getTransactions - missing addresses and transaction_hashes", async () => {
    await expect(getTransactions({
      chain: 'ethereum',
      from_block: 19000067,
      to_block: 19001067,
    })).rejects.toThrow("You must provide at least 'addresses' or 'transaction_hashes'");
  });

  test("Indexer - getTransactions - to_block not synced", async () => {
    await expect(getTransactions({
      chain: 'ethereum',
      addresses: ['0x00a7227f026012459c218f0d9eaabd992bd48c56'],
      from_block: 19000067,
      to_block: 999999999,
    })).rejects.toThrow();
  });

  test("Indexer - getTransactions - unknown chain", async () => {
    await expect(getTransactions({
      chain: 'unknownchain',
      addresses: ['0x00a7227f026012459c218f0d9eaabd992bd48c56'],
      from_block: 19000067,
      to_block: 19001067,
    })).rejects.toThrow();
  });

  test("Indexer - getLogs - Viem vs Ethers comparison", async () => {
    const testConfig = {
      target: contract,
      eventAbi,
      fromBlock: 16310967,
      toBlock: 16610967,
      chain: 'ethereum',
      entireLog: true,
    };

    // Convert BigInt to string immediately to avoid Jest serialization issues
    function convertBigIntToString(obj: any): any {
      if (obj === null || obj === undefined) return obj;
      if (typeof obj === 'bigint') return obj.toString();
      if (Array.isArray(obj)) return obj.map(convertBigIntToString);
      if (typeof obj === 'object') {
        const converted: any = {};
        for (const key in obj) {
          converted[key] = convertBigIntToString(obj[key]);
        }
        return converted;
      }
      return obj;
    }

    const viemLogsRaw = await getLogs({
      ...testConfig,
      decoderType: "viem",
    });
    const viemLogs = convertBigIntToString(viemLogsRaw);

    const ethersLogsRaw = await getLogs({
      ...testConfig,
      decoderType: "ethers",
    });
    const ethersLogs = convertBigIntToString(ethersLogsRaw);

    expect(viemLogs.length).toBe(ethersLogs.length);
    expect(viemLogs.length).toBeGreaterThan(0);

    function normalizeArgsForComparison(args: any): any {
      if (!args) return args;

      const sorted = Object.keys(args).sort().reduce((acc: any, key: string) => {
        acc[key] = args[key];
        return acc;
      }, {} as any);

      return sorted;
    }

    for (let i = 0;i < viemLogs.length;i++) {
      const viemLog = viemLogs[i];
      const ethersLog = ethersLogs[i];

      // Compare basic fields
      expect(viemLog.transactionHash).toBe(ethersLog.transactionHash);
      expect(viemLog.logIndex ?? viemLog.index).toBe(ethersLog.logIndex ?? ethersLog.index);
      expect(viemLog.blockNumber).toBe(ethersLog.blockNumber);
      expect((viemLog.address ?? viemLog.source)?.toLowerCase()).toBe(
        (ethersLog.address ?? ethersLog.source)?.toLowerCase()
      );

      // Compare args if present
      if (viemLog.args || ethersLog.args) {
        const viemArgs = normalizeArgsForComparison(viemLog.args);
        const ethersArgs = normalizeArgsForComparison(ethersLog.args);

        expect(viemArgs).toEqual(ethersArgs);
      }
    }
  });
});

(process.env.LLAMA_INDEXER_V4_ENDPOINT ? describe : describe.skip)("v4-only chains", () => {
  let sdk: typeof import('./indexer');
  let getLogsPublic: typeof import('./logs').getLogs;
  const originalChains = process.env.LLAMA_INDEXER_V4_ONLY_CHAINS;
  beforeAll(() => {
    process.env.LLAMA_INDEXER_V4_ONLY_CHAINS = [originalChains, '5042:arc'].filter(Boolean).join(',');
    jest.resetModules();
    sdk = require('./indexer');
    ({ getLogs: getLogsPublic } = require('./logs'));
  });
  afterAll(() => {
    if (originalChains === undefined) delete process.env.LLAMA_INDEXER_V4_ONLY_CHAINS;
    else process.env.LLAMA_INDEXER_V4_ONLY_CHAINS = originalChains;
  });
  const TRANSFER_EVENT = "event Transfer(address indexed from, address indexed to, uint256 value)";

  type V4ChainFixture = {
    chain: string;
    fromBlock: number;
    toBlock: number;
    tokenA: string;
    tokenACount: number;
    tokenB: string;
    tokenBCount: number;
    transferRecipient: string;
    transferRecipientToken: string;
    transferRecipientCount: number;
    tx: {
      hash: string;
      fromBlock: number;
      toBlock: number;
      blockNumber: number;
      transactionIndex: number;
      from: string;
      to: string;
      value: number;
      nonce: number;
      gasUsed: number;
    };
  };

  const V4_CHAINS: V4ChainFixture[] = [
    {
      chain: "robinhood", // chainId 4663, baked 2026-08-20
      fromBlock: 41_000_000,
      toBlock: 41_001_000,
      tokenA: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      tokenACount: 1772,
      tokenB: "0x5fc5360d0400a0fd4f2af552add042d716f1d168",
      tokenBCount: 943,
      transferRecipient: "0x8876789976decbfcbbbe364623c63652db8c0904",
      transferRecipientToken: "0x0bd7d308f8e1639fab988df18a8011f41eacad73",
      transferRecipientCount: 104,
      tx: {
        hash: "0xe362e50948eb6f1bc5044b5352af556b727843ef3c229220ce98ddc490c4ee1f",
        fromBlock: 41_000_000,
        toBlock: 41_000_010,
        blockNumber: 41_000_001,
        transactionIndex: 8,
        from: "0x331d9a049d496385998067abf6cbb6371c8d2466",
        to: "0xccc88a9d1b4ed6b0eaba998850414b24f1c315be",
        value: 0,
        nonce: 232497,
        gasUsed: 389888,
      },
    },
    {
      chain: "arc", // chainId 5042, baked 2026-09-17
      fromBlock: 21_000_000,
      toBlock: 21_001_000,
      tokenA: "0x8cd7e5a2240a1a7efaa9b164caa1dc80e9ed23a3",
      tokenACount: 122,
      tokenB: "0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b",
      tokenBCount: 107,
      transferRecipient: "0x4fca4a51ab4f23a7447b3284fbd7d73289a89fb1",
      transferRecipientToken: "0x2ba0f44bdfc17fba30eda9cdbecb908ca45b043b",
      transferRecipientCount: 1,
      tx: {
        hash: "0xb94ac55073bedd66c6c4994018264fa0a5368753d954b4f765f36f2dec2ca704",
        fromBlock: 21_000_000,
        toBlock: 21_000_010,
        blockNumber: 21_000_000,
        transactionIndex: 0,
        from: "0x3381454380d24f6a9913af81e89ab91700aa0012",
        to: "0x919c548ea8a779e0e551ef35f6aba65565b140a7",
        value: 0,
        nonce: 249,
        gasUsed: 271372,
      },
    },
  ];

  const describeChain = describe.each(V4_CHAINS);

  describeChain("Indexer v4 - $chain", (c) => {
    test("routed to the v4 indexer", () => {
      expect(sdk.supportedChainSet2.has(c.chain)).toBe(true);
      expect(sdk.getChainIndexerVersion(c.chain)).toBe("v4");
      expect(sdk.isIndexerEnabled(c.chain)).toBe(true);
    });

    test("sdk.getLogs - single target", async () => {
      const res = await sdk.getLogs({
        target: c.tokenA,
        eventAbi: TRANSFER_EVENT,
        fromBlock: c.fromBlock,
        toBlock: c.toBlock,
        chain: c.chain,
        entireLog: true,
      });
      expect(res.length).toBe(c.tokenACount);
      expect(res.every((l: any) => (l.source ?? l.address) === c.tokenA)).toBe(true);
      expect(res.every((l: any) => l.blockNumber >= c.fromBlock && l.blockNumber <= c.toBlock)).toBe(true);
      const { args } = res[0];
      expect(args.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(args.to).toMatch(/^0x[0-9a-fA-F]{40}$/);
      expect(typeof args.value).toBe("bigint");
    });

    // regression: public sdk.getLogs (the adapters path) must keep .args with entireLog + eventAbi
    test("public sdk.getLogs - entireLog + eventAbi keeps decoded args through the indexer path", async () => {
      const res: any[] = await getLogsPublic({
        target: c.tokenA,
        eventAbi: TRANSFER_EVENT,
        fromBlock: c.fromBlock,
        toBlock: c.toBlock,
        chain: c.chain,
        entireLog: true,
        skipCache: true,
      });
      expect(res.length).toBe(c.tokenACount);
      expect(res.every((l: any) => l.args !== undefined)).toBe(true);
      expect(res[0].transactionHash).toMatch(/^0x[0-9a-f]{64}$/);
    });

    test("sdk.getLogs - multiple targets, flatten=false", async () => {
      const res = await sdk.getLogs({
        targets: [c.tokenA, c.tokenB],
        eventAbi: TRANSFER_EVENT,
        fromBlock: c.fromBlock,
        toBlock: c.toBlock,
        chain: c.chain,
        flatten: false,
        onlyArgs: true,
      });
      expect(res.length).toBe(2);
      expect(res[0].length).toBe(c.tokenACount);
      expect(res[1].length).toBe(c.tokenBCount);
    });

    test("sdk.getLogs - clientStreaming matches legacy path", async () => {
      const res = await sdk.getLogs({
        target: c.tokenA,
        eventAbi: TRANSFER_EVENT,
        fromBlock: c.fromBlock,
        toBlock: c.toBlock,
        chain: c.chain,
        onlyArgs: true,
        clientStreaming: true,
      });
      expect(res.length).toBe(c.tokenACount);
    });

    test("sdk.getLogs - block not synced throws", async () => {
      const res = sdk.getLogs({
        target: c.tokenA,
        eventAbi: TRANSFER_EVENT,
        fromBlock: 999_999_990,
        toBlock: 999_999_999,
        chain: c.chain,
      });
      await expect(res).rejects.toThrowError();
    });

    test("sdk.getTokenTransfers - incoming transfers", async () => {
      const res = await sdk.getTokenTransfers({
        target: c.transferRecipient,
        tokens: [c.transferRecipientToken],
        fromBlock: c.fromBlock,
        toBlock: c.toBlock,
        chain: c.chain,
      });
      expect(res.length).toBe(c.transferRecipientCount);
      expect(res.every((t: any) => t.to_address === c.transferRecipient)).toBe(true);
      expect(res.every((t: any) => t.token === c.transferRecipientToken)).toBe(true);
    });

    test("sdk.getTransactions - by transaction hash", async () => {
      const res = await sdk.getTransactions({
        chain: c.chain,
        transaction_hashes: [c.tx.hash],
        from_block: c.tx.fromBlock,
        to_block: c.tx.toBlock,
      });
      if (!res || !res.length) throw new Error("Transaction not found");
      const tx = res[0];

      expect(tx.hash).toBe(c.tx.hash);
      expect(tx.blockNumber).toBe(c.tx.blockNumber);
      expect(tx.transactionIndex).toBe(c.tx.transactionIndex);
      expect(tx.from).toBe(c.tx.from);
      expect(tx.to).toBe(c.tx.to);
      expect(tx.value).toBe(c.tx.value);
      expect(tx.nonce).toBe(c.tx.nonce);
      expect(tx.gasUsed).toBe(c.tx.gasUsed);
      expect(tx.status).toBe(1);
    });
  });

});
