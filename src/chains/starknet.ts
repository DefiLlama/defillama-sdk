/**
 * Starknet client: dependency-free JSON-RPC transport + Cairo ABI codec.
 *
 * Replaces (and consolidates) these per-repo copies:
 *   - DefiLlama-Adapters  projects/helper/utils/starknet.js   (codec: selectors, addresses, encodeCalldata, decodeOutput)
 *   - DefiLlama-Adapters  projects/helper/chain/starknet.js   (call, multiCall via aggregator / batched, rpc, getBlockNumber, getLogs)
 *   - DefiLlama-Adapters  projects/helper/env.js              (STARKNET_RPC / STARKNET_MULTICALL defaults)
 *   - coins               src/adapters/utils/starknet.ts      (feltArrToStr, cairoErc20Abis, aggregate result layout)
 *   - defi                l2/utils.ts                         (starknetU256ToNumber, hardcoded total_supply / aggregate selectors)
 *   - peggedassets-server src/adapters/peggedAssets/helper/starknet.js (defaultAbis shape)
 *
 * Only the chain plumbing is ported: no TVL helpers (sumTokens / dexExport live
 * with their callers) and no on-disk log cache.
 *
 * Decoding mirrors starknet.js v5 (CallData.parse) so existing ABIs keep working:
 *   - scalars (felt, felt252, uN, ContractAddress, ...) decode to BigInt
 *   - core::bool decodes to boolean
 *   - core::integer::u256 decodes to a single BigInt (low + high << 128)
 *   - bare Cairo 0 "Uint256" WITHOUT a struct definition decodes as ONE felt
 *     (that is what starknet.js did, and adapters such as jediswap reordered
 *     their ABIs around it); with a struct definition it decodes to { low, high }
 *   - structs decode to objects keyed by member name, tuples to objects keyed
 *     by index (or member name for Cairo 0 named tuples), arrays to arrays
 *   - a function with a single unnamed output returns the value directly,
 *     otherwise an object keyed by output name
 *
 * Env: `STARKNET_RPC` (comma separated list, rotated on failure) overrides
 * `DEFAULT_ENDPOINTS`; `STARKNET_MULTICALL` overrides the aggregator address;
 * `STARKNET_RPC_CONCURRENCY` overrides the (default 1) request concurrency.
 */
import { keccak256, toUtf8Bytes } from "ethers";
import { getEnvValue } from "../util/env";
import { debugLog } from "../util/debugLog";
import { getEndpoints as resolveEndpoints, getLimiter, jsonRpc, jsonRpcBatch, JsonRpcError, sliceIntoChunks, sleep } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const CHAIN = 'starknet'

export const DEFAULT_ENDPOINTS = [
  'https://api.zan.top/public/starknet-mainnet',
  'https://starknet-mainnet.public.blastapi.io',
]

// On-chain Multicall aggregator. Collapses N starknet_call executions into a
// single one (the node executes all sub-calls in one call frame), which is the
// real cost win when the RPC bills per sub-call rather than per HTTP request.
// aggregate(calls: Array<Call>) -> (block_number: u64, results: Array<Span<felt252>>)
// NOTE: aggregate reverts atomically: if any sub-call reverts, the whole call
// reverts, so multiCall falls back to per-call batching to preserve permitFailure.
export const DEFAULT_MULTICALL_ADDRESS = '0x01a33330996310a1e3fa1df5b16c1e07f0491fdd20c441126e02613b948f0225'

export const AGGREGATE_CHUNK_SIZE = 50
export const BATCH_CHUNK_SIZE = 25
const CHUNK_SLEEP_MS = 200

export function getEndpoints(): string[] {
  return resolveEndpoints(CHAIN, DEFAULT_ENDPOINTS)
}

export function getMulticallAddress(): string {
  return getEnvValue('STARKNET_MULTICALL', DEFAULT_MULTICALL_ADDRESS) as string
}

const rpcOptions = () => ({ chain: CHAIN, defaultEndpoints: DEFAULT_ENDPOINTS })

// Public Starknet RPCs are stingy, so everything funnels through one limiter
// (override with STARKNET_RPC_CONCURRENCY).
const limiter = () => getLimiter('STARKNET', 1)

// ---------------------------------------------------------------------------
// types
// ---------------------------------------------------------------------------

export interface AbiParam {
  name?: string
  type: string
  /** Cairo 0 struct members carry `offset`; kept open for other metadata */
  [key: string]: any
}

export interface AbiEntry {
  name: string
  type?: string // 'function' | 'struct' | 'enum' | 'event' | ...
  inputs?: AbiParam[]
  outputs?: AbiParam[]
  members?: AbiParam[]
  variants?: AbiParam[]
  stateMutability?: string
  state_mutability?: string
  /** 'address': params are passed through as raw felts, skipping encodeCalldata */
  customInput?: string
  /** post-processing of a single output: 'address' pads, 'Uint256' | 'number' cast to number */
  customType?: string
  [key: string]: any
}

export type BlockTag = 'latest' | 'pending' | 'pre_confirmed' | 'l1_accepted'
export type BlockId = BlockTag | number | string | { block_number: number } | { block_hash: string }

export interface CallOptions {
  abi: AbiEntry
  target: string
  params?: any
  allAbi?: AbiEntry[]
  permitFailure?: boolean
  block?: BlockId
}

export interface MultiCallItem {
  target?: string
  params?: any
  abi?: AbiEntry
  allAbi?: AbiEntry[]
}

export interface MultiCallOptions {
  abi?: AbiEntry
  target?: string
  calls: (MultiCallItem | string)[]
  allAbi?: AbiEntry[]
  permitFailure?: boolean
  useAggregator?: boolean
  block?: BlockId
}

export interface StarknetEvent {
  block_number?: number
  block_hash?: string
  transaction_hash: string
  from_address: string
  keys: string[]
  data: string[]
}

export interface GetLogsOptions {
  target: string
  fromBlock: number
  toBlock?: number
  /** event selectors (any of them): shorthand for keys: [topics] */
  topics?: (string | bigint | number)[]
  /** raw starknet_getEvents keys filter (positional, each an OR list) */
  keys?: (string | bigint | number | (string | bigint | number)[])[]
  /** kept for signature parity with the adapters helper (used there as cache-key segment); ignored */
  extraKey?: string
  /** page size for starknet_getEvents (default 1000; halved and retried when the provider rejects it) */
  chunkSize?: number
}

// ---------------------------------------------------------------------------
// numbers / addresses / selectors
// ---------------------------------------------------------------------------

const ZERO = BigInt(0)
const ONE = BigInt(1)
const SHIFT_128 = BigInt(128)
const MASK_250 = (ONE << BigInt(250)) - ONE
const MASK_128 = (ONE << SHIFT_128) - ONE
export const ADDR_BOUND = (ONE << BigInt(251)) - BigInt(256)
export const FIELD_PRIME = (ONE << BigInt(251)) + BigInt(17) * (ONE << BigInt(192)) + ONE

export type BigNumberish = string | number | bigint | boolean

export function toBigInt(value: BigNumberish): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(value)
  if (typeof value === 'string') return BigInt(value.trim())
  if (typeof value === 'boolean') return value ? ONE : ZERO
  throw new Error(`starknet: cannot convert ${value} to BigInt`)
}

export function toHex(value: BigNumberish): string {
  return '0x' + toBigInt(value).toString(16)
}

export function addAddressPadding(address: BigNumberish): string {
  return '0x' + toBigInt(address).toString(16).padStart(64, '0')
}

export function validateAndParseAddress(address: BigNumberish): string {
  let n: bigint
  try {
    n = toBigInt(address)
  } catch (e) {
    throw new Error(`Starknet Address is not a number: ${address}`)
  }
  if (n < ZERO || n >= ADDR_BOUND) throw new Error(`Starknet Address out of range: ${address}`)
  return addAddressPadding(n)
}

/**
 * Loose check for a Starknet address: 0x-prefixed hex, non-zero, inside the
 * address bound, and not shaped like an EVM address (exactly 40 hex chars).
 */
export function isStarknetAddress(value: any): boolean {
  if (typeof value !== 'string') return false
  const v = value.trim()
  if (!/^0x[0-9a-fA-F]{1,64}$/.test(v)) return false
  if (v.length === 42) return false
  const n = BigInt(v)
  return n > ZERO && n < ADDR_BOUND
}

/** starknet_keccak: keccak256 of the utf8 name, masked to 250 bits */
export function starknetKeccak(str: string): bigint {
  return BigInt(keccak256(toUtf8Bytes(str))) & MASK_250
}

export function getSelectorFromName(name: string): string {
  return toHex(starknetKeccak(name))
}

/** u256 as { low, high } object or [low, high] felt pair -> bigint */
export function parseUint256(value: { low: BigNumberish, high: BigNumberish } | BigNumberish[] | BigNumberish): bigint {
  if (Array.isArray(value)) {
    if (value.length < 2) throw new Error('starknet: u256 needs [low, high]')
    return toBigInt(value[0]) + (toBigInt(value[1]) << SHIFT_128)
  }
  if (value !== null && typeof value === 'object') return toBigInt(value.low) + (toBigInt(value.high) << SHIFT_128)
  return toBigInt(value)
}

/** Cairo short string (<= 31 utf8 bytes) -> hex felt */
export function shortStringToFelt(str: string): string {
  const bytes = Buffer.from(str, 'utf8')
  if (bytes.length > 31) throw new Error(`starknet: short string too long: ${str}`)
  return '0x' + (bytes.toString('hex') || '0')
}

/** hex/decimal/bigint felt -> utf8 short string (leading zero bytes dropped) */
export function feltToShortString(felt: BigNumberish): string {
  const n = toBigInt(felt)
  if (n === ZERO) return ''
  let hex = n.toString(16)
  if (hex.length % 2) hex = '0' + hex
  return Buffer.from(hex, 'hex').toString('utf8')
}

/** concatenate an array of short-string felts (e.g. a felt* name) */
export function feltArrToStr(felts: BigNumberish[]): string {
  return felts.reduce((memo: string, felt) => memo + feltToShortString(felt), '')
}

export const number = {
  toHex,
  toBigInt,
  toBN: toBigInt,
  hexToDecimalString: (v: BigNumberish) => toBigInt(v).toString(),
}

// ---------------------------------------------------------------------------
// ABI type helpers
// ---------------------------------------------------------------------------

type StructMap = Record<string, AbiEntry>
type EnumMap = Record<string, AbiEntry>
type TupleMember = string | { name: string, type: string }

const isLen = (name?: string) => /_len$/.test(name ?? '')
const isCairo1Type = (type: string) => type.includes('::')
const isTypeArray = (type: string) => /\*/.test(type) || type.startsWith('core::array::Array::') || type.startsWith('core::array::Span::')
const isTypeTuple = (type: string) => /^\(.*\)$/.test(type)
const isTypeU256 = (type: string) => type === 'core::integer::u256'
const isTypeLegacyU256 = (type: string) => type === 'Uint256'
const isTypeBool = (type: string) => type === 'core::bool'
const isTypeOption = (type: string) => type.startsWith('core::option::Option::')
const isTypeResult = (type: string) => type.startsWith('core::result::Result::')

function getArrayType(type: string): string {
  if (isCairo1Type(type)) return type.substring(type.indexOf('<') + 1, type.lastIndexOf('>'))
  return type.replace('*', '')
}

// "(a, (b, c), core::array::Array::<x>)" -> ["a", "(b, c)", "core::array::Array::<x>"]
// Cairo 0 named tuples "(x: felt, y: felt)" -> [{ name: 'x', type: 'felt' }, ...]
function extractTupleMemberTypes(type: string): TupleMember[] {
  const inner = type.replace(/\s/g, '').slice(1, -1)
  const members: string[] = []
  let depth = 0, current = ''
  for (const ch of inner) {
    if (ch === '(' || ch === '<') depth++
    else if (ch === ')' || ch === '>') depth--
    if (ch === ',' && depth === 0) {
      members.push(current)
      current = ''
    } else current += ch
  }
  if (current) members.push(current)
  return members.map((m) => {
    if (isCairo1Type(m) || !m.includes(':')) return m
    const idx = m.indexOf(':')
    return { name: m.slice(0, idx), type: m.slice(idx + 1) }
  })
}

const memberType = (m: TupleMember) => typeof m === 'string' ? m : m.type
const memberName = (m: TupleMember, i: number) => typeof m === 'string' ? i : m.name

function getAbiStructs(abi: AbiEntry[]): StructMap {
  const structs: StructMap = {}
  abi.forEach((entry) => { if (entry && entry.type === 'struct') structs[entry.name] = entry })
  return structs
}

function getAbiEnums(abi: AbiEntry[]): EnumMap {
  const enums: EnumMap = {}
  abi.forEach((entry) => { if (entry && entry.type === 'enum') enums[entry.name] = entry })
  delete enums['core::bool']
  return enums
}

// ---------------------------------------------------------------------------
// calldata encoding
// ---------------------------------------------------------------------------

const isHexString = (v: string) => /^0x[0-9a-fA-F]+$/.test(v)
const isDecimalString = (v: string) => /^\d+$/.test(v)

/** encode a single felt (returns hex string) */
function felt(value: any): string {
  if (typeof value === 'bigint' || typeof value === 'number' || typeof value === 'boolean') return toHex(value)
  if (typeof value === 'string') {
    const v = value.trim()
    if (isHexString(v) || isDecimalString(v)) return toHex(v)
    return shortStringToFelt(v)
  }
  throw new Error(`starknet: cannot encode ${JSON.stringify(value)} as felt`)
}

function encodeU256(value: any): string[] {
  if (value !== null && typeof value === 'object' && !Array.isArray(value)) return [felt(value.low), felt(value.high)]
  if (Array.isArray(value)) return [felt(value[0]), felt(value[1])]
  const n = toBigInt(value)
  return [toHex(n & MASK_128), toHex(n >> SHIFT_128)]
}

function encodeValue(value: any, type: string, structs: StructMap, enums: EnumMap): string[] {
  if (value === undefined) throw new Error(`starknet: missing parameter for type ${type}`)
  if (isTypeU256(type) || isTypeLegacyU256(type)) return encodeU256(value)
  if (Array.isArray(value)) {
    const itemType = getArrayType(type)
    const out = [felt(value.length)]
    value.forEach((v) => out.push(...encodeValue(v, itemType, structs, enums)))
    return out
  }
  if (structs[type] && structs[type].members?.length) {
    const out: string[] = []
    structs[type].members!.forEach((m) => out.push(...encodeValue(value[m.name!], m.type, structs, enums)))
    return out
  }
  if (isTypeTuple(type)) {
    const memberTypes = extractTupleMemberTypes(type)
    const elements = Object.values(value)
    if (elements.length !== memberTypes.length) throw new Error(`starknet: tuple size mismatch for ${type}`)
    const out: string[] = []
    memberTypes.forEach((m, i) => out.push(...encodeValue(elements[i], memberType(m), structs, enums)))
    return out
  }
  if (enums[type]) throw new Error(`starknet: enum inputs are not supported (${type})`)
  if (typeof value === 'object') throw new Error(`starknet: parameter ${JSON.stringify(value)} does not match abi type ${type}`)
  return [felt(value)]
}

function asFnAbi(abiOrParams: AbiEntry | AbiParam[], key: 'inputs' | 'outputs'): AbiEntry {
  if (Array.isArray(abiOrParams)) return { name: '', type: 'function', [key]: abiOrParams }
  return abiOrParams
}

/**
 * Encode function arguments into calldata (array of hex felts).
 * @param fnAbi   function abi entry (or just its `inputs` array)
 * @param params  positional arguments
 * @param allAbi  struct/enum definitions referenced by the function
 */
export function encodeCalldata(fnAbi: AbiEntry | AbiParam[], params: any = [], allAbi: AbiEntry[] = []): string[] {
  const abi = asFnAbi(fnAbi, 'inputs')
  if (!Array.isArray(params)) params = [params]
  const structs = getAbiStructs([abi, ...allAbi])
  const enums = getAbiEnums([abi, ...allAbi])
  const inputs = abi.inputs ?? []
  const calldata: string[] = []
  let idx = 0
  for (const input of inputs) {
    // Cairo 0: `foo_len` inputs are derived from the array that follows
    if (isLen(input.name) && !isCairo1Type(input.type)) continue
    calldata.push(...encodeValue(params[idx++], input.type, structs, enums))
  }
  return calldata
}

// ---------------------------------------------------------------------------
// output decoding
// ---------------------------------------------------------------------------

type FeltIterator = Iterator<any>

function next(it: FeltIterator): any {
  const { value, done } = it.next()
  if (done) throw new Error('starknet: response too short for abi')
  return value
}

function decodeBase(type: string, it: FeltIterator): any {
  if (isTypeBool(type)) return Boolean(BigInt(next(it)))
  if (isTypeU256(type)) {
    const low = BigInt(next(it))
    const high = BigInt(next(it))
    return (high << SHIFT_128) + low
  }
  return BigInt(next(it))
}

function decodeValue(it: FeltIterator, type: string, structs: StructMap, enums: EnumMap): any {
  if (type === '()') return {}
  if (isTypeU256(type)) return decodeBase(type, it)
  if (isTypeArray(type)) {
    const itemType = getArrayType(type)
    const len = BigInt(next(it))
    const out: any[] = []
    while (out.length < len) out.push(decodeValue(it, itemType, structs, enums))
    return out
  }
  if (structs[type]) {
    const out: Record<string, any> = {}
    ;(structs[type].members ?? []).forEach((m) => { out[m.name!] = decodeValue(it, m.type, structs, enums) })
    return out
  }
  if (enums[type]) {
    const variantNum = Number(BigInt(next(it)))
    const variant = (enums[type].variants ?? [])[variantNum]
    if (!variant) throw new Error(`starknet: unknown variant ${variantNum} for ${type}`)
    const content = decodeValue(it, variant.type, structs, enums)
    if (isTypeOption(type)) return variantNum === 0 ? content : undefined
    if (isTypeResult(type)) return variantNum === 0 ? { Ok: content } : { Err: content }
    return { [variant.name!]: content }
  }
  if (isTypeTuple(type)) {
    const out: Record<string | number, any> = {}
    extractTupleMemberTypes(type).forEach((m, i) => {
      out[memberName(m, i)] = decodeValue(it, memberType(m), structs, enums)
    })
    return out
  }
  return decodeBase(type, it)
}

function decodeField(it: FeltIterator, output: AbiParam, structs: StructMap, enums: EnumMap, parsed: Record<string | number, any>): any {
  const { name, type } = output
  if (isLen(name)) return BigInt(next(it))
  if (structs[type] || isTypeTuple(type) || enums[type]) return decodeValue(it, type, structs, enums)
  if (isTypeArray(type)) {
    if (isCairo1Type(type)) return decodeValue(it, type, structs, enums)
    // Cairo 0 `foo: felt*` is preceded by a `foo_len: felt` output
    const out: any[] = []
    const len = parsed[`${name}_len`] ?? ZERO
    const itemType = type.replace('*', '')
    while (out.length < len) out.push(decodeValue(it, itemType, structs, enums))
    return out
  }
  return decodeBase(type, it)
}

/**
 * Decode a starknet_call result according to the function abi.
 * @param fnAbi   function abi entry (or just its `outputs` array)
 * @param result  array of felts returned by the node
 * @param allAbi  struct/enum definitions referenced by the function
 */
export function decodeOutput(fnAbi: AbiEntry | AbiParam[], result: any[], allAbi: AbiEntry[] = []): any {
  const abi = asFnAbi(fnAbi, 'outputs')
  const structs = getAbiStructs([abi, ...allAbi])
  const enums = getAbiEnums([abi, ...allAbi])
  const it = result.flat()[Symbol.iterator]()
  const parsed: Record<string | number, any> = {}
  const outputs = abi.outputs ?? []
  outputs.forEach((output, idx) => {
    const key = output.name ?? idx
    parsed[key] = decodeField(it, output, structs, enums, parsed)
    if (parsed[key] && parsed[`${key}_len`]) delete parsed[`${key}_len`]
  })
  return Object.keys(parsed).length === 1 && 0 in parsed ? parsed[0] : parsed
}

// ---------------------------------------------------------------------------
// call bodies / output post-processing
// ---------------------------------------------------------------------------

export function toBlockId(block?: BlockId): any {
  if (block === undefined || block === null) return 'latest'
  if (typeof block === 'number') return { block_number: block }
  if (typeof block === 'string') {
    if (['latest', 'pending', 'pre_confirmed', 'l1_accepted'].includes(block)) return block
    if (/^0x[0-9a-fA-F]+$/.test(block)) return { block_hash: block }
    if (/^\d+$/.test(block)) return { block_number: +block }
    throw new Error(`starknet: invalid block id ${block}`)
  }
  return block
}

export interface StarknetCallRequest {
  contract_address: string
  entry_point_selector: string
  calldata: string[]
}

/**
 * Build a `starknet_call` JSON-RPC request. `abi.customInput === 'address'`
 * passes params through as raw felts (u256 inputs pre-split by the caller).
 */
export function formCallBody({ abi, target, params = [], allAbi = [], block }: CallOptions, id: number | string = 0) {
  if (!abi) throw new Error('starknet: missing abi')
  if (!target) throw new Error(`starknet: missing target for ${abi.name}`)
  if ((params || params === 0) && !Array.isArray(params)) params = [params]
  if (params === undefined || params === null) params = []
  let calldata: any[] = abi.customInput === 'address' ? params : encodeCalldata(abi, params, allAbi)
  // The RPC rejects calldata felts without a 0x prefix, normalize everything.
  calldata = calldata.map((i: any) => toHex(i))
  const requestData: StarknetCallRequest = {
    contract_address: String(target).toLowerCase(),
    entry_point_selector: getSelectorFromName(abi.name),
    calldata,
  }
  return { jsonrpc: '2.0', id, method: 'starknet_call', params: [requestData, toBlockId(block)] }
}

/**
 * Decode a call result and apply the legacy post-processing: BigInts at depth 1
 * become strings, a single non-Cairo 1 output is unwrapped, `Uint256` outputs
 * (or `customType: 'Uint256' | 'number'`) become numbers, `customType: 'address'`
 * is padded.
 */
export function parseOutput(result: any, abi: AbiEntry, allAbi: AbiEntry[] = [], { permitFailure = false, error }: { permitFailure?: boolean, error?: any } = {}): any {
  if (!result) {
    if (permitFailure) return null
    throw new Error(`Starknet call ${abi?.name ?? ''} failed: ${formatRpcError(error) || 'no result'}`)
  }

  let response = decodeOutput(abi, result, allAbi)
  if (typeof response === 'bigint') response = response.toString()
  else if (response && typeof response === 'object') {
    for (const key in response) {
      if (typeof response[key] === 'bigint') response[key] = response[key].toString()
    }
  }

  const outputs = abi.outputs ?? []
  if (outputs.length === 1 && !outputs[0].type.includes('::')) {
    const name = outputs[0].name
    if (name !== undefined && response && typeof response === 'object') response = response[name]
    if (outputs[0].type === 'Uint256') return +response
  }
  if (outputs.length === 1) {
    switch (abi.customType) {
      case 'address': return validateAndParseAddress(response)
      case 'Uint256':
      case 'number': return +response
    }
  }
  return response
}

function formatRpcError(e: any): string {
  if (!e) return ''
  const data = e.data ?? e.error?.data
  const message = e.message ?? e.error?.message
  const revert = data?.revert_error ?? data?.execution_error ?? (typeof data === 'string' ? data : undefined)
  if (revert) {
    const text = typeof revert === 'string' ? revert : JSON.stringify(revert)
    return message ? `${message}: ${text}` : text
  }
  return message ? String(message) : JSON.stringify(e)
}

// ---------------------------------------------------------------------------
// json-rpc
// ---------------------------------------------------------------------------

/** Raw JSON-RPC call against the Starknet endpoints (STARKNET_RPC rotation + retries) */
export async function rpc(method: string, params: any = []): Promise<any> {
  try {
    return await jsonRpc(method, params, rpcOptions())
  } catch (e) {
    if (e instanceof JsonRpcError) throw new Error(`Starknet ${method} failed: ${formatRpcError(e)}`)
    throw e
  }
}

export async function getBlockNumber(): Promise<number> {
  return +(await rpc('starknet_blockNumber'))
}

export async function getBlock({ blockNumber, block }: { blockNumber?: number | 'latest', block?: BlockId } = {}): Promise<{ number: number, timestamp: number, hash?: string }> {
  const id = toBlockId(block ?? blockNumber)
  const res = await rpc('starknet_getBlockWithTxHashes', [id])
  return { number: +res.block_number, timestamp: +res.timestamp, hash: res.block_hash }
}

/** Last block whose timestamp is <= `timestamp` (binary search, no cache) */
export async function getBlockAtTimestamp({ timestamp }: { timestamp: number }): Promise<{ number: number, timestamp: number }> {
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000)
  let hi = await getBlock({ blockNumber: 'latest' })
  if (hi.timestamp <= timestamp) return { number: hi.number, timestamp: hi.timestamp }
  let lo = { number: 0, timestamp: 0 }
  while (hi.number - lo.number > 1) {
    const mid = Math.floor((lo.number + hi.number) / 2)
    const b = await getBlock({ blockNumber: mid })
    if (b.timestamp <= timestamp) lo = { number: b.number, timestamp: b.timestamp }
    else hi = b
  }
  if (lo.number === 0 && lo.timestamp === 0) {
    const b = await getBlock({ blockNumber: 0 })
    if (b.timestamp > timestamp) throw new Error(`starknet: timestamp ${timestamp} is before genesis`)
    return { number: b.number, timestamp: b.timestamp }
  }
  return lo
}

export async function getNonce({ address, block }: { address: string, block?: BlockId }): Promise<string> {
  return rpc('starknet_getNonce', [toBlockId(block), String(address).toLowerCase()])
}

export async function getClassHashAt({ address, block }: { address: string, block?: BlockId }): Promise<string> {
  return rpc('starknet_getClassHashAt', [toBlockId(block), String(address).toLowerCase()])
}

// ---------------------------------------------------------------------------
// call / multiCall
// ---------------------------------------------------------------------------

async function rawCall(request: StarknetCallRequest, block: BlockId | undefined, permitFailure: boolean, abiName: string): Promise<any[] | null> {
  try {
    return await jsonRpc('starknet_call', [request, toBlockId(block)], rpcOptions())
  } catch (e) {
    if (permitFailure) {
      debugLog(`[starknet] call ${abiName} on ${request.contract_address} failed (permitted): ${formatRpcError(e)}`)
      return null
    }
    throw new Error(`Starknet call ${abiName} on ${request.contract_address} failed: ${formatRpcError(e)}`)
  }
}

export async function call({ abi, target, params = [], allAbi = [], permitFailure = false, block }: CallOptions): Promise<any> {
  const body = formCallBody({ abi, target, params, allAbi, block })
  const result = await limiter()(() => rawCall(body.params[0] as StarknetCallRequest, block, permitFailure, abi.name))
  return parseOutput(result, abi, allAbi, { permitFailure })
}

interface NormalizedCall {
  target: string
  params: any
  abi: AbiEntry
  allAbi: AbiEntry[]
}

function normalizeCalls({ abi: rootAbi, target: rootTarget, calls, allAbi = [] }: MultiCallOptions): NormalizedCall[] {
  return calls.map((callArgs, i) => {
    let item: NormalizedCall
    if (callArgs === null || typeof callArgs !== 'object') {
      if (!rootTarget) item = { target: callArgs as string, params: [], abi: rootAbi!, allAbi }
      else item = { target: rootTarget, params: callArgs, abi: rootAbi!, allAbi }
    } else {
      const { target, params, abi } = callArgs
      item = { target: (target || rootTarget) as string, params, abi: (abi || rootAbi) as AbiEntry, allAbi: callArgs.allAbi ?? allAbi }
    }
    if (!item.abi) throw new Error(`starknet: multiCall item ${i} has no abi`)
    if (!item.target) throw new Error(`starknet: multiCall item ${i} has no target`)
    return item
  })
}

/**
 * Run many `starknet_call`s. By default one on-chain `aggregate` call per 50
 * sub-calls; if the aggregator reverts (any sub-call reverting reverts the whole
 * batch) or `useAggregator` is false, falls back to JSON-RPC batches of 25 so
 * `permitFailure` still applies per call. Results are in call order.
 */
export async function multiCall(options: MultiCallOptions): Promise<any[]> {
  const { calls = [], permitFailure = false, useAggregator = true, block } = options
  if (!calls.length) return []
  const normalized = normalizeCalls(options)
  return limiter()(async () => {
    if (useAggregator) {
      try {
        return await aggregateMultiCall(normalized, block)
      } catch (e) {
        debugLog(`[starknet] aggregate multicall failed, falling back to batched calls: ${formatRpcError(e)}`)
      }
    }
    return batchedMultiCall(normalized, permitFailure, block)
  })
}

/** One starknet_call to the on-chain aggregator covering all sub-calls. */
async function aggregateMultiCall(calls: NormalizedCall[], block?: BlockId): Promise<any[]> {
  const aggregator = getMulticallAddress()
  const aggSelector = getSelectorFromName('aggregate')
  const response: any[] = []
  const chunks = sliceIntoChunks(calls, AGGREGATE_CHUNK_SIZE)
  let offset = 0
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    if (c > 0) await sleep(CHUNK_SLEEP_MS)
    // Build the Call[] calldata: [n, (to, selector, calldata_len, ...calldata) x n]
    const aggCalldata: string[] = [toHex(chunk.length)]
    chunk.forEach((item) => {
      const body = formCallBody(item).params[0] as StarknetCallRequest
      aggCalldata.push(body.contract_address, body.entry_point_selector, toHex(body.calldata.length), ...body.calldata)
    })
    const request: StarknetCallRequest = { contract_address: aggregator, entry_point_selector: aggSelector, calldata: aggCalldata }
    const result: string[] = await jsonRpc('starknet_call', [request, toBlockId(block)], rpcOptions())
    if (!Array.isArray(result)) throw new Error('aggregate failed: empty result')
    // result layout: [block_number, results_len, (span_len, ...span_felts) x results_len]
    let i = 1 // skip block_number
    const resultsLen = Number(toBigInt(result[i++]))
    if (resultsLen !== chunk.length) throw new Error(`aggregate returned ${resultsLen} results for ${chunk.length} calls`)
    for (let j = 0; j < resultsLen; j++) {
      const spanLen = Number(toBigInt(result[i++]))
      const span = result.slice(i, i + spanLen)
      i += spanLen
      const item = chunk[j]
      response[offset + j] = parseOutput(span, item.abi, item.allAbi)
    }
    offset += chunk.length
  }
  return response
}

/** N individual starknet_call requests packed into JSON-RPC batches. */
async function batchedMultiCall(calls: NormalizedCall[], permitFailure: boolean, block?: BlockId): Promise<any[]> {
  const bodies = calls.map((item, id) => formCallBody({ ...item, block }, id))
  const response: any[] = new Array(calls.length)
  const chunks = sliceIntoChunks(bodies, BATCH_CHUNK_SIZE)
  for (let c = 0; c < chunks.length; c++) {
    const chunk = chunks[c]
    if (c > 0) await sleep(CHUNK_SLEEP_MS)
    let results: any[]
    if (chunk.length === 1) {
      // some providers (e.g. lava.build) answer a one-element batch with a bare
      // object; use a plain call for that case
      const body = chunk[0]
      results = [await rawCall(body.params[0] as StarknetCallRequest, block, permitFailure, calls[body.id as number].abi.name)]
    } else {
      try {
        results = await jsonRpcBatch(chunk.map((b) => ({ method: b.method, params: b.params, id: b.id })), { ...rpcOptions(), permitFailure })
      } catch (e) {
        if (e instanceof JsonRpcError) throw new Error(`Starknet call ${e.method} failed: ${formatRpcError(e)}`)
        throw e
      }
    }
    chunk.forEach((body, i) => {
      const id = body.id as number
      const item = calls[id]
      response[id] = parseOutput(results[i], item.abi, item.allAbi, { permitFailure })
    })
  }
  return response
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

/** starknet_getEvents page size; public providers reject larger pages ("Requested page size is too big") */
export const DEFAULT_EVENTS_CHUNK_SIZE = 1000
const MIN_EVENTS_CHUNK_SIZE = 100

function isPageSizeError(e: any): boolean {
  const message = String(e?.message ?? e ?? '').toLowerCase()
  return message.includes('page size') || message.includes('chunk_size') || message.includes('chunk size')
}

/**
 * Fetch events emitted by `target` via `starknet_getEvents`, following
 * `continuation_token` until the range [fromBlock, toBlock] is exhausted.
 * Returns raw events: { block_number, transaction_hash, from_address, keys, data }.
 */
export async function getLogs({ target, fromBlock, toBlock, topics, keys, chunkSize = DEFAULT_EVENTS_CHUNK_SIZE }: GetLogsOptions): Promise<StarknetEvent[]> {
  if (!target) throw new Error('Missing target!')
  if (fromBlock === undefined || fromBlock === null) throw new Error('Missing fromBlock!')
  if (!keys && topics) keys = [topics]
  const keyFilter = (keys ?? []).map((k) => (Array.isArray(k) ? k : [k]).map((i) => toHex(i)))
  const address = String(target).toLowerCase()

  return limiter()(async () => {
    const end = toBlock ?? await getBlockNumber()
    if (fromBlock > end) return []
    const filter: any = {
      from_block: { block_number: fromBlock },
      to_block: { block_number: end },
      address,
      keys: keyFilter,
      chunk_size: chunkSize,
    }
    const logs: StarknetEvent[] = []
    let pages = 0
    while (true) {
      let page: any
      try {
        page = await rpc('starknet_getEvents', [filter])
      } catch (e) {
        // providers cap chunk_size at different values; shrink and retry the same page
        if (isPageSizeError(e) && filter.chunk_size > MIN_EVENTS_CHUNK_SIZE) {
          filter.chunk_size = Math.max(MIN_EVENTS_CHUNK_SIZE, Math.floor(filter.chunk_size / 2))
          debugLog(`[starknet] getLogs page size rejected, retrying with chunk_size ${filter.chunk_size}`)
          continue
        }
        throw e
      }
      logs.push(...(page?.events ?? []))
      pages++
      if (!page?.continuation_token) break
      filter.continuation_token = page.continuation_token
    }
    debugLog(`[starknet] getLogs ${address} [${fromBlock}, ${end}]: ${logs.length} events in ${pages} page(s)`)
    return logs
  })
}

// ---------------------------------------------------------------------------
// ERC20 ABIs
// ---------------------------------------------------------------------------

/**
 * Cairo 0 style ERC20 ABIs (camelCase entrypoints, `felt` / `Uint256` types).
 * `balanceOf` uses `customInput: 'address'` so the owner felt is passed through
 * untouched; `decimals` casts to a number.
 */
export const erc20Abis: Record<string, AbiEntry> = {
  balanceOf: {
    name: 'balanceOf',
    type: 'function',
    inputs: [{ name: 'account', type: 'felt' }],
    outputs: [{ name: 'balance', type: 'Uint256' }],
    stateMutability: 'view',
    customInput: 'address',
  },
  totalSupply: {
    name: 'totalSupply',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'totalSupply', type: 'Uint256' }],
    stateMutability: 'view',
  },
  decimals: {
    name: 'decimals',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'decimals', type: 'felt' }],
    stateMutability: 'view',
    customType: 'number',
  },
  name: {
    name: 'name',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'name', type: 'felt' }],
    stateMutability: 'view',
  },
  symbol: {
    name: 'symbol',
    type: 'function',
    inputs: [],
    outputs: [{ name: 'symbol', type: 'felt' }],
    stateMutability: 'view',
  },
  allowance: {
    name: 'allowance',
    type: 'function',
    inputs: [{ name: 'owner', type: 'felt' }, { name: 'spender', type: 'felt' }],
    outputs: [{ name: 'remaining', type: 'Uint256' }],
    stateMutability: 'view',
  },
}

/**
 * Cairo 1 style ERC20 ABIs (snake_case entrypoints, `core::` types). u256
 * outputs decode to a bigint (returned as a decimal string by `call`).
 */
export const erc20AbisCairo1: Record<string, AbiEntry> = {
  balanceOf: {
    name: 'balance_of',
    type: 'function',
    inputs: [{ name: 'account', type: 'core::starknet::contract_address::ContractAddress' }],
    outputs: [{ type: 'core::integer::u256' }],
    state_mutability: 'view',
  },
  totalSupply: {
    name: 'total_supply',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'core::integer::u256' }],
    state_mutability: 'view',
  },
  decimals: {
    name: 'decimals',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'core::integer::u8' }],
    state_mutability: 'view',
    customType: 'number',
  },
  name: {
    name: 'name',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'core::felt252' }],
    state_mutability: 'view',
  },
  symbol: {
    name: 'symbol',
    type: 'function',
    inputs: [],
    outputs: [{ type: 'core::felt252' }],
    state_mutability: 'view',
  },
  allowance: {
    name: 'allowance',
    type: 'function',
    inputs: [
      { name: 'owner', type: 'core::starknet::contract_address::ContractAddress' },
      { name: 'spender', type: 'core::starknet::contract_address::ContractAddress' },
    ],
    outputs: [{ type: 'core::integer::u256' }],
    state_mutability: 'view',
  },
}

/** alias matching the coins repo export */
export const cairoErc20Abis = erc20AbisCairo1
