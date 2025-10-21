
const whitelistedEnvConstants = [
  'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY', 'TRON_PRO_API_KEY', 'COINS_API_KEY',
  'ELASTICSEARCH_CONFIG', 'GRAPH_API_KEY', 'LLAMA_INDEXER_ENDPOINT', 'LLAMA_INDEXER_API_KEY', 'LLAMA_INDEXER_V2_ENDPOINT', 'LLAMA_INDEXER_V2_API_KEY',
]

export const isDebugLevel3 = process.env.LLAMA_SDK_DEBUG_LEVEL_3 === 'true' || false
export const logLlamaProviderCalls = process.env.LLAMA_SDK_LOG_LLAMA_PROVIDER_CALLS === 'true' || isDebugLevel3
export const logGetBlockStats = process.env.LLAMA_SDK_LOG_GET_BLOCK_STATS === 'true' || isDebugLevel3
export const logGetLogsErrors = process.env.LLAMA_SDK_LOG_GET_LOGS_ERRORS === 'true' || isDebugLevel3
export const logGetLogsDebug = process.env.LLAMA_SDK_LOG_GET_LOGS_DEBUG === 'true' || isDebugLevel3
export const logGetLogsIndexer = process.env.LLAMA_SDK_LOG_GET_LOGS_INDEXER === 'true' || isDebugLevel3
export const defaultShortenStringLength = +(process.env.LLAMA_SDK_DEFAULT_SHORTEN_STRING_LENGTH ?? '120')

const defaultEnvValues = {
  INTERNAL_SDK_CACHE_FILE: './cache.json',
  TRON_RPC_CONCURRENCY_LIMIT: '5',
  LLAMA_INDEXER_ADDRESS_CHUNK_SIZE: '20',
  TRON_WALLET_RPC: 'https://api.trongrid.io',
  // TRON_EVM_RPC: 'https://rpc.ankr.com/tron_jsonrpc', // no longer used
  NAKA_RPC: 'https://node.nakachain.xyz',
  ETHF_RPC: 'https://rpc.dischain.xyz/',
  CORE_RPC: "https://rpc.coredao.org,https://rpc.ankr.com/core,https://1rpc.io/core,https://rpc-core.icecreamswap.com",
  BITGERT_RPC: "https://flux-rpc2.brisescan.com,https://mainnet-rpc.brisescan.com,https://chainrpc.com,https://serverrpc.com,https://flux-rpc.brisescan.com",
  BITCHAIN_RPC: "https://rpc.bitchain.biz/",
  OZONE_RPC: "https://node1.ozonechain.io",
  ZETA_RPC: "https://zetachain-evm.blockpi.network/v1/rpc/public,https://zetachain-mainnet-archive.allthatnode.com:8545",
  DEFIVERSE_RPC: "https://rpc.defi-verse.org/",
} as {
  [key: string]: string
}

const _ENV_CONSTANTS = {
  DEBUG_ENABLED: getEnvValue('DEBUG') === "true" || process.env.LLAMA_DEBUG_MODE ? 'true' : 'false',
  DEBUG_LEVEL2: process.env.LLAMA_DEBUG_LEVEL2 ? 'true' : 'false',
} as {
  [key: string]: string | undefined
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

export function getParallelGetLogsLimit(chain: string, providerUrl?: string) {
  let defaultLimit = getEnvValue('GET_LOGS_CONCURRENCY_LIMIT', '25')
  if (chain === 'fantom') defaultLimit = '10'
  const defaultAlchemyLimit = getEnvValue('ALCHEMY_GET_LOGS_CONCURRENCY_LIMIT', '25')
  if (providerUrl && providerUrl.includes('alchemy.com')) return +(defaultAlchemyLimit!)
  return +(getEnvValue(`${chain}_RPC_GET_LOGS_CONCURRENCY_LIMIT`, defaultLimit)!)
}

export function getParallelGetBlocksLimit(chain: string) {
  const defaultLimit = getEnvValue('GET_BLOCKS_CONCURRENCY_LIMIT', '5')
  return +(getEnvValue(`${chain}_RPC_GET_BLOCKS_CONCURRENCY_LIMIT`, defaultLimit)!)
}

export function getEnvRPC(chain: string): string | undefined {
  const key = `${chain}_RPC`.toUpperCase()
  return getEnvValue(key, defaultEnvValues[key])
}

export function getEnvValue(key: string, defaultValue?: string) {
  key = key.toUpperCase()
  defaultValue = defaultValue ?? defaultEnvValues[key]
  return process.env['LLAMA_SDK_' + key] ?? process.env['SDK_' + key] ?? process.env[key] ?? defaultValue
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
    case 'zkfair': return 1
    default: return +getEnvValue('BATCH_MAX_COUNT', '5')!
  }
}

export function getArchivalRPCs(chain: string): string[] {
  const key = chain + '_ARCHIVAL_RPC'
  if (getEnvValue(key)) return getEnvValue(key)!.split(',')
  return []
}

export function getChainRPCs(chain: string, defaultList: string[] = []): string | undefined {
  const envValue = getEnvRPC(chain)
  if (defaultList.length) {
    const listString = defaultList.join(',')
    if (envValue) return envValue + ',' + listString
    return listString
  }
  return envValue || undefined
}

export function getWhitelistedRPCs(chain: string): string[] {
  const key = chain + '_WHITELISTED_RPC'
  if (getEnvValue(key)) return getEnvValue(key)!.split(',')
  return []
}