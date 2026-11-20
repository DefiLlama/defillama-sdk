// redis is replaced by an in-memory fake, no test here talks to a real redis server
const store = new Map<string, { value: string, ttl: number }>()
const redisState = { failConnect: false, failCommands: false }
const createClient = jest.fn((_options: any) => {
  const client: any = {
    isReady: false,
    on: jest.fn(),
    ref: jest.fn(),
    unref: jest.fn(),
    destroy: jest.fn(() => { client.isReady = false }),
    connect: jest.fn(async () => {
      if (redisState.failConnect) throw new Error('ECONNREFUSED')
      client.isReady = true
    }),
    mGet: jest.fn(async (keys: string[]) => {
      if (redisState.failCommands) throw new Error('redis down')
      return keys.map(key => store.get(key)?.value ?? null)
    }),
    multi: jest.fn(() => {
      const queued: any[] = []
      const pipeline = {
        set: (key: string, value: string, options: any) => { queued.push({ key, value, ttl: options.EX }) },
        execAsPipeline: async () => {
          if (redisState.failCommands) throw new Error('redis down')
          queued.forEach(({ key, value, ttl }) => store.set(key, { value, ttl }))
        },
      }
      return pipeline
    }),
  }
  return client
})
jest.mock('@redis/client',() => ({ createClient }))

const makeMultiCall = jest.fn()
jest.mock('../abi/multicall3', () => ({
  __esModule: true,
  default: (...args: any[]) => makeMultiCall(...args),
  isMulticallV3Supported: () => true,
}))

import { call, multiCall } from '../abi'
import { setProvider } from '../general'
import {
  getRpcCallCacheRule, getRpcCallCacheKey, readRpcCallCache, writeRpcCallCache, closeRpcCallCache,
  isRpcCallCacheEnabled, RPC_CALL_CACHE_TTL, RPC_CALL_CACHE_FAILURE_CONFIRM_GAP, rpcCallCacheStats,
} from './rpcCallCache'

const ENV_KEY = 'RPC_CALL_CACHE_REDIS'
const EMPTY_KEY = 'RPC_CALL_CACHE_EMPTY'
const ADDRESS_KEY = 'RPC_CALL_CACHE_ADDRESS'
const ERROR_KEY = 'RPC_CALL_CACHE_ERROR'
const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'
const tokenA = '0x00000000000000000000000000000000000000aA'
const tokenB = '0x00000000000000000000000000000000000000bb'
const tokenC = '0x00000000000000000000000000000000000000cc'
const recent = { isRecent: true }
const old = { isRecent: false }
const stored = (value: any) => JSON.stringify({ v: value })

const fragment = (name: string, inputs: string[], outputs: string[]) => ({
  type: 'function', name, inputs: inputs.map(type => ({ type })), outputs: outputs.map(type => ({ type })),
})
const ruleOf = (name: string, inputs: string[], outputs: string[]) => getRpcCallCacheRule(fragment(name, inputs, outputs))

let now = 1_800_000_000_000
const advance = (seconds: number) => { now += seconds * 1000 }

beforeEach(async () => {
  await closeRpcCallCache()
  store.clear()
  redisState.failConnect = false
  redisState.failCommands = false
  createClient.mockClear()
  makeMultiCall.mockReset()
  process.env[ENV_KEY] = 'redis://cache.test:6379'
  process.env[EMPTY_KEY] = 'true'
  process.env[ADDRESS_KEY] = 'true'
  process.env[ERROR_KEY] = 'true'
  jest.spyOn(Date, 'now').mockImplementation(() => now)
})

afterEach(() => {
  jest.restoreAllMocks()
})

afterAll(async () => {
  await closeRpcCallCache()
  delete process.env[ENV_KEY]
  delete process.env[EMPTY_KEY]
  delete process.env[ADDRESS_KEY]
  delete process.env[ERROR_KEY]
})

describe('cache rules', () => {
  const { immutable, generic } = RPC_CALL_CACHE_TTL

  test.each([
    ['symbol', [], ['string'], immutable],
    ['name', [], ['string'], immutable],
    ['symbol', [], ['bytes32'], immutable],
    ['decimals', [], ['uint8'], immutable],
    ['decimals', [], ['uint256'], immutable],
    ['version', [], ['string'], immutable],
    ['token0', [], ['address'], immutable],
    ['asset', [], ['address'], immutable],
    ['getTokenX', [], ['address'], immutable],
    ['UNDERLYING_ASSET_ADDRESS', [], ['address'], immutable],
    ['getPoolId', [], ['bytes32'], immutable],
    ['allPairs', ['uint256'], ['address'], immutable],
    ['coins', ['int128'], ['address'], immutable],
    ['underlying_coins', ['uint256'], ['address'], immutable],
    ['getPair', ['address', 'address'], ['address'], immutable],
    ['getPool', ['address', 'address', 'uint24'], ['address'], immutable],
    ['owner', [], ['address'], generic],
    ['strategy', [], ['address'], generic],
  ])('%s(%j) -> %j is cached', (name, inputs, outputs, ttl) => {
    const rule = ruleOf(name as string, inputs as string[], outputs as string[])!
    expect(rule.ttl).toBe(ttl)
    expect(rule.blockIndependent).toBe(ttl === immutable)
  })

  test.each([
    ['totalSupply', [], ['uint256']],
    ['balanceOf', ['address'], ['uint256']],
    ['ownerOf', ['uint256'], ['address']],       // changes on every transfer
    ['strategies', ['uint256'], ['address']],    // list that is not append only
    ['getAllMarkets', [], ['address[]']],
    ['merkleRoot', [], ['bytes32']],
    ['fee', [], ['uint24']],
    ['paused', [], ['bool']],
    ['getReserves', [], ['uint112', 'uint112', 'uint32']],
    ['getPool', ['bytes32'], ['address']],
    ['token0', [], ['uint256']],
  ])('%s(%j) -> %j is not cached', (name, inputs, outputs) => {
    expect(ruleOf(name as string, inputs as string[], outputs as string[])).toBeUndefined()
  })

  test('rejects anything that is not a resolved function fragment', () => {
    expect(getRpcCallCacheRule('address:token0')).toBeUndefined()
    expect(getRpcCallCacheRule(undefined)).toBeUndefined()
    expect(getRpcCallCacheRule({ type: 'event', name: 'token0', inputs: [], outputs: [{ type: 'address' }] })).toBeUndefined()
  })

  test('key holds chain, lowercased target, signature and params', () => {
    const rule = ruleOf('allPairs', ['uint256'], ['address'])!
    expect(getRpcCallCacheKey('bsc', rule, { target: tokenA, params: [7] }))
      .toBe(`rpc-call:v1:bsc:${tokenA.toLowerCase()}:allPairs(uint256):address:7`)
    const noArgs = ruleOf('token0', [], ['address'])!
    expect(getRpcCallCacheKey('bsc', noArgs, { target: tokenA })).toBe(`rpc-call:v1:bsc:${tokenA.toLowerCase()}:token0():address`)
  })
})

describe('read and write', () => {
  const rule = ruleOf('token0', [], ['address'])!
  const owner = ruleOf('owner', [], ['address'])!

  test('disabled without the env variable: no redis client is created', async () => {
    delete process.env[ENV_KEY]
    expect(isRpcCallCacheEnabled()).toBe(false)
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: tokenB }], recent)
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([undefined])
    expect(createClient).not.toHaveBeenCalled()
    expect(store.size).toBe(0)
  })

  test('written values are read back, misses are undefined, ttl follows the rule', async () => {
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: tokenB }], recent)
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }, { target: tokenC }], recent)).resolves.toEqual([{ output: tokenB }, undefined])
    await expect(readRpcCallCache('bsc', rule, [{ target: tokenA }], recent)).resolves.toEqual([undefined])
    expect([...store.values()]).toEqual([{ value: stored(tokenB), ttl: RPC_CALL_CACHE_TTL.immutable }])
    expect(createClient).toHaveBeenCalledTimes(1)
    expect(createClient.mock.calls[0][0].url).toBe('redis://cache.test:6379')
  })

  test('a value that cannot change is written and read at any block', async () => {
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: tokenB }], old)
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], old)).resolves.toEqual([{ output: tokenB }])
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([{ output: tokenB }])
  })

  test('a value that can change is written and read by recent calls only', async () => {
    await writeRpcCallCache('ethereum', owner, [{ target: tokenA, output: tokenB }], old)
    expect(store.size).toBe(0)
    await writeRpcCallCache('ethereum', owner, [{ target: tokenA, output: tokenB }], recent)
    expect([...store.values()]).toEqual([{ value: stored(tokenB), ttl: RPC_CALL_CACHE_TTL.generic }])
    await expect(readRpcCallCache('ethereum', owner, [{ target: tokenA }], old)).resolves.toEqual([undefined])
    await expect(readRpcCallCache('ethereum', owner, [{ target: tokenA }], recent)).resolves.toEqual([{ output: tokenB }])
  })

  test('empty string and null address are kept for 12h, for recent calls only; null is never stored', async () => {
    const symbol = ruleOf('symbol', [], ['string'])!
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: null }, { target: tokenC, output: NULL_ADDRESS }], old)
    await writeRpcCallCache('ethereum', symbol, [{ target: tokenB, output: '' }], old)
    expect(store.size).toBe(0)

    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: null }, { target: tokenC, output: NULL_ADDRESS }], recent)
    await writeRpcCallCache('ethereum', symbol, [{ target: tokenB, output: '' }], recent)
    expect([...store.values()]).toEqual([
      { value: stored(NULL_ADDRESS), ttl: RPC_CALL_CACHE_TTL.empty },
      { value: stored(''), ttl: RPC_CALL_CACHE_TTL.empty },
    ])
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenC }], recent)).resolves.toEqual([{ output: NULL_ADDRESS }])
    await expect(readRpcCallCache('ethereum', symbol, [{ target: tokenB }], recent)).resolves.toEqual([{ output: '' }])
    // the pool may not have existed yet at an old block, and may exist now
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenC }], old)).resolves.toEqual([undefined])
  })

  test('falsy but valid values survive a round trip', async () => {
    const decimals = ruleOf('decimals', [], ['uint8'])!
    await writeRpcCallCache('ethereum', decimals, [{ target: tokenA, output: '0' }, { target: tokenB, output: 0 }], recent)
    await expect(readRpcCallCache('ethereum', decimals, [{ target: tokenA }, { target: tokenB }], recent)).resolves.toEqual([{ output: '0' }, { output: 0 }])
  })

  test('a failure is flagged the first time and cached for 24h when it is seen again on a later run', async () => {
    const failedAt = Math.floor(now / 1000)
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, failed: true }], recent)
    expect([...store.values()]).toEqual([{ value: JSON.stringify({ f: failedAt }), ttl: RPC_CALL_CACHE_TTL.failure }])
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([{ failedOnceAt: failedAt }])

    // seen again too soon (same run, same lagging node): still only a flag
    advance(RPC_CALL_CACHE_FAILURE_CONFIRM_GAP - 1)
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, failed: true, failedOnceAt: failedAt }], recent)
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([{ failedOnceAt: failedAt }])

    advance(1)
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, failed: true, failedOnceAt: failedAt }], recent)
    expect([...store.values()]).toEqual([{ value: JSON.stringify({ e: 1 }), ttl: RPC_CALL_CACHE_TTL.failure }])
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([{ failure: true }])
    // a failure now says nothing about an old block
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], old)).resolves.toEqual([undefined])
  })

  test('a success replaces the failure flag, and a failure at an old block is not recorded', async () => {
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, failed: true }], old)
    expect(store.size).toBe(0)
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, failed: true }], recent)
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: tokenB }], recent)
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([{ output: tokenB }])
  })

  test('a redis command failure is a cache miss, and redis is left alone for the cooldown', async () => {
    await writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: tokenB }], recent)
    const errorsBefore = rpcCallCacheStats.errors
    redisState.failCommands = true
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([undefined])
    expect(rpcCallCacheStats.errors).toBe(errorsBefore + 1)

    redisState.failCommands = false
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([undefined]) // still in cooldown
    await closeRpcCallCache() // resets the cooldown
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([{ output: tokenB }])
  })

  test('a failed connection is a cache miss and is not retried on every call', async () => {
    redisState.failConnect = true
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([undefined])
    await expect(writeRpcCallCache('ethereum', rule, [{ target: tokenA, output: tokenB }], recent)).resolves.toBeUndefined()
    await expect(readRpcCallCache('ethereum', rule, [{ target: tokenA }], recent)).resolves.toEqual([undefined])
    expect(createClient).toHaveBeenCalledTimes(1)
  })
})

describe('opt in classes', () => {
  const token0 = ruleOf('token0', [], ['address'])!
  const owner = ruleOf('owner', [], ['address'])!
  const symbol = ruleOf('symbol', [], ['string'])!

  const confirmedFailure = { failed: true as const, failedOnceAt: Math.floor(now / 1000) - RPC_CALL_CACHE_FAILURE_CONFIRM_GAP }

  test('without RPC_CALL_CACHE_EMPTY: empty results are neither written nor read, values and failures still are', async () => {
    delete process.env[EMPTY_KEY]
    await writeRpcCallCache('ethereum', token0, [{ target: tokenA, output: NULL_ADDRESS }, { target: tokenB, ...confirmedFailure }, { target: tokenC, output: tokenA }], recent)
    await writeRpcCallCache('ethereum', symbol, [{ target: tokenA, output: '' }], recent)
    expect([...store.values()]).toEqual([
      { value: JSON.stringify({ e: 1 }), ttl: RPC_CALL_CACHE_TTL.failure },
      { value: stored(tokenA), ttl: RPC_CALL_CACHE_TTL.immutable },
    ])

    // an empty entry written by a job that has the option on is ignored
    process.env[EMPTY_KEY] = 'true'
    await writeRpcCallCache('ethereum', token0, [{ target: tokenA, output: NULL_ADDRESS }], recent)
    await expect(readRpcCallCache('ethereum', token0, [{ target: tokenA }], recent)).resolves.toEqual([{ output: NULL_ADDRESS }])
    delete process.env[EMPTY_KEY]
    await expect(readRpcCallCache('ethereum', token0, [{ target: tokenA }, { target: tokenB }, { target: tokenC }], recent)).resolves.toEqual([undefined, { failure: true }, { output: tokenA }])
  })

  test('without RPC_CALL_CACHE_ERROR: failures are neither written nor read, values and empty results still are', async () => {
    delete process.env[ERROR_KEY]
    await writeRpcCallCache('ethereum', token0, [{ target: tokenA, output: NULL_ADDRESS }, { target: tokenB, failed: true }, { target: tokenB, ...confirmedFailure }, { target: tokenC, output: tokenA }], recent)
    expect([...store.values()]).toEqual([
      { value: stored(NULL_ADDRESS), ttl: RPC_CALL_CACHE_TTL.empty },
      { value: stored(tokenA), ttl: RPC_CALL_CACHE_TTL.immutable },
    ])

    // a flag or a failure written by a job that has the option on is ignored
    process.env[ERROR_KEY] = 'true'
    await writeRpcCallCache('ethereum', token0, [{ target: tokenB, failed: true }], recent)
    const [flag]: any = await readRpcCallCache('ethereum', token0, [{ target: tokenB }], recent)
    expect(typeof flag.failedOnceAt).toBe('number')
    delete process.env[ERROR_KEY]
    await expect(readRpcCallCache('ethereum', token0, [{ target: tokenB }], recent)).resolves.toEqual([undefined])
    process.env[ERROR_KEY] = 'true'
    await writeRpcCallCache('ethereum', token0, [{ target: tokenB, ...confirmedFailure }], recent)
    await expect(readRpcCallCache('ethereum', token0, [{ target: tokenB }], recent)).resolves.toEqual([{ failure: true }])
    delete process.env[ERROR_KEY]
    await expect(readRpcCallCache('ethereum', token0, [{ target: tokenA }, { target: tokenB }, { target: tokenC }], recent)).resolves.toEqual([{ output: NULL_ADDRESS }, undefined, { output: tokenA }])
  })

  test('without RPC_CALL_CACHE_ADDRESS: the 12h address class does not touch redis, fixed getters still do', async () => {
    delete process.env[ADDRESS_KEY]
    await writeRpcCallCache('ethereum', owner, [{ target: tokenA, output: tokenB }], recent)
    await expect(readRpcCallCache('ethereum', owner, [{ target: tokenA }], recent)).resolves.toEqual([undefined])
    expect(store.size).toBe(0)
    expect(createClient).not.toHaveBeenCalled()

    await writeRpcCallCache('ethereum', token0, [{ target: tokenA, output: tokenB }], recent)
    await expect(readRpcCallCache('ethereum', token0, [{ target: tokenA }], recent)).resolves.toEqual([{ output: tokenB }])
  })

  test('only the value "true" turns an option on', async () => {
    process.env[ADDRESS_KEY] = '1'
    process.env[EMPTY_KEY] = 'yes'
    process.env[ERROR_KEY] = 'TRUE'
    await writeRpcCallCache('ethereum', owner, [{ target: tokenA, output: tokenB }], recent)
    await writeRpcCallCache('ethereum', token0, [{ target: tokenA, failed: true }, { target: tokenB, output: NULL_ADDRESS }], recent)
    expect(store.size).toBe(0)
  })

  test('multiCall with the options off: the failed call and the 12h class go to the rpc on every run', async () => {
    delete process.env[EMPTY_KEY]
    delete process.env[ERROR_KEY]
    delete process.env[ADDRESS_KEY]
    const calls = [{ target: tokenA }, { target: tokenB }]
    makeMultiCall.mockImplementation(async (_abi: any, chunk: any[]) => chunk.map((call: any) => {
      const failed = call.contract === tokenB
      return { input: { target: call.contract, params: call.params }, success: !failed, output: failed ? null : 'AAA' }
    }))

    await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    expect(store.size).toBe(1)
    advance(RPC_CALL_CACHE_FAILURE_CONFIRM_GAP)
    await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    makeMultiCall.mockClear()
    const third = await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    expect(third.output.map((i: any) => i.output)).toEqual(['AAA', null])
    expect(makeMultiCall.mock.calls.flatMap(([, chunk]: any) => chunk.map((call: any) => call.contract))).toEqual([tokenB])
    await expect(multiCall({ abi: 'erc20:symbol', calls })).rejects.toThrow('Multicall failed!')

    makeMultiCall.mockClear()
    await multiCall({ abi: 'address:owner', calls: calls.slice(0, 1) })
    await multiCall({ abi: 'address:owner', calls: calls.slice(0, 1) })
    expect(makeMultiCall).toHaveBeenCalledTimes(2)
    expect(store.size).toBe(1)
  })
})

describe('multiCall goes through the cache', () => {
  const answers: { [target: string]: any } = {}
  const calls = [{ target: tokenA }, { target: tokenB }, { target: tokenC }]

  beforeEach(() => {
    answers[tokenA.toLowerCase()] = 'AAA'
    answers[tokenB.toLowerCase()] = 'BBB'
    answers[tokenC.toLowerCase()] = null // this call reverts
    makeMultiCall.mockImplementation(async (_abi: any, chunk: any[]) => chunk.map((call: any) => {
      const output = answers[call.contract.toLowerCase()]
      return { input: { target: call.contract, params: call.params }, success: output !== null, output }
    }))
  })

  const rpcTargets = () => makeMultiCall.mock.calls.flatMap(([, chunk]: any) => chunk.map((call: any) => call.contract))
  const outputs = (res: any) => res.output.map((i: any) => i.output)

  test('second run is served from redis, the failed call goes back to the rpc until it failed on two runs', async () => {
    const first = await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    expect(outputs(first)).toEqual(['AAA', 'BBB', null])
    expect(rpcTargets()).toEqual([tokenA, tokenB, tokenC])
    expect(store.size).toBe(3) // two values and the failure flag

    advance(RPC_CALL_CACHE_FAILURE_CONFIRM_GAP)
    makeMultiCall.mockClear()
    const second = await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    expect(second.output).toEqual([
      { input: { target: tokenA, params: [] }, success: true, output: 'AAA' },
      { input: { target: tokenB, params: [] }, success: true, output: 'BBB' },
      { input: { target: tokenC, params: [] }, success: false, output: null },
    ])
    expect(rpcTargets()).toEqual([tokenC]) // flagged once: still asked

    makeMultiCall.mockClear()
    const third = await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    expect(outputs(third)).toEqual(['AAA', 'BBB', null])
    expect(third.output[2].success).toBe(false)
    expect(makeMultiCall).not.toHaveBeenCalled() // failed twice: answered from the cache
  })

  test('a cached failure fails a multiCall without permitFailure, without an rpc call', async () => {
    await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    advance(RPC_CALL_CACHE_FAILURE_CONFIRM_GAP)
    await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })
    makeMultiCall.mockClear()

    await expect(multiCall({ abi: 'erc20:symbol', calls })).rejects.toThrow('Multicall failed!')
    expect(makeMultiCall).not.toHaveBeenCalled()
    await multiCall({ abi: 'erc20:symbol', calls, permitFailure: true, skipCache: true })
    expect(rpcTargets()).toEqual([tokenA, tokenB, tokenC]) // skipCache retries it
  })

  test('without permitFailure the results of the calls that succeeded still reach the cache', async () => {
    await expect(multiCall({ abi: 'erc20:symbol', calls })).rejects.toThrow('Multicall failed!')
    expect(store.size).toBe(3)
  })

  test('an rpc failure throws even with permitFailure and nothing is cached', async () => {
    makeMultiCall.mockRejectedValue(new Error('rpc is down'))
    await expect(multiCall({ abi: 'erc20:symbol', calls, permitFailure: true })).rejects.toThrow('rpc is down')
    expect(store.size).toBe(0)
  })

  test('all hits: the rpc is not called at all', async () => {
    await multiCall({ abi: 'string:symbol', calls: calls.slice(0, 2) })
    makeMultiCall.mockClear()
    const res = await multiCall({ abi: 'function symbol() view returns (string)', calls: calls.slice(0, 2) })
    expect(outputs(res)).toEqual(['AAA', 'BBB'])
    expect(makeMultiCall).not.toHaveBeenCalled()
  })

  test('values that cannot change are shared between calls with and without a block', async () => {
    await multiCall({ abi: 'erc20:symbol', calls: calls.slice(0, 2), block: 123 })
    expect(store.size).toBe(2)
    makeMultiCall.mockClear()
    expect(outputs(await multiCall({ abi: 'erc20:symbol', calls: calls.slice(0, 2) }))).toEqual(['AAA', 'BBB'])
    expect(outputs(await multiCall({ abi: 'erc20:symbol', calls: calls.slice(0, 2), block: 456 }))).toEqual(['AAA', 'BBB'])
    expect(makeMultiCall).not.toHaveBeenCalled()
  })

  test('a failure at an old block is not recorded', async () => {
    await multiCall({ abi: 'erc20:symbol', calls, block: 123, permitFailure: true })
    expect(store.size).toBe(2)
  })

  test('values that can change: an old block bypasses redis, a block with a recent timestamp does not', async () => {
    await multiCall({ abi: 'address:owner', calls: calls.slice(0, 2), block: 123 })
    await multiCall({ abi: 'address:owner', calls: calls.slice(0, 2), block: 123, timestamp: now / 1000 - 3 * 60 * 60 })
    expect(store.size).toBe(0)
    expect(createClient).not.toHaveBeenCalled()

    await multiCall({ abi: 'address:owner', calls: calls.slice(0, 2), block: 123, timestamp: now / 1000 - 60 })
    expect(store.size).toBe(2)
    makeMultiCall.mockClear()
    await multiCall({ abi: 'address:owner', calls: calls.slice(0, 2) })
    expect(makeMultiCall).not.toHaveBeenCalled()
  })

  test('uncacheable abis and skipCache bypass redis', async () => {
    await multiCall({ abi: 'uint256:totalSupply', calls: calls.slice(0, 2) })
    await multiCall({ abi: 'erc20:symbol', calls: calls.slice(0, 2), skipCache: true })
    expect(store.size).toBe(0)
    expect(createClient).not.toHaveBeenCalled()
    expect(makeMultiCall).toHaveBeenCalledTimes(2)
  })

  test('env variable not set: every call goes to the rpc', async () => {
    delete process.env[ENV_KEY]
    await multiCall({ abi: 'erc20:symbol', calls: calls.slice(0, 2) })
    await multiCall({ abi: 'erc20:symbol', calls: calls.slice(0, 2) })
    expect(makeMultiCall).toHaveBeenCalledTimes(2)
    expect(createClient).not.toHaveBeenCalled()
  })

  test('redis down: results still come from the rpc', async () => {
    redisState.failCommands = true
    const res = await multiCall({ abi: 'erc20:symbol', calls: calls.slice(0, 2) })
    expect(outputs(res)).toEqual(['AAA', 'BBB'])
  })
})

describe('call goes through the cache', () => {
  const chain = 'rpc_call_cache_test_chain'
  const providerCall = jest.fn()
  const revert = { llamaRPCError: true, method: 'call', errors: [{ host: 'a', error: 'execution reverted', jsonRpcError: true }] }
  const rpcDown = { llamaRPCError: true, method: 'call', errors: [{ host: 'a', error: 'timeout of 30000ms exceeded', jsonRpcError: false }] }
  const encodedAddress = '0x' + tokenB.slice(2).padStart(64, '0')

  beforeEach(() => {
    providerCall.mockReset()
    setProvider(chain, { call: providerCall } as any)
  })

  test('a value is fetched once', async () => {
    providerCall.mockResolvedValue(encodedAddress)
    const first = await call({ chain, target: tokenA, abi: 'address:token0' })
    const second = await call({ chain, target: tokenA, abi: 'address:token0', block: 5 })
    expect(first.output.toLowerCase()).toBe(tokenB)
    expect(second.output).toBe(first.output)
    expect(providerCall).toHaveBeenCalledTimes(1)
  })

  test('a revert is flagged, then cached: the third call throws without an rpc call', async () => {
    providerCall.mockRejectedValue(revert)
    await expect(call({ chain, target: tokenA, abi: 'address:token0' })).rejects.toMatchObject({ isContractFailure: true, isRpcFailure: false })
    advance(RPC_CALL_CACHE_FAILURE_CONFIRM_GAP)
    await expect(call({ chain, target: tokenA, abi: 'address:token0' })).rejects.toMatchObject({ isContractFailure: true })
    expect(providerCall).toHaveBeenCalledTimes(2)
    expect([...store.values()]).toEqual([{ value: JSON.stringify({ e: 1 }), ttl: RPC_CALL_CACHE_TTL.failure }])

    await expect(call({ chain, target: tokenA, abi: 'address:token0' })).rejects.toMatchObject({ isContractFailure: true })
    expect(providerCall).toHaveBeenCalledTimes(2)
  })

  test('a result that cannot be decoded is a contract failure', async () => {
    providerCall.mockResolvedValue('0x')
    await expect(call({ chain, target: tokenA, abi: 'address:token0' })).rejects.toMatchObject({ isContractFailure: true, isRpcFailure: false })
    expect(store.size).toBe(1)
  })

  test('an rpc failure is not a contract failure and is never cached', async () => {
    providerCall.mockRejectedValue(rpcDown)
    await expect(call({ chain, target: tokenA, abi: 'address:token0' })).rejects.toMatchObject({ isContractFailure: false, isRpcFailure: true })
    advance(RPC_CALL_CACHE_FAILURE_CONFIRM_GAP)
    await expect(call({ chain, target: tokenA, abi: 'address:token0' })).rejects.toMatchObject({ isRpcFailure: true })
    expect(store.size).toBe(0)
    expect(providerCall).toHaveBeenCalledTimes(2)
  })
})
