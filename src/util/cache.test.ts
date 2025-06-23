
import largeMulticall from '../abi/largeMulticall';
import { writeCache, readCache, parseCache, compressCache, currentVersion, deleteCache, } from './cache';
import { getR2JSONString } from './r2';

// Swallow error for testing purposes
async function deleteCacheSwallowError(file: string, throwError = false) {
  try {
    await deleteCache(file);
  } catch (error) {
    if (throwError) throw error;
  }
}

test("Cache - parseCache & compressCache", async () => {
  const inputData = { test: 'this is a string' }

  const compressedData = await compressCache(inputData)
  expect((await parseCache(compressedData.toString('base64'))).test).toEqual(inputData.test)
  expect((await parseCache(compressedData)).test).toEqual(inputData.test)
})

test("Cache r2 - Write Object", async () => {
  const testFile = 'unit-test/object.json'
  const inputData = { test: 'this is a string' }
  await deleteCacheSwallowError(testFile)

  await writeCache(testFile, inputData)

  const data = await readCache(testFile)
  expect(data.test).toEqual(inputData.test)
  await deleteCacheSwallowError(testFile, true)
})

test("Cache - Read R2 Object", async () => {
  const testFile = 'unit-test/object.json'
  await deleteCacheSwallowError(testFile)
  const data = await getR2JSONString(currentVersion + '/' + testFile)
  const parsedData = await parseCache(data)
  expect(parsedData.test).toEqual('this is a string')
})

test("Cache - write string", async () => {
  const testFile = 'unit-test/string.json'
  await deleteCacheSwallowError(testFile)
  const stringData = 'this is a string; Lopum ipsum dolor sit amet, consectetur adipiscing elit. Nulla euismod, nisl eget aliquam ultricies, nisl nisl aliquet nisl, nec aliquam nisl nisl nec.'

  await writeCache(testFile, stringData)

  const data = await readCache(testFile)
  expect(data).toEqual(stringData)
  await deleteCacheSwallowError(testFile, true)
})


test("Cache - write large file", async () => {
  const testFile = 'unit-test/large-file.json'
  await deleteCacheSwallowError(testFile)
  const largeData = [0, 1, 2, 3, 4, 5].map(_ => largeMulticall)

  await writeCache(testFile, largeData)

  const data = await readCache(testFile)
  expect(data.length).toBe(6)
  expect(data[0].calls.length).toBeGreaterThan(100)
  await deleteCacheSwallowError(testFile, true)
})


test("write cache: empty object", async () => {
  const testFile = 'unit-test/empty-file.json'
  await deleteCacheSwallowError(testFile)

  await writeCache(testFile, {})
  let data = await readCache(testFile)
  expect(data).toEqual({})

  await writeCache(testFile, undefined)
  data = await readCache(testFile)
  expect(data).toEqual({})

  await writeCache(testFile, 'tiny')
  data = await readCache(testFile)
  expect(data).toEqual({})

  await writeCache(testFile, '')
  data = await readCache(testFile)
  expect(data).toEqual({})


  await writeCache(testFile, undefined, { skipCompression: true })
  data = await readCache(testFile, { skipCompression: true })
  expect(data).toEqual({})

  await writeCache(testFile, 'tiny', { skipCompression: true })
  data = await readCache(testFile, { skipCompression: true })
  expect(data).toEqual({})

  await writeCache(testFile, '', { skipCompression: true })
  data = await readCache(testFile, { skipCompression: true })
  expect(data).toEqual({})
})

test("Cache - write string - uncompressed", async () => {
  const testFile = 'unit-test/string.json'
  await deleteCacheSwallowError(testFile)
  const stringData = 'this is a string; Lopum ipsum dolor sit amet, consectetur adipiscing elit. Nulla euismod, nisl eget aliquam ultricies, nisl nisl aliquet nisl, nec aliquam nisl nisl nec.'

  await writeCache(testFile, stringData, { skipCompression: true })

  const data = await readCache(testFile, { skipCompression: true })
  expect(data).toEqual(stringData)
})

test("Cache - write large file - uncompressed", async () => {
  const testFile = 'unit-test/large-file-uncompressed.json'
  await deleteCacheSwallowError(testFile)
  const largeData = [0, 1, 2, 3, 4, 5].map(_ => largeMulticall)

  await writeCache(testFile, largeData, { skipCompression: true })

  const data = await readCache(testFile, { skipCompression: true })
  expect(data.length).toBe(6)
  expect(data[0].calls.length).toBeGreaterThan(100)
})


test("Cache - parseCache & compressCache - uncompressed", async () => {
  const inputData = { test: 'this is a string' }

  const compressedData = await compressCache(inputData, { skipCompression: true })
  expect((await parseCache(compressedData.toString('base64'), { skipCompression: true })).test).toEqual(inputData.test)
  expect((await parseCache(compressedData, { skipCompression: true })).test).toEqual(inputData.test)
})
