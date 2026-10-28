import * as http from "http"
import axios from "axios"
import { run, registerEndpoints, resolveChain, snapshot, buildDocs, mergeSnapshots, getCurrent, recordMethod, recordLogs, flushActive, ES_INDEX } from "./callStats"
import { getProvider } from "./LlamaProvider"
import { writeLog } from "./elastic"

jest.mock("./elastic", () => ({ ...jest.requireActual("./elastic"), writeLog: jest.fn(async () => { }) }))
const writeLogMock = writeLog as jest.Mock

function startServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (chunk) => { body += chunk })
      req.on('end', () => {
        let result: any = "0x1"
        try {
          const parsed = JSON.parse(body)
          if (parsed.method === 'eth_getLogs') result = []
        } catch { /* not json rpc */ }
        res.writeHead(200, { "content-type": "application/json" })
        res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result }))
      })
    })
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      close: () => server.close(),
    }))
  })
}

let server: { url: string; close: () => void }
beforeAll(async () => { server = await startServer() })
afterAll(() => server.close())

const meta = { application: 'test', name: 'proto' }
const opts = { skipElastic: true, minCalls: 0 }

test("resolveChain uses the longest registered path prefix on a host", () => {
  registerEndpoints('chainA', ['https://rpc.example.com/a', 'https://rpc.example.com/a/'])
  registerEndpoints('chainB', 'https://rpc.example.com/a/b,https://other.example.com')
  registerEndpoints('chainB', 'https://rpc.example.com/a/b,https://other.example.com') // repeat is a no-op
  registerEndpoints('chainB', ['https://rpc.example.com/a/b', 'https://other.example.com'])
  expect(resolveChain('https://rpc.example.com/a/eth_call')).toBe('chaina')
  expect(resolveChain('https://rpc.example.com/a/b/x?key=1')).toBe('chainb')
  expect(resolveChain('https://rpc.example.com/ab')).toBeUndefined()
  expect(resolveChain('https://OTHER.example.com/anything')).toBe('chainb')
  expect(resolveChain('wss://rpc.example.com/a')).toBeUndefined()
})

test("axios, http.get and fetch requests are counted and attributed to the chain", async () => {
  registerEndpoints('foochain', [`${server.url}/rpc`])
  const stats = await run(meta, async () => {
    await axios.post(`${server.url}/rpc`, {})
    await axios.get(`${server.url}/rpc?x=1`)
    await new Promise<void>((resolve) => http.get(`${server.url}/other`, (res) => { res.resume(); res.on('end', resolve) }))
    await fetch(`${server.url}/rpc/sub`)
    return snapshot()
  }, opts)
  const host = server.url.replace('http://', '')
  expect(stats.total).toBe(4)
  expect(stats.byChain).toEqual({ foochain: 3 })
  expect(stats.unattributed).toBe(1)
  expect(stats.byHost).toEqual({ [host]: 4 })
  expect(stats.byMethod).toEqual({})
  expect(stats.logs).toEqual({ rpc: {}, indexer: {} })
})

test("recordLogs sums fetched rows per source and chain, ignoring empty fetches", async () => {
  const stats = await run(meta, async () => {
    recordLogs('rpc', 'Ethereum', 5)
    recordLogs('rpc', 'ethereum', 7)
    recordLogs('indexer', 'ethereum', 100)
    recordLogs('indexer', 'arbitrum', 0)
    recordLogs('rpc', undefined, 2)
    return snapshot()
  }, opts)
  expect(stats.logs).toEqual({ rpc: { ethereum: 12, _other: 2 }, indexer: { ethereum: 100 } })
})

test("concurrent runs keep separate counters and calls outside a run go to the global bucket", async () => {
  const before = getCurrent().total
  const [a, b] = await Promise.all([
    run({ ...meta, name: 'a' }, async () => {
      await axios.get(`${server.url}/a`)
      await axios.get(`${server.url}/a`)
      recordMethod('getLogs', 'A')
      return snapshot()
    }, opts),
    run({ ...meta, name: 'b' }, async () => {
      await axios.get(`${server.url}/b`)
      return snapshot()
    }, opts),
  ])
  expect(a.total).toBe(2)
  expect(a.byMethod).toEqual({ getLogs: { a: 1 } })
  expect(b.total).toBe(1)
  expect(b.byMethod).toEqual({})
  await axios.get(`${server.url}/outside`)
  expect(getCurrent().total).toBe(before + 1)
})

test("run reports on failure too and rethrows", async () => {
  await expect(run(meta, async () => { throw new Error('boom') }, opts)).rejects.toThrow('boom')
})

test("flushActive writes the runs in flight as interrupted failures, once, and the run does not write again when it settles", async () => {
  writeLogMock.mockClear()
  let finish!: () => void
  const slow = run({ ...meta, name: 'slow' }, async () => {
    await axios.get(`${server.url}/slow`)
    await new Promise<void>((resolve) => { finish = resolve })
    return snapshot()
  }, { minCalls: 0 })
  const other = run({ ...meta, name: 'other' }, async () => {
    await axios.get(`${server.url}/other`)
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
  }, { minCalls: 0 })
  await new Promise((resolve) => setTimeout(resolve, 10))

  expect(await flushActive('timeout', { filter: (m) => m.name === 'slow' })).toBe(1)
  const docs = writeLogMock.mock.calls.filter(([index]) => index === ES_INDEX).map(([, doc]) => doc)
  expect(docs).toHaveLength(1)
  expect(docs[0]).toMatchObject({ name: 'slow', success: false, interrupted: 'timeout', runCalls: 1 })
  expect(docs[0].runtime).toBeGreaterThanOrEqual(0)
  expect(await flushActive('timeout', { filter: (m) => m.name === 'slow' })).toBe(0) // already written

  finish()
  await slow
  await other
  const names = writeLogMock.mock.calls.filter(([index]) => index === ES_INDEX).map(([, doc]) => [doc.name, doc.success, doc.interrupted])
  expect(names).toEqual([['slow', false, 'timeout'], ['other', true, undefined]])
})

test("buildDocs writes one flat doc per chain plus _other, and one per host, all sharing the run fields", () => {
  registerEndpoints('bigchain', 'https://big.rpc')
  const stats = {
    total: 130, unattributed: 40, byChain: { bigchain: 90, small: 0 }, byHost: { 'big.rpc': 90, 'api.other.com': 30, 'api.heavy.com': 10 },
    byMethod: { call: { bigchain: 80 }, getLogs: { bigchain: 10 }, indexer: { bigchain: 25, _other: 1 }, indexerGetLogs: { bigchain: 2 } },
    logs: { rpc: { bigchain: 300 }, indexer: { bigchain: 5000 } },
  }
  const { chainDocs, hostDocs } = buildDocs(stats, meta, { success: true, runtime: 3 })
  expect(chainDocs.map(d => d.chain)).toEqual(['bigchain', '_other'])
  expect(chainDocs[0]).toMatchObject({
    application: 'test', name: 'proto', chain: 'bigchain', calls: 90, getLogs: 10, indexerCalls: 25,
    logs: 5300, logsRpc: 300, logsIndexer: 5000, methods: { call: 80, getLogs: 10, indexer: 25, indexerGetLogs: 2 },
    runCalls: 130, runGetLogs: 10, runIndexerCalls: 26, runLogs: 5300, runChains: 1, success: true, runtime: 3,
  })
  expect(chainDocs[1]).toMatchObject({ chain: '_other', calls: 40, getLogs: 0, indexerCalls: 1, logs: 0, methods: { indexer: 1 }, runCalls: 130 })
  expect(chainDocs[0]['@timestamp']).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  expect(chainDocs[0]).not.toHaveProperty('type')
  expect(chainDocs[0]).not.toHaveProperty('metadata')
  expect(hostDocs.map(d => [d.host, d.calls, d.rpc])).toEqual([['big.rpc', 90, true], ['api.other.com', 30, false], ['api.heavy.com', 10, false]])
  const runIds = new Set([...chainDocs, ...hostDocs].map(d => d.runId))
  expect(runIds.size).toBe(1)
  expect([...runIds][0]).toMatch(/^[0-9a-f]{16}$/)
})

test("small chains are kept, runs under minCalls are skipped, and non-scalar meta is not written", () => {
  const stats = { total: 3, unattributed: 0, byChain: { small: 3 }, byHost: { 'small.rpc': 3 }, byMethod: { getLogs: { small: 2 } } }
  const { chainDocs, hostDocs } = buildDocs(stats, { ...meta, runType: 'cron', chains: ['small'], nested: { a: 1 } })
  expect(chainDocs).toHaveLength(1)
  expect(chainDocs[0]).toMatchObject({ chain: 'small', calls: 3, getLogs: 2, methods: { getLogs: 2 }, runType: 'cron' })
  expect(chainDocs[0]).not.toHaveProperty('chains')
  expect(chainDocs[0]).not.toHaveProperty('nested')
  expect(hostDocs).toHaveLength(1)
  expect(buildDocs(stats, meta, { minCalls: 50 })).toEqual({ chainDocs: [], hostDocs: [] })
  expect(buildDocs({ total: 0, unattributed: 0, byChain: {}, byHost: {}, byMethod: {} }, meta)).toEqual({ chainDocs: [], hostDocs: [] })
})

test("a chain seen only through a recorded method or fetched logs still gets a doc", () => {
  const stats = { total: 5, unattributed: 5, byChain: {}, byHost: { 'indexer.llama.fi': 5 }, byMethod: { indexer: { arbitrum: 5 } }, logs: { rpc: {}, indexer: { arbitrum: 900, optimism: 1 } } }
  const { chainDocs } = buildDocs(stats, meta)
  expect(chainDocs.map(d => [d.chain, d.calls, d.indexerCalls, d.logs])).toEqual([['_other', 5, 0, 0], ['arbitrum', 0, 5, 900], ['optimism', 0, 0, 1]])
})

test("getProvider registers the evm rpcs of a chain", () => {
  process.env.SKIP_RPC_CHECK = 'true'
  process.env.FOOCHAIN2_RPC = 'https://foo2.example/rpc,https://foo2-b.example'
  process.env.FOOCHAIN2_ARCHIVAL_RPC = 'https://foo2-archive.example/v1'
  getProvider('foochain2' as any)
  expect(resolveChain('https://foo2.example/rpc')).toBe('foochain2')
  expect(resolveChain('https://foo2-b.example/')).toBe('foochain2')
  expect(resolveChain('https://foo2-archive.example/v1/x')).toBe('foochain2')
  delete process.env.SKIP_RPC_CHECK
})

test("LlamaProvider getLogs attempts are counted per method and per chain", async () => {
  process.env.SKIP_RPC_CHECK = 'true'
  process.env.FOOCHAIN3_RPC = `${server.url}/foochain3`
  const provider = getProvider('foochain3' as any)
  const stats = await run(meta, async () => {
    const logs = await provider.getLogs({ address: '0x0000000000000000000000000000000000000001', fromBlock: 1, toBlock: 2 })
    expect(logs).toEqual([])
    await provider.call({ to: '0x0000000000000000000000000000000000000001', data: '0x' })
    return snapshot()
  }, opts)
  delete process.env.SKIP_RPC_CHECK
  expect(stats.byMethod.getLogs).toEqual({ foochain3: 1 })
  expect(stats.byMethod.call).toEqual({ foochain3: 1 })
  expect(stats.byChain.foochain3).toBe(2)
})

test("mergeSnapshots sums buckets", () => {
  const merged = mergeSnapshots([
    { total: 2, unattributed: 1, byChain: { a: 1 }, byHost: { h: 2 }, byMethod: { getLogs: { a: 1 } } },
    { total: 3, unattributed: 0, byChain: { a: 2, b: 1 }, byHost: { h: 1, g: 2 }, byMethod: { getLogs: { a: 2, b: 1 }, call: { b: 1 } }, logs: { rpc: { a: 4 }, indexer: {} } },
    { total: 0, unattributed: 0, byChain: {}, byHost: {}, byMethod: {}, logs: { rpc: { a: 1, b: 2 }, indexer: { b: 3 } } },
  ])
  expect(merged).toEqual({
    total: 5, unattributed: 1, byChain: { a: 3, b: 1 }, byHost: { h: 3, g: 2 }, byMethod: { getLogs: { a: 3, b: 1 }, call: { b: 1 } },
    logs: { rpc: { a: 5, b: 2 }, indexer: { b: 3 } },
  })
})
