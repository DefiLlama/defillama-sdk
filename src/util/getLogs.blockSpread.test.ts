import { getLogs } from "./index";

// a provider that rejects ranges wider than `cap` blocks, like etherlink's public node (500)
function cappedProvider(cap: number, logBlocks: number[] = []) {
  const calls: [number, number][] = []
  return {
    calls,
    getLogs: async ({ fromBlock, toBlock }: any) => {
      calls.push([fromBlock, toBlock])
      if (toBlock - fromBlock > cap) throw new Error(`Cannot request logs over more than ${cap} blocks`)
      return logBlocks.filter(b => b >= fromBlock && b <= toBlock).map(b => ({ blockNumber: b, transactionHash: `0x${b.toString(16)}`, index: 0, topics: [] }))
    },
  }
}

const opts = (provider: any, fromBlock: number, toBlock: number) => ({ chain: 'etlk', target: '0x0000000000000000000000000000000000000001', topic: 'Test()', keys: [], fromBlock, toBlock, provider } as any)

test("getLogs splits below 1000 blocks for an RPC capped at 500", async () => {
  const provider = cappedProvider(500, [1_000_100, 1_001_000, 1_002_400])
  const { output } = await getLogs(opts(provider, 1_000_000, 1_002_500))
  expect(output.map((i: any) => i.blockNumber)).toEqual([1_000_100, 1_001_000, 1_002_400])
  const succeeded = provider.calls.filter(([from, to]) => to - from <= 500)
  expect(succeeded.length).toBeGreaterThan(1)
  expect(succeeded[0][0]).toBe(1_000_000)
  expect(succeeded[succeeded.length - 1][1]).toBe(1_002_500)
});

test("getLogs returns a log on a chunk boundary block once", async () => {
  // spread goes 2500 -> 999 -> 499, so the first chunk ends on block 1_000_499 and the next one starts there
  const provider = cappedProvider(500, [1_000_499])
  const { output } = await getLogs(opts(provider, 1_000_000, 1_002_500))
  expect(provider.calls.filter(([from, to]) => to - from <= 500 && from <= 1_000_499 && to >= 1_000_499).length).toBe(2)
  expect(output.length).toBe(1)
});

test("getLogs still fails fast when a capped RPC would need too many small requests", async () => {
  const provider = cappedProvider(500)
  await expect(getLogs(opts(provider, 1_000_000, 2_000_000))).rejects.toThrow('Cannot request logs over more than 500 blocks')
  expect(provider.calls.every(([from, to]) => to - from >= 999)).toBe(true)
});

test("getLogs never requests fewer than 100 blocks", async () => {
  const provider = cappedProvider(50)
  await expect(getLogs(opts(provider, 1_000_000, 1_002_500))).rejects.toThrow('Cannot request logs over more than 50 blocks')
  expect(Math.min(...provider.calls.map(([from, to]) => to - from))).toBeGreaterThanOrEqual(100)
});

test("getLogs is unchanged for an RPC that serves the whole range", async () => {
  const provider = cappedProvider(1e9, [1_000_000, 1_000_499, 1_002_500])
  const { output } = await getLogs(opts(provider, 1_000_000, 1_002_500))
  expect(provider.calls).toEqual([[1_000_000, 1_002_500]])
  expect(output.length).toBe(3)
});

test("getLogs keeps splitting at 999 blocks the same way for an RPC capped at 1000", async () => {
  const provider = cappedProvider(1000, [1_000_999])
  const { output } = await getLogs(opts(provider, 1_000_000, 1_002_500))
  expect(provider.calls.slice(1)).toEqual([[1_000_000, 1_000_999], [1_000_999, 1_001_998], [1_001_998, 1_002_500]])
  // block 1_000_999 is in two chunks, its log is returned once
  expect(output.length).toBe(1)
});
