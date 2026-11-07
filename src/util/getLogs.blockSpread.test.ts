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
  expect(provider.calls).toEqual([
    [1_000_000, 1_002_500], [1_000_000, 1_000_999], // fail
    [1_000_000, 1_000_499], [1_000_499, 1_000_998], [1_000_998, 1_001_497], [1_001_497, 1_001_996], [1_001_996, 1_002_495], [1_002_495, 1_002_500],
  ])
});

test("getLogs keeps the 999-block split and returns a log on a shared chunk boundary once", async () => {
  const provider = cappedProvider(1000, [1_000_999])
  const { output } = await getLogs(opts(provider, 1_000_000, 1_002_500))
  expect(provider.calls).toEqual([[1_000_000, 1_002_500], [1_000_000, 1_000_999], [1_000_999, 1_001_998], [1_001_998, 1_002_500]])
  expect(output.length).toBe(1)
});

test("getLogs still fails fast when a capped RPC would need too many small requests", async () => {
  const provider = cappedProvider(500)
  await expect(getLogs(opts(provider, 1_000_000, 2_000_000))).rejects.toThrow('Cannot request logs over more than 500 blocks')
  expect(provider.calls.every(([from, to]) => to - from >= 999)).toBe(true)
});
