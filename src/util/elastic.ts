import { Client } from '@elastic/elasticsearch'
import { getEnvValue } from './env'

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
    console.error(error)
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