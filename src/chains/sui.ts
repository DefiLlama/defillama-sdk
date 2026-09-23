/**
 * Sui (GraphQL RPC + hand-rolled BCS codec) and IOTA (Sui fork, JSON-RPC) client.
 *
 * Replaces / consolidates:
 *  - DefiLlama-Adapters `projects/helper/chain/sui.js` (BCS codec, GraphQL object / event /
 *    dynamic-field readers, `devInspectTransactionBlock`, `getInitialSharedVersion`, `getTokenSupply`,
 *    `normalizeCoinType`; the TVL-specific `dexExport` / `sumTokens` are intentionally not ported)
 *  - DefiLlama-Adapters `projects/helper/chain/iota.js` (IOTA JSON-RPC `call` / `getObject` / `getObjects`)
 *  - defillama-server `coins/src/adapters/utils/sui.ts` (`getAllBalances`, `getTokenInfo`, `queryEvents`, `getObjects`)
 *  - peggedassets-server `src/adapters/peggedAssets/helper/sui.ts` (`getDynamicFieldObject` with `nameBcs`, `EMPTY_STRUCT_BCS`)
 *  - dimension-adapters `helpers/sui.ts` (`graphqlCall` retry, windowed `queryEvents`, `eventModule` filter, `toParsedJson`)
 *
 * Endpoints: `SUI_GRAPH_RPC` (GraphQL, default `https://graphql.mainnet.sui.io/graphql`), `SUI_RPC`
 * (JSON-RPC, default `https://sui-rpc.publicnode.com`) and `IOTA_RPC` (default `https://api.mainnet.iota.cafe`).
 * Chains without a GraphQL endpoint (iota) transparently fall back to JSON-RPC for the reader helpers.
 *
 * Usage: `sdk.chains.sui.getObject({ objectId: '0x6' })`, `sdk.chains.sui.call({ chain: 'iota', method: 'iota_getLatestCheckpointSequenceNumber', params: [] })`
 *
 * Refs: https://docs.sui.io/concepts/data-access/graphql-rpc, https://docs.sui.io/develop/accessing-data/json-rpc-migration#method-mapping
 */
import { getEndpoints, getLimiter, httpPost, jsonRpc, runInChunks, sliceIntoChunks, withRetry, sleep } from "./rpc";
import { debugLog } from "../util/debugLog";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const suiChains = ['sui', 'iota']

export const DEFAULT_GRAPHQL_ENDPOINTS: Record<string, string> = {
  sui: 'https://graphql.mainnet.sui.io/graphql',
}

export const DEFAULT_RPC_ENDPOINTS: Record<string, string> = {
  sui: 'https://sui-rpc.publicnode.com',
  iota: 'https://api.mainnet.iota.cafe',
}

export const DUMMY_SENDER = '0x' + '0'.repeat(64)
/** BCS of a Move struct whose only member is `dummy_field: bool` (Wormhole-style `Key<T>` witness structs) */
export const EMPTY_STRUCT_BCS = 'AA=='

const PAGE_SIZE = 50
const OBJECTS_PER_QUERY = 50
const RPC_OBJECTS_PER_QUERY = 9
const GRAPHQL_TIMEOUT = 60_000

export interface ChainOptions {
  /** 'sui' (default) or 'iota' */
  chain?: string
}

export function getGraphqlEndpoints({ chain = 'sui' }: ChainOptions = {}): string[] {
  return getEndpoints(chain, DEFAULT_GRAPHQL_ENDPOINTS[chain], { envKey: `${chain.toUpperCase()}_GRAPH_RPC` })
}

export function getGraphqlEndpoint(options: ChainOptions = {}): string {
  return getGraphqlEndpoints(options)[0]
}

export function getRpcEndpoints({ chain = 'sui' }: ChainOptions = {}): string[] {
  return getEndpoints(chain, DEFAULT_RPC_ENDPOINTS[chain])
}

export function getRpcEndpoint(options: ChainOptions = {}): string {
  return getRpcEndpoints(options)[0]
}

/** true when the chain has a GraphQL endpoint (built-in default or `<CHAIN>_GRAPH_RPC`) */
export function hasGraphql(chain = 'sui'): boolean {
  try {
    getGraphqlEndpoints({ chain })
    return true
  } catch {
    return false
  }
}

function rpcPrefix(chain = 'sui') {
  return chain === 'iota' ? 'iota' : 'sui'
}

// ---------------------------------------------------------------------------
// BCS codec (pure)
// ---------------------------------------------------------------------------

export type Bytes = number[] | Uint8Array
export type IntLike = number | string | bigint

const TYPE_TAG_INDEXES: Record<string, number> = {
  bool: 0, u8: 1, u64: 2, u128: 3, address: 4, signer: 5, u16: 8, u32: 9, u256: 10,
}

/** Hex string (with or without 0x) to a fixed-size byte array, left padded with zeros. Default size is a 32 byte address. */
export function hexToBytes(hex: string, size = 32): number[] {
  const normalized = String(hex).trim().replace(/^0x/i, '')
  if (!/^[0-9a-fA-F]+$/.test(normalized) || normalized.length > size * 2) throw new Error(`Invalid Sui hex value: ${hex}`)
  return Array.from(Buffer.from(normalized.padStart(size * 2, '0'), 'hex'))
}

export function bytesToHex(bytes: Bytes): string {
  return '0x' + Buffer.from(bytes).toString('hex')
}

export function textToBytes(value: string): number[] {
  return Array.from(Buffer.from(String(value), 'utf8'))
}

export function bytesToBase64(bytes: Bytes): string {
  return Buffer.from(bytes).toString('base64')
}

export function base64ToBytes(value: string): number[] {
  return Array.from(Buffer.from(value, 'base64'))
}

export function uleb128Encode(value: IntLike): number[] {
  const bytes: number[] = []
  let num = Number(value)
  if (!Number.isSafeInteger(num) || num < 0) throw new Error(`Invalid uleb128 value: ${value}`)
  do {
    let byte = num % 0x80
    num = Math.floor(num / 0x80)
    if (num > 0) byte |= 0x80
    bytes.push(byte)
  } while (num > 0)
  return bytes
}

/** Decode a uleb128 at `offset`; returns the value and how many bytes it consumed. */
export function uleb128Decode(data: Bytes, offset = 0): { value: number, length: number } {
  const source = Uint8Array.from(data)
  let value = 0
  let shift = 0
  let i = offset
  for (; ;) {
    if (i >= source.length) throw new RangeError(`uleb128: unexpected end of data at offset ${i}`)
    const byte = source[i++]
    value += (byte & 0x7f) * Math.pow(2, shift)
    if (!(byte & 0x80)) break
    shift += 7
    if (shift > 49) throw new RangeError('uleb128: value exceeds safe integer range')
  }
  return { value, length: i - offset }
}

/** Alias kept for parity with the adapters helper */
export const uleb128 = uleb128Encode

export function toLittleEndian(value: IntLike, size: number): number[] {
  const bits = size * 8
  let big: bigint
  try {
    if (typeof value === 'number' && !Number.isInteger(value)) throw new Error()
    big = BigInt(value)
  } catch {
    throw new Error(`Invalid u${bits} value: ${value}`)
  }
  const max = BigInt(1) << BigInt(bits)
  if (big < BigInt(0) || big >= max) throw new Error(`Value out of range for u${bits}: ${value}`)
  const result: number[] = new Array(size).fill(0)
  let i = 0
  while (big > BigInt(0)) {
    result[i] = Number(big % BigInt(256))
    big /= BigInt(256)
    i += 1
  }
  return result
}

export const toU16 = (value: IntLike) => toLittleEndian(value, 2)
export const toU32 = (value: IntLike) => toLittleEndian(value, 4)
export const toU64 = (value: IntLike) => toLittleEndian(value, 8)
export const toU128 = (value: IntLike) => toLittleEndian(value, 16)
export const toU256 = (value: IntLike) => toLittleEndian(value, 32)

export function fromLittleEndian(data: Bytes, offset = 0, size = 8): bigint {
  if (!Number.isInteger(offset) || offset < 0) throw new RangeError(`Invalid byte offset: ${offset}`)
  if (!Number.isInteger(size) || size < 1) throw new RangeError(`Invalid integer byte size: ${size}`)
  const source = Uint8Array.from(data)
  if (source.length < offset + size) throw new RangeError(`Expected ${size} bytes at offset ${offset}, got ${source.length}`)
  let value = BigInt(0)
  for (let i = offset + size - 1; i >= offset; i--) value = (value << BigInt(8)) + BigInt(source[i])
  return value
}

export const fromU16 = (data: Bytes, offset = 0) => fromLittleEndian(data, offset, 2)
export const fromU32 = (data: Bytes, offset = 0) => fromLittleEndian(data, offset, 4)
export const fromU64 = (data: Bytes, offset = 0) => fromLittleEndian(data, offset, 8)
export const fromU128 = (data: Bytes, offset = 0) => fromLittleEndian(data, offset, 16)
export const fromU256 = (data: Bytes, offset = 0) => fromLittleEndian(data, offset, 32)

/** Lower-cased, 0x-prefixed, zero padded 64 hex char address */
export function normalizeSuiAddress(address: string): string {
  const hex = String(address).trim().replace(/^0x/i, '').toLowerCase()
  if (!/^[0-9a-f]{1,64}$/.test(hex)) throw new Error(`Invalid Sui address: ${address}`)
  return '0x' + hex.padStart(64, '0')
}

/**
 * GraphQL returns coin types with the address zero padded to 64 hex chars (0x000...002::sui::SUI)
 * while configs commonly use the short form (0x2::sui::SUI); this maps both to the padded form.
 */
export function normalizeCoinType(coinType: string): string {
  const [addr, ...rest] = String(coinType).trim().split('::')
  return [normalizeSuiAddress(addr), ...rest].join('::')
}

/** Split a comma separated generic argument list, respecting nested `<...>` */
export function splitTypeArgs(value: string): string[] {
  const items: string[] = []
  let depth = 0
  let start = 0
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '<') depth++
    if (value[i] === '>') {
      depth--
      if (depth < 0) throw new Error(`Unbalanced type argument brackets: ${value}`)
    }
    if (value[i] === ',' && depth === 0) {
      items.push(value.slice(start, i).trim())
      start = i + 1
    }
  }
  if (depth !== 0) throw new Error(`Unbalanced type argument brackets: ${value}`)
  const last = value.slice(start).trim()
  if (last) items.push(last)
  return items
}

export interface StructTag {
  address: string
  module: string
  name: string
  typeParams: string[]
}

export function parseStructTag(type: string): StructTag {
  const match = String(type).trim().match(/^([^:<>]+)::([^:<>]+)::([^<>]+)(?:<(.+)>)?$/)
  if (!match) throw new Error(`Invalid Sui struct tag: ${type}`)
  return {
    address: match[1],
    module: match[2],
    name: match[3],
    typeParams: match[4] ? splitTypeArgs(match[4]) : [],
  }
}

/** BCS `TypeTag` */
export function typeTagToBytes(type: string): number[] {
  const tag = String(type).trim()
  if (TYPE_TAG_INDEXES[tag] !== undefined) return [TYPE_TAG_INDEXES[tag]]
  if (tag.startsWith('vector<') && tag.endsWith('>')) return [6, ...typeTagToBytes(tag.slice(7, -1))]
  const { address, module, name, typeParams } = parseStructTag(tag)
  const moduleBytes = textToBytes(module)
  const nameBytes = textToBytes(name)
  const out = [
    7,
    ...hexToBytes(address),
    ...uleb128Encode(moduleBytes.length),
    ...moduleBytes,
    ...uleb128Encode(nameBytes.length),
    ...nameBytes,
    ...uleb128Encode(typeParams.length),
  ]
  typeParams.forEach(p => out.push(...typeTagToBytes(p)))
  return out
}

export interface SharedObjectRef {
  objectId: string
  initialSharedVersion: IntLike
  mutable?: boolean
}

export type MoveCallArgument = number | { Input?: number, input?: number }

export interface MoveCallParams {
  packageId: string
  module: string
  functionName: string
  typeArguments?: string[]
  /** shared objects become the transaction inputs, in order */
  sharedObjects?: SharedObjectRef[]
  /** defaults to one `Input(i)` per shared object */
  arguments?: MoveCallArgument[]
}

/**
 * BCS `TransactionKind::ProgrammableTransaction` with a single `MoveCall` command whose inputs are
 * shared objects (enough for read-only view functions inspected through `devInspectTransactionBlock`).
 */
export function buildProgrammableMoveCallBytes({ packageId, module, functionName, typeArguments = [], sharedObjects = [], arguments: moveArguments }: MoveCallParams): Uint8Array {
  if (!packageId || !module || !functionName) throw new Error('Missing packageId, module, or functionName')
  const moduleBytes = textToBytes(module)
  const functionBytes = textToBytes(functionName)
  const args: MoveCallArgument[] = moveArguments || sharedObjects.map((_, i) => ({ Input: i }))
  const inputCount = sharedObjects.length
  const bytes: number[] = [0, ...uleb128Encode(sharedObjects.length)]
  sharedObjects.forEach(({ objectId, initialSharedVersion, mutable = false }) => {
    bytes.push(1, 1, ...hexToBytes(objectId), ...toU64(initialSharedVersion), mutable ? 1 : 0)
  })
  bytes.push(
    ...uleb128Encode(1), 0,
    ...hexToBytes(packageId),
    ...uleb128Encode(moduleBytes.length), ...moduleBytes,
    ...uleb128Encode(functionBytes.length), ...functionBytes,
    ...uleb128Encode(typeArguments.length),
  )
  typeArguments.forEach(t => bytes.push(...typeTagToBytes(t)))
  bytes.push(...uleb128Encode(args.length))
  args.forEach((arg) => {
    const input = typeof arg === 'number' ? arg : (arg.Input ?? arg.input)
    if (input === undefined || !Number.isInteger(input) || input < 0 || input > 0xffff) throw new Error(`Unsupported Sui move call argument: ${JSON.stringify(arg)}`)
    if (input >= inputCount) throw new Error(`Sui move call argument input ${input} exceeds input count ${inputCount}`)
    bytes.push(1, ...toU16(input))
  })
  return Uint8Array.from(bytes)
}

export interface TransactionDataOptions {
  sender?: string
  gasPrice?: IntLike
  gasBudget?: IntLike
}

/** BCS `TransactionData::V1` wrapping `kindBytes` with dummy gas data (gas payment left empty for `doGasSelection`) */
export function buildTransactionDataBytes(kindBytes: Bytes, { sender = DUMMY_SENDER, gasPrice = 1000, gasBudget = 50_000_000_000 }: TransactionDataOptions = {}): Uint8Array {
  return Uint8Array.from([
    0,                       // TransactionData::V1
    ...Array.from(kindBytes),// TransactionKind::ProgrammableTransaction
    ...hexToBytes(sender),   // sender
    ...uleb128Encode(0),     // GasData.payment: empty
    ...hexToBytes(sender),   // GasData.owner
    ...toU64(gasPrice),      // GasData.price
    ...toU64(gasBudget),     // GasData.budget
    0,                       // TransactionExpiration::None
  ])
}

/** BCS (base64) of a dynamic field name of the given Move type */
export function bcsDynamicFieldName(nameType: string, value: any): string {
  const type = String(nameType).trim()
  let bytes: number[]
  if (type === 'address' || type === 'signer' || type.endsWith('::object::ID') || type.endsWith('::object::UID'))
    bytes = hexToBytes(value) // 32 byte address
  else if (type === 'bool') bytes = [value === true || value === 'true' || value === 1 ? 1 : 0]
  else if (type === 'u8') bytes = [Number(value) & 0xff]
  else if (type === 'u16') bytes = toU16(value)
  else if (type === 'u32') bytes = toU32(value)
  else if (type === 'u64') bytes = toU64(value)
  else if (type === 'u128') bytes = toU128(value)
  else if (type === 'u256') bytes = toU256(value)
  else if (type === 'vector<u8>') {
    const b = Array.isArray(value) ? value.map(Number) : textToBytes(String(value))
    bytes = [...uleb128Encode(b.length), ...b] // length-prefixed
  } else if (type.endsWith('::string::String') || type.endsWith('::ascii::String') || type.endsWith('::type_name::TypeName')) {
    const b = textToBytes(String(value))
    bytes = [...uleb128Encode(b.length), ...b] // String == vector<u8> of utf8
  } else throw new Error(`[sui] unsupported dynamic field name type: ${nameType}`)
  return bytesToBase64(bytes)
}

// ---------------------------------------------------------------------------
// response shaping (GraphQL `json` + `layout` -> JSON-RPC-like `{ type, fields }`)
// ---------------------------------------------------------------------------

export interface SuiObject {
  /** object address (from the query key, or the UID inside `fields.id`) */
  id?: string
  type: string
  fields: any
  dataType: 'moveObject'
  /** dynamic field key (`name.json`) when read via `getDynamicFieldObject(s)` */
  name?: any
  version?: number | string
  owner?: any
  [key: string]: any
}

function normalizeFields(fields: any): any {
  if (!fields || typeof fields !== 'object') return fields
  const normalized: any = {}
  for (const [key, value] of Object.entries(fields)) {
    if (key === 'id' && typeof value === 'string') {
      normalized[key] = { id: value }
    } else if (Array.isArray(value)) {
      normalized[key] = value.map((v: any) => (typeof v === 'object' && v !== null) ? wrapStruct(v) : v)
    } else if (typeof value === 'object' && value !== null) {
      normalized[key] = wrapStruct(value)
    } else {
      normalized[key] = value
    }
  }
  return normalized
}

function wrapStruct(obj: any): any {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return obj
  return { fields: normalizeFields(obj) }
}

/** Mirror the JSON-RPC type display: strip leading zeros from addresses, but keep a single leading zero on 64-char addresses */
export function shortenTypeAddresses(type: string): string {
  return String(type)
    .replace(/0x0*([0-9a-fA-F])/g, '0x$1')
    .replace(/0x([0-9a-fA-F]{63})(?![0-9a-fA-F])/g, '0x0$1')
}

function normalizeTypeRepr(type: string): string {
  return shortenTypeAddresses(String(type).replace(/,(?!\s)/g, ', '))
}

function rewrapWithLayout(value: any, layout: any): any {
  if (!layout || typeof layout === 'string') {
    if (layout === 'address' && typeof value === 'string' && value && !value.startsWith('0x')) return '0x' + value
    return value
  }
  if (layout.vector !== undefined)
    return Array.isArray(value) ? value.map((v: any) => rewrapWithLayout(v, layout.vector)) : value
  if (layout.struct) {
    const { type, fields } = layout.struct
    if (type.endsWith('::object::UID')) return { id: (value && typeof value === 'object') ? value.id : value }
    if (type.endsWith('::object::ID') || type.endsWith('::string::String') || type.endsWith('::ascii::String'))
      return (value && typeof value === 'object') ? Object.values(value)[0] : value
    const t = normalizeTypeRepr(type)
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      const f: any = {}
      for (const fl of fields) f[fl.name] = rewrapWithLayout(value[fl.name], fl.layout)
      return { type: t, fields: f }
    }
    if (type.endsWith('::type_name::TypeName'))
      return { type: t, fields: { [fields[0].name]: value } }
    return value
  }
  return value
}

/**
 * Shape GraphQL `MoveObject.contents` / `MoveValue` (`{ json, type: { repr, layout? } }`) like the
 * JSON-RPC `content` (`{ dataType, type, fields }`), nested structs wrapped as `{ type, fields }`.
 * With a layout, Option / TypeName / UID / ID / String are rewrapped exactly; without it (`skipLayout`)
 * only the generic struct wrapping is applied.
 */
export function formatObject(contents: any, address?: string): SuiObject | null {
  if (!contents || !contents.type) return null
  const layout = contents.type.layout
  let out: SuiObject
  if (layout) {
    const rewrapped = rewrapWithLayout(contents.json, layout)
    if (!rewrapped || typeof rewrapped !== 'object') throw new Error(`Unexpected Sui move object shape for type ${contents.type.repr}`)
    out = { type: rewrapped.type, fields: rewrapped.fields, dataType: 'moveObject' }
  } else {
    out = { type: normalizeTypeRepr(contents.type.repr), fields: normalizeFields(contents.json), dataType: 'moveObject' }
  }
  const id = address ?? out.fields?.id?.id
  if (id) out.id = id
  return out
}

/** Prefix a bare hex object id with 0x */
export function toAddr(id: string): string {
  if (typeof id === 'string' && id && !id.startsWith('0x') && /^[0-9a-fA-F]+$/.test(id)) return '0x' + id
  return id
}

/** Shape GraphQL `json` like the JSON-RPC `parsedJson` of an event (TypeName -> `{ name }`, String / ID unwrapped, UID -> `{ id }`) */
export function toParsedJson(value: any, layout: any): any {
  if (value === null || value === undefined) return value
  if (!layout || typeof layout === 'string') return value // bool / uN / address
  if (layout.vector !== undefined) return Array.isArray(value) ? value.map((v: any) => toParsedJson(v, layout.vector)) : value
  if (layout.struct) {
    const { type, fields } = layout.struct
    const unwrap = (v: any) => (v && typeof v === 'object' && !Array.isArray(v)) ? Object.values(v)[0] : v
    if (type.endsWith('::type_name::TypeName')) return { name: unwrap(value) }
    if (type.endsWith('::ascii::String') || type.endsWith('::string::String') || type.endsWith('::object::ID')) return unwrap(value)
    if (type.endsWith('::object::UID')) return { id: (value && typeof value === 'object') ? (value.id ?? unwrap(value)) : value }
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const out: any = {}
      for (const f of fields) out[f.name] = toParsedJson(value[f.name], f.layout)
      return out
    }
    return value
  }
  return value
}

/** Shape a JSON-RPC `getObject` response (`{ data: { objectId, type, content, owner, version } }`) like `formatObject` */
function formatRpcObject(data: any): SuiObject | null {
  if (!data) return null
  const content = data.content
  if (!content) return null
  const out: SuiObject = {
    id: data.objectId,
    type: content.type ?? data.type,
    fields: content.fields,
    dataType: content.dataType ?? 'moveObject',
  }
  if (data.version !== undefined) out.version = data.version
  if (data.owner !== undefined) out.owner = data.owner
  return out
}

// ---------------------------------------------------------------------------
// GraphQL transport
// ---------------------------------------------------------------------------

export class SuiGraphqlError extends Error {
  errors: any[]
  constructor(message: string, errors: any[] = []) {
    super(message)
    this.name = 'SuiGraphqlError'
    this.errors = errors
  }
}

const NON_RETRYABLE_GRAPHQL = /Unknown (field|argument|type)|Syntax Error|Cannot query field|Expected type|Invalid value|Variable ".*" of (required )?type/i

export interface GraphqlCallOptions extends ChainOptions {
  query: string
  variables?: Record<string, any>
  /** total attempts, default 3 (at least one per endpoint) */
  retries?: number
  timeout?: number
}

/** POST a GraphQL query; returns `data`, throws `SuiGraphqlError` on `errors` / empty data. Rotates endpoints and retries. */
export async function graphqlCall({ chain = 'sui', query, variables = {}, retries, timeout = GRAPHQL_TIMEOUT }: GraphqlCallOptions): Promise<any> {
  const endpoints = getGraphqlEndpoints({ chain })
  const limiter = getLimiter(`${chain.toUpperCase()}_GRAPHQL`, 10)
  const attempts = retries ?? Math.max(3, endpoints.length)
  return withRetry(async (attempt) => {
    const endpoint = endpoints[attempt % endpoints.length]
    const res = await limiter(() => httpPost(endpoint, { query, variables }, { timeout, retries: 1 }))
    if (res?.errors?.length || !res?.data) {
      const message = res?.errors?.[0]?.message ?? 'no data returned'
      throw new SuiGraphqlError(`[${chain}] graphql: ${message}`, res?.errors ?? [])
    }
    return res.data
  }, {
    retries: attempts,
    label: `${chain} graphql`,
    shouldRetry: (e) => !(e instanceof SuiGraphqlError && NON_RETRYABLE_GRAPHQL.test(e.message)),
  })
}

const CONTENTS_FULL = 'contents { json type { repr layout } }'
const CONTENTS_LITE = 'contents { json type { repr } }'
const contentsSelection = (skipLayout?: boolean) => skipLayout ? CONTENTS_LITE : CONTENTS_FULL

// ---------------------------------------------------------------------------
// JSON-RPC transport (iota, and sui fallback)
// ---------------------------------------------------------------------------

export interface CallOptions extends ChainOptions {
  method: string
  params?: any
  retries?: number
  timeout?: number
}

/** Raw JSON-RPC call (`sui_*` / `suix_*` / `iota_*` / `iotax_*`); returns `result` */
export async function call({ chain = 'sui', method, params = [], retries, timeout }: CallOptions): Promise<any> {
  if (!Array.isArray(params)) params = [params]
  return jsonRpc(method, params, { chain, defaultEndpoints: DEFAULT_RPC_ENDPOINTS[chain], retries, timeout })
}

const RPC_OBJECT_OPTIONS = { showType: true, showOwner: true, showContent: true }

export interface RpcGetObjectOptions extends ChainOptions {
  objectId: string
}

/** `<prefix>_getObject` shaped like `getObject` (`{ id, type, fields, dataType, version, owner }`), null when missing */
export async function rpcGetObject({ chain = 'sui', objectId }: RpcGetObjectOptions): Promise<SuiObject | null> {
  const res = await call({ chain, method: `${rpcPrefix(chain)}_getObject`, params: [toAddr(objectId), RPC_OBJECT_OPTIONS] })
  return formatRpcObject(res?.data)
}

export interface RpcGetObjectsOptions extends ChainOptions {
  objectIds: string[]
}

/** `<prefix>_multiGetObjects` in chunks of 9, order preserving (null for missing objects) */
export async function rpcGetObjects({ chain = 'sui', objectIds }: RpcGetObjectsOptions): Promise<(SuiObject | null)[]> {
  if (!objectIds.length) return []
  const method = `${rpcPrefix(chain)}_multiGetObjects`
  return runInChunks(objectIds, async (chunk) => {
    const ids = chunk.map(toAddr)
    const result: any[] = await call({ chain, method, params: [ids, RPC_OBJECT_OPTIONS] })
    const byId: Record<string, any> = {}
    for (const r of result ?? []) if (r?.data?.objectId) byId[normalizeSuiAddress(r.data.objectId)] = r.data
    return ids.map((id, i) => formatRpcObject(byId[normalizeSuiAddress(id)] ?? result?.[i]?.data))
  }, { chunkSize: RPC_OBJECTS_PER_QUERY })
}

// ---------------------------------------------------------------------------
// objects
// ---------------------------------------------------------------------------

export interface GetObjectOptions extends ChainOptions {
  objectId: string
  /** drop the layout blob (~3.5x the json payload); only safe when reading plain fields */
  skipLayout?: boolean
}

/** Move object contents shaped like the JSON-RPC `content` (`{ id, type, fields, dataType }`), null when missing */
export async function getObject({ chain = 'sui', objectId, skipLayout }: GetObjectOptions): Promise<SuiObject | null> {
  if (!hasGraphql(chain)) return rpcGetObject({ chain, objectId })
  const data = await graphqlCall({
    chain, query: `query ($address: SuiAddress!) {
    object(address: $address) { address version asMoveObject { ${contentsSelection(skipLayout)} } }
  }`, variables: { address: toAddr(objectId) }
  })
  const obj = formatObject(data.object?.asMoveObject?.contents, data.object?.address)
  if (obj && data.object?.version !== undefined) obj.version = data.object.version
  return obj
}

export interface GetObjectsOptions extends ChainOptions {
  objectIds: string[]
  skipLayout?: boolean
  /** parallel chunks of 50, default 5 */
  concurrency?: number
  /** ms to wait between chunks (forces sequential chunks) */
  sleep?: number
}

/** `multiGetObjects` in chunks of 50, order preserving (null for missing objects) */
export async function getObjects({ chain = 'sui', objectIds, skipLayout, concurrency = 5, sleep: sleepTime }: GetObjectsOptions): Promise<(SuiObject | null)[]> {
  if (!objectIds.length) return []
  if (!hasGraphql(chain)) return rpcGetObjects({ chain, objectIds })
  const sel = contentsSelection(skipLayout)
  return runInChunks(objectIds, async (chunk) => {
    const ids = chunk.map(toAddr)
    const keys = ids.map((id) => `{ address: ${JSON.stringify(id)} }`).join(', ')
    const data = await graphqlCall({ chain, query: `{ multiGetObjects(keys: [${keys}]) { address asMoveObject { ${sel} } } }` })
    const nodes: any[] = data.multiGetObjects ?? []
    const byAddress: Record<string, any> = {}
    for (const o of nodes) if (o?.address) byAddress[normalizeSuiAddress(o.address)] = o
    return ids.map((id, i) => {
      const node = byAddress[normalizeSuiAddress(id)] ?? nodes[i]
      return formatObject(node?.asMoveObject?.contents, node?.address)
    })
  }, { chunkSize: OBJECTS_PER_QUERY, concurrency: sleepTime ? 1 : concurrency, sleepTime })
}

export interface GetObjectsByTypeOptions<T = SuiObject> extends ChainOptions {
  type: string
  owner?: string
  skipLayout?: boolean
  /** stop after this many objects */
  limit?: number
  transform?: (obj: SuiObject) => T
}

/** All live objects of a Move type (optionally owned by `owner`), walking every page */
export async function getObjectsByType<T = SuiObject>({ chain = 'sui', type, owner, skipLayout, limit, transform }: GetObjectsByTypeOptions<T>): Promise<T[]> {
  if (!hasGraphql(chain)) {
    if (!owner) throw new Error(`[${chain}] getObjectsByType needs a GraphQL endpoint (set ${chain.toUpperCase()}_GRAPH_RPC) or an owner`)
    return getOwnedObjects({ chain, owner, type, limit, transform })
  }
  const filter = owner ? `{ type: ${JSON.stringify(type)}, owner: ${JSON.stringify(toAddr(owner))} }` : `{ type: ${JSON.stringify(type)} }`
  const objects: SuiObject[] = []
  let after: string | null = null
  do {
    const data = await graphqlCall({
      chain, query: `query ($after: String) {
      objects(first: ${PAGE_SIZE}, after: $after, filter: ${filter}) {
        pageInfo { hasNextPage endCursor }
        nodes { address asMoveObject { ${contentsSelection(skipLayout)} } }
      }
    }`, variables: { after }
    })
    const { pageInfo, nodes } = data.objects
    for (const n of nodes) {
      const obj = formatObject(n.asMoveObject?.contents, n.address)
      if (obj) objects.push(obj)
    }
    after = pageInfo.hasNextPage ? pageInfo.endCursor : null
    if (limit && objects.length >= limit) break
  } while (after)
  const out = limit ? objects.slice(0, limit) : objects
  return (transform ? out.map(transform) : out) as T[]
}

export interface GetOwnedObjectsOptions<T = SuiObject> extends ChainOptions {
  owner: string
  /** struct type filter, e.g. `0x2::coin::Coin` */
  type?: string
  skipLayout?: boolean
  limit?: number
  transform?: (obj: SuiObject) => T
}

/** Objects owned by an address, walking every page */
export async function getOwnedObjects<T = SuiObject>({ chain = 'sui', owner, type, skipLayout, limit, transform }: GetOwnedObjectsOptions<T>): Promise<T[]> {
  const objects: SuiObject[] = []
  if (!hasGraphql(chain)) {
    let cursor: string | null = null
    do {
      const query = { filter: type ? { StructType: type } : null, options: { showType: true, showContent: true } }
      const res = await call({ chain, method: `${rpcPrefix(chain)}x_getOwnedObjects`, params: [toAddr(owner), query, cursor, PAGE_SIZE] })
      for (const n of res?.data ?? []) {
        const obj = formatRpcObject(n?.data)
        if (obj) objects.push(obj)
      }
      cursor = res?.hasNextPage ? res.nextCursor : null
      if (limit && objects.length >= limit) break
    } while (cursor)
  } else {
    const filter = type ? `, filter: { type: ${JSON.stringify(type)} }` : ''
    let after: string | null = null
    do {
      const data = await graphqlCall({
        chain, query: `query ($owner: SuiAddress!, $after: String) {
        address(address: $owner) {
          objects(first: ${PAGE_SIZE}, after: $after${filter}) {
            pageInfo { hasNextPage endCursor }
            nodes { address ${contentsSelection(skipLayout)} }
          }
        }
      }`, variables: { owner: toAddr(owner), after }
      })
      const page = data.address?.objects
      if (!page) break
      for (const n of page.nodes) {
        const obj = formatObject(n.contents, n.address)
        if (obj) objects.push(obj)
      }
      after = page.pageInfo.hasNextPage ? page.pageInfo.endCursor : null
      if (limit && objects.length >= limit) break
    } while (after)
  }
  const out = limit ? objects.slice(0, limit) : objects
  return (transform ? out.map(transform) : out) as T[]
}

// ---------------------------------------------------------------------------
// events
// ---------------------------------------------------------------------------

export interface SuiEvent {
  type: string
  /** unix seconds */
  timestamp: number
  sender?: string
  /** parsed event payload */
  json: any
}

export interface QueryEventsOptions<T = any> extends ChainOptions {
  /** full event struct type, e.g. `0x...::pool::SwapEvent` */
  eventType?: string
  /** emitting module, `package::module` or `{ package, module }` */
  eventModule?: string | { package: string, module: string }
  sender?: string
  /** unix seconds, inclusive. With a window the newest events are walked backwards until `startTimestamp`. */
  startTimestamp?: number
  /** unix seconds, exclusive */
  endTimestamp?: number
  /** stop after this many events */
  limit?: number
  /** return raw `json` without the layout based `parsedJson` shaping (smaller responses) */
  skipLayout?: boolean
  /** return `{ type, timestamp, sender, json }` instead of the bare payload */
  withMetadata?: boolean
  transform?: (item: any) => T
}

function buildEventFilter({ eventType, eventModule, sender }: QueryEventsOptions): string {
  const parts: string[] = []
  if (eventType) parts.push(`type: ${JSON.stringify(eventType)}`)
  if (eventModule) {
    const mod = typeof eventModule === 'string' ? eventModule : `${eventModule.package}::${eventModule.module}`
    parts.push(`module: ${JSON.stringify(mod)}`)
  }
  if (sender) parts.push(`sender: ${JSON.stringify(toAddr(sender))}`)
  return parts.length ? `, filter: { ${parts.join(', ')} }` : ''
}

function toSeconds(value: number): number {
  return value > 1e12 ? value / 1e3 : value
}

/**
 * Events matching a type / module / sender filter, cursor walking all pages (oldest first).
 * With `startTimestamp` / `endTimestamp` the newest events are walked backwards and only the
 * half-open window `[start, end)` is returned (as dimension-adapters did).
 */
export async function queryEvents<T = any>(options: QueryEventsOptions<T>): Promise<T[]> {
  const { chain = 'sui', limit, skipLayout, withMetadata, transform } = options
  if (!hasGraphql(chain)) throw new Error(`[${chain}] queryEvents needs a GraphQL endpoint (set ${chain.toUpperCase()}_GRAPH_RPC)`)
  const filter = buildEventFilter(options)
  const start = options.startTimestamp !== undefined ? toSeconds(options.startTimestamp) : undefined
  const end = options.endTimestamp !== undefined ? toSeconds(options.endTimestamp) : undefined
  const windowed = start !== undefined || end !== undefined
  const sel = `timestamp sender { address } ${contentsSelection(skipLayout)}`
  const items: any[] = []

  const shape = (node: any) => {
    const json = skipLayout ? node.contents.json : toParsedJson(node.contents.json, node.contents.type?.layout)
    if (!withMetadata) return json
    const event: SuiEvent = { type: node.contents.type?.repr, timestamp: Date.parse(node.timestamp) / 1e3, sender: node.sender?.address, json }
    return event
  }

  if (windowed) {
    let before: string | null = null
    do {
      const data = await graphqlCall({
        chain, query: `query ($before: String) {
        events(last: ${PAGE_SIZE}, before: $before${filter}) {
          pageInfo { hasPreviousPage startCursor }
          nodes { ${sel} }
        }
      }`, variables: { before }
      })
      const { pageInfo, nodes } = data.events // ascending (oldest -> newest)
      before = pageInfo.hasPreviousPage ? pageInfo.startCursor : null
      for (let i = nodes.length - 1; i >= 0; i--) {
        const ts = Date.parse(nodes[i].timestamp) / 1e3
        if (end !== undefined && ts >= end) continue
        if (start !== undefined && ts < start) { before = null; break }
        items.push(shape(nodes[i]))
      }
      if (!nodes.length) before = null
      if (limit && items.length >= limit) before = null
    } while (before)
    items.reverse() // oldest first, like the forward walk
  } else {
    let after: string | null = null
    do {
      const data = await graphqlCall({
        chain, query: `query ($after: String) {
        events(first: ${PAGE_SIZE}, after: $after${filter}) {
          pageInfo { hasNextPage endCursor }
          nodes { ${sel} }
        }
      }`, variables: { after }
      })
      const { pageInfo, nodes } = data.events
      after = pageInfo.hasNextPage ? pageInfo.endCursor : null
      for (const n of nodes) items.push(shape(n))
      if (limit && items.length >= limit) after = null
    } while (after)
  }

  const out = limit ? items.slice(0, limit) : items
  return (transform ? out.map(transform) : out) as T[]
}

// ---------------------------------------------------------------------------
// dynamic fields
// ---------------------------------------------------------------------------

/**
 * Selects both the dynamic field's own object (`contents`, the `0x2::dynamic_field::Field<K, V>`
 * wrapper with `fields.name` / `fields.value`) and its `value`. Dynamic *object* fields resolve to
 * the child MoveObject; plain dynamic fields resolve to the Field wrapper, which is what the
 * adapters historically read (`i.fields.value`) and the only shape that works for primitive values
 * such as `0x2::object::ID`.
 */
const DYNAMIC_FIELD_VALUE_SELECTION = (skipLayout?: boolean) => `${contentsSelection(skipLayout)} value {
  __typename
  ... on MoveValue { json type { repr ${skipLayout ? '' : 'layout'} } }
  ... on MoveObject { address ${contentsSelection(skipLayout)} }
}`

function formatDynamicFieldValue(node: { value?: any, contents?: any }, fallbackAddress?: string): SuiObject | null {
  const { value, contents } = node ?? {}
  if (value?.__typename === 'MoveObject' && value.contents) return formatObject(value.contents, value.address)
  if (contents) return formatObject(contents, fallbackAddress)
  if (!value) return null
  return formatObject({ json: value.json, type: value.type }, fallbackAddress)
}

export interface GetDynamicFieldObjectOptions extends ChainOptions {
  parent: string
  /** field name value (alias: `id`) */
  name?: any
  id?: any
  /** Move type of the name (alias: `idType`), default `0x2::object::ID` */
  nameType?: string
  idType?: string
  /** pre-encoded BCS (base64) of the name; overrides `name`. Defaults to `EMPTY_STRUCT_BCS` when no name is given. */
  nameBcs?: string
  skipLayout?: boolean
}

/** One dynamic field (or dynamic object field) of `parent` by name; null when missing */
export async function getDynamicFieldObject({ chain = 'sui', parent, name, id, nameType, idType, nameBcs, skipLayout }: GetDynamicFieldObjectOptions): Promise<SuiObject | null> {
  const type = nameType ?? idType ?? '0x2::object::ID'
  const value = name ?? id
  const bcs = nameBcs ?? (value !== undefined ? bcsDynamicFieldName(type, value) : EMPTY_STRUCT_BCS)
  if (!hasGraphql(chain)) {
    const res = await call({ chain, method: `${rpcPrefix(chain)}x_getDynamicFieldObject`, params: [toAddr(parent), { type, value: typeof value === 'bigint' ? value.toString() : value }] })
    const obj = formatRpcObject(res?.data)
    if (obj && value !== undefined) obj.name = value
    return obj
  }
  const sel = DYNAMIC_FIELD_VALUE_SELECTION(skipLayout)
  const data = await graphqlCall({
    chain, query: `query ($parent: SuiAddress!, $name: DynamicFieldName!) {
    address(address: $parent) {
      dynamicField(name: $name) { name { json } ${sel} }
      dynamicObjectField(name: $name) { name { json } ${sel} }
    }
  }`, variables: { parent: toAddr(parent), name: { type, bcs } }
  })
  const df = data.address?.dynamicObjectField ?? data.address?.dynamicField
  if (!df) return null
  const obj = formatDynamicFieldValue(df)
  if (obj) obj.name = df.name?.json
  return obj
}

export interface DynamicFieldFilterInput {
  objectId: string
  objectType: string
  /** `fields.name` of the value, when present */
  name?: any
  /** the dynamic field key (`name.json`) */
  key?: any
}

export interface GetDynamicFieldObjectsOptions extends ChainOptions {
  parent: string
  /** resume from this cursor */
  cursor?: string | null
  /** stop after this many objects (all pages by default) */
  limit?: number
  /** page size, max 50 */
  pageSize?: number
  idFilter?: (input: DynamicFieldFilterInput) => any
  skipLayout?: boolean
  /** ms to wait before each page */
  sleep?: number
  /** receive each page as it arrives; the return value is then empty */
  onPage?: (items: SuiObject[]) => any
}

/** All dynamic fields of `parent` (Table / Bag / ObjectTable entries), walking every page. Each item carries `name` (the field key). */
export async function getDynamicFieldObjects({ chain = 'sui', parent, cursor = null, limit, pageSize = PAGE_SIZE, idFilter, skipLayout, sleep: sleepTime, onPage }: GetDynamicFieldObjectsOptions): Promise<SuiObject[]> {
  const size = Math.min(Math.max(1, Number(pageSize) || PAGE_SIZE), 50)
  const items: SuiObject[] = []
  const addedIds = new Set<string>()
  const useRpc = !hasGraphql(chain)
  const parentAddr = toAddr(parent)
  let after: string | null = cursor
  const push = async (pageItems: SuiObject[]) => {
    if (onPage) await onPage(pageItems) // let callers start downstream reads while paging continues
    else items.push(...pageItems)
  }
  let count = 0

  do {
    if (sleepTime) await sleep(sleepTime)
    const pageItems: SuiObject[] = []
    if (useRpc) {
      const prefix = rpcPrefix(chain)
      const page = await call({ chain, method: `${prefix}x_getDynamicFields`, params: [parentAddr, after, size] })
      const ids: string[] = (page?.data ?? []).map((f: any) => f.objectId)
      const objs = await rpcGetObjects({ chain, objectIds: ids })
      page?.data?.forEach((f: any, i: number) => {
        const obj = objs[i]
        if (!obj || addedIds.has(obj.id!)) return
        obj.name = f.name?.value
        if (idFilter && !idFilter({ objectId: obj.id!, objectType: obj.type, name: obj.fields?.name, key: obj.name })) return
        addedIds.add(obj.id!)
        pageItems.push(obj)
      })
      after = page?.hasNextPage ? page.nextCursor : null
    } else {
      const data = await graphqlCall({
        chain, query: `query ($parent: SuiAddress!, $after: String) {
        address(address: $parent) {
          dynamicFields(first: ${size}, after: $after) {
            pageInfo { hasNextPage endCursor }
            nodes { address name { json } ${DYNAMIC_FIELD_VALUE_SELECTION(skipLayout)} }
          }
        }
      }`, variables: { parent: parentAddr, after }
      })
      const df = data.address?.dynamicFields
      if (!df) throw new Error(`[${chain}] dynamicFields not available for ${parent} (endpoint may not index this object)`)
      debugLog(`[${chain}] fetched dynamic fields`, df.nodes.length, df.pageInfo.hasNextPage)
      for (const n of df.nodes) {
        const obj = formatDynamicFieldValue(n, n.address)
        const objectId = obj?.id ?? n.address
        if (!obj || !objectId || addedIds.has(objectId)) continue
        obj.id = objectId
        obj.name = n.name?.json // the dynamic-field key (e.g. a coin TypeName), which the value object may not carry
        if (idFilter && !idFilter({ objectId, objectType: obj.type, name: obj.fields?.name, key: obj.name })) continue
        addedIds.add(objectId)
        pageItems.push(obj)
      }
      after = df.pageInfo.hasNextPage ? df.pageInfo.endCursor : null
    }
    count += pageItems.length
    await push(limit && count > limit ? pageItems.slice(0, pageItems.length - (count - limit)) : pageItems)
    if (limit && count >= limit) after = null
  } while (after)
  return items
}

// ---------------------------------------------------------------------------
// coins & balances
// ---------------------------------------------------------------------------

export interface CoinTypeOptions extends ChainOptions {
  coinType: string
}

export interface CoinMetadata {
  decimals: number
  symbol: string
  name: string
  description?: string
  iconUrl?: string
  /** total supply in base units, when the endpoint knows it */
  supply?: string
}

/** `coinMetadata` (GraphQL) or `<prefix>x_getCoinMetadata` + `<prefix>x_getTotalSupply` (JSON-RPC) */
export async function getCoinMetadata({ chain = 'sui', coinType }: CoinTypeOptions): Promise<CoinMetadata> {
  if (!hasGraphql(chain)) {
    const prefix = rpcPrefix(chain)
    const meta = await call({ chain, method: `${prefix}x_getCoinMetadata`, params: [coinType] })
    if (!meta) throw new Error(`[${chain}] Failed to fetch coin metadata for token: ${coinType}`)
    let supply: string | undefined
    try {
      const res = await call({ chain, method: `${prefix}x_getTotalSupply`, params: [coinType] })
      supply = res?.value
    } catch (e) {
      debugLog(`[${chain}] getTotalSupply failed for ${coinType}: ${(e as any)?.message}`)
    }
    return { decimals: meta.decimals, symbol: meta.symbol, name: meta.name, description: meta.description, iconUrl: meta.iconUrl, supply }
  }
  const data = await graphqlCall({
    chain, query: `query ($coinType: String!) {
    coinMetadata(coinType: $coinType) { decimals symbol name description iconUrl supply }
  }`, variables: { coinType }
  })
  const meta = data.coinMetadata
  if (!meta) throw new Error(`[${chain}] Failed to fetch coin metadata for token: ${coinType}`)
  return { decimals: meta.decimals ?? 0, symbol: meta.symbol, name: meta.name, description: meta.description, iconUrl: meta.iconUrl, supply: meta.supply ?? undefined }
}

export interface TokenSupply {
  /** base units */
  supply: string
  decimals: number
  /** supply / 10 ** decimals */
  normalized: number
}

export async function getTokenSupply({ chain = 'sui', coinType }: CoinTypeOptions): Promise<TokenSupply> {
  const { supply, decimals } = await getCoinMetadata({ chain, coinType })
  if (supply === undefined || supply === null) throw new Error(`[${chain}] supply not available for token: ${coinType}`)
  return { supply: String(supply), decimals, normalized: Number(supply) / 10 ** decimals }
}

export interface OwnerOptions extends ChainOptions {
  owner: string
}

export interface CoinBalance {
  /** zero padded coin type as returned by GraphQL */
  coinType: string
  totalBalance: string
}

/** Every coin balance of `owner`, walking all pages */
export async function getAllBalances({ chain = 'sui', owner }: OwnerOptions): Promise<CoinBalance[]> {
  const out: CoinBalance[] = []
  if (!hasGraphql(chain)) {
    const res: any[] = await call({ chain, method: `${rpcPrefix(chain)}x_getAllBalances`, params: [toAddr(owner)] })
    for (const b of res ?? []) out.push({ coinType: b.coinType, totalBalance: String(b.totalBalance) })
    return out
  }
  let after: string | null = null
  do {
    const data = await graphqlCall({
      chain, query: `query ($owner: SuiAddress!, $after: String) {
      address(address: $owner) {
        balances(first: ${PAGE_SIZE}, after: $after) {
          nodes { coinType { repr } totalBalance }
          pageInfo { hasNextPage endCursor }
        }
      }
    }`, variables: { owner: toAddr(owner), after }
    })
    const balances = data.address?.balances
    if (!balances) break
    for (const n of balances.nodes ?? []) out.push({ coinType: n.coinType.repr, totalBalance: String(n.totalBalance) })
    after = balances.pageInfo?.hasNextPage ? balances.pageInfo.endCursor : null
  } while (after)
  return out
}

export interface GetBalanceOptions extends OwnerOptions {
  coinType: string
}

/** Balance of one coin type for `owner` (base units, '0' when none) */
export async function getBalance({ chain = 'sui', owner, coinType }: GetBalanceOptions): Promise<string> {
  if (!hasGraphql(chain)) {
    const res = await call({ chain, method: `${rpcPrefix(chain)}x_getBalance`, params: [toAddr(owner), coinType] })
    return String(res?.totalBalance ?? '0')
  }
  const data = await graphqlCall({
    chain, query: `query ($owner: SuiAddress!, $coinType: String!) {
    address(address: $owner) { balance(coinType: $coinType) { totalBalance } }
  }`, variables: { owner: toAddr(owner), coinType }
  })
  return String(data.address?.balance?.totalBalance ?? '0')
}

// ---------------------------------------------------------------------------
// checkpoints
// ---------------------------------------------------------------------------

export interface Checkpoint {
  sequenceNumber: number
  /** unix seconds */
  timestamp: number
  digest?: string
}

function shapeGraphqlCheckpoint(c: any): Checkpoint | null {
  if (!c) return null
  return { sequenceNumber: Number(c.sequenceNumber), timestamp: Math.floor(Date.parse(c.timestamp) / 1e3), digest: c.digest }
}

function shapeRpcCheckpoint(c: any): Checkpoint | null {
  if (!c) return null
  return { sequenceNumber: Number(c.sequenceNumber), timestamp: Math.floor(Number(c.timestampMs) / 1e3), digest: c.digest }
}

export interface GetCheckpointOptions extends ChainOptions {
  sequenceNumber: number | string
}

/** A checkpoint by sequence number; null when the endpoint no longer has it */
export async function getCheckpoint({ chain = 'sui', sequenceNumber }: GetCheckpointOptions): Promise<Checkpoint | null> {
  if (!hasGraphql(chain)) {
    const res = await call({ chain, method: `${rpcPrefix(chain)}_getCheckpoint`, params: [String(sequenceNumber)] })
    return shapeRpcCheckpoint(res)
  }
  const data = await graphqlCall({
    chain, query: `query ($seq: UInt53!) { checkpoint(sequenceNumber: $seq) { sequenceNumber timestamp digest } }`,
    variables: { seq: Number(sequenceNumber) },
  })
  return shapeGraphqlCheckpoint(data.checkpoint)
}

export async function getLatestCheckpoint({ chain = 'sui' }: ChainOptions = {}): Promise<Checkpoint> {
  if (!hasGraphql(chain)) {
    const prefix = rpcPrefix(chain)
    const seq = await call({ chain, method: `${prefix}_getLatestCheckpointSequenceNumber`, params: [] })
    const c = await getCheckpoint({ chain, sequenceNumber: seq })
    if (!c) throw new Error(`[${chain}] checkpoint ${seq} not found`)
    return c
  }
  const data = await graphqlCall({ chain, query: `{ checkpoint { sequenceNumber timestamp digest } }` })
  const c = shapeGraphqlCheckpoint(data.checkpoint)
  if (!c) throw new Error(`[${chain}] latest checkpoint not available`)
  return c
}

export interface GetCheckpointAtTimestampOptions extends ChainOptions {
  /** unix seconds */
  timestamp: number
}

/** Last checkpoint with `timestamp <= target` (binary search over sequence numbers, ~30 requests) */
export async function getCheckpointAtTimestamp({ chain = 'sui', timestamp }: GetCheckpointAtTimestampOptions): Promise<Checkpoint> {
  const target = toSeconds(timestamp)
  const latest = await getLatestCheckpoint({ chain })
  if (latest.timestamp <= target) return latest
  let lo = 0
  let hi = latest.sequenceNumber
  let best: Checkpoint | null = null
  while (lo < hi) {
    const mid = Math.floor((lo + hi + 1) / 2)
    const c = await getCheckpoint({ chain, sequenceNumber: mid })
    if (!c || c.timestamp <= target) {
      // missing (pruned) checkpoints are treated as older than the target
      if (c) best = c
      lo = mid
    } else {
      hi = mid - 1
    }
  }
  if (best && best.sequenceNumber === lo) return best
  const c = await getCheckpoint({ chain, sequenceNumber: lo })
  if (!c) throw new Error(`[${chain}] no checkpoint found at or before ${target}`)
  return c
}

// ---------------------------------------------------------------------------
// simulation
// ---------------------------------------------------------------------------

export interface DevInspectOptions extends ChainOptions {
  /** BCS `TransactionKind` bytes, e.g. from `buildProgrammableMoveCallBytes` */
  txBytes: Bytes
  sender?: string
}

export interface DevInspectResult {
  /** per command: `[bcsBytes, typeRepr]` per return value */
  results: { returnValues: [number[], string | undefined][] }[]
  effects: any
}

/** Simulate a transaction kind and return the BCS return values of every command (GraphQL `simulateTransaction`, JSON-RPC `devInspectTransactionBlock`) */
export async function devInspectTransactionBlock({ chain = 'sui', txBytes, sender = DUMMY_SENDER }: DevInspectOptions): Promise<DevInspectResult> {
  const kindBytes = Array.from(txBytes)
  if (!hasGraphql(chain)) {
    const res = await call({ chain, method: `${rpcPrefix(chain)}_devInspectTransactionBlock`, params: [sender, bytesToBase64(kindBytes)] })
    if (res?.error) throw new Error(`[${chain}] devInspectTransactionBlock failed: ${res.error}`)
    const status = res?.effects?.status?.status
    if (status && status !== 'success') throw new Error(`[${chain}] devInspectTransactionBlock failed: ${res.effects.status.error ?? status}`)
    const results = (res?.results ?? []).map((cmd: any) => ({
      returnValues: (cmd.returnValues ?? []).map((rv: any) => [Array.from(rv[0] as number[]), rv[1] as string] as [number[], string | undefined]),
    }))
    return { results, effects: res?.effects }
  }
  const value = bytesToBase64(buildTransactionDataBytes(kindBytes, { sender }))
  const data = await graphqlCall({
    chain, query: `query ($tx: JSON!) {
    simulateTransaction(transaction: $tx, checksEnabled: false, doGasSelection: true) {
      effects { status }
      outputs { returnValues { value { bcs type { repr } } } }
    }
  }`, variables: { tx: { bcs: { value } } }
  })
  const sim = data.simulateTransaction
  if (sim?.effects?.status && sim.effects.status !== 'SUCCESS')
    throw new Error(`[${chain}] simulateTransaction failed: ${sim.effects.status}`)
  const results = (sim?.outputs || []).map((cmd: any) => ({
    returnValues: (cmd.returnValues || []).map((rv: any) => [base64ToBytes(rv.value.bcs), rv.value.type?.repr] as [number[], string | undefined]),
  }))
  return { results, effects: sim?.effects }
}

export interface GetInitialSharedVersionOptions extends ChainOptions {
  objectId: string
}

/** `initialSharedVersion` of a shared object (needed to reference it as a transaction input) */
export async function getInitialSharedVersion({ chain = 'sui', objectId }: GetInitialSharedVersionOptions): Promise<number> {
  if (!hasGraphql(chain)) {
    const res = await call({ chain, method: `${rpcPrefix(chain)}_getObject`, params: [toAddr(objectId), { showOwner: true }] })
    const version = res?.data?.owner?.Shared?.initial_shared_version
    if (version === undefined || version === null) throw new Error(`[${chain}] object ${objectId} is not a shared object`)
    return Number(version)
  }
  const data = await graphqlCall({
    chain, query: `query ($address: SuiAddress!) {
    object(address: $address) { owner { __typename ... on Shared { initialSharedVersion } } }
  }`, variables: { address: toAddr(objectId) }
  })
  const version = data.object?.owner?.initialSharedVersion
  if (version === undefined || version === null) throw new Error(`[${chain}] object ${objectId} is not a shared object`)
  return Number(version)
}

export interface ViewFunctionOptions extends ChainOptions, Omit<MoveCallParams, 'sharedObjects'> {
  /** shared object ids (or refs); `initialSharedVersion` is looked up when missing */
  sharedObjects?: (string | SharedObjectRef)[]
  sender?: string
}

/** Build a single MoveCall over shared objects, simulate it and return `[bcsBytes, typeRepr]` per return value */
export async function callViewFunction({ chain = 'sui', sharedObjects = [], sender, ...moveCall }: ViewFunctionOptions): Promise<[number[], string | undefined][]> {
  const refs: SharedObjectRef[] = await Promise.all(sharedObjects.map(async (o) => {
    if (typeof o !== 'string' && o.initialSharedVersion !== undefined) return o
    const objectId = typeof o === 'string' ? o : o.objectId
    const initialSharedVersion = await getInitialSharedVersion({ chain, objectId })
    return { objectId, initialSharedVersion, mutable: typeof o === 'string' ? false : o.mutable }
  }))
  const txBytes = buildProgrammableMoveCallBytes({ ...moveCall, sharedObjects: refs })
  const { results } = await devInspectTransactionBlock({ chain, txBytes, sender })
  return results[0]?.returnValues ?? []
}

export { sliceIntoChunks }
