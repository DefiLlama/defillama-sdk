import { getCacheBuffer, getLogs } from './logs'
import { getLogs as getRpcLogs } from '.'
import { readCache, writeCache } from './cache'
import { getBlockNumber } from './blocks'

jest.mock('.', () => ({ getLogs: jest.fn() }))
jest.mock('./cache', () => ({ ...jest.requireActual('./cache'), readCache: jest.fn(), writeCache: jest.fn() }))
jest.mock('./blocks', () => ({ ...jest.requireActual('./blocks'), getBlockNumber: jest.fn() }))

const rpc = getRpcLogs as jest.Mock
const cached = readCache as jest.Mock
const saved = writeCache as jest.Mock
const head = getBlockNumber as jest.Mock

const TRANSFER = 'event Transfer(address indexed from, address indexed to, uint256 value)'
const TARGETS = [
  '0x000000000000000000000000000000000000000a',
  '0x000000000000000000000000000000000000000b',
  '0x000000000000000000000000000000000000000c',
]

beforeEach(() => {
  jest.clearAllMocks()
  cached.mockResolvedValue({})
  saved.mockResolvedValue(undefined)
  head.mockResolvedValue(10_000_000)
})

function recordRanges() {
  const asked: Array<[number, number]> = []
  rpc.mockImplementation(async ({ fromBlock, toBlock }: any) => { asked.push([fromBlock, toBlock]); return { output: [] } })
  return asked
}

test('no sub-query is wider than maxBlockRange', async () => {
  const asked = recordRanges()
  await getLogs({
    chain: 'ethereum', target: TARGETS[0], eventAbi: TRANSFER,
    fromBlock: 1_000_000, toBlock: 1_002_000,
    maxBlockRange: 500, skipIndexer: true, skipCache: true,
  })
  const widths = asked.map(([f, t]) => t - f + 1)
  expect(widths.length).toBeGreaterThan(1)
  expect(Math.max(...widths)).toBeLessThanOrEqual(500)
})

test('the range is still covered end to end', async () => {
  const asked = recordRanges()
  await getLogs({
    chain: 'ethereum', target: TARGETS[0], eventAbi: TRANSFER,
    fromBlock: 1_000_000, toBlock: 1_002_000,
    maxBlockRange: 500, skipIndexer: true, skipCache: true,
  })
  const sorted = [...asked].sort((a, b) => a[0] - b[0])
  expect(sorted[0][0]).toBeLessThanOrEqual(1_000_000)
  expect(sorted[sorted.length - 1][1]).toBeGreaterThanOrEqual(1_002_000)
  for (let i = 1; i < sorted.length; i++) expect(sorted[i][0]).toBeLessThanOrEqual(sorted[i - 1][1] + 1)
})

test('the cache padding is kept when the cap leaves room for it', async () => {
  const asked = recordRanges()
  await getLogs({
    chain: 'ethereum', target: TARGETS[0], eventAbi: TRANSFER,
    fromBlock: 1_000_000, toBlock: 1_000_100,
    maxBlockRange: 500, skipIndexer: true, skipCache: true,
  })
  expect(asked).toEqual([[1_000_000 - 10, 1_000_100 + 10]])
})

test('no cap means the padding is unchanged', async () => {
  const asked = recordRanges()
  await getLogs({
    chain: 'ethereum', target: TARGETS[0], eventAbi: TRANSFER,
    fromBlock: 1_000_000, toBlock: 1_000_100,
    skipIndexer: true, skipCache: true,
  })
  expect(asked).toEqual([[1_000_000 - 10, 1_000_100 + 10]])
})

describe('targets with a block range split', () => {
  beforeEach(() => {
    // one log per target per sub-query, tagged with its target so attribution is checkable
    rpc.mockImplementation(async ({ target, fromBlock }: any) => ({
      output: [{ address: target, blockNumber: fromBlock, transactionHash: '0x' + fromBlock.toString(16) + target.slice(-1), index: 0, topics: [], args: {} }],
    }))
  })

  const call = (over: any = {}) => getLogs({
    chain: 'ethereum', targets: TARGETS, eventAbi: TRANSFER,
    fromBlock: 1_000_000, toBlock: 1_002_000,
    maxBlockRange: 500, entireLog: true, skipIndexer: true, skipCache: true,
    ...over,
  })

  test('flatten false gives one entry per target, not one per chunk', async () => {
    const out = (await call({ flatten: false })) as any[][]
    expect(out).toHaveLength(TARGETS.length)
    out.forEach((group, i) => {
      expect(group.length).toBeGreaterThan(0)
      for (const log of group) expect(String(log.address).toLowerCase()).toBe(TARGETS[i])
    })
  })

  test('flatten true still returns one flat list', async () => {
    const out = (await call({ flatten: true })) as any[]
    expect(Array.isArray(out)).toBe(true)
    expect(out.every((log: any) => typeof log.address === 'string')).toBe(true)
    expect(new Set(out.map((log: any) => String(log.address).toLowerCase())).size).toBe(TARGETS.length)
  })
})

describe('getCacheBuffer', () => {
  test.each([
    [100, undefined, 10],
    [500, 500, 0],
    [499, 500, 0],
    [480, 500, 10],
    [490, 500, 5],
    [100, 500, 10],
    [600, 500, 0],
  ])('span %s under cap %s pads by %s a side', (span, cap, expected) => {
    expect(getCacheBuffer(span, cap)).toBe(expected)
  })
})
