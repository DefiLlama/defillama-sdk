/**
 * Per-run counters for every outbound HTTP request a process makes, attributed to a chain
 * and to the adapter run that made them, and flushed to Elasticsearch when the run ends.
 *
 * What gets written (see `buildDocs`)
 *  - `adapter-calls`: one flat doc per (run, chain) carrying the run's meta (application, name, runType...),
 *    `chain`, `calls` (rpc http requests), `getLogs` (rpc getLogs attempts), `indexerCalls` (http requests to
 *    the llama indexer for that chain), `logs` / `logsRpc` / `logsIndexer` (log rows fetched over the wire),
 *    `methods.*`, the run totals (`runCalls`, `runGetLogs`, `runLogs`), `success`, `runtime` and a shared
 *    `runId`. Requests matching no registered rpc go to `chain: "_other"`. Nothing is dropped, so a terms
 *    aggregation on `chain` or `name` over any time range is exact.
 *  - `adapter-call-hosts`: one doc per (run, host) for the 25 busiest hosts of the run, same base fields
 *    plus `host` and `rpc` (true when the host is a registered rpc endpoint).
 *  - `adapter-reads` (only when env CALL_STATS_RECORD_READS=true): one doc per (run, chain) listing the DISTINCT
 *    `balances` (`owner|token`) and `calls` (`contract|function`) the run read, sorted, with their counts. Written
 *    with a stable id (adapter + chain), so a successful run replaces the previous doc; failed or interrupted runs
 *    write nothing. A run reading more than CALL_STATS_READS_MAX (default 2000) distinct pairs writes a single
 *    `chain: "_all"` doc with empty lists and `truncated: true`. Reads made outside `run` are not recorded.
 *  All carry `@timestamp` (ISO) so Kibana picks it up as the time field with no index template.
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
import crypto from 'crypto'
import http from 'http'
import https from 'https'
import diagnosticsChannel from 'diagnostics_channel'
import { writeLog } from './elastic'
import { debugLog, debugTable } from './debugLog'
import { getEnvValue } from './env'
import { ETHER_ADDRESS } from '../general'

/** one doc per (run, chain) */
export const ES_INDEX = 'adapter-calls'
/** one doc per (run, host) */
export const ES_HOST_INDEX = 'adapter-call-hosts'
/** one doc per (adapter, chain), replaced by every successful run */
export const ES_READS_INDEX = 'adapter-reads'
/** distinct reads kept per run (env CALL_STATS_READS_MAX), over it the run stores no lists at all */
export const DEFAULT_READS_MAX = 2000
/** `chain` of the doc counting requests that matched no registered rpc endpoint */
export const OTHER_CHAIN = '_other'
/** runs with fewer http requests in total are not written at all (env CALL_STATS_MIN_CALLS) */
export const DEFAULT_MIN_CALLS = 1
export const MAX_HOSTS_PER_RUN = 25

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
  /** log rows fetched over the wire: source ('rpc' | 'indexer') -> chain -> rows, recorded by the SDK (`recordLogs`) */
  logs: Record<LogSource, Record<string, number>>
  /** distinct reads of the run, created on first use (env CALL_STATS_RECORD_READS) */
  reads?: Reads
  /** set once the run's docs were written (by `run` settling, or earlier by `flushActive`) */
  reported?: boolean
}

/** `chain|owner|token` and `chain|contract|function` keys; `truncated`: the cap was passed and the sets were dropped */
export type Reads = { balances: Set<string>, calls: Set<string>, truncated: boolean }
export type ReadsSnapshot = { balances: string[], calls: string[], truncated: boolean }

export type LogSource = 'rpc' | 'indexer'
export const INDEXER_METHOD = 'indexer'

export type CallStatsSnapshot = Pick<CallStats, 'total' | 'byChain' | 'byHost' | 'unattributed' | 'byMethod'> & Partial<Pick<CallStats, 'logs'>> & { reads?: ReadsSnapshot }

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
  /** runs in flight, so a process about to be killed can still write them (`flushActive`) */
  active: Set<CallStats>
}

const STATE_KEY = Symbol.for('@defillama/sdk/callStats')

function newStats(meta: CallStatsMeta): CallStats {
  return { meta, startTime: Date.now(), total: 0, byChain: {}, byHost: {}, unattributed: 0, byMethod: {}, logs: { rpc: {}, indexer: {} } }
}

const shared: SharedState = (globalThis as any)[STATE_KEY] ?? ((globalThis as any)[STATE_KEY] = {
  als: new AsyncLocalStorage<CallStats>(),
  installed: false,
  endpoints: new Map(),
  global: newStats({ application: 'global', name: '-' }),
  ignoredHosts: new Set(),
  registered: new Set(),
  active: new Set(),
} as SharedState)
// the state may have been created by an older sdk copy that did not track active runs
if (!shared.active) shared.active = new Set()

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
export function recordMethod(method: string, chain: string = OTHER_CHAIN): void {
  const stats = shared.als.getStore() ?? shared.global
  const byChain = stats.byMethod[method] ?? (stats.byMethod[method] = {})
  chain = chain.toLowerCase()
  byChain[chain] = (byChain[chain] ?? 0) + 1
}

/** Count `count` log rows fetched from `source` for `chain` in the current run (rows received, cached reads are not fetched). */
export function recordLogs(source: LogSource, chain: string = OTHER_CHAIN, count: number): void {
  if (!(count > 0)) return
  const stats = shared.als.getStore() ?? shared.global
  const byChain = stats.logs[source] ?? (stats.logs[source] = {})
  chain = chain.toLowerCase()
  byChain[chain] = (byChain[chain] ?? 0) + count
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

function getReadsMax(): number {
  const max = +(getEnvValue('CALL_STATS_READS_MAX', String(DEFAULT_READS_MAX)) as string)
  return max >= 0 ? max : DEFAULT_READS_MAX
}

function newReads(): Reads {
  return { balances: new Set(), calls: new Set(), truncated: false }
}

/** Add `key` unless the run is truncated; passing `max` distinct keys truncates the run and frees the sets. */
function addRead(reads: Reads, kind: 'balances' | 'calls', key: string, max: number): void {
  if (reads.truncated || reads[kind].has(key)) return
  if (reads.balances.size + reads.calls.size >= max) {
    reads.truncated = true
    reads.balances = new Set()
    reads.calls = new Set()
    return
  }
  reads[kind].add(key)
}

/** Function name of an abi in any form the sdk accepts (object, `type:name`, signature), `?` when unreadable. */
function abiName(abi: unknown): string {
  if (typeof abi === 'string') {
    const match = abi.includes('(') ? /^\s*(?:function\s+)?([\w$]+)\s*\(/.exec(abi) : /^[^:\s]+:([\w$]+)\s*$/.exec(abi)
    return match?.[1] ?? '?'
  }
  const name = (abi as { name?: unknown } | null | undefined)?.name
  return typeof name === 'string' && name ? name : '?'
}

/** The current run's reads and the cap, or undefined when recording is off, outside a run, or the run is truncated. */
function activeReads(): { reads: Reads, max: number } | undefined {
  if (getEnvValue('CALL_STATS_RECORD_READS') !== 'true') return
  const stats = shared.als.getStore()
  if (!stats) return
  const reads = stats.reads ?? (stats.reads = newReads())
  if (reads.truncated) return
  return { reads, max: getReadsMax() }
}

/**
 * Remember which contract functions and balances the current run reads (env CALL_STATS_RECORD_READS=true, only inside `run`).
 * `balanceOf(owner)` and `getEthBalance(owner)` are balance reads, everything else a `contract|function` read. Never throws.
 * A call carries its contract as `target`, or as `contract` (the abi multiCall's own list).
 */
export function recordReads(chain: string | undefined, abi: unknown, calls: { target?: unknown, contract?: unknown, params?: unknown }[]): void {
  try {
    const active = activeReads()
    if (!active) return
    const { reads, max } = active
    const name = abiName(abi)
    if (name === 'tryAggregate') return // the sdk's own multicall transport, not a read of the adapter
    const chainKey = String(chain ?? 'ethereum').toLowerCase()
    for (const call of calls) {
      if (reads.truncated) return
      const target = call.target ?? call.contract
      if (typeof target !== 'string') continue
      const contract = target.toLowerCase()
      const params = Array.isArray(call.params) ? call.params : call.params === undefined ? [] : [call.params]
      const owner = params.length === 1 && typeof params[0] === 'string' && ADDRESS_RE.test(params[0]) ? params[0].toLowerCase() : undefined
      if (owner && name === 'balanceOf') addRead(reads, 'balances', `${chainKey}|${owner}|${contract}`, max)
      else if (owner && name === 'getEthBalance') addRead(reads, 'balances', `${chainKey}|${owner}|${ETHER_ADDRESS}`, max)
      else addRead(reads, 'calls', `${chainKey}|${contract}|${name}`, max)
    }
  } catch { /* never break the adapter */ }
}

/** Record a balance read that does not go through an abi call (native coin, ethers contract). Same rules as `recordReads`. */
export function recordBalanceRead(chain: string | undefined, owner: unknown, token: unknown): void {
  try {
    if (typeof owner !== 'string' || typeof token !== 'string') return
    const active = activeReads()
    if (active) addRead(active.reads, 'balances', `${String(chain ?? 'ethereum').toLowerCase()}|${owner.toLowerCase()}|${token.toLowerCase()}`, active.max)
  } catch { /* never break the adapter */ }
}

function sumValues(map: Record<string, number> | undefined): number {
  return Object.values(map ?? {}).reduce((a, b) => a + b, 0)
}

function getLogsCount(stats: CallStatsSnapshot, chain?: string): number {
  const byChain = stats.byMethod?.getLogs ?? {}
  if (chain) return byChain[chain] ?? 0
  return sumValues(byChain)
}

function logsFetched(stats: CallStatsSnapshot, source: LogSource, chain?: string): number {
  const byChain = stats.logs?.[source] ?? {}
  if (chain) return byChain[chain] ?? 0
  return sumValues(byChain)
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
  /** nothing is written when the run made fewer http requests in total (default 1, env CALL_STATS_MIN_CALLS) */
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

function copyNested(map: Record<string, Record<string, number>> | undefined): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const [key, byChain] of Object.entries(map ?? {})) out[key] = { ...byChain }
  return out
}

function addNested(target: Record<string, Record<string, number>>, source: Record<string, Record<string, number>> | undefined): void {
  for (const [key, byChain] of Object.entries(source ?? {})) {
    const into = target[key] ?? (target[key] = {})
    for (const [k, v] of Object.entries(byChain)) into[k] = (into[k] ?? 0) + v
  }
}

export function snapshot(stats: CallStats = getCurrent()): CallStatsSnapshot {
  const out: CallStatsSnapshot = {
    total: stats.total, byChain: { ...stats.byChain }, byHost: { ...stats.byHost }, unattributed: stats.unattributed,
    byMethod: copyNested(stats.byMethod), logs: copyNested(stats.logs) as CallStats['logs'],
  }
  if (stats.reads) out.reads = { balances: [...stats.reads.balances], calls: [...stats.reads.calls], truncated: stats.reads.truncated }
  return out
}

export function mergeSnapshots(snapshots: CallStatsSnapshot[]): CallStatsSnapshot {
  const out: CallStatsSnapshot = { total: 0, byChain: {}, byHost: {}, unattributed: 0, byMethod: {}, logs: { rpc: {}, indexer: {} } }
  let reads: Reads | undefined
  for (const s of snapshots) {
    if (!s) continue
    if (s.reads) {
      reads = reads ?? newReads()
      if (s.reads.truncated) {
        reads.truncated = true
        reads.balances = new Set()
        reads.calls = new Set()
      }
      const max = getReadsMax()
      for (const key of s.reads.balances ?? []) addRead(reads, 'balances', key, max)
      for (const key of s.reads.calls ?? []) addRead(reads, 'calls', key, max)
    }
    out.total += s.total ?? 0
    out.unattributed += s.unattributed ?? 0
    for (const [k, v] of Object.entries(s.byChain ?? {})) out.byChain[k] = (out.byChain[k] ?? 0) + v
    for (const [k, v] of Object.entries(s.byHost ?? {})) out.byHost[k] = (out.byHost[k] ?? 0) + v
    addNested(out.byMethod, s.byMethod)
    addNested(out.logs!, s.logs)
  }
  if (reads) out.reads = { balances: [...reads.balances], calls: [...reads.calls], truncated: reads.truncated }
  return out
}

/**
 * Run `fn` with its own counters and report them when it settles (success or failure).
 * Nested calls get their own context; calls made by `fn` through any http client are attributed to it.
 */
export async function run<T>(meta: CallStatsMeta, fn: () => Promise<T>, options: RunOptions = {}): Promise<T> {
  install()
  const stats = newStats(meta)
  shared.active.add(stats)
  return shared.als.run(stats, async () => {
    let success = false
    try {
      const result = await fn()
      success = true
      return result
    } finally {
      shared.active.delete(stats)
      // already written by flushActive: the run was given up on (timeout / shutdown), its outcome no longer counts
      if (!stats.reported) {
        stats.reported = true
        try {
          await report(stats, { success, runtime: (Date.now() - stats.startTime) / 1000, ...options })
        } catch (e) {
          debugLog('[callStats] failed to report', (e as any)?.message)
        }
      }
    }
  })
}

/**
 * Write the docs of the runs still in flight (all of them, or those whose meta passes `filter`) as failed runs
 * with `interrupted: reason`, and mark them so they are not written again when they eventually settle.
 * For a process that is about to be killed, or a job the caller has given up on: without this the heaviest runs,
 * the ones that hit the timeout, would be exactly the ones never recorded. Returns the number of runs written.
 */
export async function flushActive(reason: string, { filter, ...options }: RunOptions & { filter?: (meta: CallStatsMeta) => boolean } = {}): Promise<number> {
  const runs = [...shared.active].filter(stats => !stats.reported && (!filter || filter(stats.meta)))
  for (const stats of runs) stats.reported = true
  await Promise.all(runs.map(stats => report(stats, { success: false, interrupted: reason, runtime: (Date.now() - stats.startTime) / 1000, ...options })
    .catch(e => debugLog('[callStats] failed to flush', (e as any)?.message))))
  return runs.length
}

// ---------------------------------------------------------------------------
// reporting
// ---------------------------------------------------------------------------

export function getMinCalls(minCalls?: number): number {
  if (minCalls !== undefined) return minCalls
  return +(getEnvValue('CALL_STATS_MIN_CALLS', String(DEFAULT_MIN_CALLS)) as string)
}

export type ChainRow = {
  chain: string
  /** http requests to a registered rpc of the chain (`_other`: requests matching no registered rpc, the indexer included) */
  calls: number
  /** rpc getLogs attempts */
  getLogs: number
  /** http requests to the llama indexer for this chain */
  indexerCalls: number
  /** log rows fetched over the wire, by source and in total */
  logs: number
  logsRpc: number
  logsIndexer: number
  methods: Record<string, number>
}
export type HostRow = { host: string, calls: number, rpc: boolean }

/**
 * One row per chain that made an http request, had an rpc method recorded or had logs fetched, plus `_other`
 * for requests matching no registered rpc. Most calls first. Nothing is thresholded away: the long tail of
 * small adapters is exactly what a per-chain sum must include.
 */
function chainRows(stats: CallStatsSnapshot): ChainRow[] {
  const chains = new Set(Object.keys(stats.byChain))
  for (const byChain of Object.values(stats.byMethod ?? {})) for (const chain of Object.keys(byChain)) chains.add(chain)
  for (const byChain of Object.values(stats.logs ?? {})) for (const chain of Object.keys(byChain)) chains.add(chain)
  if (stats.unattributed > 0) chains.add(OTHER_CHAIN)
  const rows: ChainRow[] = [...chains].map(chain => {
    const methods = methodsForChain(stats, chain)
    const logsRpc = logsFetched(stats, 'rpc', chain)
    const logsIndexer = logsFetched(stats, 'indexer', chain)
    return {
      chain,
      calls: chain === OTHER_CHAIN ? stats.unattributed : stats.byChain[chain] ?? 0,
      getLogs: getLogsCount(stats, chain),
      indexerCalls: methods[INDEXER_METHOD] ?? 0,
      logs: logsRpc + logsIndexer, logsRpc, logsIndexer,
      methods,
    }
  }).filter(r => r.calls > 0 || r.logs > 0 || Object.keys(r.methods).length > 0)
  rows.sort((a, b) => b.calls - a.calls || b.getLogs - a.getLogs || b.logs - a.logs)
  return rows
}

/** The busiest hosts of the run, rpc endpoints included so provider load is visible too. */
function hostRows(stats: CallStatsSnapshot): HostRow[] {
  return Object.entries(stats.byHost)
    .map(([host, calls]) => ({ host, calls, rpc: shared.endpoints.has(host) }))
    .sort((a, b) => b.calls - a.calls)
    .slice(0, MAX_HOSTS_PER_RUN)
}

/** Scalar meta fields become top-level doc fields; arrays/objects (eg. the list of chains to run) would only bloat the mapping. */
function flatMeta(meta: CallStatsMeta): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {}
  for (const [key, value] of Object.entries(meta))
    if (value !== undefined && value !== null && typeof value !== 'object') out[key] = value
  return out
}

/** `readDocs` is only present when there is a doc for `adapter-reads` */
export type CallStatsDocs = { chainDocs: any[], hostDocs: any[], readDocs?: any[] }

/**
 * Elasticsearch documents for a run: `chainDocs` for `adapter-calls` (one per chain) and `hostDocs` for
 * `adapter-call-hosts` (one per host). Every doc carries the run meta, totals and the same `runId`, so
 * run-level questions are a `runId` grouping of the same index. Empty when the run is under `minCalls`.
 */
export type ReportOptions = { success?: boolean, runtime?: number, minCalls?: number, /** why the run was written before it settled ('timeout', 'shutdown'...) */ interrupted?: string }

export function buildDocs(stats: CallStatsSnapshot, meta: CallStatsMeta, { success, runtime, minCalls, interrupted }: ReportOptions = {}): CallStatsDocs {
  const rows = stats.total >= getMinCalls(minCalls) ? chainRows(stats) : []
  const readDocs = success === true && !interrupted ? buildReadDocs(stats.reads, meta) : []
  const docs: CallStatsDocs = rows.length ? buildCallDocs(stats, meta, rows, { success, runtime, interrupted }) : { chainDocs: [], hostDocs: [] }
  if (readDocs.length) docs.readDocs = readDocs
  return docs
}

/** `adapter-reads` docs: one per chain with reads, or one `_all` doc for a truncated run. `_docId` is the doc id the report writes it under. */
function buildReadDocs(reads: ReadsSnapshot | undefined, meta: CallStatsMeta): any[] {
  if (!reads) return []
  const doc = (chain: string, balances: string[], calls: string[], extra: object) => ({
    '@timestamp': new Date().toISOString(),
    ...flatMeta(meta),
    chain, balances, calls, balanceCount: balances.length, callCount: calls.length,
    ...extra,
    _docId: crypto.createHash('sha1').update(`${meta.application}|${meta.name}|${chain}`).digest('hex'),
  })
  if (reads.truncated) return [doc('_all', [], [], { truncated: true, readsMax: getReadsMax() })]
  const byChain = new Map<string, { balances: string[], calls: string[] }>()
  const add = (kind: 'balances' | 'calls', key: string) => {
    const split = key.indexOf('|')
    const chain = key.slice(0, split)
    const entry = byChain.get(chain) ?? byChain.set(chain, { balances: [], calls: [] }).get(chain)!
    entry[kind].push(key.slice(split + 1))
  }
  for (const key of reads.balances ?? []) add('balances', key)
  for (const key of reads.calls ?? []) add('calls', key)
  return [...byChain].sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([chain, { balances, calls }]) => doc(chain, balances.sort(), calls.sort(), { truncated: false }))
}

function buildCallDocs(stats: CallStatsSnapshot, meta: CallStatsMeta, rows: ChainRow[], { success, runtime, interrupted }: ReportOptions): CallStatsDocs {
  const base = {
    '@timestamp': new Date().toISOString(),
    ...flatMeta(meta),
    runId: crypto.randomBytes(8).toString('hex'),
    success, runtime, interrupted,
    runCalls: stats.total,
    runGetLogs: getLogsCount(stats),
    runIndexerCalls: sumValues(stats.byMethod?.[INDEXER_METHOD]),
    runLogs: logsFetched(stats, 'rpc') + logsFetched(stats, 'indexer'),
    runChains: rows.filter(r => r.chain !== OTHER_CHAIN).length,
  }
  return {
    chainDocs: rows.map(r => ({ ...base, ...r })),
    hostDocs: hostRows(stats).map(r => ({ ...base, ...r })),
  }
}

/** Write the docs for `stats` to elasticsearch (no-op when ELASTICSEARCH_CONFIG is unset) and print the summary in debug mode. */
export async function report(stats: CallStats | CallStatsSnapshot, { success, runtime, minCalls, interrupted, print, skipElastic, meta }: RunOptions & ReportOptions & { meta?: CallStatsMeta } = {}): Promise<void> {
  meta = meta ?? (stats as CallStats).meta ?? { application: 'unknown', name: '-' }
  const data = (stats as CallStats).reads?.balances instanceof Set ? snapshot(stats as CallStats) : stats as CallStatsSnapshot
  const { chainDocs, hostDocs, readDocs = [] } = buildDocs(data, meta, { success, runtime, minCalls, interrupted })
  if (print) printStats(data, meta, console.log, console.table)
  else printStats(data, meta, debugLog, debugTable)
  if (skipElastic) return
  await Promise.all([
    ...chainDocs.map(doc => writeLog(ES_INDEX, doc)),
    ...hostDocs.map(doc => writeLog(ES_HOST_INDEX, doc)),
    ...readDocs.map(({ _docId, ...doc }) => writeLog(ES_READS_INDEX, doc, _docId)),
  ])
}

function printStats(stats: CallStatsSnapshot, meta: CallStatsMeta, log: Function, table: Function) {
  if (!stats.total) return
  const logs = logsFetched(stats, 'rpc') + logsFetched(stats, 'indexer')
  log(`[callStats] ${meta.application}/${meta.name}: ${stats.total} http requests (${stats.unattributed} not matching a known rpc, ${getLogsCount(stats)} getLogs, ${sumValues(stats.byMethod?.[INDEXER_METHOD])} indexer requests, ${logs} logs fetched)`)
  const rows = [
    ...chainRows(stats).slice(0, 30).map(r => ({ chain: r.chain, calls: r.calls, getLogs: r.getLogs, indexerCalls: r.indexerCalls, logs: r.logs })),
    ...hostRows(stats).filter(h => !h.rpc).slice(0, 10).map(h => ({ chain: `host: ${h.host}`, calls: h.calls, getLogs: 0, indexerCalls: 0, logs: 0 })),
  ]
  if (rows.length) table(rows)
}
