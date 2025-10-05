import axios from "axios";
import { readCache, writeCache } from "./cache";
import { debugLog } from "./debugLog";
import { getEnvValue } from "./env";

export async function request(endpoint: string, query: string, {
  cache = false,
  cacheKey,
  variables,
  withMetadata = false,
  network,
}: { cache?: boolean, cacheKey?: string, withMetadata?: boolean, variables?: any, network?: string } = {}) {

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
    endpoint = modifyEndpoint(endpoint, network)
    const { data: result } = await axios.post(endpoint, { query, variables })
    if (result.errors) throw new Error(result.errors[0].message)
    return withMetadata ? result : result.data
  }
}
let graphKeyWarned = false

export function modifyEndpoint(endpoint: string, network = 'arbitrum') {
  // example: https://api.thegraph.com/subgraphs/name/yieldyak/reinvest-tracker
  let graphKey = getEnvValue('GRAPH_API_KEY')

  if (!endpoint.includes('http')) // we assume it is subgraph id
    endpoint = `https://gateway-${network}.network.thegraph.com/api/[api-key]/subgraphs/id/${endpoint}`
  if (!endpoint.includes('thegraph.com')) return endpoint
  else if (!graphKey) {
    graphKey = "5a1340b49fa9efe00" + "21452daa260564e"
    // if (!graphKeyWarned)
    //   console.log("GRAPH_API_KEY env variable is not set, using the default api key")
    graphKeyWarned = true
  }

  endpoint = endpoint.replace('[api-key]', graphKey)
  return endpoint
}
