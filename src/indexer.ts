import axios from "axios"
import { getEnvValue } from "./util/env"
import { readCache, writeCache } from "./util/cache"
import { debugLog } from "./util/debugLog"
import { getUniqueAddresses } from "./generalUtil"
import { ETHER_ADDRESS } from "./general"

const indexerURL = getEnvValue('LLAMA_INDEXER_ENDPOINT')

const indexerChainIdChainMapping: any = {
  1: 'ethereum',
  56: 'bsc',
  137: 'polygon',
  250: 'fantom',
  43114: 'avalanche',
  10: 'optimism',
  42161: 'arbitrum',
  100: 'xdai',
  204: 'op_bnb',
  324: 'era',
  8453: 'base',
  42170: 'arbitrum_nova',
  1101: 'polygon_zkevm',
  59144: 'linea',
  534352: 'scroll',
}

export async function getTokens(address: string, { onlyWhitelisted = true, skipCacheRead = false } = {}) {

  if (!indexerURL) throw new Error('Llama Indexer URL not set')

  const project = 'llama-indexer-cache'
  const key = onlyWhitelisted ? address : `${address}/all`
  const file = `${project}/${key}`
  const timeNow = Math.floor(Date.now() / 1e3)
  const THREE_DAYS = 3 * 24 * 3600
  const cache = (await readCache(file)) ?? {}
  if (!skipCacheRead && cache.timestamp && (timeNow - cache.timestamp) < THREE_DAYS)
    return cache.tokens

  debugLog('Pulling tokens for ' + address)

  const tokens = cache.tokens ?? {}
  const { data: { balances } } = await axios.get(`${indexerURL}/balances?address=${address}`)
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

  await writeCache(file, tokenCache)
  return tokens
}