import axios from 'axios'
import { getProvider } from './LlamaProvider'

jest.mock('axios', () => ({ post: jest.fn() }))

const post = axios.post as jest.Mock

const GOOD = 'https://good.example'
const BAD = 'https://bad.example'
const TARGET = '0x0000000000000000000000000000000000000001'
const RESULT = '0x0000000000000000000000000000000000000000000000000000000000000020'

// responses keyed by rpc url; a function so each test can shape the bad node differently
let badResponse: () => any

beforeAll(() => {
  process.env.SKIP_RPC_CHECK = 'true' // the health check would also hit axios, keep the test to the request path
  process.env.RPC_NO_PLAYING_AROUND = 'true' // keep the first rpc first, so the bad node is always tried before the good one
  process.env.TESTBADRPC_RPC = `${BAD},${GOOD}`
})

beforeEach(() => {
  jest.clearAllMocks()
  post.mockImplementation(async (url: string) => {
    if (url === GOOD) return { data: { jsonrpc: '2.0', id: 1, result: RESULT } }
    return badResponse()
  })
})

const provider = () => getProvider('testbadrpc' as any) as any

test.each([
  { name: 'HTML page with HTTP 200', data: '<!DOCTYPE html><html><body>EOSIO Block Producer</body></html>' },
  { name: 'empty body', data: '' },
  { name: 'JSON without result', data: { jsonrpc: '2.0', id: 1 } },
  { name: 'null result', data: { jsonrpc: '2.0', id: 1, result: null } },
])('eth_call moves on to the next rpc when a node answers with $name', async ({ data }) => {
  badResponse = () => ({ data })
  const out = await provider().call({ to: TARGET, data: '0x' })
  expect(out).toBe(RESULT)
  expect(post).toHaveBeenCalledTimes(2)
  expect(post.mock.calls[0][0]).toBe(BAD)
  expect(post.mock.calls[1][0]).toBe(GOOD)
})

test('eth_call still surfaces a JSON-RPC error instead of returning undefined', async () => {
  badResponse = () => ({ data: { jsonrpc: '2.0', id: 1, error: { code: -32000, message: 'execution reverted' } } })
  post.mockImplementation(async () => badResponse())
  await expect(provider().call({ to: TARGET, data: '0x' })).rejects.toMatchObject({ llamaRPCError: true })
})

test('health check drops a node whose eth_blockNumber answers with HTML', async () => {
  process.env.SKIP_RPC_CHECK = ''
  process.env.TESTBADRPC2_RPC = `${BAD},${GOOD}`
  post.mockImplementation(async (url: string, body: any) => {
    if (url === GOOD) return { data: { jsonrpc: '2.0', id: 1, result: body.method === 'eth_blockNumber' ? '0x100' : RESULT } }
    return { data: '<!DOCTYPE html><html></html>' }
  })
  const p = getProvider('testbadrpc2' as any) as any
  await p._isReady
  process.env.SKIP_RPC_CHECK = 'true'
  expect(p.rpcs.map((i: any) => i.url)).toEqual([GOOD])
})
