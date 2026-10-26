import { getLogs } from '.'
import { getHintedBlockSpan, isRangeTooWideError } from './logs.range'

// a node that refuses any range wider than `cap` blocks, the ordinary shape of a public rpc
function cappedProvider(cap: number, logsPerBlock = 1) {
  const asked: Array<[number, number]> = []
  return {
    asked,
    getLogs: async ({ fromBlock, toBlock }: any) => {
      if (toBlock - fromBlock + 1 > cap) throw new Error(`eth_getLogs is limited to ${cap} blocks range`)
      asked.push([fromBlock, toBlock])
      const out: any[] = []
      for (let b = fromBlock; b <= toBlock; b++)
        for (let i = 0; i < logsPerBlock; i++)
          out.push({ blockNumber: b, transactionHash: '0x' + b.toString(16), index: i, topics: ['0x'], data: '0x' })
      return out
    },
  } as any
}

const TRANSFER = 'Transfer(address,address,uint256)'
const call = (provider: any, fromBlock: number, toBlock: number) =>
  getLogs({ chain: 'ethereum', provider, topic: TRANSFER, keys: [], fromBlock, toBlock })

test('a split range returns every block exactly once', async () => {
  const provider = cappedProvider(1000)
  const { output } = await call(provider, 1_000_000, 1_004_000)
  const keys = output.map((l: any) => `${l.blockNumber}-${l.index}`)
  expect(output).toHaveLength(4001)
  expect(new Set(keys).size).toBe(4001)
})

test('sub-queries tile the range without overlapping', async () => {
  const provider = cappedProvider(1000)
  await call(provider, 1_000_000, 1_004_000)
  const sorted = [...provider.asked].sort((a, b) => a[0] - b[0])
  for (const [from, to] of sorted) expect(to - from + 1).toBeLessThanOrEqual(1000)
  for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBe(sorted[i - 1][1] + 1)
  expect(sorted[0][0]).toBe(1_000_000)
  expect(sorted[sorted.length - 1][1]).toBe(1_004_000)
})

test('a single block range is fetched, not skipped', async () => {
  const provider = cappedProvider(1000, 3)
  const { output } = await call(provider, 1_000_000, 1_000_000)
  expect(output).toHaveLength(3)
  expect(provider.asked).toEqual([[1_000_000, 1_000_000]])
})

test('a cap below 1000 blocks is still reachable', async () => {
  const provider = cappedProvider(50)
  const { output } = await call(provider, 1_000_000, 1_002_000)
  expect(output).toHaveLength(2001)
  expect(new Set(output.map((l: any) => l.blockNumber)).size).toBe(2001)
})

test('a stated cap is used directly instead of halving down to it', async () => {
  const provider = cappedProvider(112) // the etherlink case
  await call(provider, 1_000_000, 1_002_000)
  expect(provider.asked.length).toBe(Math.ceil(2001 / 112))
})

test('an error that is not about the range is not retried at a narrower span', async () => {
  let calls = 0
  const provider: any = {
    getLogs: async () => { calls++; throw new Error('Unauthorized: You must authenticate your request') },
  }
  await expect(call(provider, 1_000_000, 1_100_000)).rejects.toThrow(/Unauthorized/)
  expect(calls).toBe(1)
})

test('a range needing more sub-queries than the budget fails instead of crawling', async () => {
  const provider = cappedProvider(1)
  await expect(call(provider, 1_000_000, 1_100_000)).rejects.toThrow()
})

describe('range hints', () => {
  test.each([
    ['Block range too large: maximum allowed is 50 blocks on your current plan', 50],
    ['eth_getLogs is limited to 0 - 50 blocks range', 50],
    ['log query range must not exceed 25 blocks', 25],
    ['query exceeds max block range 10000 for this key', 10000],
    ['Log response size exceeded. Maximum allowed number of requested blocks is 112', 112],
    ['query exceeds max results 20000, retry with the range 26174185-26174468', 284],
  ])('%s', (msg, span) => {
    expect(getHintedBlockSpan(new Error(msg as string))).toBe(span)
    expect(isRangeTooWideError(new Error(msg as string))).toBe(true)
  })

  test.each([
    'Unauthorized: You must authenticate your request',
    'method not available',
    'Archive requests require a personal token',
  ])('not a range complaint: %s', (msg) => {
    expect(isRangeTooWideError(new Error(msg))).toBe(false)
  })

  test('reads the message out of a wrapped error', () => {
    const wrapped = { info: { error: { code: -32602, message: 'query exceeds max block range 10000' } } }
    expect(getHintedBlockSpan(wrapped)).toBe(10000)
    expect(isRangeTooWideError(wrapped)).toBe(true)
  })
})
