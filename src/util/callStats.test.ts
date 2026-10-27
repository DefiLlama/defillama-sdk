import * as http from "http"
import axios from "axios"
import { run, registerEndpoints, resolveChain, snapshot, buildDocs, mergeSnapshots, getCurrent } from "./callStats"
import { getProvider } from "./LlamaProvider"

function startServer(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }))
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
})

test("concurrent runs keep separate counters and calls outside a run go to the global bucket", async () => {
  const before = getCurrent().total
  const [a, b] = await Promise.all([
    run({ ...meta, name: 'a' }, async () => {
      await axios.get(`${server.url}/a`)
      await axios.get(`${server.url}/a`)
      return snapshot()
    }, opts),
    run({ ...meta, name: 'b' }, async () => {
      await axios.get(`${server.url}/b`)
      return snapshot()
    }, opts),
  ])
  expect(a.total).toBe(2)
  expect(b.total).toBe(1)
  await axios.get(`${server.url}/outside`)
  expect(getCurrent().total).toBe(before + 1)
})

test("run reports on failure too and rethrows", async () => {
  await expect(run(meta, async () => { throw new Error('boom') }, opts)).rejects.toThrow('boom')
})

test("buildDocs drops buckets under minCalls and writes nothing for small runs", () => {
  registerEndpoints('bigchain', 'https://big.rpc')
  const stats = { total: 130, unattributed: 40, byChain: { bigchain: 90, small: 0 }, byHost: { 'big.rpc': 90, 'api.other.com': 30, 'api.heavy.com': 10 } }
  const docs = buildDocs(stats, meta, { success: true, runtime: 3, minCalls: 50 })
  expect(docs.map(d => d.type)).toEqual(['run', 'chain'])
  expect(docs[0]).toMatchObject({ calls: 130, rpcCalls: 90, otherCalls: 40, chains: [{ chain: 'bigchain', calls: 90 }], hosts: [{ host: 'big.rpc', calls: 90 }], success: true, runtime: 3 })
  expect(docs[1]).toMatchObject({ chain: 'bigchain', calls: 90, metadata: meta })
  expect(buildDocs({ ...stats, total: 49 }, meta, { minCalls: 50 })).toEqual([])
  const withHost = buildDocs({ ...stats, byHost: { ...stats.byHost, 'api.other.com': 60 } }, meta, { minCalls: 50 })
  expect(withHost.map(d => d.type)).toEqual(['run', 'chain', 'host'])
  expect(withHost[2]).toMatchObject({ host: 'api.other.com', calls: 60 })
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

test("mergeSnapshots sums buckets", () => {
  const merged = mergeSnapshots([
    { total: 2, unattributed: 1, byChain: { a: 1 }, byHost: { h: 2 } },
    { total: 3, unattributed: 0, byChain: { a: 2, b: 1 }, byHost: { h: 1, g: 2 } },
  ])
  expect(merged).toEqual({ total: 5, unattributed: 1, byChain: { a: 3, b: 1 }, byHost: { h: 3, g: 2 } })
})
