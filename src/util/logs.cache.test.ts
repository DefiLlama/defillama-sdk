import { getLogs } from './logs'
import { getLogs as getRpcLogs } from '.'
import { readCache, writeCache } from './cache'
import { getLogs as getIndexerLogs, isIndexerEnabled } from './indexer'

jest.mock('.', () => ({ getLogs: jest.fn() }))
jest.mock('./cache', () => ({ ...jest.requireActual('./cache'), readCache: jest.fn(), writeCache: jest.fn() }))
jest.mock('./indexer', () => ({ ...jest.requireActual('./indexer'), getLogs: jest.fn(), isIndexerEnabled: jest.fn() }))
jest.mock('./blocks', () => ({ ...jest.requireActual('./blocks'), getBlockNumber: jest.fn().mockResolvedValue(10_000_000) }))

const rpcLogs = getRpcLogs as jest.Mock
const cached = readCache as jest.Mock
const saved = writeCache as jest.Mock
const indexerLogs = getIndexerLogs as jest.Mock
const indexerEnabled = isIndexerEnabled as jest.Mock

beforeEach(() => {
  jest.clearAllMocks()
  rpcLogs.mockResolvedValue({ output: [] })
  saved.mockResolvedValue(undefined)
  indexerLogs.mockResolvedValue([])
  indexerEnabled.mockReturnValue(false)
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

describe('cacheInCloud on an indexer-enabled chain', () => {
  const topic = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
  const options = { chain: 'ethereum', target: '0x0000000000000000000000000000000000000001', topic, cacheInCloud: true }
  const rawLog = (blockNumber: number) => ({
    address: options.target, topics: [topic], data: '0x', blockNumber,
    transactionHash: `0x${String(blockNumber).padStart(64, '0')}`, logIndex: 0, index: 0,
  })

  beforeEach(() => indexerEnabled.mockReturnValue(true))

  test('a range the cache already holds is served without any indexer or RPC call', async () => {
    cached.mockResolvedValue({ version: 'v3', caches: [{ logs: [rawLog(400), rawLog(550)], metadata: { fromBlock: 100, toBlock: 1000 } }] })

    const logs = await getLogs({ ...options, fromBlock: 500, toBlock: 600 })

    expect(logs.map((l: any) => l.blockNumber)).toEqual([550])
    expect(indexerLogs).not.toHaveBeenCalled()
    expect(rpcLogs).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
  })

  test('only the missing part of the range is fetched, from the indexer as raw logs, and the cloud cache is written', async () => {
    cached.mockResolvedValue({ version: 'v3', caches: [{ logs: [rawLog(550)], metadata: { fromBlock: 100, toBlock: 600 } }] })
    indexerLogs.mockResolvedValue([rawLog(700)])

    const logs = await getLogs({ ...options, fromBlock: 500, toBlock: 1000 })

    expect(logs.map((l: any) => l.blockNumber)).toEqual([550, 700])
    expect(rpcLogs).not.toHaveBeenCalled()
    expect(indexerLogs).toHaveBeenCalledTimes(1)
    expect(indexerLogs.mock.calls[0][0]).toMatchObject({
      chain: 'ethereum', target: options.target, fromBlock: 590, toBlock: 1010,
      all: true, entireLog: true, parseLog: false, onlyArgs: false, eventAbi: undefined,
      cacheInCloud: false, skipCache: true, offset: 0,
    })
    expect(cached.mock.calls[0][1]).toMatchObject({ skipR2Cache: false })
    expect(saved.mock.calls[0][1].caches.map((c: any) => c.metadata)).toEqual([{ fromBlock: 100, toBlock: 1010 }])
    expect(saved.mock.calls[0][2]).toMatchObject({ skipR2CacheWrite: false })
  })

  test('an indexer failure falls back to RPC for the missing part', async () => {
    cached.mockResolvedValue({ version: 'v3', caches: [] })
    indexerLogs.mockRejectedValue(new Error('indexer down'))
    rpcLogs.mockResolvedValue({ output: [rawLog(500)] })

    const logs = await getLogs({ ...options, fromBlock: 500, toBlock: 600 })

    expect(logs.map((l: any) => l.blockNumber)).toEqual([500])
    expect(rpcLogs).toHaveBeenCalledTimes(1)
  })

  test('onlyIndexer propagates an indexer failure instead of using RPC', async () => {
    cached.mockResolvedValue({ version: 'v3', caches: [] })
    indexerLogs.mockRejectedValue(new Error('indexer down'))

    await expect(getLogs({ ...options, fromBlock: 500, toBlock: 600, onlyIndexer: true })).rejects.toThrow('indexer down')
    expect(rpcLogs).not.toHaveBeenCalled()
  })

  test('several targets each go through the indexer-backed cache', async () => {
    cached.mockResolvedValue({ version: 'v3', caches: [] })
    const targets = ['0x0000000000000000000000000000000000000001', '0x0000000000000000000000000000000000000002']

    await getLogs({ ...options, target: undefined, targets, fromBlock: 500, toBlock: 600, flatten: false })

    expect(rpcLogs).not.toHaveBeenCalled()
    expect(indexerLogs.mock.calls.map((c) => c[0].target).sort()).toEqual(targets)
  })

  test('a processor with collect: false, or offset/limit, still caches the whole range', async () => {
    cached.mockResolvedValue({ version: 'v3', caches: [] })
    indexerLogs.mockResolvedValue([rawLog(500), rawLog(560)])
    const processor = jest.fn()

    const logs = await getLogs({ ...options, fromBlock: 500, toBlock: 600, processor, collect: false, offset: 1, limit: 1 } as any)

    const sent = indexerLogs.mock.calls[0][0]
    expect(sent.collect).toBeUndefined()
    expect(sent.offset).toBe(0)
    expect(sent.limit).toBeUndefined()
    expect(sent.processor).toBeUndefined()
    expect(logs.map((l: any) => l.blockNumber)).toEqual([500, 560])
    expect(processor).toHaveBeenCalledTimes(1)
    expect(saved.mock.calls[0][1].caches[0].logs).toHaveLength(2)
  })

  test('indexer-shaped raw logs survive the cache round trip and decode on the way out', async () => {
    // what the indexer returns in raw mode: normalized fields plus its own row fields
    const indexerRaw = (blockNumber: number, from: string, to: string, value: number) => ({
      block_number: blockNumber, timestamp: '2024-06-01 22:36:47',
      transaction_hash: `0x${String(blockNumber).padStart(64, '0')}`,
      source: options.target, address: options.target,
      topic0: topic, topic1: `0x${from.slice(2).padStart(64, '0')}`, topic2: `0x${to.slice(2).padStart(64, '0')}`, topic3: '',
      data: `0x${value.toString(16).padStart(64, '0')}`,
      logIndex: 0, index: 0, blockNumber,
      transactionHash: `0x${String(blockNumber).padStart(64, '0')}`,
      topics: [topic, `0x${from.slice(2).padStart(64, '0')}`, `0x${to.slice(2).padStart(64, '0')}`],
      _originalTopics: { topic0: topic }, _originalTransactionHash: `0x${String(blockNumber).padStart(64, '0')}`,
    })
    const from = '0x00000000000000000000000000000000000000aa', to = '0x00000000000000000000000000000000000000bb'
    const eventAbi = 'event Transfer(address indexed from, address indexed to, uint256 value)'
    cached.mockResolvedValue({ version: 'v3', caches: [] })
    indexerLogs.mockResolvedValue([indexerRaw(500, from, to, 7)])

    const logs = await getLogs({ ...options, topic: undefined, eventAbi, fromBlock: 500, toBlock: 600 })
    expect(logs).toHaveLength(1)
    expect(logs[0].args.from.toLowerCase()).toBe(from)
    expect(logs[0].args.to.toLowerCase()).toBe(to)
    expect(logs[0].args.value).toBe(BigInt(7))

    // the second call decodes the cached copy with different options
    cached.mockResolvedValue(JSON.parse(JSON.stringify(saved.mock.calls[0][1], (_k, v) => typeof v === 'bigint' ? v.toString() : v)))
    const args = await getLogs({ ...options, topic: undefined, eventAbi, fromBlock: 500, toBlock: 600, onlyArgs: true })
    expect(indexerLogs).toHaveBeenCalledTimes(1)
    expect(args[0].value).toBe(BigInt(7))
    expect(args[0].from.toLowerCase()).toBe(from)
  })

  test('without cacheInCloud the indexer still answers directly and the cache is not read', async () => {
    indexerLogs.mockResolvedValue([rawLog(500)])

    const logs = await getLogs({ ...options, cacheInCloud: false, fromBlock: 500, toBlock: 600 })

    expect(logs.map((l: any) => l.blockNumber)).toEqual([500])
    expect(indexerLogs).toHaveBeenCalledTimes(1)
    expect(cached).not.toHaveBeenCalled()
    expect(saved).not.toHaveBeenCalled()
  })
})
