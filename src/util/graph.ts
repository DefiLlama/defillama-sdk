import axios from "axios";
import { readCache, writeCache } from "./cache";
import { debugLog } from "./debugLog";
import { getEnvValue } from "./env";

export async function request(endpoint: string, query: string, {
  cache = false,
  cacheKey,
  variables,
  withMetadata = false,
}: { cache?: boolean, cacheKey?: string, withMetadata?: boolean, variables?: any } = {}) {

  try {
    const data = await _request()
    if (cache) {
      if (!cacheKey) throw new Error('cacheKey is required')
      await writeCache('graph-data/' + cacheKey, data)
    }
    return data
  } catch (error) {
    if (!cache) throw error
    debugLog('Error fetching data, reading from cache:', error)
    const cacheData = await readCache('graph-data/' + cacheKey)
    return cacheData
  }

  async function _request() {
    endpoint = modifyEndpoint(endpoint)
    const { data: result } = await axios.post(endpoint, { query, variables })
    if (result.errors) throw new Error(result.errors[0].message)
    return withMetadata ? result : result.data
  }
}

export function modifyEndpoint(endpoint: string) {
  // example: https://api.thegraph.com/subgraphs/name/yieldyak/reinvest-tracker
  const graphKey = getEnvValue('GRAPH_API_KEY')
  if (!graphKey) return endpoint
  if (!endpoint.includes('api.thegraph.com')) return endpoint

  endpoint = endpoint.replace('[api-key]', graphKey)
  return endpoint
}