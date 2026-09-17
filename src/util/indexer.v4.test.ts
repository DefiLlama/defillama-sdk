// v4-only chains battery: adding a chain = appending one fixture object to V4_CHAINS (immutable historical ranges)
export {};

// no hoisted imports on purpose: the env must be set before the indexer module loads
if (!(process.env.LLAMA_INDEXER_V4_ONLY_CHAINS || "").split(",").some((e) => e.trim().startsWith("5042:"))) {
  process.env.LLAMA_INDEXER_V4_ONLY_CHAINS = [process.env.LLAMA_INDEXER_V4_ONLY_CHAINS, "5042:arc"]
    .filter(Boolean)
    .join(",");
}

/* eslint-disable @typescript-eslint/no-var-requires */
const { getChainIndexerVersion, getLogs, getTokenTransfers, getTransactions, isIndexerEnabled, supportedChainSet2 } =
  require("./indexer") as typeof import("./indexer");
const { getLogs: getLogsPublic } = require("./logs") as typeof import("./logs");

const enabled = !!(
  process.env.LLAMA_INDEXER_V4_ENDPOINT &&
  (process.env.LLAMA_INDEXER_V4_API_KEY || process.env.LLAMA_INDEXER_V2_API_KEY)
);

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn("[indexer.v4] LLAMA_INDEXER_V4_ENDPOINT/API key not set - skipping v4 chain tests");
}

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

const describeChain = enabled ? describe.each(V4_CHAINS) : describe.skip.each(V4_CHAINS);

describeChain("Indexer v4 - $chain", (c) => {
  test("routed to the v4 indexer", () => {
    expect(supportedChainSet2.has(c.chain)).toBe(true);
    expect(getChainIndexerVersion(c.chain)).toBe("v4");
    expect(isIndexerEnabled(c.chain)).toBe(true);
  });

  test("getLogs - single target", async () => {
    const res = await getLogs({
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

  // regression: public getLogs (the adapters path) must keep .args with entireLog + eventAbi
  test("public getLogs - entireLog + eventAbi keeps decoded args through the indexer path", async () => {
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

  test("getLogs - multiple targets, flatten=false", async () => {
    const res = await getLogs({
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

  test("getLogs - clientStreaming matches legacy path", async () => {
    const res = await getLogs({
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

  test("getLogs - block not synced throws", async () => {
    const res = getLogs({
      target: c.tokenA,
      eventAbi: TRANSFER_EVENT,
      fromBlock: 999_999_990,
      toBlock: 999_999_999,
      chain: c.chain,
    });
    await expect(res).rejects.toThrowError();
  });

  test("getTokenTransfers - incoming transfers", async () => {
    const res = await getTokenTransfers({
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

  test("getTransactions - by transaction hash", async () => {
    const res = await getTransactions({
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
