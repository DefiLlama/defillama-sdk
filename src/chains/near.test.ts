import * as near from "./near";
import { encodeArgs, decodeResult, isNearAccountId, isImplicitAccountId, yoctoToNear, shouldRetry, NearRpcError, DEFAULT_ENDPOINTS } from "./near";

describe('chains.near offline', () => {
  afterEach(() => {
    delete process.env.NEAR_RPC
    delete process.env.SDK_NEAR_RPC
  })

  test('encodeArgs / decodeResult round trip', () => {
    const args = { account_id: 'wrap.near', nested: { a: [1, 2, 3] } }
    const b64 = encodeArgs(args)
    expect(b64).toBe(Buffer.from(JSON.stringify(args)).toString('base64'))
    const bytes = Array.from(Buffer.from(b64, 'base64'))
    expect(decodeResult(bytes)).toEqual(args)
  })

  test('encodeArgs defaults and passthrough', () => {
    expect(encodeArgs()).toBe(Buffer.from('{}').toString('base64'))
    expect(encodeArgs(null)).toBe(Buffer.from('{}').toString('base64'))
    expect(encodeArgs('')).toBe('')
    expect(encodeArgs('e30=')).toBe('e30=')
    expect(encodeArgs(Buffer.from('{}'))).toBe('e30=')
  })

  test('decodeResult handles strings, numbers and empty payloads', () => {
    expect(decodeResult(Array.from(Buffer.from('"123"')))).toBe('123')
    expect(decodeResult(Array.from(Buffer.from('42')))).toBe(42)
    expect(decodeResult(Array.from(Buffer.from('not json')))).toBe('not json')
    expect(decodeResult([])).toBe('')
    expect(decodeResult(undefined)).toBe('')
  })

  test('isNearAccountId', () => {
    expect(isNearAccountId('wrap.near')).toBe(true)
    expect(isNearAccountId('usdt.tether-token.near')).toBe(true)
    expect(isNearAccountId('token.v2.ref-finance.near')).toBe(true)
    expect(isNearAccountId('aurora')).toBe(true)
    expect(isNearAccountId('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')).toBe(true)
    expect(isImplicitAccountId('17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1')).toBe(true)
    expect(isImplicitAccountId('wrap.near')).toBe(false)
    expect(isNearAccountId('Bad!')).toBe(false)
    expect(isNearAccountId('a')).toBe(false)
    expect(isNearAccountId('.near')).toBe(false)
    expect(isNearAccountId('a..near')).toBe(false)
    expect(isNearAccountId('a'.repeat(65))).toBe(false)
    expect(isNearAccountId(undefined)).toBe(false)
  })

  test('yoctoToNear', () => {
    expect(yoctoToNear('1000000000000000000000000')).toBe(1)
    expect(yoctoToNear('1500000000000000000000000')).toBe(1.5)
    expect(yoctoToNear('0')).toBe(0)
  })

  test('endpoints default to DEFAULT_ENDPOINTS', () => {
    expect(near.getEndpoints()).toEqual(DEFAULT_ENDPOINTS)
    expect(DEFAULT_ENDPOINTS[0]).toBe('https://free.rpc.fastnear.com')
  })

  test('NEAR_RPC env override (comma separated)', () => {
    process.env.NEAR_RPC = 'https://one.example, https://two.example ,'
    expect(near.getEndpoints()).toEqual(['https://one.example', 'https://two.example'])
    delete process.env.NEAR_RPC
    expect(near.getEndpoints()).toEqual(DEFAULT_ENDPOINTS)
  })

  test('shouldRetry classifies errors', () => {
    expect(shouldRetry(new Error('ECONNRESET'))).toBe(true)
    expect(shouldRetry({ response: { status: 429 } })).toBe(true)
    expect(shouldRetry({ response: { status: 503 } })).toBe(true)
    expect(shouldRetry({ response: { status: 410 } })).toBe(true)
    expect(shouldRetry(new NearRpcError('query', { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_BLOCK' }, code: -32000, message: 'Server error' }))).toBe(true)
    expect(shouldRetry(new NearRpcError('query', { name: 'HANDLER_ERROR', cause: { name: 'UNKNOWN_ACCOUNT' }, code: -32000, message: 'Server error' }))).toBe(false)
    expect(shouldRetry(new NearRpcError('query', { name: 'HANDLER_ERROR', cause: { name: 'CONTRACT_EXECUTION_ERROR' }, code: -32000, message: 'Server error' }))).toBe(false)
    expect(shouldRetry(new NearRpcError('query', { code: -32000, message: 'Server error', data: 'account x does not exist while viewing' }))).toBe(false)
  })

  test('NearRpcError message carries the node error details', () => {
    const e = new NearRpcError('query', { name: 'HANDLER_ERROR', cause: { name: 'CONTRACT_EXECUTION_ERROR', info: { vm_error: 'MethodNotFound' } }, code: -32000, message: 'Server error', data: 'wasm execution failed with error: MethodResolveError(MethodNotFound)' })
    expect(e).toBeInstanceOf(Error)
    expect(e.cause).toBe('CONTRACT_EXECUTION_ERROR')
    expect(e.code).toBe(-32000)
    expect(e.message).toMatch(/MethodNotFound/)
    expect(e.message).toMatch(/CONTRACT_EXECUTION_ERROR/)
  })
})

describe('chains.near live', () => {
  jest.setTimeout(60_000)

  test('getTokenMetadata wrap.near', async () => {
    const meta = await near.getTokenMetadata({ token: 'wrap.near' })
    expect(meta.decimals).toBe(24)
    expect(meta.symbol).toMatch(/near/i)
  })

  test('getTokenMetadata usdt.tether-token.near', async () => {
    const meta = await near.getTokenMetadata({ token: 'usdt.tether-token.near' })
    expect(meta.decimals).toBe(6)
  })

  test('getTokenTotalSupply wrap.near', async () => {
    const supply = await near.getTokenTotalSupply({ token: 'wrap.near' })
    expect(supply).toMatch(/^\d+$/)
    expect(BigInt(supply) > BigInt(0)).toBe(true)
  })

  test('viewAccount / getBalance wrap.near', async () => {
    const account = await near.viewAccount({ account: 'wrap.near' })
    expect(account.amount).toMatch(/^\d+$/)
    expect(typeof account.storage_usage).toBe('number')
    const balance = await near.getBalance({ account: 'wrap.near' })
    expect(balance).toMatch(/^\d+$/)
  })

  test('getTokenBalance returns a raw string', async () => {
    const balance = await near.getTokenBalance({ token: 'wrap.near', account: 'wrap.near' })
    expect(balance).toMatch(/^\d+$/)
  })

  test('getLatestBlock / getBlock by height', async () => {
    const latest = await near.getLatestBlock()
    expect(latest.number).toBeGreaterThan(0)
    expect(latest.timestamp).toBeGreaterThan(1_600_000_000)
    expect(latest.timestamp).toBeLessThan(Date.now() / 1000 + 60)
    expect(typeof latest.hash).toBe('string')
    const same = await near.getBlock({ blockId: latest.number })
    expect(same.hash).toBe(latest.hash)
    const byHash = await near.getBlock({ blockId: latest.hash })
    expect(byHash.number).toBe(latest.number)
  })

  test('getBlockAtTimestamp finds the block before a recent timestamp', async () => {
    const target = Math.floor(Date.now() / 1000) - 600
    const block = await near.getBlockAtTimestamp({ timestamp: target })
    expect(block.timestamp).toBeLessThanOrEqual(target)
    expect(target - block.timestamp).toBeLessThan(30)
  })

  test('call with a bogus method rejects with the node message', async () => {
    await expect(near.call({ contract: 'wrap.near', method: 'this_method_does_not_exist' }))
      .rejects.toThrow(/MethodNotFound|MethodResolveError|CONTRACT_EXECUTION_ERROR/i)
  })

  test('getAccessKeys returns a list', async () => {
    const keys = await near.getAccessKeys({ account: 'wrap.near' })
    expect(Array.isArray(keys)).toBe(true)
  })
})
