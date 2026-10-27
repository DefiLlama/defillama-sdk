/**
 * Per-run counters for every outbound HTTP request a process makes, attributed to a chain
 * and to the adapter run that made them, and flushed to Elasticsearch when the run ends.
 *
 * How it works
 *  - `install()` wraps `http.request` / `http.get` / `https.request` / `https.get` and subscribes to
 *    the `undici:request:create` diagnostics channel (global `fetch`). That catches axios, ethers,
 *    @solana/web3.js, graphql-request, raw fetch... without touching any call site.
 *  - The SDK registers the RPC urls it resolves for a chain (`registerEndpoints`, called from
 *    LlamaProvider and the `chains/*` endpoint resolvers). A request whose url starts with a
 *    registered endpoint is counted against that chain, everything else against its host only.
 *  - `run(meta, fn)` executes `fn` inside an AsyncLocalStorage context, so concurrent adapter runs
 *    in one process (the server's pooled children) each get their own counters.
 *
 * All state lives on `globalThis` under a well-known symbol: when two copies of the SDK are loaded
 * (server's node_modules + the adapters repo's node_modules) they share one hook, one endpoint
 * registry and one context, and nothing is counted twice.
 */
import { AsyncLocalStorage } from 'async_hooks'
import http from 'http'
import https from 'https'
import diagnosticsChannel from 'diagnostics_channel'
import { writeLog } from './elastic'
import { debugLog, debugTable } from './debugLog'
import { getEnvValue } from './env'

export const ES_INDEX = 'adapter-call-stats'
export const DEFAULT_MIN_CALLS = 50
/** a chain bucket is also kept when it has at least this many getLogs requests, however few calls it made */
export const DEFAULT_MIN_GET_LOGS = 10

export type CallStatsMeta = {
  /** 'tvl' | 'dimensions' | ... */
  application: string
  /** protocol / module name */
  name: string
  [key: string]: any
}

export type CallStats = {
  meta: CallStatsMeta
  startTime: number
  total: number
  /** chain -> requests to a registered rpc endpoint of that chain */
  byChain: Record<string, number>
  /** host -> requests, every request */
  byHost: Record<string, number>
  /** requests that matched no registered endpoint */
  unattributed: number
  /**
   * logical rpc method -> chain -> requests, recorded by the SDK at the call site (`recordMethod`):
   * every LlamaProvider attempt (`call`, `getLogs`, `getBlock`, ...), starknet `getLogs`, and `indexerGetLogs`
   */
  byMethod: Record<string, Record<string, number>>
}

export type CallStatsSnapshot = Pick<CallStats, 'total' | 'byChain' | 'byHost' | 'unattributed' | 'byMethod'>

type EndpointEntry = { path: string, chain: string }

type SharedState = {
  als: AsyncLocalStorage<CallStats>
  installed: boolean
  /** host -> entries, longest path first */
  endpoints: Map<string, EndpointEntry[]>
  /** counters for requests made outside any `run` context */
  global: CallStats
  ignoredHosts: Set<string>
  /** `chain|endpoints` keys already registered: the endpoint resolvers are not cached and run per request */
  registered: Set<string>
}

const STATE_KEY = Symbol.for('@defillama/sdk/callStats')

function newStats(meta: CallStatsMeta): CallStats {
  return { meta, startTime: Date.now(), total: 0, byChain: {}, byHost: {}, unattributed: 0, byMethod: {} }
}

const shared: SharedState = (globalThis as any)[STATE_KEY] ?? ((globalThis as any)[STATE_KEY] = {
  als: new AsyncLocalStorage<CallStats>(),
  installed: false,
  endpoints: new Map(),
  global: newStats({ application: 'global', name: '-' }),
  ignoredHosts: new Set(),
  registered: new Set(),
} as SharedState)

// ---------------------------------------------------------------------------
// endpoint registry
// ---------------------------------------------------------------------------

function parseUrl(url: string): { host: string, path: string } | undefined {
  try {
    const u = new URL(url)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return
    return { host: u.host.toLowerCase(), path: u.pathname.replace(/\/+$/, '') }
  } catch {
    return
  }
}

/**
 * Remember that `endpoints` serve `chain`, so requests to them are counted against that chain.
 * Called by the SDK wherever it resolves rpc urls; adapters can call it for endpoints they manage themselves.
 */
export function registerEndpoints(chain: string | undefined, endpoints: string | string[] | undefined): void {
  if (!chain || !endpoints) return
  chain = chain.toLowerCase()
  // callers pass the same list on every request: skip the url parsing after the first time
  const key = chain + '|' + (Array.isArray(endpoints) ? endpoints.join(',') : endpoints)
  if (shared.registered.has(key)) return
  shared.registered.add(key)
  const list = Array.isArray(endpoints) ? endpoints : endpoints.split(',')
  for (const raw of list) {
    const parsed = parseUrl(String(raw).trim())
    if (!parsed) continue
    let entries = shared.endpoints.get(parsed.host)
    if (!entries) {
      entries = []
      shared.endpoints.set(parsed.host, entries)
    }
    if (entries.some(e => e.path === parsed.path && e.chain === chain)) continue
    entries.push({ path: parsed.path, chain })
    entries.sort((a, b) => b.path.length - a.path.length)
  }
}

/** Chain a url is counted against, or undefined when it matches no registered endpoint. */
export function resolveChain(url: string): string | undefined {
  const parsed = parseUrl(url)
  if (!parsed) return
  const entries = shared.endpoints.get(parsed.host)
  if (!entries) return
  for (const entry of entries) {
    if (!entry.path || parsed.path === entry.path || parsed.path.startsWith(entry.path + '/')) return entry.chain
  }
}

/** Requests to these hosts are not counted (eg. the elasticsearch cluster the stats are written to). */
export function ignoreHost(url: string): void {
  const parsed = parseUrl(url)
  if (parsed) shared.ignoredHosts.add(parsed.host)
}

// ---------------------------------------------------------------------------
// recording
// ---------------------------------------------------------------------------

function record(url: string): void {
  const parsed = parseUrl(url)
  if (!parsed || shared.ignoredHosts.has(parsed.host)) return
  const stats = shared.als.getStore() ?? shared.global
  stats.total++
  stats.byHost[parsed.host] = (stats.byHost[parsed.host] ?? 0) + 1
  const chain = resolveChain(url)
  if (chain) stats.byChain[chain] = (stats.byChain[chain] ?? 0) + 1
  else stats.unattributed++
}

/**
 * Count a logical rpc request (one attempt, so retries count) against `method` and `chain` in the current run.
 * The http layer already counts the request itself; this adds the method breakdown (getLogs being the one that matters).
 */
export function recordMethod(method: string, chain: string = 'unknown'): void {
  const stats = shared.als.getStore() ?? shared.global
  const byChain = stats.byMethod[method] ?? (stats.byMethod[method] = {})
  chain = chain.toLowerCase()
  byChain[chain] = (byChain[chain] ?? 0) + 1
}

function getLogsCount(stats: CallStatsSnapshot, chain?: string): number {
  const byChain = stats.byMethod?.getLogs ?? {}
  if (chain) return byChain[chain] ?? 0
  return Object.values(byChain).reduce((a, b) => a + b, 0)
}

/** method -> requests across chains */
function methodTotals(stats: CallStatsSnapshot): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [method, byChain] of Object.entries(stats.byMethod ?? {}))
    out[method] = Object.values(byChain).reduce((a, b) => a + b, 0)
  return out
}

/** method -> requests for one chain (only methods the chain used) */
function methodsForChain(stats: CallStatsSnapshot, chain: string): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [method, byChain] of Object.entries(stats.byMethod ?? {}))
    if (byChain[chain]) out[method] = byChain[chain]
  return out
}

function urlFromRequestArgs(args: any[], defaultProtocol: string): string | undefined {
  let url: string | undefined
  let options: any
  if (typeof args[0] === 'string') {
    url = args[0]
    if (args[1] && typeof args[1] === 'object') options = args[1]
  } else if (args[0] instanceof URL) {
    url = args[0].href
    if (args[1] && typeof args[1] === 'object') options = args[1]
  } else if (args[0] && typeof args[0] === 'object') {
    options = args[0]
  }
  if (url && (!options || (!options.hostname && !options.host && !options.path))) return url
  if (!options) return url
  // options override the url (same precedence as node)
  const base = url ? new URL(url) : undefined
  const protocol = options.protocol || base?.protocol || defaultProtocol
  const host = options.hostname || options.host || base?.hostname || 'localhost'
  const port = options.port ? `:${options.port}` : (options.hostname || !options.host) && base?.port ? `:${base.port}` : ''
  const path = options.path || (base ? base.pathname + base.search : '/')
  return `${protocol}//${host}${host.includes(':') ? '' : port}${path}`
}

function wrap(mod: any, name: 'request' | 'get', defaultProtocol: string) {
  const original = mod[name]
  if (typeof original !== 'function') return
  const patched = function (this: any, ...args: any[]) {
    try {
      const url = urlFromRequestArgs(args, defaultProtocol)
      if (url) record(url)
    } catch { /* never break the request */ }
    return original.apply(this, args)
  }
  Object.defineProperty(patched, 'name', { value: original.name })
  mod[name] = patched
}

/** Patch the node http layer. Idempotent, shared across sdk copies. Called by `run`. */
export function install(): void {
  if (shared.installed) return
  shared.installed = true
  wrap(http, 'request', 'http:')
  wrap(http, 'get', 'http:')
  wrap(https, 'request', 'https:')
  wrap(https, 'get', 'https:')
  try {
    // global fetch (undici); node < 18.7 has no subscribe, fetch is then simply not counted
    ;(diagnosticsChannel as any).subscribe?.('undici:request:create', (message: any) => {
      try {
        const request = message?.request
        if (request?.origin) record(String(request.origin) + String(request.path ?? ''))
      } catch { /* ignore */ }
    })
  } catch { /* ignore */ }
  try {
    const esConfig = getEnvValue('ELASTICSEARCH_CONFIG')
    if (esConfig) ignoreHost(JSON.parse(esConfig.replace(/\\"/g, '"')).host)
  } catch { /* ignore */ }
}

// ---------------------------------------------------------------------------
// run context
// ---------------------------------------------------------------------------

export type RunOptions = {
  /** chain / host buckets below this are dropped, and nothing is written when the total is below it (default 50, env LLAMA_SDK_CALL_STATS_MIN_CALLS) */
  minCalls?: number
  /** print the summary table to the console (always, not only in debug mode) */
  print?: boolean
  /** skip the elasticsearch write */
  skipElastic?: boolean
}

/** Stats of the current run context, or the process-wide bucket when called outside `run`. */
export function getCurrent(): CallStats {
  return shared.als.getStore() ?? shared.global
}

export function snapshot(stats: CallStats = getCurrent()): CallStatsSnapshot {
  const byMethod: CallStats['byMethod'] = {}
  for (const [method, byChain] of Object.entries(stats.byMethod)) byMethod[method] = { ...byChain }
  return { total: stats.total, byChain: { ...stats.byChain }, byHost: { ...stats.byHost }, unattributed: stats.unattributed, byMethod }
}

export function mergeSnapshots(snapshots: CallStatsSnapshot[]): CallStatsSnapshot {
  const out: CallStatsSnapshot = { total: 0, byChain: {}, byHost: {}, unattributed: 0, byMethod: {} }
  for (const s of snapshots) {
    if (!s) continue
    out.total += s.total ?? 0
    out.unattributed += s.unattributed ?? 0
    for (const [k, v] of Object.entries(s.byChain ?? {})) out.byChain[k] = (out.byChain[k] ?? 0) + v
    for (const [k, v] of Object.entries(s.byHost ?? {})) out.byHost[k] = (out.byHost[k] ?? 0) + v
    for (const [method, byChain] of Object.entries(s.byMethod ?? {})) {
      const target = out.byMethod[method] ?? (out.byMethod[method] = {})
      for (const [k, v] of Object.entries(byChain)) target[k] = (target[k] ?? 0) + v
    }
  }
  return out
}

/**
 * Run `fn` with its own counters and report them when it settles (success or failure).
 * Nested calls get their own context; calls made by `fn` through any http client are attributed to it.
 */
export async function run<T>(meta: CallStatsMeta, fn: () => Promise<T>, options: RunOptions = {}): Promise<T> {
  install()
  const stats = newStats(meta)
  return shared.als.run(stats, async () => {
    let success = false
    try {
      const result = await fn()
      success = true
      return result
    } finally {
      try {
        await report(stats, { success, runtime: (Date.now() - stats.startTime) / 1000, ...options })
      } catch (e) {
        debugLog('[callStats] failed to report', (e as any)?.message)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

function sortedEntries(map: Record<string, number>, minCalls: number, limit?: number): { key: string, calls: number }[] {
  const entries = Object.entries(map).filter(([, calls]) => calls >= minCalls).map(([key, calls]) => ({ key, calls }))
  entries.sort((a, b) => b.calls - a.calls)
  return limit ? entries.slice(0, limit) : entries
}

export function getMinCalls(minCalls?: number): number {
  if (minCalls !== undefined) return minCalls
  return +(getEnvValue('CALL_STATS_MIN_CALLS', String(DEFAULT_MIN_CALLS)) as string)
}

function getMinGetLogs(): number {
  return +(getEnvValue('CALL_STATS_MIN_GET_LOGS', String(DEFAULT_MIN_GET_LOGS)) as string)
}

/**
 * Chains worth a row: at least `minCalls` http requests, or at least `minGetLogs` getLogs requests
 * (a chain that makes 20 getLogs calls is heavier than one making 50 eth_calls). Most calls first.
 */
function chainEntries(stats: CallStatsSnapshot, minCalls: number): { key: string, calls: number, getLogs: number }[] {
  const minGetLogs = getMinGetLogs()
  const chains = new Set([...Object.keys(stats.byChain), ...Object.keys(stats.byMethod?.getLogs ?? {})])
  const entries = [...chains]
    .map(key => ({ key, calls: stats.byChain[key] ?? 0, getLogs: getLogsCount(stats, key) }))
    .filter(i => i.calls >= minCalls || i.getLogs >= minGetLogs)
  entries.sort((a, b) => b.calls - a.calls || b.getLogs - a.getLogs)
  return entries
}

/** Elasticsearch documents for a run: one `run` summary, one `chain` doc per chain and one `host` doc per unattributed host at or above `minCalls`. */
export function buildDocs(stats: CallStatsSnapshot, meta: CallStatsMeta, { success, runtime, minCalls }: { success?: boolean, runtime?: number, minCalls?: number } = {}) {
  minCalls = getMinCalls(minCalls)
  const timestamp = Date.now()
  const chains = chainEntries(stats, minCalls)
  const hosts = sortedEntries(stats.byHost, minCalls, 25)
  const rpcCalls = Object.values(stats.byChain).reduce((a, b) => a + b, 0)
  const getLogsCalls = getLogsCount(stats)
  const unattributedHosts = sortedEntries(
    Object.fromEntries(Object.entries(stats.byHost).filter(([host]) => !shared.endpoints.has(host))), minCalls)
  const docs: any[] = []
  if (stats.total < minCalls && getLogsCalls < getMinGetLogs()) return docs
  docs.push({
    timestamp, type: 'run', metadata: meta, success, runtime,
    calls: stats.total, rpcCalls, otherCalls: stats.unattributed, getLogsCalls,
    methods: methodTotals(stats),
    chains: chains.map(i => ({ chain: i.key, calls: i.calls, getLogs: i.getLogs })),
    hosts: hosts.map(i => ({ host: i.key, calls: i.calls })),
  })
  for (const i of chains) docs.push({ timestamp, type: 'chain', metadata: meta, chain: i.key, calls: i.calls, getLogs: i.getLogs, methods: methodsForChain(stats, i.key) })
  for (const i of unattributedHosts) docs.push({ timestamp, type: 'host', metadata: meta, host: i.key, calls: i.calls })
  return docs
}

/** Write the docs for `stats` to elasticsearch (no-op when ELASTICSEARCH_CONFIG is unset) and print the summary in debug mode. */
export async function report(stats: CallStats | CallStatsSnapshot, { success, runtime, minCalls, print, skipElastic, meta }: RunOptions & { success?: boolean, runtime?: number, meta?: CallStatsMeta } = {}): Promise<void> {
  meta = meta ?? (stats as CallStats).meta ?? { application: 'unknown', name: '-' }
  minCalls = getMinCalls(minCalls)
  const docs = buildDocs(stats, meta, { success, runtime, minCalls })
  if (print) printStats(stats, meta, minCalls, console.log, console.table)
  else printStats(stats, meta, minCalls, debugLog, debugTable)
  if (skipElastic || !docs.length) return
  await Promise.all(docs.map(doc => writeLog(ES_INDEX, doc)))
}

function printStats(stats: CallStatsSnapshot, meta: CallStatsMeta, minCalls: number, log: Function, table: Function) {
  const getLogsCalls = getLogsCount(stats)
  if (stats.total < minCalls && getLogsCalls < getMinGetLogs()) return
  log(`[callStats] ${meta.application}/${meta.name}: ${stats.total} http requests (${stats.unattributed} not matching a known rpc, ${getLogsCalls} getLogs)`)
  const rows = [
    ...chainEntries(stats, minCalls).map(i => ({ chain: i.key, calls: i.calls, getLogs: i.getLogs })),
    ...sortedEntries(Object.fromEntries(Object.entries(stats.byHost).filter(([host]) => !shared.endpoints.has(host))), minCalls).map(i => ({ chain: `host: ${i.key}`, calls: i.calls, getLogs: 0 })),
  ]
  if (rows.length) table(rows)
}
