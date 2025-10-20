
import { Client, } from '@elastic/elasticsearch'
import { getEnvValue } from './env'
import { debugLog } from './debugLog'

let _client: Client | undefined

export function getClient() {
  if (_client) return _client
  let config: any
  try {
    const envString = getEnvValue('ELASTICSEARCH_CONFIG')
    if (!envString) return;
    config = JSON.parse(envString.replace(/\\"/g, '"')) // replace escaped quotes
  } catch (error) {
    return;
  }
  if (!_client)
    _client = new Client({
      maxRetries: 3,
      requestTimeout: 5000,
      compression: true,
      node: config.host,
      auth: {
        username: config.username,
        password: config.password,
      },
    })
  return _client
}

export async function writeLog(index: string, log: {
  [key: string]: any
}) {
  const client = getClient()
  if (!client) return;
  index = addYearAndMonth(index)
  log.timestamp = +Date.now()
  try {
    await client.index({ index, body: log })
  } catch (error) {
    debugLog((error as Error)?.message || 'Error writing log to Elasticsearch')
  }
}

function addYearAndMonth(index: string) {
  const date = new Date()
  return `${index}-${date.getUTCFullYear()}-${date.getUTCMonth()}`
}

type Metadata = {
  application: string,
  tags?: string[],
  [key: string]: any
}

export async function addDebugLog(body: {
  data: object,
  metadata: Metadata,
}) {
  await writeLog('debug-logs', body)
}

export async function addRuntimeLog(body: {
  metadata: Metadata,
  runtime: number,
  success: boolean,
}) {
  await writeLog('debug-runtime-logs', body)
}

export async function addErrorLog(body: {
  error: object,
  metadata: Metadata,
}) {
  await writeLog('error-logs', body)
}

/**
 * Performs a search operation using the Elasticsearch client
 * 
 * This is a wrapper around the Elasticsearch client's search method.
 * See the Elasticsearch documentation for details:
 * https://www.elastic.co/guide/en/elasticsearch/reference/8.13/search-search.html
 * 
 * @returns The search results as returned by Elasticsearch
 * @throws Error if Elasticsearch client is not configured
 * 
 * @see {@link https://www.elastic.co/guide/en/elasticsearch/client/javascript-api/current/api-reference.html#_search | Elasticsearch Node.js client search API}
 */
export async function search(...options: Parameters<Client['search']>): Promise<ReturnType<Client['search']>> {
  const client = getClient()
  if (!client) throw new Error('Elasticsearch client not configured')
  return client.search(...options)
}

export async function getAllLogs({ index, scrollTime = '1m', size = 100000, query = {
  match_all: {},
} }: {
  index: string,
  scrollTime?: string,
  size?: number,
  query?: object,
}) {
  const client = getClient()
  if (!client) throw new Error('Elasticsearch client not configured')
  const allLogs: any[] = [];
  let response: any = await client.search({
    index: index,
    scroll: scrollTime,
    body: { query, size, },
  });

  while (response.hits.hits.length) {
    allLogs.push(
      ...response.hits.hits.map((i: any) => {
        const source = i._source;
        // reduce final file size by removing fields we don't need
        // delete source.chain
        // delete source.address
        // delete source.adapter
        return source;
      })
    );
    debugLog(`Fetched ${allLogs.length} records, ${response.hits.hits.length} in batch`);
    response = await client.scroll({
      scroll_id: response._scroll_id,
      scroll: scrollTime,
    });
  }

  return allLogs;
}
