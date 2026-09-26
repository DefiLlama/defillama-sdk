import { getLogs } from './logs'
import { getLogs as getRpcLogs } from '.'
import { readCache, writeCache } from './cache'

jest.mock('.', () => ({ getLogs: jest.fn() }))
jest.mock('./cache', () => ({ ...jest.requireActual('./cache'), readCache: jest.fn(), writeCache: jest.fn() }))

const rpcLogs = getRpcLogs as jest.Mock
const cached = readCache as jest.Mock
const saved = writeCache as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  rpcLogs.mockResolvedValue({ output: [] })
  saved.mockResolvedValue(undefined)
})

test.each([
  { name: 'nested', existing: [100, 1000], requested: [500, 600], expected: [100, 1000] },
  { name: 'overlap extending right', existing: [100, 600], requested: [550, 1000], expected: [100, 1010] },
  { name: 'adjacent', existing: [100, 600], requested: [611, 700], expected: [100, 710] },
])('getLogs retains the union of cached block ranges for $name fetches', async ({ existing, requested, expected }) => {
  cached.mockResolvedValue({ version: 'v3', caches: [{ logs: [], metadata: { fromBlock: existing[0], toBlock: existing[1] } }] })

  await getLogs({
    chain: 'ethereum',
    target: '0x0000000000000000000000000000000000000001',
    topic: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    fromBlock: requested[0],
    toBlock: requested[1],
    skipCacheRead: true,
    skipIndexer: true,
  })

  expect(rpcLogs).toHaveBeenCalledTimes(1)
  const stored = saved.mock.calls[0][1].caches
  expect(stored).toHaveLength(1)
  expect(stored[0].metadata).toEqual({ fromBlock: expected[0], toBlock: expected[1] })
})

test('getLogs keeps disjoint cached ranges separate', async () => {
  cached.mockResolvedValue({ version: 'v3', caches: [{ logs: [], metadata: { fromBlock: 100, toBlock: 600 } }] })

  await getLogs({
    chain: 'ethereum',
    target: '0x0000000000000000000000000000000000000001',
    topic: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
    fromBlock: 801,
    toBlock: 900,
    skipCacheRead: true,
    skipIndexer: true,
  })

  expect(saved.mock.calls[0][1].caches.map((c: any) => c.metadata)).toEqual([
    { fromBlock: 100, toBlock: 600 },
    { fromBlock: 791, toBlock: 910 },
  ])
})
