import { getLogParams, getLogs } from './logs'
import { getLogs as getRpcLogs } from '.'
import { getLogs as getIndexerLogs, isIndexerEnabled, requireSingleTopic } from './indexer'

jest.mock('.', () => ({ getLogs: jest.fn() }))
jest.mock('./indexer', () => ({
  ...jest.requireActual('./indexer'),
  getLogs: jest.fn(),
  isIndexerEnabled: jest.fn(),
}))
jest.mock('./blocks', () => ({ ...jest.requireActual('./blocks'), getBlockNumber: jest.fn() }))

const rpcLogs = getRpcLogs as jest.Mock
const indexerLogs = getIndexerLogs as jest.Mock
const indexerEnabled = isIndexerEnabled as jest.Mock

const SIG = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'
const A = '0x' + 'a'.repeat(64)
const B = '0x' + 'b'.repeat(64)

const baseOptions = { chain: 'ethereum', target: '0x' + '1'.repeat(40), fromBlock: 100, toBlock: 200, skipCache: true }

beforeEach(() => {
  jest.clearAllMocks()
  rpcLogs.mockResolvedValue({ output: [] })
  indexerEnabled.mockReturnValue(false)
})

test('an OR list at a topic position survives getLogParams instead of being stringified', async () => {
  const params = await getLogParams({ ...baseOptions, topics: [SIG, [A, B], null] } as any)
  expect(params.topics).toEqual([SIG, [A, B], null])
  expect(params.topic1).toEqual([A, B])
})

test('the rpc path receives the OR list as an array, not a joined string', async () => {
  await getLogs({ ...baseOptions, topics: [SIG, [A, B], null] } as any)
  expect(rpcLogs).toHaveBeenCalledTimes(1)
  expect(rpcLogs.mock.calls[0][0].topics).toEqual([SIG, [A, B], null])
})

test.each([
  { position: 1, topics: [SIG, [A, B]] },
  { position: 2, topics: [SIG, A, [A, B]] },
  { position: 3, topics: [SIG, A, B, [A, B]] },
])('the indexer refuses an OR list at topic$position rather than comma joining it', async ({ position, topics }) => {
  const params = await getLogParams({ ...baseOptions, topics } as any, true)
  const value = [params.topic1, params.topic2, params.topic3][position - 1]
  expect(() => requireSingleTopic(value, position)).toThrow(new RegExp(`OR list at topic${position}`))
})

test('a single value at a topic position is passed through untouched', () => {
  expect(requireSingleTopic(A, 1)).toBe(A)
  expect(requireSingleTopic(undefined, 1)).toBeUndefined()
  expect(requireSingleTopic(null, 2)).toBeUndefined()
})

test('an OR list on an indexer chain still returns rpc logs, because the indexer rejects it', async () => {
  indexerEnabled.mockReturnValue(true)
  indexerLogs.mockRejectedValue(new Error('indexer getLogs cannot filter an OR list at topic1, only a single value'))
  rpcLogs.mockResolvedValue({ output: [{ topics: [SIG, A], data: '0x' }] })

  await getLogs({ ...baseOptions, topics: [SIG, [A, B]], noTarget: true } as any)

  expect(indexerLogs).toHaveBeenCalledTimes(1)
  expect(rpcLogs).toHaveBeenCalledTimes(1)
  expect(rpcLogs.mock.calls[0][0].topics).toEqual([SIG, [A, B]])
})

test('onlyIndexer surfaces the refusal instead of silently falling back', async () => {
  indexerEnabled.mockReturnValue(true)
  indexerLogs.mockRejectedValue(new Error('indexer getLogs cannot filter an OR list at topic1, only a single value'))

  await expect(getLogs({ ...baseOptions, topics: [SIG, [A, B]], onlyIndexer: true } as any)).rejects.toThrow(/OR list at topic1/)
  expect(rpcLogs).not.toHaveBeenCalled()
})

test('a query with no OR list is still handed to the indexer', async () => {
  indexerEnabled.mockReturnValue(true)
  indexerLogs.mockResolvedValue([{ topics: [SIG, A], data: '0x' }])

  const logs = await getLogs({ ...baseOptions, topics: [SIG, A] } as any)

  expect(indexerLogs).toHaveBeenCalledTimes(1)
  expect(rpcLogs).not.toHaveBeenCalled()
  expect(logs).toHaveLength(1)
})
