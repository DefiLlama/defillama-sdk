import { debugLog } from "./debugLog";
import { storeR2JSONString, getR2JSONString, } from "./r2";
import { constants, brotliCompress, brotliDecompress } from "zlib";
import { promisify } from 'util';
import { getEnvCacheFolder } from "./env";

const brotliOptions = {
  [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
  [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
}

function zipAsync(data: string) {
  return promisify(brotliCompress)(data, brotliOptions)
}

function unzipAsync(data: Buffer) {
  return promisify(brotliDecompress)(data, brotliOptions).then(r => r.toString())
}

const _fs = require('fs');
const fs = _fs.promises;
const path = require('path');

const foldersCreated: {
  [key: string]: boolean
} = {}

export const currentVersion = 'zlib-1.0'

function getCacheRootFolder() {
  const defaultCacheRootFolder = path.join(__dirname, 'local_cache')
  return path.join(getEnvCacheFolder(defaultCacheRootFolder), currentVersion)
}

function getFilePath(file: string) {
  return path.join(getCacheRootFolder(), file);
}

async function createSubPath(folderPath: string) {
  const datRoot = getCacheRootFolder();
  folderPath = folderPath.replace(datRoot, '')
  if (foldersCreated[folderPath]) return;
  try {
    await fs.mkdir(path.join(datRoot, folderPath), { recursive: true });
  } catch (error) {
    // sdk.log('Error creating folder path:', error)
  }
  foldersCreated[folderPath] = true;
}

const ONE_DAY_IN_MS = 1000 * 60 * 60 * 24

export async function readCache(file: string, options: ReadCacheOptions = {}): Promise<any> {
  if (options.skipCompression)
    file = `${file}-uncompressed`

  try {
    const data = await readFile()
    return await parseCache(data, options)
  } catch (error) {
    // debugLog('Error reading cache:', error)
    return {}
  }


  async function readFile() {
    const filePath = getFilePath(file)
    try {
      if (options.checkIfRecent) {
        const stats = await fs.stat(filePath)
        if (Date.now() - stats.mtimeMs > ONE_DAY_IN_MS)
          throw new Error('File too old, read from R2 instead')
      }
      if (options.readFromR2Cache) throw new Error('Read from R2 cache')
      const data = await fs.readFile(filePath)
      return data
    } catch (error) {
      // debugLog('Error reading cache:', error)
      if (options.skipR2Cache) return;
      const r2Data = await getR2JSONString(currentVersion + '/' + file)

      if (r2Data) {
        await writeCache(file, r2Data, { alreadyCompressed: true, skipR2CacheWrite: true, skipCompression: options.skipCompression })
        return r2Data
      }
    }
  }
}

interface WriteCacheOptions {
  skipR2CacheWrite?: boolean,
  alreadyCompressed?: boolean
  skipCompression?: boolean // if true, data will not be compressed before writing to cache, more suited for local cache, it is faster but takes more space
}

interface ReadCacheOptions {
  checkIfRecent?: boolean, // if the file is older than a day, read from R2 cache
  readFromR2Cache?: boolean,
  skipR2Cache?: boolean,
  skipCompression?: boolean // if true, data will not be decompressed after reading from cache
}

export async function writeCache(file: string, data: any, options: WriteCacheOptions = {}): Promise<string | undefined> {

  try {
    const fileData = options.alreadyCompressed ? data : await compressCache(data, options)

    if (!data || (typeof data === 'string' && data.length < 20) || fileData.length < 20) {
      debugLog('Data too small to cache: ', file);
      return;
    }
    if (isSameData(data, await readCache(file, { skipR2Cache: true, skipCompression: options.skipCompression, }))) return;

    if (options.skipCompression)
      file = `${file}-uncompressed`

    const filePath = getFilePath(file)
    await createSubPath(path.dirname(filePath))
    await fs.writeFile(filePath, fileData)
    if (!options.skipR2CacheWrite) {
      await storeR2JSONString(currentVersion + '/' + file, fileData)
    }

    return fileData
  } catch (error) {
    debugLog('Error writing cache:', error)
  }
}

export async function parseCache(dataString: string | Buffer, options: ReadCacheOptions = {}) {
  let dataBuffer: Buffer
  if (typeof dataString === 'string') dataBuffer = Buffer.from(dataString, 'base64')
  let decompressed: any

  let _unzipAsync = (str: Buffer) => options.skipCompression ?  dataString : unzipAsync(str)  // if skipCompression is true, we don't decompress the data

  try {
    decompressed = await _unzipAsync(dataBuffer! ?? dataString)
  } catch (e) {
    dataString = dataString.toString('utf8')
    const convertedDataString = Buffer.from(dataString, 'base64')
    decompressed = await _unzipAsync(convertedDataString)
  }
  return JSON.parse(decompressed).llamaWrapped
}

export async function compressCache(data: any, options: WriteCacheOptions = {}) {
  const dataString = JSON.stringify({ version: currentVersion, llamaWrapped: data })

  if (options.skipCompression)
    return dataString

  const comressedCache = await zipAsync(dataString)
  return comressedCache
}

function isSameData(data1: any, data2: any) {
  return JSON.stringify(data1) === JSON.stringify(data2)
}

export const ONE_WEEK = 1000 * 60 * 60 * 24 * 7

export function getTempLocalCache({ file, defaultData = {}, clearAfter = ONE_WEEK, returnWithSaveFunction = false }: { file: string, defaultData?: any, clearAfter?: number, returnWithSaveFunction?: boolean }): any | ({ data: any, saveCacheFile: () => void }) {
  const now = Math.floor(Date.now() / 1e3)
  let emptyFile = { created: now, data: defaultData }
  let fileData = emptyFile
  const filePath = getFilePath(file)
  let saveCacheFlag = false  // to ensure that we save only once on exit
  createSubPath(path.dirname(filePath)) // create folder if not exists, this is async but we don't care
  try {
    const data = _fs.readFileSync(filePath)
    fileData = JSON.parse(data.toString())
    if (now - fileData.created > clearAfter)
      fileData = emptyFile // clear cache
  } catch (error) { }

  // save cache on exit
  process.on('exit', _save);
  process.on('SIGTERM', _save)
  process.on('SIGINT', _save)

  if (returnWithSaveFunction) {
    return {
      data: fileData.data,
      saveCacheFile: () => saveCache(true)
    }
  }

  return fileData.data

  function _save() {
    saveCache(false);
  }

  function saveCache(skipCacheFlagCheck = false) {

    if (!skipCacheFlagCheck) {
      if (saveCacheFlag) return;
      saveCacheFlag = true;
    }

    try {
      // debugLog('Saving cache to file:', filePath)
      removePromisesAndFunctions(fileData)
      _fs.writeFileSync(filePath, JSON.stringify(fileData))
    } catch (error) {
      try { debugLog('Error saving cache:', error?.toString()) }
      catch (error) { }
    }
  }

  function removePromisesAndFunctions(data: any) {
    if (typeof data === 'object') {
      for (const key in data) {
        if (typeof data[key] === 'function') delete data[key]
        if (data[key] instanceof Promise) delete data[key]
        else removePromisesAndFunctions(data[key])
      }
    }
  }
}

// this removes data only from the file cache, not from the R2 cache
export async function deleteCache(file: string) {
  const filePath = getFilePath(file)
  await fs.unlink(filePath)
}

export async function readExpiringJsonCache(file: string): Promise<any> {
  const options: ReadCacheOptions = { readFromR2Cache: false, skipR2Cache: true }
  file = 'expiring/' + file
  const data = await readCache(file, options)
  if (!data || Object.keys(data).length === 0) return null
  if (data.expiryTimestamp < (Date.now() / 1e3)) {
    await deleteCache(file)
    return null
  }
  return data.data
}

export async function writeExpiringJsonCache(file: string, data: any, {
  expireAfter = 60 * 60 * 24, // cache for 1 day by default
  expiryTimestamp,
}: { expireAfter?: number, expiryTimestamp?: number }): Promise<void> {
  file = 'expiring/' + file
  if (!expiryTimestamp) expiryTimestamp = Math.floor(Date.now() / 1e3) + expireAfter
  const options: WriteCacheOptions = { skipR2CacheWrite: true, skipCompression: true }
  await writeCache(file, { data, expiryTimestamp }, options)
}