const storeR2JSONString = jest.fn()
const getR2JSONString = jest.fn()
jest.mock('./r2', () => ({ storeR2JSONString, getR2JSONString }))

const os = require('os')
const fs = require('fs')
const path = require('path')

const cacheRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'llama-cache-test-'))
process.env.LLAMA_SDK_TVL_LOCAL_CACHE_ROOT_FOLDER = cacheRoot

import { readCache, writeCache, cachedFetch, compressCache, currentVersion } from './cache'

const data = { test: 'this is a string long enough to be cached' }
const localOnlyRead = { skipR2Cache: true }
const localOnlyWrite = { skipR2CacheWrite: true }
let counter = 0
const newFile = () => `throw-test/file-${counter++}.json`

beforeEach(() => {
  storeR2JSONString.mockReset()
  getR2JSONString.mockReset()
})

afterAll(() => {
  delete process.env.LLAMA_SDK_TVL_LOCAL_CACHE_ROOT_FOLDER
  fs.rmSync(cacheRoot, { recursive: true, force: true })
})

describe('readCache throwErrorOnFail', () => {
  test('missing local file: {} by default, throws with the option', async () => {
    const file = newFile()
    await expect(readCache(file, localOnlyRead)).resolves.toEqual({})
    await expect(readCache(file, { ...localOnlyRead, throwErrorOnFail: true })).rejects.toThrow('ENOENT')
  })

  test('corrupt local file throws with the option', async () => {
    const file = newFile()
    const filePath = path.join(cacheRoot, currentVersion, file)
    fs.mkdirSync(path.dirname(filePath), { recursive: true })
    fs.writeFileSync(filePath, 'not a brotli payload')
    await expect(readCache(file, localOnlyRead)).resolves.toEqual({})
    await expect(readCache(file, { ...localOnlyRead, throwErrorOnFail: true })).rejects.toThrow()
  })

  test('R2 failure: {} by default, throws the R2 error with the option', async () => {
    const file = newFile()
    getR2JSONString.mockImplementation(async (_file: string, { throwErrorOnFail }: any) => {
      if (throwErrorOnFail) throw new Error('AccessDenied')
      return {}
    })
    await expect(readCache(file)).resolves.toEqual({})
    await expect(readCache(file, { throwErrorOnFail: true })).rejects.toThrow('AccessDenied')
  })

  test('falls back to R2 without throwing when the local file is missing', async () => {
    const file = newFile()
    getR2JSONString.mockResolvedValue((await compressCache(data) as Buffer).toString('base64'))
    await expect(readCache(file, { throwErrorOnFail: true })).resolves.toEqual(data)
    expect(storeR2JSONString).not.toHaveBeenCalled()
  })

  test('successful read is unaffected', async () => {
    const file = newFile()
    await writeCache(file, data, localOnlyWrite)
    await expect(readCache(file, { ...localOnlyRead, throwErrorOnFail: true })).resolves.toEqual(data)
  })
})

describe('writeCache throwErrorOnFail', () => {
  test('R2 write failure: swallowed by default, throws with the option', async () => {
    storeR2JSONString.mockRejectedValue(new Error('R2 write denied'))
    await expect(writeCache(newFile(), data)).resolves.toBeUndefined()
    await expect(writeCache(newFile(), data, { throwErrorOnFail: true })).rejects.toThrow('R2 write denied')
  })

  test('local write failure throws with the option', async () => {
    // a file where a folder is expected makes the local write fail
    fs.mkdirSync(path.join(cacheRoot, currentVersion), { recursive: true })
    fs.writeFileSync(path.join(cacheRoot, currentVersion, 'blocker'), 'x')
    await expect(writeCache('blocker/file.json', data, localOnlyWrite)).resolves.toBeUndefined()
    await expect(writeCache('blocker/file.json', data, { ...localOnlyWrite, throwErrorOnFail: true })).rejects.toThrow()
  })

  test('data too small: skipped by default, throws with the option', async () => {
    await expect(writeCache(newFile(), undefined, localOnlyWrite)).resolves.toBeUndefined()
    await expect(writeCache(newFile(), undefined, { ...localOnlyWrite, throwErrorOnFail: true })).rejects.toThrow('Data too small to cache')
  })

  test('successful write and unchanged rewrite do not throw', async () => {
    const file = newFile()
    storeR2JSONString.mockResolvedValue('ok')
    await expect(writeCache(file, data, { throwErrorOnFail: true })).resolves.toBeDefined()
    await expect(writeCache(file, data, { throwErrorOnFail: true })).resolves.toBeUndefined()
    expect(storeR2JSONString).toHaveBeenCalledTimes(1)
  })
})

describe('cachedFetch', () => {
  const failingFetcher = async () => { throw new Error('upstream down') }

  test('fetch fails with no cache: throws, or {} when errorOnNoCache is false', async () => {
    await expect(cachedFetch({ key: 'cf-' + counter++, fetcher: failingFetcher })).rejects.toThrow('Fetch failed and no cache available: upstream down')
    await expect(cachedFetch({ key: 'cf-' + counter++, fetcher: failingFetcher, errorOnNoCache: false })).resolves.toEqual({})
  })

  test('fetch fails with cache: returns the cached value, even an empty one', async () => {
    const key = 'cf-' + counter++
    await cachedFetch({ key, fetcher: async () => data })
    await expect(cachedFetch({ key, fetcher: failingFetcher })).resolves.toEqual(data)

    const emptyKey = 'cf-' + counter++
    await cachedFetch({ key: emptyKey, fetcher: async () => [] })
    await expect(cachedFetch({ key: emptyKey, fetcher: failingFetcher })).resolves.toEqual([])
  })

  test('cache write failure surfaces instead of falling back to stale cache', async () => {
    const key = 'cf-' + counter++
    await cachedFetch({ key, fetcher: async () => data })
    storeR2JSONString.mockRejectedValue(new Error('R2 write denied'))
    const fresh = { test: 'a fresh value that is long enough to be cached' }
    await expect(cachedFetch({ key, fetcher: async () => fresh, writeCacheOptions: { skipCompression: true, throwErrorOnFail: true } })).rejects.toThrow('R2 write denied')
    await expect(cachedFetch({ key, fetcher: async () => fresh, writeCacheOptions: { skipCompression: true } })).resolves.toEqual(fresh)
  })
})
