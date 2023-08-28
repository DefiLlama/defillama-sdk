
import largeMulticall from '../abi/largeMulticall';
import { writeCache, readCache, parseCache, compressCache, currentVersion, } from './cache';
import { getR2JSONString } from './r2';

test("Cache - parseCache & compressCache", async () => {
  const inputData = { test: 'this is a string' }

  const compressedData = await compressCache(inputData)
  expect((await parseCache(compressedData.toString('base64'))).test).toEqual(inputData.test)
  expect((await parseCache(compressedData)).test).toEqual(inputData.test)
})

test("Cache r2 - Write Object", async () => {
  const testFile = 'unit-test/object.json'
  const inputData = { test: 'this is a string' }

  await writeCache(testFile, inputData)

  const data = await readCache(testFile)
  expect(data.test).toEqual(inputData.test)

})

test("Cache - Read R2 Object", async () => {
  const testFile = 'unit-test/object.json'
  const data = await getR2JSONString(currentVersion + '/' + testFile)
  const parsedData = await parseCache(data)
  expect(parsedData.test).toEqual('this is a string')
})

test("Cache - write string", async () => {
  const testFile = 'unit-test/string.json'
  const stringData = 'this is a string; Lopum ipsum dolor sit amet, consectetur adipiscing elit. Nulla euismod, nisl eget aliquam ultricies, nisl nisl aliquet nisl, nec aliquam nisl nisl nec.'

  await writeCache(testFile, stringData)

  const data = await readCache(testFile)
  expect(data).toEqual(stringData)
})


test("Cache - write large file", async () => {
  const testFile = 'unit-test/large-file.json'
  const largeData = [0, 1, 2, 3, 4, 5].map(_ => largeMulticall)

  await writeCache(testFile, largeData)

  const data = await readCache(testFile)
  expect(data.length).toBe(6)
  expect(data[0].calls.length).toBeGreaterThan(100)
})


test("write cache: empty object", async () => {
  const testFile = 'unit-test/empty-file.json'

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
}) 
