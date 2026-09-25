/**
 * Internet Computer (ICP) query client with a hand-rolled CBOR / Candid / Principal codec.
 *
 * Replaces (and unifies) the ad-hoc ICP helpers spread across the llama repos:
 * - DefiLlama-Adapters   `projects/helper/chain/icp.js` (encodeCbor, decodeCbor, LEB128, decodeCandid,
 *                        hashCandidLabel, principal text <-> bytes, queryCanister; used by liquidium, onesec)
 * - dimension-adapters   `helpers/icp.ts` (TS port of the above + queryCanisterDecoded; used by dexs/ICDex)
 *
 * What is new compared to those helpers:
 * - `queryCanister` accepts an `arg` (Candid encoded) so methods with parameters can be queried
 *   (`icrc1_balance_of`, `account_balance`, ...). Zero-arg calls behave exactly as before.
 * - A minimal Candid *encoder* (`encodeCandid`) covering the primitive types plus `opt`, `vec`,
 *   `record` and `variant`, enough for ICRC-1 / ICRC-2 queries.
 * - CBOR encoder supports negative integers, LEB128 encoders, base32 decoder, principal checksum
 *   verification, `isPrincipal`, `accountIdentifierFromPrincipal` (ICP ledger account ids).
 * - ICRC helpers (`getIcrcMetadata`, `getIcrcDecimals`, `getIcrcSymbol`, `getIcrcTotalSupply`,
 *   `getIcrcBalance`) and `getIcpAccountBalance` for the ICP ledger.
 *
 * Transport: requests go through the shared `httpPost` (endpoint rotation + retry on transport
 * errors) and a shared p-limit(10) limiter (`ICP_RPC_CONCURRENCY` overrides it). `ICP_RPC` (comma
 * separated) overrides the default boundary node list. Canister rejects are NOT retried and are
 * surfaced as `IcpRejectError` with `rejectCode` / `errorCode` so callers can tell a permanently
 * dead canister (`IC0537`, no Wasm module installed) from a transient failure.
 *
 * Only anonymous query calls are supported (no update calls, no identities), which is all the
 * llama adapters need.
 *
 * Usage:
 *   `sdk.chains.icp.getIcrcBalance({ ledger: 'mxzaz-hqaaa-aaaar-qaada-cai', owner: 'mqygn-kiaaa-aaaar-qaadq-cai' })`
 *   `sdk.chains.icp.queryCanisterDecoded({ canisterId, method: 'stats', labels: ['vol24h'] })`
 */
import { createHash } from "crypto";
import { debugLog } from "../util/debugLog";
import { getEndpoints as resolveEndpoints, getLimiter, httpPost, stripTrailingSlash, toEndpointList, Endpoints } from "./rpc";

export const CHAIN = 'icp'

export const DEFAULT_ENDPOINTS: string[] = [
  'https://icp-api.io',
  'https://ic0.app',
]

/** ICP ledger canister */
export const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai'

const DEFAULT_TIMEOUT = 30_000
const CONCURRENCY = 10
const INGRESS_EXPIRY_MS = 5 * 60 * 1000

/** Candid encoding of an empty argument list: "DIDL" + 0 types + 0 args */
export const EMPTY_ARGS: Uint8Array = Buffer.from([0x44, 0x49, 0x44, 0x4c, 0x00, 0x00])
/** anonymous principal (0x04) */
export const ANONYMOUS_SENDER: Uint8Array = Buffer.from([0x04])

// bigint literals need es2020, so build the constants at runtime
const B0 = BigInt(0)
const B1 = BigInt(1)
const B7 = BigInt(7)
const B8 = BigInt(8)
const B24 = BigInt(24)
const B0x40 = BigInt(0x40)
const B0x7f = BigInt(0x7f)
const B0xff = BigInt(0xff)
const B0xffff = BigInt(0xffff)
const B0xffffffff = BigInt(0xffffffff)
const MAX_U64 = BigInt('18446744073709551615')
const NEG1 = BigInt(-1)
const MAX_SAFE_BIGINT = BigInt(Number.MAX_SAFE_INTEGER)
const MIN_SAFE_BIGINT = BigInt(Number.MIN_SAFE_INTEGER)
const NANOS_PER_MS = BigInt(1_000_000)

type Cursor = { i: number }

// ---------------------------------------------------------------------------
// CBOR encoder
// ---------------------------------------------------------------------------

/** Encode a CBOR item head: major type (0-7) + unsigned argument. */
export function encodeCborHead(major: number, value: number | bigint): Buffer {
  const n = BigInt(value)
  if (n < B0) throw new Error('CBOR head argument must be non-negative')
  if (n > MAX_U64) throw new Error(`CBOR head argument exceeds 64 bits: ${n}`)
  if (n < B24) return Buffer.from([(major << 5) | Number(n)])
  if (n <= B0xff) return Buffer.from([(major << 5) | 24, Number(n)])
  if (n <= B0xffff) return Buffer.from([(major << 5) | 25, Number((n >> B8) & B0xff), Number(n & B0xff)])
  if (n <= B0xffffffff)
    return Buffer.from([
      (major << 5) | 26,
      Number((n >> BigInt(24)) & B0xff),
      Number((n >> BigInt(16)) & B0xff),
      Number((n >> B8) & B0xff),
      Number(n & B0xff),
    ])
  const out = Buffer.alloc(9)
  out[0] = (major << 5) | 27
  for (let i = 0; i < 8; i++) out[1 + i] = Number((n >> BigInt(56 - i * 8)) & B0xff)
  return out
}

/**
 * Encode a JS value as CBOR. Supports null, booleans, integers (number / bigint, negative too),
 * byte strings (Buffer / Uint8Array), text, arrays and plain objects (keys encoded as text, in
 * insertion order). Floats are rejected: the IC request format never needs them.
 */
export function encodeCbor(value: any): Buffer {
  if (value === null || value === undefined) return Buffer.from([0xf6])
  if (value === false) return Buffer.from([0xf4])
  if (value === true) return Buffer.from([0xf5])

  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error('CBOR encoder only supports integers')
    return encodeCbor(BigInt(value))
  }
  if (typeof value === 'bigint') {
    if (value < B0) return encodeCborHead(1, NEG1 - value)
    return encodeCborHead(0, value)
  }
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    const bytes = Buffer.from(value)
    return Buffer.concat([encodeCborHead(2, bytes.length), bytes])
  }
  if (typeof value === 'string') {
    const bytes = Buffer.from(value, 'utf8')
    return Buffer.concat([encodeCborHead(3, bytes.length), bytes])
  }
  if (Array.isArray(value)) return Buffer.concat([encodeCborHead(4, value.length), ...value.map(encodeCbor)])
  if (typeof value === 'object') {
    const keys = Object.keys(value)
    const chunks = [encodeCborHead(5, keys.length)]
    for (const key of keys) {
      chunks.push(encodeCbor(key))
      chunks.push(encodeCbor(value[key]))
    }
    return Buffer.concat(chunks)
  }
  throw new Error(`Unsupported CBOR value type: ${typeof value}`)
}

// ---------------------------------------------------------------------------
// CBOR decoder
// ---------------------------------------------------------------------------

function readCborUint(bytes: Uint8Array, state: Cursor, additionalInfo: number): bigint {
  if (additionalInfo < 24) return BigInt(additionalInfo)
  if (additionalInfo === 24) return BigInt(bytes[state.i++])
  if (additionalInfo === 25) {
    const out = (BigInt(bytes[state.i]) << B8) | BigInt(bytes[state.i + 1])
    state.i += 2
    return out
  }
  if (additionalInfo === 26) {
    const out =
      (BigInt(bytes[state.i]) << BigInt(24)) |
      (BigInt(bytes[state.i + 1]) << BigInt(16)) |
      (BigInt(bytes[state.i + 2]) << B8) |
      BigInt(bytes[state.i + 3])
    state.i += 4
    return out
  }
  if (additionalInfo === 27) {
    let out = B0
    for (let i = 0; i < 8; i++) out = (out << B8) | BigInt(bytes[state.i++])
    return out
  }
  throw new Error(`Unsupported CBOR additional info ${additionalInfo}`)
}

/**
 * Decode one CBOR item starting at `state.i` (default: the start of `bytes`).
 * Integers within the safe range decode to `number`, larger ones to `bigint`; byte strings to
 * `Uint8Array`; maps to plain objects. Tags are skipped (the IC self-describe tag 55799 included).
 */
export function decodeCbor(bytes: Uint8Array, state: Cursor = { i: 0 }): any {
  if (state.i >= bytes.length) throw new Error('Unexpected end of CBOR input')
  const first = bytes[state.i++]
  const major = first >> 5
  const additionalInfo = first & 0x1f

  if (major === 0) {
    const out = readCborUint(bytes, state, additionalInfo)
    return out <= MAX_SAFE_BIGINT ? Number(out) : out
  }
  if (major === 1) {
    const out = NEG1 - readCborUint(bytes, state, additionalInfo)
    return out >= MIN_SAFE_BIGINT ? Number(out) : out
  }
  if (major === 2) {
    if (additionalInfo === 31) {
      const parts: Buffer[] = []
      while (bytes[state.i] !== 0xff) parts.push(Buffer.from(decodeCbor(bytes, state)))
      state.i += 1
      return Buffer.concat(parts)
    }
    const length = Number(readCborUint(bytes, state, additionalInfo))
    const out = bytes.slice(state.i, state.i + length)
    state.i += length
    return out
  }
  if (major === 3) {
    if (additionalInfo === 31) {
      let out = ''
      while (bytes[state.i] !== 0xff) out += decodeCbor(bytes, state)
      state.i += 1
      return out
    }
    const length = Number(readCborUint(bytes, state, additionalInfo))
    const out = Buffer.from(bytes.slice(state.i, state.i + length)).toString('utf8')
    state.i += length
    return out
  }
  if (major === 4) {
    if (additionalInfo === 31) {
      const out: any[] = []
      while (bytes[state.i] !== 0xff) out.push(decodeCbor(bytes, state))
      state.i += 1
      return out
    }
    const length = Number(readCborUint(bytes, state, additionalInfo))
    const out: any[] = []
    for (let i = 0; i < length; i++) out.push(decodeCbor(bytes, state))
    return out
  }
  if (major === 5) {
    if (additionalInfo === 31) {
      const out: any = {}
      while (bytes[state.i] !== 0xff) {
        const key = decodeCbor(bytes, state)
        out[key] = decodeCbor(bytes, state)
      }
      state.i += 1
      return out
    }
    const length = Number(readCborUint(bytes, state, additionalInfo))
    const out: any = {}
    for (let i = 0; i < length; i++) {
      const key = decodeCbor(bytes, state)
      out[key] = decodeCbor(bytes, state)
    }
    return out
  }
  if (major === 6) {
    readCborUint(bytes, state, additionalInfo) // tag number, ignored
    return decodeCbor(bytes, state)
  }
  if (major === 7) {
    if (additionalInfo === 20) return false
    if (additionalInfo === 21) return true
    if (additionalInfo === 22) return null
    if (additionalInfo === 23) return undefined
    if (additionalInfo === 26) {
      const out = Buffer.from(bytes.slice(state.i, state.i + 4)).readFloatBE(0)
      state.i += 4
      return out
    }
    if (additionalInfo === 27) {
      const out = Buffer.from(bytes.slice(state.i, state.i + 8)).readDoubleBE(0)
      state.i += 8
      return out
    }
  }
  throw new Error(`Unsupported CBOR major type ${major} with additional info ${additionalInfo}`)
}

// ---------------------------------------------------------------------------
// LEB128
// ---------------------------------------------------------------------------

/** Read an unsigned LEB128 integer at `state.i`, advancing the cursor. */
export function decodeUleb128(bytes: Uint8Array, state: Cursor): bigint {
  let out = B0
  let shift = B0
  while (true) {
    if (state.i >= bytes.length) throw new Error('Unexpected end of LEB128 input')
    const byte = bytes[state.i++]
    out |= BigInt(byte & 0x7f) << shift
    if ((byte & 0x80) === 0) return out
    shift += B7
  }
}

/** Read a signed LEB128 integer at `state.i`, advancing the cursor. */
export function decodeSleb128(bytes: Uint8Array, state: Cursor): bigint {
  let out = B0
  let shift = B0
  let byte = 0
  while (true) {
    if (state.i >= bytes.length) throw new Error('Unexpected end of LEB128 input')
    byte = bytes[state.i++]
    out |= BigInt(byte & 0x7f) << shift
    shift += B7
    if ((byte & 0x80) === 0) break
  }
  if (byte & 0x40) out |= NEG1 << shift
  return out
}

/** Encode a non-negative integer as unsigned LEB128. */
export function encodeUleb128(value: number | bigint | string): Buffer {
  let n = BigInt(value)
  if (n < B0) throw new Error(`uleb128: value must be non-negative, got ${value}`)
  const out: number[] = []
  do {
    let byte = Number(n & B0x7f)
    n >>= B7
    if (n !== B0) byte |= 0x80
    out.push(byte)
  } while (n !== B0)
  return Buffer.from(out)
}

/** Encode an integer as signed LEB128. */
export function encodeSleb128(value: number | bigint | string): Buffer {
  let n = BigInt(value)
  const out: number[] = []
  while (true) {
    const byte = Number(n & B0x7f)
    n >>= B7
    const signBitClear = (byte & 0x40) === 0
    const done = (n === B0 && signBitClear) || (n === NEG1 && !signBitClear)
    out.push(done ? byte : byte | 0x80)
    if (done) break
  }
  return Buffer.from(out)
}

// ---------------------------------------------------------------------------
// Candid
// ---------------------------------------------------------------------------

/** Candid type opcodes (negative sleb128 in the type table) */
export const CANDID_TYPE = {
  null: -1,
  bool: -2,
  nat: -3,
  int: -4,
  nat8: -5,
  nat16: -6,
  nat32: -7,
  nat64: -8,
  int8: -9,
  int16: -10,
  int32: -11,
  int64: -12,
  float32: -13,
  float64: -14,
  text: -15,
  reserved: -16,
  empty: -17,
  opt: -18,
  vec: -19,
  record: -20,
  variant: -21,
  func: -22,
  service: -23,
  principal: -24,
} as const

export type CandidPrimitive =
  | 'null' | 'bool' | 'nat' | 'int'
  | 'nat8' | 'nat16' | 'nat32' | 'nat64'
  | 'int8' | 'int16' | 'int32' | 'int64'
  | 'float32' | 'float64' | 'text' | 'reserved' | 'empty' | 'principal'
  /** shorthand for `vec nat8`, value may be Uint8Array / number[] / hex string */
  | 'blob'

/**
 * Type descriptor for {@link encodeCandid}. Record / variant field names are hashed with
 * {@link hashCandidLabel}; a purely numeric name (`'0'`, `'1'`) is used as the field id directly
 * (Candid tuple fields).
 */
export type CandidType =
  | CandidPrimitive
  | { opt: CandidType }
  | { vec: CandidType }
  | { record: Record<string, CandidType> }
  | { variant: Record<string, CandidType> }

export interface CandidValue {
  type: CandidType
  value: any
}

/**
 * Candid identifies a record field by a hash of its name rather than the name itself, so a decoded
 * record comes back keyed by number. Build a `{ [hash]: name }` map with this (or with
 * {@link buildLabelHashMap}) to get readable keys. `hash = fold(h * 223 + byte) mod 2^32`.
 */
export function hashCandidLabel(label: string): number {
  let out = 0
  for (const codePoint of Buffer.from(label, 'utf8')) out = (out * 223 + codePoint) >>> 0
  return out
}

/** `['owner', 'subaccount']` -> `{ 947296307: 'owner', 1349681965: 'subaccount' }` */
export function buildLabelHashMap(labels: string[] = []): Record<number, string> {
  const out: Record<number, string> = {}
  for (const label of labels) out[hashCandidLabel(label)] = label
  return out
}

function fieldId(name: string): number {
  if (/^\d+$/.test(name)) return Number(name)
  return hashCandidLabel(name)
}

/**
 * Decode a Candid-encoded reply. Candid is self-describing, so the concrete shape is only known at
 * runtime and values are returned as `any`; narrow them at the call site.
 * - `nat`, `int`, `nat64`, `int64` -> `bigint`; `nat8/16/32`, `int8/16/32`, floats -> `number`
 * - `text`, `principal` -> `string`; `opt` -> 0- or 1-element array; `vec` -> array (`vec nat8` too)
 * - `record` -> object keyed by label (via `labelHashMap`) or by field hash as a string
 * - `variant` -> single-key object
 * @param bytes the raw `DIDL...` payload returned by {@link queryCanister}
 * @param labelHashMap `{ [hash]: name }` from {@link hashCandidLabel}; unmapped fields keep their hash
 * @returns one entry per value in the reply tuple
 */
export function decodeCandid(bytes: Uint8Array, labelHashMap: Record<number, string> = {}): any[] {
  const state: Cursor = { i: 0 }
  if (Buffer.from(bytes.slice(0, 4)).toString('ascii') !== 'DIDL') throw new Error('Invalid Candid payload')
  state.i = 4

  const typeCount = Number(decodeUleb128(bytes, state))
  const typeTable: any[] = []
  const readTypeRef = () => Number(decodeSleb128(bytes, state))

  for (let i = 0; i < typeCount; i++) {
    const kind = Number(decodeSleb128(bytes, state))
    if (kind === CANDID_TYPE.opt || kind === CANDID_TYPE.vec) {
      typeTable.push({ kind, type: readTypeRef() })
      continue
    }
    if (kind === CANDID_TYPE.record || kind === CANDID_TYPE.variant) {
      const fieldCount = Number(decodeUleb128(bytes, state))
      const fields: any[] = []
      for (let j = 0; j < fieldCount; j++) {
        const id = Number(decodeUleb128(bytes, state))
        const type = readTypeRef()
        fields.push({ id, type })
      }
      typeTable.push({ kind, fields })
      continue
    }
    throw new Error(`Unsupported Candid type table kind ${kind}`)
  }

  const argCount = Number(decodeUleb128(bytes, state))
  const argTypes: number[] = []
  for (let i = 0; i < argCount; i++) argTypes.push(readTypeRef())

  const readFixedUint = (size: number): bigint => {
    let out = B0
    for (let i = 0; i < size; i++) out |= BigInt(bytes[state.i++]) << BigInt(i * 8)
    return out
  }
  const label = (id: number) => labelHashMap[id] || String(id)

  const decodeType = (typeRef: number): any => {
    if (typeRef >= 0) {
      const definition = typeTable[typeRef]
      if (!definition) throw new Error(`Unknown Candid type ref ${typeRef}`)

      if (definition.kind === CANDID_TYPE.opt) {
        const tag = bytes[state.i++]
        if (tag === 0) return []
        if (tag === 1) return [decodeType(definition.type)]
        throw new Error(`Invalid Candid opt tag ${tag}`)
      }
      if (definition.kind === CANDID_TYPE.vec) {
        const length = Number(decodeUleb128(bytes, state))
        const out: any[] = []
        for (let i = 0; i < length; i++) out.push(decodeType(definition.type))
        return out
      }
      if (definition.kind === CANDID_TYPE.record) {
        const out: any = {}
        for (const field of definition.fields) out[label(field.id)] = decodeType(field.type)
        return out
      }
      if (definition.kind === CANDID_TYPE.variant) {
        const index = Number(decodeUleb128(bytes, state))
        const selectedField = definition.fields[index]
        if (!selectedField) throw new Error(`Invalid Candid variant index ${index}`)
        return { [label(selectedField.id)]: decodeType(selectedField.type) }
      }
      throw new Error(`Unsupported Candid composite kind ${definition.kind}`)
    }

    switch (typeRef) {
      case CANDID_TYPE.null:
      case CANDID_TYPE.reserved:
        return null
      case CANDID_TYPE.bool: {
        const value = bytes[state.i++]
        if (value !== 0 && value !== 1) throw new Error(`Invalid Candid bool value ${value}`)
        return value === 1
      }
      case CANDID_TYPE.nat: return decodeUleb128(bytes, state)
      case CANDID_TYPE.int: return decodeSleb128(bytes, state)
      case CANDID_TYPE.nat8: return bytes[state.i++]
      case CANDID_TYPE.nat16: return Number(readFixedUint(2))
      case CANDID_TYPE.nat32: return Number(readFixedUint(4))
      case CANDID_TYPE.nat64: return readFixedUint(8)
      case CANDID_TYPE.int8: return Number(BigInt.asIntN(8, readFixedUint(1)))
      case CANDID_TYPE.int16: return Number(BigInt.asIntN(16, readFixedUint(2)))
      case CANDID_TYPE.int32: return Number(BigInt.asIntN(32, readFixedUint(4)))
      case CANDID_TYPE.int64: return BigInt.asIntN(64, readFixedUint(8))
      case CANDID_TYPE.float32: {
        const out = Buffer.from(bytes.slice(state.i, state.i + 4)).readFloatLE(0)
        state.i += 4
        return out
      }
      case CANDID_TYPE.float64: {
        const out = Buffer.from(bytes.slice(state.i, state.i + 8)).readDoubleLE(0)
        state.i += 8
        return out
      }
      case CANDID_TYPE.text: {
        const length = Number(decodeUleb128(bytes, state))
        const out = Buffer.from(bytes.slice(state.i, state.i + length)).toString('utf8')
        state.i += length
        return out
      }
      case CANDID_TYPE.principal: {
        const principalTag = bytes[state.i++]
        if (principalTag !== 1) throw new Error(`Invalid Candid principal tag ${principalTag}`)
        const length = Number(decodeUleb128(bytes, state))
        const principalBytes = bytes.slice(state.i, state.i + length)
        state.i += length
        return principalBytesToText(principalBytes)
      }
      case CANDID_TYPE.empty:
        throw new Error('Cannot decode a value of Candid type empty')
    }
    throw new Error(`Unsupported Candid primitive type ${typeRef}`)
  }

  return argTypes.map(decodeType)
}

/**
 * Minimal Candid encoder: `DIDL` + type table + arg types + values.
 *
 * Value conventions (mirroring what {@link decodeCandid} produces):
 * - `nat` / `int` / fixed-width ints accept number, bigint or decimal string
 * - `text` string; `bool` boolean; `null` / `reserved` anything (nothing is written)
 * - `principal` textual principal or raw bytes
 * - `blob` (`vec nat8`) Uint8Array / Buffer / number[] / hex string
 * - `opt` `null` / `undefined` / `[]` -> none, `[x]` -> some(x), any other value -> some(value)
 * - `vec` array (or Uint8Array when the element type is `nat8`)
 * - `record` object keyed by field name; a missing `opt` field is encoded as none
 * - `variant` single-key object `{ Tag: value }`, or a string `'Tag'` for unit variants
 */
export function encodeCandid(args: CandidValue[] = []): Buffer {
  const table: Buffer[] = []
  const tableIndex = new Map<string, number>()

  const addComposite = (key: string, body: Buffer): number => {
    const existing = tableIndex.get(key)
    if (existing !== undefined) return existing
    const idx = table.length
    table.push(body)
    tableIndex.set(key, idx)
    return idx
  }

  const sortedFields = (fields: Record<string, CandidType>) =>
    Object.keys(fields)
      .map(name => ({ name, id: fieldId(name), type: fields[name] }))
      .sort((a, b) => a.id - b.id)

  const typeRef = (t: CandidType): number => {
    if (typeof t === 'string') {
      if (t === 'blob') return addComposite('vec:-5', Buffer.concat([encodeSleb128(CANDID_TYPE.vec), encodeSleb128(CANDID_TYPE.nat8)]))
      const code = (CANDID_TYPE as Record<string, number>)[t]
      if (code === undefined || code === CANDID_TYPE.opt || code === CANDID_TYPE.vec || code === CANDID_TYPE.record || code === CANDID_TYPE.variant || code === CANDID_TYPE.func || code === CANDID_TYPE.service)
        throw new Error(`Unsupported Candid type "${t}"`)
      return code
    }
    if ('opt' in t) {
      const inner = typeRef(t.opt)
      return addComposite(`opt:${inner}`, Buffer.concat([encodeSleb128(CANDID_TYPE.opt), encodeSleb128(inner)]))
    }
    if ('vec' in t) {
      const inner = typeRef(t.vec)
      return addComposite(`vec:${inner}`, Buffer.concat([encodeSleb128(CANDID_TYPE.vec), encodeSleb128(inner)]))
    }
    const kind = 'record' in t ? CANDID_TYPE.record : CANDID_TYPE.variant
    const fields = sortedFields('record' in t ? t.record : t.variant)
    const refs = fields.map(f => ({ id: f.id, ref: typeRef(f.type) }))
    const body = Buffer.concat([
      encodeSleb128(kind),
      encodeUleb128(refs.length),
      ...refs.map(f => Buffer.concat([encodeUleb128(f.id), encodeSleb128(f.ref)])),
    ])
    return addComposite(`${kind}:${refs.map(f => `${f.id}=${f.ref}`).join(',')}`, body)
  }

  const fixedInt = (value: any, bits: number, signed: boolean): Buffer => {
    let n = toBigInt(value)
    if (signed) n = BigInt.asUintN(bits, n)
    else if (n < B0 || n >= (B1 << BigInt(bits))) throw new Error(`nat${bits} out of range: ${value}`)
    const out = Buffer.alloc(bits / 8)
    for (let i = 0; i < out.length; i++) out[i] = Number((n >> BigInt(i * 8)) & B0xff)
    return out
  }

  const encodeValue = (t: CandidType, value: any): Buffer => {
    if (typeof t === 'string') {
      switch (t) {
        case 'null':
        case 'reserved':
          return Buffer.alloc(0)
        case 'empty': throw new Error('Cannot encode a value of Candid type empty')
        case 'bool': return Buffer.from([value ? 1 : 0])
        case 'nat': return encodeUleb128(toBigInt(value))
        case 'int': return encodeSleb128(toBigInt(value))
        case 'nat8': return fixedInt(value, 8, false)
        case 'nat16': return fixedInt(value, 16, false)
        case 'nat32': return fixedInt(value, 32, false)
        case 'nat64': return fixedInt(value, 64, false)
        case 'int8': return fixedInt(value, 8, true)
        case 'int16': return fixedInt(value, 16, true)
        case 'int32': return fixedInt(value, 32, true)
        case 'int64': return fixedInt(value, 64, true)
        case 'float32': { const b = Buffer.alloc(4); b.writeFloatLE(Number(value), 0); return b }
        case 'float64': { const b = Buffer.alloc(8); b.writeDoubleLE(Number(value), 0); return b }
        case 'text': {
          const bytes = Buffer.from(String(value), 'utf8')
          return Buffer.concat([encodeUleb128(bytes.length), bytes])
        }
        case 'principal': {
          const bytes = typeof value === 'string' ? principalTextToBytes(value) : toBytes(value, 'principal')
          return Buffer.concat([Buffer.from([1]), encodeUleb128(bytes.length), Buffer.from(bytes)])
        }
        case 'blob': {
          const bytes = toBytes(value, 'blob')
          return Buffer.concat([encodeUleb128(bytes.length), Buffer.from(bytes)])
        }
      }
      throw new Error(`Unsupported Candid type "${t}"`)
    }
    if ('opt' in t) {
      if (value === null || value === undefined) return Buffer.from([0])
      if (Array.isArray(value)) {
        if (value.length === 0) return Buffer.from([0])
        if (value.length === 1) return Buffer.concat([Buffer.from([1]), encodeValue(t.opt, value[0])])
        throw new Error('opt value must be [] or a single element array')
      }
      return Buffer.concat([Buffer.from([1]), encodeValue(t.opt, value)])
    }
    if ('vec' in t) {
      if (t.vec === 'nat8' && !Array.isArray(value)) {
        const bytes = toBytes(value, 'vec nat8')
        return Buffer.concat([encodeUleb128(bytes.length), Buffer.from(bytes)])
      }
      if (!Array.isArray(value)) throw new Error('vec value must be an array')
      return Buffer.concat([encodeUleb128(value.length), ...value.map((v: any) => encodeValue(t.vec, v))])
    }
    if ('record' in t) {
      if (value === null || typeof value !== 'object') throw new Error('record value must be an object')
      const chunks: Buffer[] = []
      for (const field of sortedFields(t.record)) {
        const v = value[field.name]
        if (v === undefined && !(typeof field.type === 'object' && 'opt' in field.type) && field.type !== 'null' && field.type !== 'reserved')
          throw new Error(`Missing record field "${field.name}"`)
        chunks.push(encodeValue(field.type, v))
      }
      return Buffer.concat(chunks)
    }
    // variant
    const fields = sortedFields(t.variant)
    let tag: string
    let inner: any = null
    if (typeof value === 'string') tag = value
    else if (value && typeof value === 'object') {
      const keys = Object.keys(value)
      if (keys.length !== 1) throw new Error('variant value must have exactly one key')
      tag = keys[0]
      inner = value[tag]
    } else throw new Error('variant value must be a string or a single-key object')
    const index = fields.findIndex(f => f.name === tag)
    if (index === -1) throw new Error(`Unknown variant tag "${tag}"`)
    return Buffer.concat([encodeUleb128(index), encodeValue(fields[index].type, inner)])
  }

  // type refs first (fills the table), then values
  const refs = args.map(a => typeRef(a.type))
  const values = args.map((a, i) => encodeValue(a.type, a.value))
  return Buffer.concat([
    Buffer.from('DIDL', 'ascii'),
    encodeUleb128(table.length),
    ...table,
    encodeUleb128(refs.length),
    ...refs.map(r => encodeSleb128(r)),
    ...values,
  ])
}

function toBigInt(value: any): bigint {
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new Error(`Expected an integer, got ${value}`)
    return BigInt(value)
  }
  if (typeof value === 'string') return BigInt(value.trim())
  if (typeof value === 'boolean') return value ? B1 : B0
  throw new Error(`Cannot convert ${typeof value} to bigint`)
}

/** Uint8Array / Buffer / number[] / hex string (0x optional) -> Uint8Array */
export function toBytes(value: any, what = 'bytes'): Uint8Array {
  if (value instanceof Uint8Array) return value
  if (Array.isArray(value)) return Uint8Array.from(value)
  if (typeof value === 'string') {
    const hex = value.startsWith('0x') ? value.slice(2) : value
    if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error(`Invalid hex ${what}: ${value}`)
    return Uint8Array.from(Buffer.from(hex, 'hex'))
  }
  if (value && typeof value === 'object' && value.type === 'Buffer' && Array.isArray(value.data)) return Uint8Array.from(value.data)
  throw new Error(`Cannot convert ${typeof value} to ${what}`)
}

// ---------------------------------------------------------------------------
// Principal / account identifier
// ---------------------------------------------------------------------------

const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567'

/** CRC-32 (IEEE) as used by principal text and account identifiers */
export function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff
  for (const value of bytes) {
    crc ^= value
    for (let i = 0; i < 8; i++) {
      const mask = -(crc & 1)
      crc = (crc >>> 1) ^ (0xedb88320 & mask)
    }
  }
  return ~crc >>> 0
}

function crc32Bytes(bytes: Uint8Array): Buffer {
  const checksum = crc32(bytes)
  return Buffer.from([(checksum >>> 24) & 0xff, (checksum >>> 16) & 0xff, (checksum >>> 8) & 0xff, checksum & 0xff])
}

/** RFC 4648 base32 without padding, lowercase alphabet by default (as principals use). */
export function bytesToBase32(bytes: Uint8Array, alphabet: string = BASE32_ALPHABET): string {
  let out = ''
  let value = 0
  let bits = 0
  for (const byte of bytes) {
    value = ((value << 8) | byte) & 0xffff
    bits += 8
    while (bits >= 5) {
      out += alphabet[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += alphabet[(value << (5 - bits)) & 31]
  return out
}

/** Inverse of {@link bytesToBase32}: case-insensitive, ignores `-` separators and `=` padding. */
export function base32ToBytes(text: string): Uint8Array {
  const clean = text.replace(/[-=]/g, '').toLowerCase()
  let value = 0
  let bits = 0
  const out: number[] = []
  for (const char of clean) {
    const index = BASE32_ALPHABET.indexOf(char)
    if (index === -1) throw new Error(`Invalid base32 character "${char}"`)
    value = ((value << 5) | index) & 0xffff
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
    }
  }
  return Uint8Array.from(out)
}

/** Raw principal bytes -> textual principal (`crc32 || bytes`, base32, dashed every 5 chars). */
export function principalBytesToText(principalBytes: Uint8Array): string {
  const bytes = Buffer.from(principalBytes)
  if (bytes.length > 29) throw new Error(`Principal too long: ${bytes.length} bytes`)
  const base32 = bytesToBase32(Buffer.concat([crc32Bytes(bytes), bytes]))
  return (base32.match(/.{1,5}/g) as string[]).join('-')
}

/** Textual principal -> raw bytes. Verifies the CRC-32 prefix and throws on mismatch. */
export function principalTextToBytes(principalText: string): Uint8Array {
  if (typeof principalText !== 'string' || !principalText.length) throw new Error(`Invalid principal "${principalText}"`)
  const decoded = base32ToBytes(principalText)
  if (decoded.length < 4) throw new Error(`Invalid principal "${principalText}": too short`)
  const bytes = decoded.slice(4)
  if (bytes.length > 29) throw new Error(`Invalid principal "${principalText}": too long`)
  const expected = crc32Bytes(bytes)
  for (let i = 0; i < 4; i++)
    if (decoded[i] !== expected[i]) throw new Error(`Invalid principal "${principalText}": checksum mismatch`)
  return bytes
}

/** True when `str` is a well formed textual principal (valid base32, checksum and grouping). */
export function isPrincipal(str: any): boolean {
  if (typeof str !== 'string') return false
  try {
    return principalBytesToText(principalTextToBytes(str)) === str.toLowerCase()
  } catch {
    return false
  }
}

/**
 * ICP ledger account identifier (hex, 32 bytes):
 * `crc32(h) || h` where `h = sha224("\x0Aaccount-id" || principal || subaccount)`.
 * `subaccount` defaults to 32 zero bytes; accepts Uint8Array / number[] / hex, right-padded to 32 bytes.
 */
export function accountIdentifierFromPrincipal(principal: string | Uint8Array, subaccount?: Uint8Array | number[] | string | null): string {
  const principalBytes = typeof principal === 'string' ? principalTextToBytes(principal) : principal
  const sub = Buffer.alloc(32)
  if (subaccount !== undefined && subaccount !== null) {
    const given = Buffer.from(toBytes(subaccount, 'subaccount'))
    if (given.length > 32) throw new Error('subaccount must be at most 32 bytes')
    given.copy(sub, 32 - given.length)
  }
  const hash = createHash('sha224')
    .update(Buffer.concat([Buffer.from([0x0a]), Buffer.from('account-id', 'ascii'), Buffer.from(principalBytes), sub]))
    .digest()
  return Buffer.concat([crc32Bytes(hash), hash]).toString('hex')
}

// ---------------------------------------------------------------------------
// endpoints
// ---------------------------------------------------------------------------

/** Boundary node list: `ICP_RPC` (comma separated) or {@link DEFAULT_ENDPOINTS}. */
export function getEndpoints(): string[] {
  return resolveEndpoints(CHAIN, DEFAULT_ENDPOINTS)
}

// ---------------------------------------------------------------------------
// query call
// ---------------------------------------------------------------------------

/** Thrown when the replica answers a query with a reject (canister error, missing method, dead canister). */
export class IcpRejectError extends Error {
  canisterId: string
  method: string
  status?: string
  rejectCode?: number
  rejectMessage?: string
  errorCode?: string
  constructor(canisterId: string, method: string, decoded: any) {
    super(`Canister ${canisterId} did not reply to ${method}: ${decoded?.reject_message ?? decoded?.status ?? 'unknown response'}`)
    this.name = 'IcpRejectError'
    this.canisterId = canisterId
    this.method = method
    this.status = decoded?.status
    this.rejectCode = decoded?.reject_code
    this.rejectMessage = decoded?.reject_message
    this.errorCode = decoded?.error_code
  }
}

export interface QueryCanisterParams {
  canisterId: string
  /** canister method name */
  method?: string
  /** alias of `method` (DefiLlama-Adapters / dimension-adapters naming) */
  methodName?: string
  /** Candid encoded argument, default: empty args (`DIDL\0\0`) */
  arg?: Uint8Array
  /** explicit boundary node(s); overrides `ICP_RPC` and the defaults */
  host?: Endpoints
  /** http timeout in ms, default 30s */
  timeout?: number
  /** total transport attempts across hosts, default max(3, hosts) */
  retries?: number
}

export interface QueryDecodedParams extends QueryCanisterParams {
  /** `{ [hash]: name }` map for record / variant labels (see {@link hashCandidLabel}) */
  labelHashMap?: Record<number, string>
  /** label names, merged into `labelHashMap` via {@link buildLabelHashMap} */
  labels?: string[]
}

export interface CallCandidParams extends QueryDecodedParams {
  /** typed arguments `{ type, value }`; or raw values when `argTypes` is given */
  args?: CandidValue[] | any[]
  /** types for `args` when they are raw values */
  argTypes?: CandidType[]
}

function toUint8Array(data: any): Uint8Array {
  if (Buffer.isBuffer(data) || data instanceof Uint8Array) return data
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (typeof data === 'string') return Buffer.from(data, 'binary')
  throw new Error(`Unexpected response body type ${typeof data}`)
}

/**
 * Anonymous query call against a canister (`/api/v2/canister/<id>/query`).
 * Rotates over the configured boundary nodes and retries transport errors; canister rejects are
 * thrown as {@link IcpRejectError} without retry.
 * @returns the raw Candid reply (`DIDL...` bytes), to be passed to {@link decodeCandid}
 */
export async function queryCanister(params: QueryCanisterParams): Promise<Uint8Array> {
  const { canisterId, arg = EMPTY_ARGS, timeout = DEFAULT_TIMEOUT, retries } = params
  const method = params.method ?? params.methodName
  if (!method) throw new Error('queryCanister: method is required')
  const hosts = params.host ? toEndpointList(params.host) : getEndpoints()

  const content = {
    request_type: 'query',
    canister_id: Buffer.from(principalTextToBytes(canisterId)),
    method_name: method,
    arg: Buffer.from(arg),
    sender: Buffer.from(ANONYMOUS_SENDER),
    ingress_expiry: BigInt(Date.now() + INGRESS_EXPIRY_MS) * NANOS_PER_MS,
  }
  // self-describing CBOR tag (55799) as recommended by the IC HTTP interface spec
  const body = Buffer.concat([Buffer.from([0xd9, 0xd9, 0xf7]), encodeCbor({ content })])
  const urls = hosts.map(h => `${stripTrailingSlash(h)}/api/v2/canister/${canisterId}/query`)

  const data = await getLimiter('ICP', CONCURRENCY)(() => httpPost(urls, body, {
    timeout,
    retries,
    headers: { 'Content-Type': 'application/cbor' },
    axiosConfig: { responseType: 'arraybuffer' },
  }))

  const decoded = decodeCbor(toUint8Array(data))
  if (decoded?.status !== 'replied' || !decoded?.reply?.arg) {
    debugLog(`[chains.icp] ${canisterId}.${method} rejected: ${decoded?.reject_message ?? decoded?.status} (code ${decoded?.reject_code}, ${decoded?.error_code})`)
    throw new IcpRejectError(canisterId, method, decoded)
  }
  return toUint8Array(decoded.reply.arg)
}

/**
 * Query a method and decode its reply in one step.
 * Accepts either `{ canisterId, method, arg?, labelHashMap?, labels? }` or the dimension-adapters
 * positional form `(canisterId, methodName, labels?)`.
 * @returns the first value of the reply tuple (`any`, see {@link decodeCandid})
 */
export async function queryCanisterDecoded(params: QueryDecodedParams): Promise<any>
export async function queryCanisterDecoded(canisterId: string, method: string, labels?: string[]): Promise<any>
export async function queryCanisterDecoded(paramsOrCanister: QueryDecodedParams | string, method?: string, labels?: string[]): Promise<any> {
  const params: QueryDecodedParams = typeof paramsOrCanister === 'string'
    ? { canisterId: paramsOrCanister, method, labels }
    : paramsOrCanister
  const labelHashMap = { ...buildLabelHashMap(params.labels), ...(params.labelHashMap ?? {}) }
  const [value] = decodeCandid(await queryCanister(params), labelHashMap)
  return value
}

/**
 * Encode `args` with {@link encodeCandid}, query `method` and decode the reply.
 * `args` is either `CandidValue[]` (`{ type, value }`) or raw values paired with `argTypes`.
 * @returns the first value of the reply tuple
 */
export async function callCandid(params: CallCandidParams): Promise<any> {
  const { args = [], argTypes, ...rest } = params
  let typed: CandidValue[]
  if (argTypes) {
    if (argTypes.length !== args.length) throw new Error('callCandid: args and argTypes length mismatch')
    typed = args.map((value: any, i: number) => ({ type: argTypes[i], value }))
  } else typed = args as CandidValue[]
  return queryCanisterDecoded({ ...rest, arg: encodeCandid(typed) })
}

// ---------------------------------------------------------------------------
// ICRC-1 / ICP ledger helpers
// ---------------------------------------------------------------------------

export interface LedgerParams {
  /** ledger canister id */
  ledger: string
  host?: Endpoints
  timeout?: number
}

export type IcrcMetadataValue = string | Uint8Array

const ICRC_ACCOUNT_TYPE: CandidType = { record: { owner: 'principal', subaccount: { opt: 'blob' } } }

/**
 * `icrc1_metadata` as `{ 'icrc1:symbol': 'ckBTC', 'icrc1:decimals': '8', ... }`.
 * `Nat` / `Int` values are returned as decimal strings, `Text` as string, `Blob` as Uint8Array.
 */
export async function getIcrcMetadata({ ledger, host, timeout }: LedgerParams): Promise<Record<string, IcrcMetadataValue>> {
  const rows = await queryCanisterDecoded({ canisterId: ledger, method: 'icrc1_metadata', host, timeout, labels: ['Nat', 'Int', 'Text', 'Blob'] })
  const out: Record<string, IcrcMetadataValue> = {}
  if (!Array.isArray(rows)) throw new Error(`Unexpected icrc1_metadata reply from ${ledger}`)
  for (const row of rows) {
    const key = row?.[0]
    const variant = row?.[1]
    if (typeof key !== 'string' || !variant || typeof variant !== 'object') continue
    const tag = Object.keys(variant)[0]
    const value = variant[tag]
    if (tag === 'Blob') out[key] = Array.isArray(value) ? Uint8Array.from(value) : toBytes(value)
    else out[key] = typeof value === 'bigint' ? value.toString() : String(value)
  }
  return out
}

/** `icrc1_decimals` (nat8) */
export async function getIcrcDecimals({ ledger, host, timeout }: LedgerParams): Promise<number> {
  return Number(await queryCanisterDecoded({ canisterId: ledger, method: 'icrc1_decimals', host, timeout }))
}

/** `icrc1_symbol` */
export async function getIcrcSymbol({ ledger, host, timeout }: LedgerParams): Promise<string> {
  return String(await queryCanisterDecoded({ canisterId: ledger, method: 'icrc1_symbol', host, timeout }))
}

/** `icrc1_name` */
export async function getIcrcName({ ledger, host, timeout }: LedgerParams): Promise<string> {
  return String(await queryCanisterDecoded({ canisterId: ledger, method: 'icrc1_name', host, timeout }))
}

/** `icrc1_total_supply` as a decimal string in base units */
export async function getIcrcTotalSupply({ ledger, host, timeout }: LedgerParams): Promise<string> {
  return toBigInt(await queryCanisterDecoded({ canisterId: ledger, method: 'icrc1_total_supply', host, timeout })).toString()
}

/**
 * `icrc1_balance_of(record { owner: principal; subaccount: opt blob })` as a decimal string in base units.
 * `subaccount` accepts Uint8Array / number[] / hex; omit it for the default subaccount.
 */
export async function getIcrcBalance({ ledger, owner, subaccount, host, timeout }: LedgerParams & { owner: string, subaccount?: Uint8Array | number[] | string | null }): Promise<string> {
  const sub = subaccount === undefined || subaccount === null ? null : toBytes(subaccount, 'subaccount')
  const balance = await callCandid({
    canisterId: ledger,
    method: 'icrc1_balance_of',
    host,
    timeout,
    args: [{ type: ICRC_ACCOUNT_TYPE, value: { owner, subaccount: sub } }],
  })
  return toBigInt(balance).toString()
}

/**
 * ICP ledger `account_balance(record { account: blob })` -> `e8s` as a decimal string.
 * `accountIdentifierHex` is the 32 byte account identifier (see {@link accountIdentifierFromPrincipal}).
 */
export async function getIcpAccountBalance({ accountIdentifierHex, ledger = ICP_LEDGER, host, timeout }: { accountIdentifierHex: string, ledger?: string, host?: Endpoints, timeout?: number }): Promise<string> {
  const account = toBytes(accountIdentifierHex, 'account identifier')
  if (account.length !== 32) throw new Error('account identifier must be 32 bytes')
  const res = await callCandid({
    canisterId: ledger,
    method: 'account_balance',
    host,
    timeout,
    labels: ['e8s'],
    args: [{ type: { record: { account: 'blob' } }, value: { account } }],
  })
  return toBigInt(res?.e8s).toString()
}
