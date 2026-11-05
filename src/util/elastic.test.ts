const bulk = jest.fn()

jest.mock('@elastic/elasticsearch', () => ({
  Client: jest.fn().mockImplementation(() => ({ bulk })),
}))

import { reportIssues, dayOf, DataIssue } from './elastic'

const issue = (overrides: Partial<DataIssue> = {}): DataIssue => ({
  entity_type: 'protocol',
  entity_id: '1',
  parent_id: null,
  name: 'test',
  metric: 'tvl',
  day: dayOf(Date.now() / 1000),
  value: 200,
  baseline: 100,
  check: 'spike-check',
  type: 'spike',
  state: 'live',
  message: 'doubled',
  ...overrides,
})

const now = new Date()
const expectedIndex = `data-issues-${now.getUTCFullYear()}-${now.getUTCMonth()}`

beforeEach(() => {
  process.env.ELASTICSEARCH_CONFIG = JSON.stringify({ host: 'http://localhost:9200', username: 'u', password: 'p' })
  bulk.mockReset()
  bulk.mockResolvedValue({ errors: false })
  jest.spyOn(console, 'error').mockImplementation(() => { })
  jest.spyOn(console, 'warn').mockImplementation(() => { })
})

afterEach(() => {
  delete process.env.ELASTICSEARCH_CONFIG
  jest.restoreAllMocks()
})

test('writes all issues in a single bulk request', async () => {
  await reportIssues([issue({ name: 'a' }), issue({ name: 'b' }), issue({ name: 'c' })])

  expect(bulk).toHaveBeenCalledTimes(1)
  const { index, operations } = bulk.mock.calls[0][0]
  expect(index).toBe(expectedIndex)
  expect(operations).toHaveLength(6) // action + doc per issue
  expect(operations.filter((_: any, i: number) => i % 2 === 0)).toEqual([{ index: {} }, { index: {} }, { index: {} }])
  expect(operations.filter((_: any, i: number) => i % 2 === 1).map((d: any) => d.name)).toEqual(['a', 'b', 'c'])
})

test('adds deviation and timestamp to each doc', async () => {
  const before = Date.now()
  await reportIssues([
    issue({ value: 200, baseline: 100 }),
    issue({ value: null, baseline: 100 }),
    issue({ value: 50, baseline: null }),
    issue({ value: 50, baseline: 0 }),
  ])

  const docs = bulk.mock.calls[0][0].operations.filter((_: any, i: number) => i % 2 === 1)
  expect(docs.map((d: any) => d.deviation)).toEqual([1, null, null, null])
  for (const doc of docs) {
    expect(doc.timestamp).toBeGreaterThanOrEqual(before)
    expect(doc.timestamp).toBeLessThanOrEqual(Date.now())
  }
})

test('writes an old day of any type: a problem can be weeks old, and the queue merges repeats', async () => {
  const old = dayOf(Date.now() / 1000 - 30 * 86400)
  await reportIssues([issue({ name: 'stale', day: old, type: 'stale' }), issue({ name: 'spike', day: old, type: 'spike' }), issue({ name: 'noday', day: null })])
  const docs = bulk.mock.calls[0][0].operations.filter((_: any, i: number) => i % 2 === 1)
  expect(docs.map((d: any) => d.name)).toEqual(['stale', 'spike', 'noday'])
})

test('a config with no host does not reject, as some callers do not wait for this', async () => {
  let fresh: typeof reportIssues
  jest.isolateModules(() => {
    const { Client } = require('@elastic/elasticsearch')
    Client.mockImplementationOnce(() => { throw new Error('Missing node(s) option') })
    fresh = require('./elastic').reportIssues
  })
  await expect(fresh!([issue()])).resolves.toBeUndefined()
  expect(console.error).toHaveBeenCalledWith('data-issues write failed:', 'Missing node(s) option')
})

test('sends nothing for an empty list', async () => {
  await reportIssues([])
  expect(bulk).not.toHaveBeenCalled()
})

test('passes limitMs as the request timeout', async () => {
  await reportIssues([issue()], { limitMs: 1234 })
  expect(bulk.mock.calls[0][0].timeout).toBe('1234ms')
})

test('never rejects when the bulk request fails', async () => {
  bulk.mockRejectedValue(new Error('boom'))
  await expect(reportIssues([issue()])).resolves.toBeUndefined()
  expect(console.error).toHaveBeenCalledWith('data-issues write failed:', 'boom')
})

test('logs partial failures reported by bulk', async () => {
  bulk.mockResolvedValue({ errors: true, items: [] })
  await reportIssues([issue()])
  expect(console.error).toHaveBeenCalledWith('data-issues bulk write: some items failed')
})

test('resolves after limitMs when the bulk request hangs', async () => {
  bulk.mockReturnValue(new Promise(() => { })) // never settles
  const start = Date.now()
  await reportIssues([issue()], { limitMs: 50 })
  expect(Date.now() - start).toBeGreaterThanOrEqual(45)
  expect(Date.now() - start).toBeLessThan(1000)
})
