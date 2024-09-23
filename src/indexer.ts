import axios from "axios"
import { getEnvValue } from "./util/env"
import { readCache, writeCache } from "./util/cache"
import { debugLog } from "./util/debugLog"
import { getUniqueAddresses } from "./generalUtil"
import { ETHER_ADDRESS } from "./general"

const indexerURL = getEnvValue('LLAMA_INDEXER_ENDPOINT')

const indexerChainIdChainMapping: any = {
  1: 'ethereum',
  10: 'optimism',
  56: 'bsc',
  100: 'xdai',
  137: 'polygon',
  204: 'op_bnb',
  250: 'fantom',
  324: 'era',
  1101: 'polygon_zkevm',
  8453: 'base',
  34443: 'mode',
  42170: 'arbitrum_nova',
  42161: 'arbitrum',
  43114: 'avalanche',
  59144: 'linea',
  81457: 'blast',
  534352: 'scroll',
}

export const supportedChainSet = new Set(Object.values(indexerChainIdChainMapping))
const chainToIDMapping: any = {}
Object.entries(indexerChainIdChainMapping).forEach(([id, chain]: any) => {
  chainToIDMapping[chain] = id
})


enum TokenTypes {
  ERC20 = 'erc20',
  ERC721 = 'erc721',
}

type Cache = {
  timestamp: number
  tokens: {
    [chain: string]: string[]
  }
}

export async function getTokens(address: string, { onlyWhitelisted = true, skipCacheRead = false, skipCache = false, chain, tokenType }: {
  onlyWhitelisted?: boolean,
  skipCacheRead?: boolean,
  skipCache?: boolean,
  chain?: string,
  tokenType?: TokenTypes,
} = {}) {

  if (!indexerURL) throw new Error('Llama Indexer URL not set')

  const project = 'llama-indexer-cache'
  const key = onlyWhitelisted ? address : `${address}/all`
  const file = `${project}/${key}`
  const timeNow = Math.floor(Date.now() / 1e3)
  const THREE_DAYS = 3 * 24 * 3600
  let cache = {} as Cache
  if (!skipCacheRead && !skipCache) {
    cache = (await readCache(file)) ?? {}
    if (cache.timestamp && (timeNow - cache.timestamp) < THREE_DAYS)
      return cache.tokens
  }
  debugLog('Pulling tokens for ' + address)

  const tokens = cache.tokens ?? {}
  const { data: { balances } } = await axios.get(`${indexerURL}/balances?address=${address}`, {
    params: {
      chain: chain,
      type: tokenType,
    }
  })
  balances.filter((b: any) => +b.total_amount > 0).forEach((b: any) => {
    const chain = indexerChainIdChainMapping[b.chain]
    if (!chain) {
      return;
    }
    if (!tokens[chain]) tokens[chain] = []
    tokens[chain].push(b.address)
  })
  const tokenCache = { timestamp: timeNow, tokens, }
  Object.entries(tokens).forEach(([chain, values]: any) => {
    values.push(ETHER_ADDRESS)
    tokens[chain] = getUniqueAddresses(values)
  })

  if (!skipCache)
    await writeCache(file, tokenCache)
  return tokens
}

export async function getLogs({ address, chain, topic0, fromBlock, toBlock, all = true, limit = 1000, offset = 0 }: {
  address: string,
  chain: string,
  topic0: string,
  fromBlock: number,
  toBlock: number,
  limit?: number,
  offset?: number,
  all?: boolean,
}) {
  if (!indexerURL) throw new Error('Llama Indexer URL not set')
  const chainId = chainToIDMapping[chain]
  if (!chainId) throw new Error('Chain not supported')
  let hasMore = true
  const logs: any[] = []
  do {
    const params = {
      address,
      chain: chainId,
      topic: topic0,
      from_block: fromBlock,
      to_block: toBlock,
      limit,
      offset,
    }
    const { data: { logs: _logs } } = await axios.get(`${indexerURL}/logs`, { params })
    offset += limit
  } while (all && hasMore)
  

  const project = 'llama-indexer-cache'
  const key = address
  const file = `${project}/${key}`
  const timeNow = Math.floor(Date.now() / 1e3)
  const THREE_DAYS = 3 * 24 * 3600
  let cache = {} as any
  if (!skipCacheRead && !skipCache) {
    cache = (await readCache(file)) ?? {}
    if (cache.timestamp && (timeNow - cache.timestamp) < THREE_DAYS)
      return cache.logs
  }
  debugLog('Pulling logs for ' + address)

  const { data: { logs } } = await axios.get(`${indexerURL}/logs?address=${address}`)
  const logCache = { timestamp: timeNow, logs }
  if (!skipCache)
    await writeCache(file, logCache)
  return logs
}