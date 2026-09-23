import { getEndpoints, toEndpointList, joinUrl, withRetry, jsonRpc, jsonRpcBatch, sliceIntoChunks, runInChunks, isRateLimitError, JsonRpcError, httpGet } from "./rpc";

describe('chains.rpc endpoints', () => {
  afterEach(() => {
    delete process.env.FOOCHAIN_RPC
    delete process.env.SDK_FOOCHAIN_RPC
    delete process.env.MY_CUSTOM_ENDPOINT
  })

  test('toEndpointList splits comma separated values and trims', () => {
    expect(toEndpointList(' https://a.io, https://b.io ,')).toEqual(['https://a.io', 'https://b.io'])
    expect(toEndpointList(['https://a.io'])).toEqual(['https://a.io'])
    expect(toEndpointList(undefined)).toEqual([])
  })

  test('env override wins over defaults', () => {
    process.env.FOOCHAIN_RPC = 'https://env.io,https://env2.io'
    expect(getEndpoints('foochain', 'https://default.io')).toEqual(['https://env.io', 'https://env2.io'])
  })

  test('SDK_ prefixed env override wins too', () => {
    process.env.SDK_FOOCHAIN_RPC = 'https://sdk-env.io'
    expect(getEndpoints('foochain', 'https://default.io')).toEqual(['https://sdk-env.io'])
  })

  test('defaults are used when no env is set', () => {
    expect(getEndpoints('foochain', ['https://default.io'])).toEqual(['https://default.io'])
  })

  test('custom envKey is honoured', () => {
    process.env.MY_CUSTOM_ENDPOINT = 'https://custom.io'
    expect(getEndpoints('foochain', 'https://default.io', { envKey: 'MY_CUSTOM_ENDPOINT' })).toEqual(['https://custom.io'])
  })

  test('fallback used when neither env nor defaults exist', () => {
    expect(getEndpoints('foochain', undefined, { fallback: 'https://fallback.io' })).toEqual(['https://fallback.io'])
  })

  test('throws when nothing is configured', () => {
    expect(() => getEndpoints('foochain')).toThrow(/No RPC endpoint configured/)
  })

  test('joinUrl normalises slashes', () => {
    expect(joinUrl('https://a.io/', '/v1/x')).toBe('https://a.io/v1/x')
    expect(joinUrl('https://a.io', 'v1/x')).toBe('https://a.io/v1/x')
    expect(joinUrl('https://a.io', '')).toBe('https://a.io')
  })
})

describe('chains.rpc retry & chunking', () => {
  test('withRetry retries then succeeds', async () => {
    let calls = 0
    const res = await withRetry(async () => {
      calls++
      if (calls < 3) throw new Error('boom')
      return 'ok'
    }, { retries: 3, delay: 1 })
    expect(res).toBe('ok')
    expect(calls).toBe(3)
  })

  test('withRetry gives up after retries', async () => {
    let calls = 0
    await expect(withRetry(async () => { calls++; throw new Error('always') }, { retries: 2, delay: 1 })).rejects.toThrow()
    expect(calls).toBe(2)
  })

  test('withRetry honours shouldRetry=false', async () => {
    let calls = 0
    await expect(withRetry(async () => { calls++; throw new Error('fatal') }, { retries: 5, delay: 1, shouldRetry: () => false })).rejects.toThrow()
    expect(calls).toBe(1)
  })

  test('sliceIntoChunks', () => {
    expect(sliceIntoChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
    expect(sliceIntoChunks([], 2)).toEqual([])
  })

  test('runInChunks preserves order and flattens', async () => {
    const res = await runInChunks([1, 2, 3, 4, 5], async (chunk) => chunk.map(i => i * 2), { chunkSize: 2, concurrency: 3 })
    expect(res).toEqual([2, 4, 6, 8, 10])
  })

  test('isRateLimitError', () => {
    expect(isRateLimitError({ response: { status: 429 } })).toBe(true)
    expect(isRateLimitError(new Error('Too Many Requests'))).toBe(true)
    expect(isRateLimitError(new Error('nope'))).toBe(false)
  })

  test('JsonRpcError carries code and method', () => {
    const e = new JsonRpcError('getFoo', { code: -32601, message: 'Method not found' })
    expect(e.code).toBe(-32601)
    expect(e.method).toBe('getFoo')
    expect(e.message).toContain('getFoo')
  })
})

describe('chains.rpc live', () => {
  const endpoints = 'https://api.mainnet-beta.solana.com'

  test('jsonRpc getHealth', async () => {
    const res = await jsonRpc('getHealth', [], { endpoints })
    expect(res).toBe('ok')
  })

  test('jsonRpc surfaces node errors as JsonRpcError without retrying forever', async () => {
    await expect(jsonRpc('thisMethodDoesNotExist', [], { endpoints, retries: 2, delay: 1 })).rejects.toThrow(/thisMethodDoesNotExist/)
  })

  test('jsonRpcBatch keeps order and permits failures', async () => {
    const res = await jsonRpcBatch([
      { method: 'getHealth' },
      { method: 'thisMethodDoesNotExist' },
      { method: 'getHealth' },
    ], { endpoints, permitFailure: true })
    expect(res).toEqual(['ok', undefined, 'ok'])
  })

  test('httpGet with path rotation', async () => {
    const res = await httpGet(['https://api.llama.fi'], { path: '/config' })
    expect(res).toBeDefined()
  })
})
