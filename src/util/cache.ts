import * as fs from 'fs'

// const cacheFile = __dirname + '/../../../sc-cache1.json'
const cacheFile = process.env.CACHE_FILE

let cache: any = {}

// if (cacheFile) cache = require(cacheFile) // disabled for now

export function getCache(options: CacheOptions) {
  let { address, abi, chain = "ethereum" } = options
  if (!address) return;

  address = address.slice(2).toLowerCase()

  if (!cache[chain])
    cache[chain] = {}
  
  if (!cache[chain][abi])
    cache[chain][abi] = {}

  return cache[chain][abi][address]
}


export function setCache(options: CacheOptions) {
  let { address, abi, chain = "ethereum", value } = options
  if (!address) return;

  address = address.slice(2).toLowerCase()

  if (!cache[chain])
    cache[chain] = {}
  
  if (!cache[chain][abi])
    cache[chain][abi] = {}

  cache[chain][abi][address] = value
}

export function saveCache() {
  fs.writeFileSync(cacheFile || './cache.json', JSON.stringify(cache))
}

export function startCache(_cache = {}) {
  cache = _cache
}

export function retriveCache() {
  return cache
}


export type CacheOptions = {
  address: string;
  abi: string;
  chain?: string;
  value?: any;
}