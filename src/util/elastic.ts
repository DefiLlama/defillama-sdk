
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

  } catch (error) {
    return;
  }
  return _client
}

export async function writeLog(index: string, log: {
  [key: string]: any
}) {
  const client = getClient()
  if (!client) return;
  index = addYearAndMonth(index)

  if (!log.hasOwnProperty('timestamp'))
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


export type DataIssue = {
  entity_type: 'protocol' | 'chain' | 'coin' | 'stablecoin' | 'rwa' | 'market' | 'pool' | 'table' | 'job'
  entity_id: string | null // the numeric Protocol.id; parent#x and chain#x as they are; never a slug
  parent_id: string | null
  name: string
  metric: string
  day: string | null // the day of the number, not of the run
  value: number | null
  baseline: number | null // the normal level the check compares with
  check: string
  type: 'spike' | 'drop' | 'gap' | 'stale' | 'missing' | 'mismatch' | 'other'
  state: 'live' | 'removed' | 'blocked' | 'disabled' // did the check keep the value out?
  message: string
}

export const dayOf = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10)

// Never rejects. One bulk request, time-limited, as a write to a down Elasticsearch takes up to 20 s.
export async function reportIssues(issues: DataIssue[], { limitMs = 50_000 }: { limitMs?: number } = {}) {
  const client = getClient()
  if (!client) {
    console.warn('Elasticsearch client not configured, skipping reportIssues')
    return;
  }

  const timestamp = +Date.now()
  const docs = issues
    .map(({ value, baseline, ...issue }) => ({ ...issue, value, baseline, timestamp, deviation: value != null && baseline ? (value - baseline) / baseline : null }))
  if (!docs.length) return;

  const write = client.bulk({ index: addYearAndMonth('data-issues'), operations: docs.flatMap((doc) => [{ index: {} }, doc]), timeout: `${limitMs}ms` })
    .then((res) => { if (res.errors) console.error('data-issues bulk write: some items failed') })
    .catch((e: any) => console.error('data-issues write failed:', e?.message))
  await Promise.race([write, new Promise((resolve) => setTimeout(resolve, limitMs).unref?.())])
}