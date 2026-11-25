// const cacheFile = __dirname + '/../../../sc-cache1.json'


// if (cacheFile) cache = require(cacheFile) // disabled for now

export function getCache(_options: CacheOptions) {
  return undefined
}


export function setCache(_options: CacheOptions) {}

export function saveCache() {}

export function startCache(_cache = {}) {}

export function retriveCache() {}


export type CacheOptions = {
  address: string;
  abi: string;
  chain?: string;
  value?: any;
}