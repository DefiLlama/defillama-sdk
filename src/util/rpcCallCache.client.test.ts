// Runs the cache through the real `redis` client against a minimal in-process redis stand-in (loopback only),
// to check the client options and commands used by rpcCallCache are valid for the installed client version.
import net from 'net'
import { getRpcCallCacheRule, readRpcCallCache, writeRpcCallCache, closeRpcCallCache, RPC_CALL_CACHE_TTL, RPC_CALL_CACHE_FAILURE_CONFIRM_GAP, rpcCallCacheStats } from './rpcCallCache'

const ENV_KEY = 'RPC_CALL_CACHE_REDIS'
const recent = { isRecent: true }
const store = new Map<string, { value: string, ttl?: number }>()
const commandsSeen: string[] = []
const sockets = new Set<net.Socket>()
let server: net.Server
let port: number

// parses complete commands (arrays of bulk strings) out of the buffer, returns the unparsed rest
function parseCommands(buffer: Buffer): { commands: string[][], rest: Buffer } {
  const commands: string[][] = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer[offset] !== 42 /* * */) throw new Error('unexpected redis protocol byte')
    let lineEnd = buffer.indexOf('\r\n', offset)
    if (lineEnd === -1) return { commands, rest: buffer.subarray(start) }
    const count = +buffer.subarray(offset + 1, lineEnd).toString()
    offset = lineEnd + 2
    const args: string[] = []
    for (let i = 0; i < count; i++) {
      lineEnd = buffer.indexOf('\r\n', offset)
      if (lineEnd === -1) return { commands, rest: buffer.subarray(start) }
      const length = +buffer.subarray(offset + 1, lineEnd).toString()
      const valueStart = lineEnd + 2
      if (buffer.length < valueStart + length + 2) return { commands, rest: buffer.subarray(start) }
      args.push(buffer.subarray(valueStart, valueStart + length).toString())
      offset = valueStart + length + 2
    }
    commands.push(args)
  }
  return { commands, rest: Buffer.alloc(0) }
}

const bulk = (value: string) => `$${Buffer.byteLength(value)}\r\n${value}\r\n`

function reply(args: string[], state: { proto: number }): string {
  const command = args[0].toUpperCase()
  commandsSeen.push(command)
  const nil = state.proto === 3 ? '_\r\n' : '$-1\r\n'
  switch (command) {
    case 'HELLO':
      state.proto = +args[1] || 2
      if (state.proto === 3) return `%2\r\n${bulk('server')}${bulk('redis')}${bulk('proto')}:3\r\n`
      return `*4\r\n${bulk('server')}${bulk('redis')}${bulk('proto')}:2\r\n`
    case 'MGET':
      return `*${args.length - 1}\r\n` + args.slice(1).map(key => store.has(key) ? bulk(store.get(key)!.value) : nil).join('')
    case 'SET': {
      const exIndex = args.findIndex((arg, i) => i > 2 && arg.toUpperCase() === 'EX')
      store.set(args[1], { value: args[2], ttl: exIndex === -1 ? undefined : +args[exIndex + 1] })
      return '+OK\r\n'
    }
    default:
      return '+OK\r\n' // CLIENT SETINFO etc.
  }
}

beforeAll(async () => {
  server = net.createServer(socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
    socket.on('error', () => { })
    const state = { proto: 2 }
    let pending: Buffer = Buffer.alloc(0)
    socket.on('data', data => {
      const { commands, rest } = parseCommands(Buffer.concat([pending, data]))
      pending = rest
      if (commands.length) socket.write(commands.map(args => reply(args, state)).join(''))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  port = (server.address() as net.AddressInfo).port
})

beforeEach(async () => {
  await closeRpcCallCache()
  store.clear()
  commandsSeen.length = 0
  process.env[ENV_KEY] = `redis://127.0.0.1:${port}`
})

afterAll(async () => {
  await closeRpcCallCache()
  delete process.env[ENV_KEY]
  sockets.forEach(socket => socket.destroy())
  await new Promise(resolve => server.close(resolve))
})

const fragment = (name: string, inputs: string[], output: string) => ({
  type: 'function', name, inputs: inputs.map(type => ({ type })), outputs: [{ type: output }],
})

test('real redis client: values are written with their ttl and read back in order', async () => {
  const symbol = getRpcCallCacheRule(fragment('symbol', [], 'string'))!
  const allPairs = getRpcCallCacheRule(fragment('allPairs', ['uint256'], 'address'))!
  const token = '0x00000000000000000000000000000000000000aa'
  const pair = '0x00000000000000000000000000000000000000bb'

  await writeRpcCallCache('ethereum', symbol, [{ target: token, output: 'Tést "quoted" symbol' }], recent)
  await writeRpcCallCache('ethereum', allPairs, [{ target: token, params: [3], output: pair }], recent)

  await expect(readRpcCallCache('ethereum', symbol, [{ target: pair }, { target: token }], recent)).resolves.toEqual([undefined, { output: 'Tést "quoted" symbol' }])
  await expect(readRpcCallCache('ethereum', allPairs, [{ target: token, params: [3] }, { target: token, params: [4] }], recent)).resolves.toEqual([{ output: pair }, undefined])

  expect([...store.entries()]).toEqual([
    [`rpc-call:v1:ethereum:${token}:symbol():string`, { value: JSON.stringify({ v: 'Tést "quoted" symbol' }), ttl: RPC_CALL_CACHE_TTL.immutable }],
    [`rpc-call:v1:ethereum:${token}:allPairs(uint256):address:3`, { value: JSON.stringify({ v: pair }), ttl: RPC_CALL_CACHE_TTL.immutable }],
  ])
  expect(commandsSeen.filter(i => i === 'MGET').length).toBe(2)
  expect(commandsSeen).not.toContain('MULTI') // writes are a plain pipeline, not a transaction
})

test('real redis client: a failure is flagged, then cached with the failure ttl', async () => {
  const token0 = getRpcCallCacheRule(fragment('token0', [], 'address'))!
  const token = '0x00000000000000000000000000000000000000aa'
  const key = `rpc-call:v1:ethereum:${token}:token0():address`
  process.env.RPC_CALL_CACHE_ERROR = 'true'

  await writeRpcCallCache('ethereum', token0, [{ target: token, failed: true }], recent)
  const [flag]: any = await readRpcCallCache('ethereum', token0, [{ target: token }], recent)
  expect(typeof flag.failedOnceAt).toBe('number')
  expect(store.get(key)!.ttl).toBe(RPC_CALL_CACHE_TTL.failure)

  await writeRpcCallCache('ethereum', token0, [{ target: token, failed: true, failedOnceAt: flag.failedOnceAt - RPC_CALL_CACHE_FAILURE_CONFIRM_GAP }], recent)
  await expect(readRpcCallCache('ethereum', token0, [{ target: token }], recent)).resolves.toEqual([{ failure: true }])
  expect(store.get(key)).toEqual({ value: JSON.stringify({ e: 1 }), ttl: RPC_CALL_CACHE_TTL.failure })
  delete process.env.RPC_CALL_CACHE_ERROR
})

test('real redis client: more entries than one chunk', async () => {
  const decimals = getRpcCallCacheRule(fragment('decimals', [], 'uint8'))!
  const targets = Array.from({ length: 2500 }, (_, i) => '0x' + (i + 1).toString(16).padStart(40, '0'))

  await writeRpcCallCache('bsc', decimals, targets.map((target, i) => ({ target, output: String(i % 19) })), recent)
  const values = await readRpcCallCache('bsc', decimals, targets.map(target => ({ target })), recent)

  expect(values).toEqual(targets.map((_, i) => ({ output: String(i % 19) })))
  expect(commandsSeen.filter(i => i === 'MGET').length).toBe(3)
})

test('real redis client: unreachable redis is a cache miss, not an error', async () => {
  const symbol = getRpcCallCacheRule(fragment('symbol', [], 'string'))!
  process.env[ENV_KEY] = 'redis://127.0.0.1:1' // nothing listens here
  const errorsBefore = rpcCallCacheStats.errors

  await expect(readRpcCallCache('ethereum', symbol, [{ target: '0x00000000000000000000000000000000000000aa' }], recent)).resolves.toEqual([undefined])
  await expect(writeRpcCallCache('ethereum', symbol, [{ target: '0x00000000000000000000000000000000000000aa', output: 'A' }], recent)).resolves.toBeUndefined()
  expect(rpcCallCacheStats.errors).toBe(errorsBefore + 1) // the write happens during the cooldown and does not reconnect
})

test('real redis client: a dropped connection is replaced on the next call', async () => {
  const symbol = getRpcCallCacheRule(fragment('symbol', [], 'string'))!
  const token = '0x00000000000000000000000000000000000000aa'
  await writeRpcCallCache('ethereum', symbol, [{ target: token, output: 'AAA' }], recent)

  sockets.forEach(socket => socket.destroy())
  await new Promise(resolve => setTimeout(resolve, 200))

  await expect(readRpcCallCache('ethereum', symbol, [{ target: token }], recent)).resolves.toEqual([{ output: 'AAA' }])
})
