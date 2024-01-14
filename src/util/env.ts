
const _ENV_CONSTANTS = {
  DEBUG_ENABLED: getEnvValue('DEBUG') === "true" || process.env.LLAMA_DEBUG_MODE ? 'true' : 'false',
} as {
  [key: string]: string | undefined
}

const whitelistedEnvConstants = [
  'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'TRON_PRO_API_KEY',
]

const defaultEnvValues = {
  INTERNAL_SDK_CACHE_FILE: './cache.json',
  TRON_RPC_CONCURRENCY_LIMIT: '5',
  TRON_RPC: 'https://api.trongrid.io',
} as {
  [key: string]: string
}

whitelistedEnvConstants.forEach(key => _ENV_CONSTANTS[key] = getEnvValue(key))
Object.keys(defaultEnvValues).forEach(key => _ENV_CONSTANTS[key] = getEnvValue(key, defaultEnvValues[key]))

// doing this as I am paranoid that that empty object when first declared might be exported before values are set
export const ENV_CONSTANTS = { ..._ENV_CONSTANTS }

export function getChainId(chain: string, chainId: number): number {
  const value = getEnvValue(`${chain}_RPC_CHAIN_ID`) ?? chainId
  return +value
}

export function getMaxParallelRequests(chain: string): number {
  const chainKey = `${chain}_RPC_MAX_PARALLEL`
  if (getEnvValue(chainKey)) return +getEnvValue(chainKey)!
  if (['harmony', 'avax'].includes(chain)) return 20
  return +getEnvValue('MAX_PARALLEL', '100')!
}

export function getParallelGetLogsLimit(chain: string) {
  let defaultLimit = chain === 'fantom' ? '10' : '42'
  return +(getEnvValue(`${chain}_RPC_GET_LOGS_CONCURRENCY_LIMIT`, defaultLimit)!)
}

export function getEnvRPC(chain: string): string | undefined {
  return getEnvValue(`${chain}_RPC`)
}

export function getEnvValue(key: string, defaultValue?: string) {
  key = key.toUpperCase()
  return process.env['LLAMA_SDK_' + key] ?? process.env['SDK_' + key] ??  process.env[key] ?? defaultValue
}

export function getEnvCacheFolder(defaultCacheFolder: string): string {
  return getEnvValue('TVL_LOCAL_CACHE_ROOT_FOLDER', defaultCacheFolder) as string
}

export function getEnvMulticallAddress(chain: string): string | undefined {
  return getEnvValue(`${chain}_RPC_MULTICALL`)
}

export function getDefaultChunkSize(chain: string) {
  const key = chain + '_MULTICALL_CHUNK_SIZE'
  if (getEnvValue(key)) return +getEnvValue(key)!
  if (chain === 'cronos') return 50
  return +(getEnvValue('MULTICALL_CHUNK_SIZE', '300')!)
}

export function getBatchMaxCount(chain: string): number {
  const key = chain + '_BATCH_MAX_COUNT'
  if (getEnvValue(key)) return +getEnvValue(key)!
  switch (chain) {
    case 'cronos': return 5
    case 'zkfair': return 1
    default: return +getEnvValue('BATCH_MAX_COUNT', '99')!
  }
}

export function getArchivalRPCs(chain: string): string[] {
  const key = chain + '_ARCHIVAL_RPC'
  if (getEnvValue(key)) return getEnvValue(key)!.split(',')
  return []
}

export function getChainRPCs(chain: string, defaultList: string[] = []): string | undefined {
  const key = chain + '_RPC'
  if (getEnvValue(key)) return getEnvValue(key)!.split(',').concat(defaultList).join(',')
  if (defaultList.length === 0) return undefined
  return defaultList.join(',')
}