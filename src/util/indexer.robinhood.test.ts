import { getChainIndexerVersion, getLogs, getTokenTransfers, getTransactions, isIndexerEnabled, supportedChainSet2 } from "./indexer";

const enabled = !!(process.env.LLAMA_INDEXER_V4_ENDPOINT && (process.env.LLAMA_INDEXER_V4_API_KEY || process.env.LLAMA_INDEXER_V2_API_KEY));
const d = enabled ? describe : describe.skip;

if (!enabled) {
  // eslint-disable-next-line no-console
  console.warn("[indexer.robinhood] LLAMA_INDEXER_V4_ENDPOINT/API key not set - skipping robinhood tests");
}

const CHAIN = "robinhood";
const FROM_BLOCK = 41_000_000;
const TO_BLOCK = 41_001_000;

const TOKEN_A = "0x0bd7d308f8e1639fab988df18a8011f41eacad73"; // 1772 Transfers on range
const TOKEN_B = "0x5fc5360d0400a0fd4f2af552add042d716f1d168"; // 943 Transfers on range
const RECIPIENT = "0x8876789976decbfcbbbe364623c63652db8c0904"; // receives 104 TOKEN_A transfers on range
const TRANSFER_EVENT = "event Transfer(address indexed from, address indexed to, uint256 value)";

const TX_HASH = "0xe362e50948eb6f1bc5044b5352af556b727843ef3c229220ce98ddc490c4ee1f";

d("Indexer v4 - robinhood", () => {
  test("robinhood is routed to the v4 indexer", () => {
    expect(supportedChainSet2.has(CHAIN)).toBe(true);
    expect(getChainIndexerVersion(CHAIN)).toBe("v4");
    expect(isIndexerEnabled(CHAIN)).toBe(true);
  });

  test("getLogs - single target", async () => {
    const res = await getLogs({
      target: TOKEN_A,
      eventAbi: TRANSFER_EVENT,
      fromBlock: FROM_BLOCK,
      toBlock: TO_BLOCK,
      chain: CHAIN,
      entireLog: true,
    });
    expect(res.length).toBe(1772);
    expect(res.every((l: any) => (l.source ?? l.address) === TOKEN_A)).toBe(true);
    expect(res.every((l: any) => l.blockNumber >= FROM_BLOCK && l.blockNumber <= TO_BLOCK)).toBe(true);
    const { args } = res[0];
    expect(args.from).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(args.to).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(typeof args.value).toBe("bigint");
  });

  test("getLogs - multiple targets, flatten=false", async () => {
    const res = await getLogs({
      targets: [TOKEN_A, TOKEN_B],
      eventAbi: TRANSFER_EVENT,
      fromBlock: FROM_BLOCK,
      toBlock: TO_BLOCK,
      chain: CHAIN,
      flatten: false,
      onlyArgs: true,
    });
    expect(res.length).toBe(2);
    expect(res[0].length).toBe(1772);
    expect(res[1].length).toBe(943);
  });

  test("getLogs - clientStreaming matches legacy path", async () => {
    const res = await getLogs({
      target: TOKEN_A,
      eventAbi: TRANSFER_EVENT,
      fromBlock: FROM_BLOCK,
      toBlock: TO_BLOCK,
      chain: CHAIN,
      onlyArgs: true,
      clientStreaming: true,
    });
    expect(res.length).toBe(1772);
  });

  test("getLogs - block not synced throws", async () => {
    const res = getLogs({
      target: TOKEN_A,
      eventAbi: TRANSFER_EVENT,
      fromBlock: 999_999_990,
      toBlock: 999_999_999,
      chain: CHAIN,
    });
    await expect(res).rejects.toThrowError();
  });

  test("getTokenTransfers - incoming transfers", async () => {
    const res = await getTokenTransfers({
      target: RECIPIENT,
      tokens: [TOKEN_A],
      fromBlock: FROM_BLOCK,
      toBlock: TO_BLOCK,
      chain: CHAIN,
    });
    expect(res.length).toBe(104);
    expect(res.every((t: any) => t.to_address === RECIPIENT)).toBe(true);
    expect(res.every((t: any) => t.token === TOKEN_A)).toBe(true);
  });

  test("getTransactions - by transaction hash", async () => {
    const res = await getTransactions({
      chain: CHAIN,
      transaction_hashes: [TX_HASH],
      from_block: 41_000_000,
      to_block: 41_000_010,
    });
    if (!res || !res.length) throw new Error("Transaction not found");
    const tx = res[0];

    expect(tx.hash).toBe(TX_HASH);
    expect(tx.blockNumber).toBe(41_000_001);
    expect(tx.transactionIndex).toBe(8);
    expect(tx.from).toBe("0x331d9a049d496385998067abf6cbb6371c8d2466");
    expect(tx.to).toBe("0xccc88a9d1b4ed6b0eaba998850414b24f1c315be");
    expect(tx.value).toBe(0);
    expect(tx.nonce).toBe(232497);
    expect(tx.gasUsed).toBe(389888);
    expect(tx.status).toBe(1);
  });
});
