const send = jest.fn()
const S3Client = jest.fn().mockImplementation(() => ({ send }))
const PutObjectCommand = jest.fn().mockImplementation((input: any) => ({ kind: 'put', input }))
const GetObjectCommand = jest.fn().mockImplementation((input: any) => ({ kind: 'get', input }))
const fetchJson = jest.fn()
const lastCall = (fn: jest.Mock) => fn.mock.calls[fn.mock.calls.length - 1][0]

jest.mock('@aws-sdk/client-s3', () => ({ S3Client, PutObjectCommand, GetObjectCommand }))
jest.mock('./common', () => ({ fetchJson }))

const R2_ENV_KEYS = ['R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'R2_CONFIG']
  .flatMap((k) => [k, `SDK_${k}`, `LLAMA_SDK_${k}`])

const publicCfg = { endpoint: 'pub.r2.cloudflarestorage.com', accessKeyId: 'pub-key', secretAccessKey: 'pub-secret' }
const privateCfg = { endpoint: 'https://priv.r2.cloudflarestorage.com', accessKeyId: 'priv-key', secretAccessKey: 'priv-secret', bucket: 'my-private-bucket' }

// env and r2 both read process.env at module load, so each test loads a fresh copy
function loadR2(env: Record<string, string>): typeof import('./r2') {
  for (const key of R2_ENV_KEYS) delete process.env[key]
  Object.assign(process.env, env)
  let mod: any
  jest.isolateModules(() => { mod = require('./r2') })
  return mod
}

beforeEach(() => {
  send.mockReset()
  S3Client.mockClear()
  PutObjectCommand.mockClear()
  GetObjectCommand.mockClear()
  fetchJson.mockReset()
})

afterAll(() => {
  for (const key of R2_ENV_KEYS) delete process.env[key]
})

describe('client setup', () => {
  test('no config: no clients', () => {
    loadR2({})
    expect(S3Client).not.toHaveBeenCalled()
  })

  test('legacy R2_* vars configure the public client only', () => {
    loadR2({ R2_ENDPOINT: publicCfg.endpoint, R2_ACCESS_KEY_ID: publicCfg.accessKeyId, R2_SECRET_ACCESS_KEY: publicCfg.secretAccessKey })
    expect(S3Client).toHaveBeenCalledTimes(1)
    expect(S3Client.mock.calls[0][0]).toEqual({
      region: 'auto',
      endpoint: 'https://pub.r2.cloudflarestorage.com',
      credentials: { accessKeyId: 'pub-key', secretAccessKey: 'pub-secret' },
    })
  })

  test('R2_CONFIG configures both clients and strips a scheme from the endpoint', () => {
    loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg, private: privateCfg }) })
    expect(S3Client).toHaveBeenCalledTimes(2)
    expect(S3Client.mock.calls[0][0].endpoint).toBe('https://pub.r2.cloudflarestorage.com')
    expect(S3Client.mock.calls[1][0].endpoint).toBe('https://priv.r2.cloudflarestorage.com')
    expect(S3Client.mock.calls[1][0].credentials).toEqual({ accessKeyId: 'priv-key', secretAccessKey: 'priv-secret' })
  })

  test('R2_CONFIG.private alone plus legacy vars: legacy fills public', () => {
    loadR2({
      R2_ENDPOINT: publicCfg.endpoint, R2_ACCESS_KEY_ID: publicCfg.accessKeyId, R2_SECRET_ACCESS_KEY: publicCfg.secretAccessKey,
      R2_CONFIG: JSON.stringify({ private: privateCfg }),
    })
    expect(S3Client).toHaveBeenCalledTimes(2)
    expect(S3Client.mock.calls[0][0].credentials.accessKeyId).toBe('pub-key')
    expect(S3Client.mock.calls[1][0].credentials.accessKeyId).toBe('priv-key')
  })

  test('R2_CONFIG.public overrides legacy vars', () => {
    loadR2({
      R2_ENDPOINT: 'legacy.example.com', R2_ACCESS_KEY_ID: 'legacy', R2_SECRET_ACCESS_KEY: 'legacy',
      R2_CONFIG: JSON.stringify({ public: publicCfg }),
    })
    expect(S3Client).toHaveBeenCalledTimes(1)
    expect(S3Client.mock.calls[0][0].credentials.accessKeyId).toBe('pub-key')
  })

  test('incomplete bucket config is ignored', () => {
    loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg, private: { endpoint: 'x' } }) })
    expect(S3Client).toHaveBeenCalledTimes(1)
  })

  test('invalid R2_CONFIG JSON throws on load', () => {
    expect(() => loadR2({ R2_CONFIG: '{not json' })).toThrow('R2_CONFIG is not valid JSON')
  })
})

describe('storeR2JSONString', () => {
  test('public write uses default public bucket', async () => {
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg, private: privateCfg }) })
    send.mockResolvedValue('ok')
    await r2.storeR2JSONString('a:b#c', '{"x":1}')
    expect(PutObjectCommand).toHaveBeenCalledWith({ Bucket: 'defillama-datasets', Key: 'a/b/c', Body: '{"x":1}', ContentType: 'application/json' })
    expect(send).toHaveBeenCalledTimes(1)
  })

  test('private write uses the private client and configured bucket', async () => {
    const publicSend = jest.fn()
    const privateSend = jest.fn().mockResolvedValue('ok')
    S3Client.mockImplementationOnce(() => ({ send: publicSend })).mockImplementationOnce(() => ({ send: privateSend }))
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg, private: privateCfg }) })

    await r2.storeR2JSONString('file', 'data', { private: true })
    expect(lastCall(PutObjectCommand).Bucket).toBe('my-private-bucket')
    expect(privateSend).toHaveBeenCalledTimes(1)
    expect(publicSend).not.toHaveBeenCalled()
  })

  test('private bucket name defaults when not configured', async () => {
    const { bucket, ...privateNoBucket } = privateCfg
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg, private: privateNoBucket }) })
    send.mockResolvedValue('ok')
    await r2.storeR2JSONString('file', 'data', { private: true })
    expect(lastCall(PutObjectCommand).Bucket).toBe('defillama-datasets-private')
  })

  test('private write without private config is a no-op', async () => {
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg }) })
    await expect(r2.storeR2JSONString('file', 'data', { private: true })).resolves.toBeUndefined()
    expect(send).not.toHaveBeenCalled()
  })

  test('buffer body is base64 encoded', async () => {
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg }) })
    send.mockResolvedValue('ok')
    await r2.storeR2JSONString('file', Buffer.from('hello'))
    expect(lastCall(PutObjectCommand).Body).toBe(Buffer.from('hello').toString('base64'))
  })
})

describe('getR2JSONString', () => {
  test('public read goes through the client when configured', async () => {
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg }) })
    send.mockResolvedValue({ Body: { transformToString: async () => '{"x":1}' } })
    await expect(r2.getR2JSONString('a:b')).resolves.toBe('{"x":1}')
    expect(GetObjectCommand).toHaveBeenCalledWith({ Bucket: 'defillama-datasets', Key: 'a/b' })
    expect(fetchJson).not.toHaveBeenCalled()
  })

  test('public read falls back to the public URL when no client', async () => {
    const r2 = loadR2({})
    fetchJson.mockResolvedValue({ x: 1 })
    await expect(r2.getR2JSONString('a:b')).resolves.toEqual({ x: 1 })
    expect(fetchJson).toHaveBeenCalledWith('https://defillama-datasets.llama.fi/a:b')
  })

  test('private read uses the private bucket', async () => {
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg, private: privateCfg }) })
    send.mockResolvedValue({ Body: { transformToString: async () => 'secret' } })
    await expect(r2.getR2JSONString('file', { private: true })).resolves.toBe('secret')
    expect(lastCall(GetObjectCommand).Bucket).toBe('my-private-bucket')
    expect(fetchJson).not.toHaveBeenCalled()
  })

  test('private read without private config never hits the public URL', async () => {
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg }) })
    await expect(r2.getR2JSONString('file', { private: true })).resolves.toEqual({})
    await expect(r2.getR2JSONString('file', { private: true, throwErrorOnFail: true })).rejects.toThrow('Private R2 bucket is not configured')
    expect(fetchJson).not.toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  test('failures return {} unless throwErrorOnFail', async () => {
    const r2 = loadR2({ R2_CONFIG: JSON.stringify({ public: publicCfg }) })
    send.mockRejectedValue(new Error('NoSuchKey'))
    await expect(r2.getR2JSONString('file')).resolves.toEqual({})
    await expect(r2.getR2JSONString('file', { throwErrorOnFail: true })).rejects.toThrow('NoSuchKey')
  })
})
