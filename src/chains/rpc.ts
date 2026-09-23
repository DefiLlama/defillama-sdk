/**
 * Shared transport for the non-EVM chain modules under `sdk.chains.*`.
 *
 * Every chain module resolves its endpoints through `getEndpoints`. When
 * `<CHAIN>_WHITELISTED_RPC` is set only those endpoints are used; otherwise the
 * `<CHAIN>_RPC` env var (and the `SDK_` / `LLAMA_SDK_` prefixed variants read by
 * `getEnvValue`) is tried first, followed by the module's built-in defaults.
 * Comma separated values give a list; `jsonRpc` / `httpGet` / `httpPost` start
 * at the first entry, rotate to the next on failure and retry with backoff.
 */
import axios, { AxiosRequestConfig } from "axios";
import pLimit from "p-limit";
import { getEnvRPC, getEnvValue, getWhitelistedRPCs } from "../util/env";
import { formError, sleep } from "../util/common";
import { debugLog } from "../util/debugLog";

export type Endpoints = string | string[] | undefined

export interface RetryOptions {
  /** total attempts across all endpoints, default 3 */
  retries?: number
  /** base delay in ms between attempts, default 500 */
  delay?: number
  /** multiplier applied to delay after every failed attempt, default 2 */
  backoff?: number
  /** max delay in ms, default 10_000 */
  maxDelay?: number
  /** return false to abort retrying for a given error */
  shouldRetry?: (error: any, attempt: number) => boolean
  /** label used in error messages */
  label?: string
}

export interface HttpOptions extends RetryOptions {
  timeout?: number
  headers?: Record<string, string>
  /** axios `params` (query string) */
  params?: Record<string, any>
  /** extra axios config merged last */
  axiosConfig?: AxiosRequestConfig
  /** return the full axios response (data, headers, status) instead of only `data` */
  withMetadata?: boolean
}

export interface JsonRpcOptions extends HttpOptions {
  /** chain key, used to look up `<CHAIN>_RPC` and passed to `getEndpoints` */
  chain?: string
  /** explicit endpoint(s); overrides `chain` */
  endpoints?: Endpoints
  /** module defaults used when neither env nor `endpoints` is set */
  defaultEndpoints?: Endpoints
  id?: number | string
}

export interface JsonRpcCall {
  method: string
  params?: any
  id?: number | string
}

const DEFAULT_TIMEOUT = 60_000

// ---------------------------------------------------------------------------
// endpoint resolution
// ---------------------------------------------------------------------------

export function toEndpointList(value: Endpoints): string[] {
  if (!value) return []
  const list = Array.isArray(value) ? value : value.split(',')
  return list.map(i => i.trim()).filter(Boolean)
}

/**
 * Resolve the endpoint list for a chain. `<CHAIN>_WHITELISTED_RPC` wins outright
 * when set. Otherwise env (`<CHAIN>_RPC` or `envKey`, comma separated) comes
 * first followed by the module defaults, then the generic fallback.
 * Throws when nothing is configured so a misconfigured chain fails loudly.
 */
export function getEndpoints(chain: string | undefined, defaults?: Endpoints, { envKey, fallback, }: { envKey?: string, fallback?: Endpoints } = {}): string[] {
  if (chain) {
    const whitelisted = toEndpointList(getWhitelistedRPCs(chain))
    if (whitelisted.length) return whitelisted
  }
  let fromEnv: string | undefined
  if (envKey) fromEnv = getEnvValue(envKey)
  else if (chain) fromEnv = getEnvRPC(chain)
  const list = [...new Set([...toEndpointList(fromEnv), ...toEndpointList(defaults)])]
  if (list.length) return list
  const fallbackList = toEndpointList(fallback)
  if (fallbackList.length) return fallbackList
  throw new Error(`No RPC endpoint configured for chain "${chain ?? '-'}"${envKey ? ` (env ${envKey})` : chain ? ` (env ${chain.toUpperCase()}_RPC)` : ''}`)
}

/** First endpoint of `getEndpoints` */
export function getEndpoint(chain: string | undefined, defaults?: Endpoints, options?: { envKey?: string, fallback?: Endpoints }): string {
  return getEndpoints(chain, defaults, options)[0]
}

export function stripTrailingSlash(url: string) {
  return url.replace(/\/+$/, '')
}

export function joinUrl(base: string, path: string) {
  if (!path) return base
  return stripTrailingSlash(base) + '/' + path.replace(/^\/+/, '')
}

// ---------------------------------------------------------------------------
// retry / concurrency
// ---------------------------------------------------------------------------

export function isRateLimitError(e: any): boolean {
  const status = e?.response?.status ?? e?.status
  if (status === 429) return true
  const message = String(e?.message ?? e ?? '').toLowerCase()
  return message.includes('429') || message.includes('rate limit') || message.includes('too many requests')
}

export function isRetryableError(e: any): boolean {
  const status = e?.response?.status ?? e?.status
  if (status && status < 500 && status !== 429 && status !== 408) return false
  return true
}

/**
 * Run `fn` with retries and exponential backoff. `fn` receives the attempt index.
 */
export async function withRetry<T>(fn: (attempt: number) => Promise<T>, options: RetryOptions = {}): Promise<T> {
  const { retries = 3, delay = 500, backoff = 2, maxDelay = 10_000, shouldRetry = isRetryableError, label = 'request' } = options
  const attempts = Math.max(1, retries)
  let wait = delay
  let lastError: any
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await fn(attempt)
    } catch (e) {
      lastError = e
      const isLast = attempt === attempts - 1
      if (isLast || !shouldRetry(e, attempt)) break
      const jitter = Math.floor(Math.random() * Math.min(wait, 250))
      debugLog(`[chains.rpc] ${label} failed (attempt ${attempt + 1}/${attempts}), retrying in ${wait}ms: ${shortMessage(e)}`)
      await sleep(Math.min(wait, maxDelay) + jitter)
      wait = Math.min(wait * backoff, maxDelay)
    }
  }
  // keep typed errors (JsonRpcError etc) intact, only reformat transport errors
  if (lastError instanceof JsonRpcError) throw lastError
  throw formError(lastError)
}

const limiters: Record<string, ReturnType<typeof pLimit>> = {}

/**
 * Lazily created per-key concurrency limiter. Concurrency can be overridden with
 * the `<KEY>_RPC_CONCURRENCY` env var.
 */
export function getLimiter(key: string, concurrency = 10) {
  if (!limiters[key]) {
    const envValue = getEnvValue(`${key}_RPC_CONCURRENCY`)
    limiters[key] = pLimit(envValue ? +envValue : concurrency)
  }
  return limiters[key]
}

export function sliceIntoChunks<T>(arr: T[], chunkSize = 100): T[][] {
  const res: T[][] = []
  for (let i = 0; i < arr.length; i += chunkSize) res.push(arr.slice(i, i + chunkSize))
  return res
}

/**
 * Process `items` in chunks, sequentially or with limited concurrency, keeping
 * result order. `fn` receives one chunk and returns an array (flattened) or any value.
 */
export async function runInChunks<T, R>(items: T[], fn: (chunk: T[], index: number) => Promise<R[] | R>, { chunkSize = 100, concurrency = 1, sleepTime = 0 }: { chunkSize?: number, concurrency?: number, sleepTime?: number } = {}): Promise<R[]> {
  const chunks = sliceIntoChunks(items, chunkSize)
  const limit = pLimit(Math.max(1, concurrency))
  const results = await Promise.all(chunks.map((chunk, i) => limit(async () => {
    if (sleepTime && i > 0 && concurrency === 1) await sleep(sleepTime)
    return fn(chunk, i)
  })))
  return results.flat() as R[]
}

// ---------------------------------------------------------------------------
// http
// ---------------------------------------------------------------------------

function buildAxiosConfig(options: HttpOptions): AxiosRequestConfig {
  const { timeout = DEFAULT_TIMEOUT, headers, params, axiosConfig } = options
  return { timeout, headers, params, ...axiosConfig }
}

/**
 * GET `url` (or rotate over several base urls when `url` is an array; `path` is
 * appended to each). Retries transient failures.
 */
export async function httpGet(url: string | string[], options: HttpOptions & { path?: string } = {}): Promise<any> {
  const urls = Array.isArray(url) ? url : [url]
  if (!urls.length) throw new Error('httpGet: no url')
  const config = buildAxiosConfig(options)
  return withRetry(async (attempt) => {
    const base = urls[attempt % urls.length]
    const fullUrl = options.path ? joinUrl(base, options.path) : base
    const res = await axios.get(fullUrl, config)
    return options.withMetadata ? res : res.data
  }, { label: `GET ${shortUrl(urls[0])}`, retries: options.retries ?? Math.max(3, urls.length), ...pickRetry(options) })
}

/**
 * POST `body` to `url` (or rotate over several urls). Retries transient failures.
 */
export async function httpPost(url: string | string[], body: any, options: HttpOptions & { path?: string } = {}): Promise<any> {
  const urls = Array.isArray(url) ? url : [url]
  if (!urls.length) throw new Error('httpPost: no url')
  const config = buildAxiosConfig(options)
  return withRetry(async (attempt) => {
    const base = urls[attempt % urls.length]
    const fullUrl = options.path ? joinUrl(base, options.path) : base
    const res = await axios.post(fullUrl, body, config)
    return options.withMetadata ? res : res.data
  }, { label: `POST ${shortUrl(urls[0])}`, retries: options.retries ?? Math.max(3, urls.length), ...pickRetry(options) })
}

// ---------------------------------------------------------------------------
// json-rpc
// ---------------------------------------------------------------------------

export class JsonRpcError extends Error {
  code?: number
  data?: any
  method: string
  constructor(method: string, error: any) {
    super(`JSON-RPC ${method} failed: ${error?.message ?? JSON.stringify(error)}`)
    this.name = 'JsonRpcError'
    this.code = error?.code
    this.data = error?.data
    this.method = method
  }
}

function resolveRpcEndpoints(options: JsonRpcOptions): string[] {
  const explicit = toEndpointList(options.endpoints)
  if (explicit.length) return explicit
  return getEndpoints(options.chain, options.defaultEndpoints)
}

/**
 * Single JSON-RPC 2.0 call. Returns `result`; throws `JsonRpcError` when the node
 * returns an `error` object. Rotates endpoints and retries on transport errors.
 */
export async function jsonRpc(method: string, params: any = [], options: JsonRpcOptions = {}): Promise<any> {
  const endpoints = resolveRpcEndpoints(options)
  const body = { jsonrpc: '2.0', id: options.id ?? 1, method, params }
  const config = buildAxiosConfig(options)
  return withRetry(async (attempt) => {
    const endpoint = endpoints[attempt % endpoints.length]
    const { data } = await axios.post(endpoint, body, config)
    if (data?.error) throw new JsonRpcError(method, data.error)
    if (data === undefined || data === null || typeof data !== 'object') throw new Error(`JSON-RPC ${method}: empty response from ${shortUrl(endpoint)}`)
    return data.result
  }, {
    label: `${options.chain ?? shortUrl(endpoints[0])} ${method}`,
    retries: options.retries ?? Math.max(3, endpoints.length),
    ...pickRetry(options),
    shouldRetry: options.shouldRetry ?? ((e) => !(e instanceof JsonRpcError) || isRateLimitError(e) || isNodeSideRetryable(e)),
  })
}

/**
 * JSON-RPC 2.0 batch call. Returns results in call order. Individual `error`
 * entries throw unless `permitFailure` is set, in which case they resolve to `undefined`.
 */
export async function jsonRpcBatch(calls: JsonRpcCall[], options: JsonRpcOptions & { permitFailure?: boolean, chunkSize?: number } = {}): Promise<any[]> {
  if (!calls.length) return []
  const endpoints = resolveRpcEndpoints(options)
  const config = buildAxiosConfig(options)
  const chunkSize = options.chunkSize ?? calls.length
  const chunks = sliceIntoChunks(calls, chunkSize)
  const results: any[] = []
  for (const chunk of chunks) {
    const body = chunk.map((c, i) => ({ jsonrpc: '2.0', id: c.id ?? i, method: c.method, params: c.params ?? [] }))
    const data = await withRetry(async (attempt) => {
      const endpoint = endpoints[attempt % endpoints.length]
      const { data } = await axios.post(endpoint, body, config)
      if (!Array.isArray(data)) {
        if (data?.error) throw new JsonRpcError('batch', data.error)
        throw new Error(`JSON-RPC batch: unexpected response from ${shortUrl(endpoint)}`)
      }
      return data
    }, { label: `${options.chain ?? shortUrl(endpoints[0])} batch(${chunk.length})`, retries: options.retries ?? Math.max(3, endpoints.length), ...pickRetry(options) })
    const byId = new Map<any, any>()
    data.forEach((r: any) => byId.set(String(r.id), r))
    chunk.forEach((c, i) => {
      const r = byId.get(String(c.id ?? i))
      if (!r) {
        if (options.permitFailure) return results.push(undefined)
        throw new Error(`JSON-RPC batch: missing response for ${c.method}`)
      }
      if (r.error) {
        if (options.permitFailure) return results.push(undefined)
        throw new JsonRpcError(c.method, r.error)
      }
      results.push(r.result)
    })
  }
  return results
}

// ---------------------------------------------------------------------------
// misc
// ---------------------------------------------------------------------------

function isNodeSideRetryable(e: any) {
  const code = e?.code
  // -32005 node is behind / limit exceeded, -32603 internal error, -32000 server error
  return code === -32005 || code === -32603 || code === -32000
}

function pickRetry(options: RetryOptions): RetryOptions {
  const { delay, backoff, maxDelay, shouldRetry } = options
  const res: RetryOptions = {}
  if (delay !== undefined) res.delay = delay
  if (backoff !== undefined) res.backoff = backoff
  if (maxDelay !== undefined) res.maxDelay = maxDelay
  if (shouldRetry !== undefined) res.shouldRetry = shouldRetry
  return res
}

export function shortUrl(url: string) {
  try {
    const u = new URL(url)
    return u.host
  } catch {
    return String(url).slice(0, 60)
  }
}

function shortMessage(e: any) {
  return String(e?.message ?? e).slice(0, 200)
}

export { sleep }
