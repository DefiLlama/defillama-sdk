// Shared cache for contract calls whose result rarely or never changes (symbol, decimals, token0, ...).
// Enabled only when RPC_CALL_CACHE_REDIS is set to a redis connection url, without it every function here is a no-op.
// Each call is its own redis key with its own TTL, so concurrent jobs on different machines never overwrite
// each other's entries. A redis failure is never an adapter failure: reads turn into cache misses and writes are dropped.
//
// A key holds one of three things:
//   {"v": output}  the result of the call
//   {"f": time}    the call failed once at the contract level (revert/undecodable result), it is still sent to the rpc
//   {"e": 1}       the call failed again on a later run, it is no longer sent to the rpc until the key expires
//
// "recent" below means the call reads the current state of the chain (no block, or a block of the last two hours).
// Values that can never change are valid at every block. Everything else (the 12h class, empty results, failures)
// describes the current state only, so it is read and written by recent calls only.

import { debugLog } from "./debugLog";
import { getBoolEnvValue, getEnvValue } from "./env";

const KEY_PREFIX = 'rpc-call:v1'
const MINUTE = 60
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

export const RPC_CALL_CACHE_TTL = {
  immutable: 30 * DAY,  // symbol, name, decimals, other strings, token0, token1, asset, allPairs(i), getPair(a, b), ...
  generic: 12 * HOUR,   // any other getter without arguments that returns an address
  empty: 12 * HOUR,     // a call that returned an empty string or the null address
  failure: 24 * HOUR,   // a call that failed at the contract level on two separate runs
}

// a failure is cached only when it is seen again at least this long after the first time, so a node that is briefly
// behind (or a batch that ran out of gas) cannot turn into a day of nulls for every job
export const RPC_CALL_CACHE_FAILURE_CONFIRM_GAP = 10 * MINUTE

const NULL_ADDRESS = '0x0000000000000000000000000000000000000000'
const REDIS_CHUNK_SIZE = 1000
const REDIS_TIMEOUT_MS = 5000
const COOLDOWN_AFTER_ERROR_MS = 60 * 1000

export type RpcCallCacheRule = {
  ttl: number                // in seconds
  signature: string          // part of the cache key, ex: token0():address
  blockIndependent: boolean  // the value is the same at every block, so calls pinned to an old block can use it too
}

export type RpcCallCacheCall = {
  target: string
  params?: any[]
}

// what the cache knows about a call, undefined when it knows nothing
export type RpcCallCacheEntry =
  | { output: any }             // cached result
  | { failure: true }           // cached failure, the call must not be sent to the rpc
  | { failedOnceAt: number }    // not a hit: the call failed once (unix timestamp), pass it back if it fails again

export type RpcCallCacheWrite = RpcCallCacheCall & (
  | { output: any }
  | { failed: true, failedOnceAt?: number }
)

export type RpcCallCacheOptions = {
  isRecent: boolean
}

// getters without arguments that point at a token/contract fixed at deployment. Names are normalised, see normaliseName
const structuralGetters = new Set([
  'token0', 'token1', 'tokena', 'tokenb', 'tokenx', 'tokeny',
  'asset', 'token', 'underlying', 'underlyingtoken', 'underlyingasset', 'underlyingassetaddress',
  'want', 'stakingtoken', 'staketoken', 'stakedtoken', 'deposittoken', 'lptoken', 'pooltoken',
  'collateral', 'collateraltoken', 'collateralasset', 'collateraladdress',
  'base', 'basetoken', 'baseasset', 'quote', 'quotetoken', 'quoteasset', 'quotetokenaddress',
  'reservetoken', 'fundsasset', 'borrowedtoken', 'gem',
  'factory', 'weth',
])

// bytes32 ids fixed at deployment, ex: balancer getPoolId, maker ilk
const structuralIds = new Set(['poolid', 'ilk'])

// append only lists read by index, ex: allPairs(uint256), coins(uint256)
const structuralIndexedGetters = new Set(['allpairs', 'allpools', 'coins', 'underlyingcoins'])

// factory lookups, they return the null address until the pool is created
const structuralLookups = new Set(['pair', 'pool', 'poolbypair'])

const isUint = (type: string) => /^uint\d*$/.test(type)
const isInt = (type: string) => /^u?int\d*$/.test(type)

// getTokenX -> tokenx, underlying_coins -> underlyingcoins, UNDERLYING_ASSET_ADDRESS -> underlyingassetaddress
function normaliseName(name: string) {
  return name.toLowerCase().replace(/_/g, '').replace(/^get/, '')
}

function getTtl(name: string, inputTypes: string[], outputType: string): number | undefined {
  const rawName = name.toLowerCase()
  const normalisedName = normaliseName(name)

  if (!inputTypes.length) {
    if ((rawName === 'symbol' || rawName === 'name') && outputType === 'bytes32') return RPC_CALL_CACHE_TTL.immutable
    if (rawName === 'decimals' && isUint(outputType)) return RPC_CALL_CACHE_TTL.immutable
    if (outputType === 'string') return RPC_CALL_CACHE_TTL.immutable
    if (outputType === 'address' && structuralGetters.has(normalisedName)) return RPC_CALL_CACHE_TTL.immutable
    if (outputType === 'bytes32' && structuralIds.has(normalisedName)) return RPC_CALL_CACHE_TTL.immutable
    if (outputType === 'address') return RPC_CALL_CACHE_TTL.generic
    return undefined
  }

  if (outputType !== 'address') return undefined

  if (inputTypes.length === 1 && isInt(inputTypes[0]) && structuralIndexedGetters.has(normalisedName))
    return RPC_CALL_CACHE_TTL.immutable

  if (structuralLookups.has(normalisedName) && (inputTypes.length === 2 || inputTypes.length === 3)
    && inputTypes[0] === 'address' && inputTypes[1] === 'address' && (inputTypes.length === 2 || isInt(inputTypes[2])))
    return RPC_CALL_CACHE_TTL.immutable

  return undefined
}

// abi must be a resolved function fragment ({ name, inputs, outputs }), returns undefined if the call must not be cached
export function getRpcCallCacheRule(abi: any): RpcCallCacheRule | undefined {
  if (!abi || typeof abi !== 'object' || typeof abi.name !== 'string') return undefined
  if (abi.type && abi.type !== 'function') return undefined
  if (!Array.isArray(abi.outputs) || abi.outputs.length !== 1) return undefined

  const outputType = abi.outputs[0]?.type
  const inputTypes = (abi.inputs ?? []).map((i: any) => i?.type)
  if (typeof outputType !== 'string' || inputTypes.some((i: any) => typeof i !== 'string')) return undefined

  const ttl = getTtl(abi.name, inputTypes, outputType)
  if (!ttl) return undefined
  return {
    ttl,
    signature: `${abi.name}(${inputTypes.join(',')}):${outputType}`,
    blockIndependent: ttl === RPC_CALL_CACHE_TTL.immutable,
  }
}

export function getRpcCallCacheKey(chain: string, rule: RpcCallCacheRule, call: RpcCallCacheCall): string {
  const params = call.params ?? []
  const paramsKey = params.length ? ':' + params.map((i: any) => String(i).toLowerCase()).join(',') : ''
  return `${KEY_PREFIX}:${chain}:${call.target.toLowerCase()}:${rule.signature}${paramsKey}`
}

// an empty string or the null address: a real answer, but one that usually means "not set yet"
function isEmptyOutput(output: any) {
  if (output === '') return true
  return typeof output === 'string' && output.toLowerCase() === NULL_ADDRESS
}

export const rpcCallCacheStats = { hits: 0, misses: 0, writes: 0, errors: 0 }

let client: any
let connecting: Promise<any> | undefined
let disabledUntil = 0

function getRedisUrl() {
  return getEnvValue('RPC_CALL_CACHE_REDIS')
}

export function isRpcCallCacheEnabled(): boolean {
  return !!getRedisUrl()
}

// opt in, RPC_CALL_CACHE_EMPTY=true: also cache empty string / null address results.
// Without it those calls go to the rpc every time and entries of that kind are ignored
export function isRpcCallCacheEmptyEnabled(): boolean {
  return getBoolEnvValue('RPC_CALL_CACHE_EMPTY')
}

// opt in, RPC_CALL_CACHE_ERROR=true: also cache contract level failures (flag on the first one, cached on the second).
// Without it failing calls go to the rpc every time and entries of that kind are ignored
export function isRpcCallCacheErrorEnabled(): boolean {
  return getBoolEnvValue('RPC_CALL_CACHE_ERROR')
}

// opt in, RPC_CALL_CACHE_ADDRESS=true: also cache the 12h class, ie. any getter without arguments that returns an
// address and is not a known fixed one (owner, strategy, oracle, ...)
export function isRpcCallCacheAddressEnabled(): boolean {
  return getBoolEnvValue('RPC_CALL_CACHE_ADDRESS')
}

// false if nothing is read or written for this rule and kind of call
export function isRpcCallCacheRuleActive(rule: RpcCallCacheRule, options: RpcCallCacheOptions): boolean {
  if (rule.blockIndependent) return true
  return options.isRecent && isRpcCallCacheAddressEnabled()
}

function onRedisError(error: any) {
  rpcCallCacheStats.errors++
  disabledUntil = Date.now() + COOLDOWN_AFTER_ERROR_MS
  debugLog('[rpc call cache] redis error, cache is skipped for a minute:', error?.message ?? error)
}

async function getClient(): Promise<any> {
  if (!isRpcCallCacheEnabled()) return undefined
  if (Date.now() < disabledUntil) return undefined
  if (client?.isReady) return client
  if (!connecting) connecting = connect().finally(() => { connecting = undefined })
  return connecting
}

async function connect(): Promise<any> {
  destroyClient()
  try {
    const { createClient } = require('@redis/client') // loaded only when the cache is enabled
    const newClient = createClient({
      url: getRedisUrl(),
      disableOfflineQueue: true, // reject instead of queueing while the socket is down, the call falls back to the rpc
      socket: { connectTimeout: REDIS_TIMEOUT_MS, reconnectStrategy: false }, // a dropped connection is replaced on the next call
      commandOptions: { timeout: REDIS_TIMEOUT_MS },
    })
    newClient.on('error', (error: any) => debugLog('[rpc call cache] redis client error:', error?.message ?? error))
    client = newClient
    await newClient.connect()
    newClient.unref() // an idle cache connection must not keep the process alive, see runCommands
    return newClient
  } catch (error) {
    destroyClient()
    onRedisError(error)
    return undefined
  }
}

const commandsInFlight = new WeakMap<any, number>()

// The connection is unref'd while idle so it never keeps a finished script alive, but it has to be ref'd while a
// command is pending: otherwise node exits in the middle of the command when nothing else is going on.
async function runCommands<T>(redis: any, commands: () => Promise<T>): Promise<T> {
  const inFlight = commandsInFlight.get(redis) ?? 0
  commandsInFlight.set(redis, inFlight + 1)
  if (inFlight === 0) try { redis.ref() } catch (e) { }
  try {
    return await commands()
  } finally {
    const remaining = (commandsInFlight.get(redis) ?? 1) - 1
    commandsInFlight.set(redis, remaining)
    if (remaining === 0) try { redis.unref() } catch (e) { }
  }
}

function destroyClient() {
  const oldClient = client
  client = undefined
  if (!oldClient) return
  try { oldClient.destroy() } catch (e) { }
}

function parseEntry(reply: any, isRecent: boolean, emptyEnabled: boolean, errorEnabled: boolean): RpcCallCacheEntry | undefined {
  if (typeof reply !== 'string') return undefined
  let stored: any
  try {
    stored = JSON.parse(reply)
  } catch (e) {
    return undefined
  }
  if (!stored || typeof stored !== 'object') return undefined

  if (Object.prototype.hasOwnProperty.call(stored, 'v')) {
    if (stored.v === null || stored.v === undefined) return undefined
    if (isEmptyOutput(stored.v) && (!isRecent || !emptyEnabled)) return undefined
    return { output: stored.v }
  }
  if (!isRecent || !errorEnabled) return undefined
  if (stored.e) return { failure: true }
  if (typeof stored.f === 'number') return { failedOnceAt: stored.f }
  return undefined
}

// returns one entry per call, undefined where the cache knows nothing about the call. Never throws
export async function readRpcCallCache(chain: string, rule: RpcCallCacheRule, calls: RpcCallCacheCall[], options: RpcCallCacheOptions): Promise<(RpcCallCacheEntry | undefined)[]> {
  const entries: (RpcCallCacheEntry | undefined)[] = new Array(calls.length).fill(undefined)
  if (!calls.length) return entries
  if (!isRpcCallCacheRuleActive(rule, options)) return entries
  const redis = await getClient()
  if (!redis) return entries

  try {
    const emptyEnabled = isRpcCallCacheEmptyEnabled()
    const errorEnabled = isRpcCallCacheErrorEnabled()
    const keys = calls.map(call => getRpcCallCacheKey(chain, rule, call))
    await runCommands(redis, async () => {
      for (let i = 0; i < keys.length; i += REDIS_CHUNK_SIZE) {
        const replies = await redis.mGet(keys.slice(i, i + REDIS_CHUNK_SIZE))
        replies.forEach((reply: any, j: number) => {
          entries[i + j] = parseEntry(reply, options.isRecent, emptyEnabled, errorEnabled)
        })
      }
    })
  } catch (error) {
    onRedisError(error)
    return new Array(calls.length).fill(undefined)
  }

  const hits = entries.filter(isRpcCallCacheHit).length
  rpcCallCacheStats.hits += hits
  rpcCallCacheStats.misses += entries.length - hits
  return entries
}

// true when the entry answers the call (a result or a confirmed failure), so the rpc is not needed
export function isRpcCallCacheHit(entry: RpcCallCacheEntry | undefined): entry is { output: any } | { failure: true } {
  return !!entry && !('failedOnceAt' in entry)
}

// what to store for a call and for how long, undefined if nothing must be stored
function getWrite(rule: RpcCallCacheRule, entry: RpcCallCacheWrite, isRecent: boolean, emptyEnabled: boolean, errorEnabled: boolean, now: number): { value: string, ttl: number } | undefined {
  if (!isRpcCallCacheRuleActive(rule, { isRecent })) return undefined
  if ('failed' in entry) {
    if (!errorEnabled) return undefined
    if (!isRecent) return undefined // at an old block a failure can just mean "not deployed yet"
    if (typeof entry.failedOnceAt !== 'number') return { value: JSON.stringify({ f: now }), ttl: RPC_CALL_CACHE_TTL.failure }
    if (now - entry.failedOnceAt < RPC_CALL_CACHE_FAILURE_CONFIRM_GAP) return undefined
    return { value: JSON.stringify({ e: 1 }), ttl: RPC_CALL_CACHE_TTL.failure }
  }

  if (entry.output === null || entry.output === undefined) return undefined
  if (isEmptyOutput(entry.output)) {
    if (!emptyEnabled) return undefined
    if (!isRecent) return undefined // may be set by now
    return { value: JSON.stringify({ v: entry.output }), ttl: Math.min(rule.ttl, RPC_CALL_CACHE_TTL.empty) }
  }
  return { value: JSON.stringify({ v: entry.output }), ttl: rule.ttl }
}

// stores call results and contract level failures (never rpc failures, the caller must not pass those). Never throws
export async function writeRpcCallCache(chain: string, rule: RpcCallCacheRule, entries: RpcCallCacheWrite[], options: RpcCallCacheOptions): Promise<void> {
  const now = Math.floor(Date.now() / 1000)
  const emptyEnabled = isRpcCallCacheEmptyEnabled()
  const errorEnabled = isRpcCallCacheErrorEnabled()
  const writes: { key: string, value: string, ttl: number }[] = []
  entries.forEach(entry => {
    const write = getWrite(rule, entry, options.isRecent, emptyEnabled, errorEnabled, now)
    if (write) writes.push({ key: getRpcCallCacheKey(chain, rule, entry), ...write })
  })
  if (!writes.length) return;
  const redis = await getClient()
  if (!redis) return;

  try {
    await runCommands(redis, async () => {
      for (let i = 0; i < writes.length; i += REDIS_CHUNK_SIZE) {
        const pipeline = redis.multi()
        writes.slice(i, i + REDIS_CHUNK_SIZE).forEach(write => {
          pipeline.set(write.key, write.value, { EX: write.ttl })
        })
        await pipeline.execAsPipeline()
      }
    })
    rpcCallCacheStats.writes += writes.length
  } catch (error) {
    onRedisError(error)
  }
}

// closes the redis connection, the next cached call opens a new one
export async function closeRpcCallCache() {
  if (connecting) await connecting
  destroyClient()
  disabledUntil = 0
}
