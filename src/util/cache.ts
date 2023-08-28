import { debugLog } from "./debugLog";
import { storeR2JSONString, getR2JSONString, } from "./r2";
import { constants, brotliCompress, brotliDecompress } from "zlib";
import { promisify } from 'util';

const brotliOptions = {
  [constants.BROTLI_PARAM_MODE]: constants.BROTLI_MODE_TEXT,
  [constants.BROTLI_PARAM_QUALITY]: constants.BROTLI_MAX_QUALITY,
}

function zipAsync(data: string) {
  return promisify(brotliCompress)(data, brotliOptions)
}

function unzipAsync(data: Buffer) {
  return promisify(brotliDecompress)(data, brotliOptions).then(r=>r.toString())
}

const fs = require('fs').promises;
const path = require('path');

const foldersCreated: {
  [key: string]: boolean
} = {}

const currentVersion = 'llama-zip-1.0.0'

function getCacheRootFolder() {
  return process.env.TVL_LOCAL_CACHE_ROOT_FOLDER || path.join(__dirname, 'local_cache')
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

export async function readCache(file: string, options: ReadCacheOptions = {}): Promise<any> {
  try {
    const data = await readFile(file, options)
    return await parseCache(data)
  } catch (error) {
    // debugLog('Error reading cache:', error)
    return {}
  }


  async function readFile(file: string, options: ReadCacheOptions = {}) {
    const filePath = getFilePath(file)
    try {
      const data = await fs.readFile(filePath)
      return data
    } catch (error) {
      // debugLog('Error reading cache:', error)
      if (options.skipR2Cache) return;
      const r2Data = await getR2JSONString(file)

      if (r2Data) {
        await writeCache(file, r2Data, { alreadyCompressed: true, skipR2CacheWrite: true })
        return r2Data
      }
    }
  }
}

interface WriteCacheOptions {
  skipR2CacheWrite?: boolean,
  alreadyCompressed?: boolean
}

interface ReadCacheOptions {
  skipR2Cache?: boolean
}

export async function writeCache(file: string, data: any, options: WriteCacheOptions = {}): Promise<string | undefined> {

  const fileData = options.alreadyCompressed ? data : await compressCache(data)

  if (!data || (typeof data === 'string' && data.length < 50) || fileData.length < 120) {
    debugLog('Data too small to cache: ', file);
    return;
  }
  if (isSameData(data, await readCache(file, { skipR2Cache: true }))) return;

  const filePath = getFilePath(file)
  await createSubPath(path.dirname(filePath))
  await fs.writeFile(filePath, fileData)
  if (!options.skipR2CacheWrite) {
    await storeR2JSONString(file, fileData)
  }

  return fileData
}

export async function parseCache(dataString: string | Buffer) {
  if (typeof dataString === 'string') dataString = Buffer.from(dataString, 'base64')
  const decompressed = await unzipAsync(dataString)
  return JSON.parse(decompressed).llamaWrapped
}

export async function compressCache(data: any) {
  const comressedCache = await zipAsync(JSON.stringify({ version: currentVersion, llamaWrapped: data }))
  return comressedCache
}

function isSameData(data1: any, data2: any) {
  return JSON.stringify(data1) === JSON.stringify(data2)
}
