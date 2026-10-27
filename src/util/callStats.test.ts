import * as http from "http"
import axios from "axios"
import { run, registerEndpoints, resolveChain, snapshot, buildDocs, mergeSnapshots, getCurrent, recordMethod } from "./callStats"
import { getProvider } from "./LlamaProvider"

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

test("buildDocs drops buckets under minCalls and writes nothing for small runs", () => {
  registerEndpoints('bigchain', 'https://big.rpc')
  const stats = { total: 130, unattributed: 40, byChain: { bigchain: 90, small: 0 }, byHost: { 'big.rpc': 90, 'api.other.com': 30, 'api.heavy.com': 10 }, byMethod: { call: { bigchain: 80 }, getLogs: { bigchain: 10 } } }
  const docs = buildDocs(stats, meta, { success: true, runtime: 3, minCalls: 50 })
  expect(docs.map(d => d.type)).toEqual(['run', 'chain'])
  expect(docs[0]).toMatchObject({
    calls: 130, rpcCalls: 90, otherCalls: 40, getLogsCalls: 10, methods: { call: 80, getLogs: 10 },
    chains: [{ chain: 'bigchain', calls: 90, getLogs: 10 }], hosts: [{ host: 'big.rpc', calls: 90 }], success: true, runtime: 3,
  })
  expect(docs[1]).toMatchObject({ chain: 'bigchain', calls: 90, getLogs: 10, methods: { call: 80, getLogs: 10 }, metadata: meta })
  expect(buildDocs({ ...stats, total: 49, byMethod: {} }, meta, { minCalls: 50 })).toEqual([])
  const withHost = buildDocs({ ...stats, byHost: { ...stats.byHost, 'api.other.com': 60 } }, meta, { minCalls: 50 })
  expect(withHost.map(d => d.type)).toEqual(['run', 'chain', 'host'])
  expect(withHost[2]).toMatchObject({ host: 'api.other.com', calls: 60 })
})

test("a chain with few calls but many getLogs requests is kept, and a tiny run with getLogs is still written", () => {
  const stats = { total: 12, unattributed: 0, byChain: { small: 12 }, byHost: { 'small.rpc': 12 }, byMethod: { getLogs: { small: 12 } } }
  const docs = buildDocs(stats, meta, { minCalls: 50 })
  expect(docs.map(d => d.type)).toEqual(['run', 'chain'])
  expect(docs[1]).toMatchObject({ chain: 'small', calls: 12, getLogs: 12 })
  expect(buildDocs({ ...stats, byMethod: { getLogs: { small: 9 } } }, meta, { minCalls: 50 })).toEqual([])
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
    { total: 3, unattributed: 0, byChain: { a: 2, b: 1 }, byHost: { h: 1, g: 2 }, byMethod: { getLogs: { a: 2, b: 1 }, call: { b: 1 } } },
  ])
  expect(merged).toEqual({ total: 5, unattributed: 1, byChain: { a: 3, b: 1 }, byHost: { h: 3, g: 2 }, byMethod: { getLogs: { a: 3, b: 1 }, call: { b: 1 } } })
})
