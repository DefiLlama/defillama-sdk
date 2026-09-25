/**
 * Stellar client: Horizon REST + Soroban JSON-RPC with a hand-rolled StrKey / XDR
 * codec (RFC 4648 base32, CRC16-XMODEM, ScVal reader/writer) so nothing from
 * `@stellar/stellar-sdk` or `hi-base32` is needed.
 *
 * Replaces the per-repo Stellar helpers:
 *  - DefiLlama-Adapters/projects/helper/chain/stellar.js (getAssetSupply, getTokenBalance,
 *    SC_VAL / SC_ADDR / STRKEY_VERSION, decodeStrKey, crc16xmodem, encodeStrKey, parseScVal,
 *    XDR writers, callSoroban / simulateTransaction envelope, getContractInstanceStorage)
 *  - server/defi/l2/utils.ts (stellarSacToClassic, isSorobanContractId, getStellarSupplies)
 *  - server/defi/src/rwa/balances.ts (fetchStellar account balances, CODE-ISSUER parsing)
 *  - peggedassets-server/src/adapters/peggedAssets/helper/stellar.ts and
 *    peggedassets-server/src/adapters/peggedAssets/valtorum-usdv/index.ts (Horizon /assets supply)
 *
 * Endpoints: `STELLAR_HORIZON` env overrides `DEFAULT_HORIZON`, `STELLAR_SOROBAN_RPC`
 * (comma separated) overrides `DEFAULT_SOROBAN_ENDPOINTS`.
 *
 * Amount conventions: Horizon reports 7-decimal display strings ("12.3456789"); every
 * `raw` / supply / balance value returned here is the integer stroop amount (x1e7) as a
 * decimal string. Soroban i128 / u128 results come back as `bigint` from `parseScVal`
 * and are stringified by the token helpers.
 */
import { createHash } from "crypto";
import { getEndpoints, getLimiter, httpGet, jsonRpc } from "./rpc";
import { debugLog } from "../util/debugLog";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

export const DEFAULT_HORIZON = 'https://horizon.stellar.org'
export const DEFAULT_SOROBAN_ENDPOINTS: string[] = [
  'https://mainnet.sorobanrpc.com',
  'https://soroban-rpc.creit.tech',
]
export const PUBLIC_NETWORK_PASSPHRASE = 'Public Global Stellar Network ; September 2015'
/** Classic assets and Stellar Asset Contracts always have 7 decimals. */
export const STELLAR_DECIMALS = 7

const HORIZON_CONCURRENCY = 5
const SOROBAN_CONCURRENCY = 5

export function getHorizonEndpoints(): string[] {
  return getEndpoints('stellar_horizon', DEFAULT_HORIZON, { envKey: 'STELLAR_HORIZON' })
}

export function getHorizonEndpoint(): string {
  return getHorizonEndpoints()[0]
}

export function getSorobanEndpoints(): string[] {
  return getEndpoints('stellar_soroban', DEFAULT_SOROBAN_ENDPOINTS, { envKey: 'STELLAR_SOROBAN_RPC' })
}

// ---------------------------------------------------------------------------
// constants (Stellar-contract.x / Stellar-ledger-entries.x / SEP-23)
// ---------------------------------------------------------------------------

/** SCValType discriminants: https://github.com/stellar/stellar-xdr/blob/main/Stellar-contract.x */
export const SC_VAL = {
  BOOL: 0, VOID: 1, ERROR: 2, U32: 3, I32: 4, U64: 5, I64: 6, TIMEPOINT: 7, DURATION: 8,
  U128: 9, I128: 10, U256: 11, I256: 12, BYTES: 13, STRING: 14, SYMBOL: 15,
  VEC: 16, MAP: 17, ADDRESS: 18,
  CONTRACT_INSTANCE: 19, LEDGER_KEY_CONTRACT_INSTANCE: 20, LEDGER_KEY_NONCE: 21,
} as const

/** SCAddressType discriminants (inside ScVal::Address / InvokeContractArgs). */
export const SC_ADDR = { ACCOUNT: 0, CONTRACT: 1, MUXED_ACCOUNT: 2, CLAIMABLE_BALANCE: 3, LIQUIDITY_POOL: 4 } as const

/** StrKey version bytes (SEP-23): the first base32 char of the encoded key. */
export const STRKEY_VERSION = {
  ACCOUNT: 6 << 3,           // G
  MUXED_ACCOUNT: 12 << 3,    // M
  SEED: 18 << 3,             // S
  PRE_AUTH_TX: 19 << 3,      // T
  SHA256_HASH: 23 << 3,      // X
  SIGNED_PAYLOAD: 15 << 3,   // P
  CONTRACT: 2 << 3,          // C
  CLAIMABLE_BALANCE: 1 << 3, // B
  LIQUIDITY_POOL: 11 << 3,   // L
} as const

const ENVELOPE_TYPE_TX = 2
const ENVELOPE_TYPE_CONTRACT_ID = 8 // EnvelopeType: TX_V0 0, SCP 1, TX 2, AUTH 3, SCPVALUE 4, TX_FEE_BUMP 5, OP_ID 6, POOL_REVOKE_OP_ID 7, CONTRACT_ID 8
const CONTRACT_ID_PREIMAGE_FROM_ASSET = 1
const OP_INVOKE_HOST_FUNCTION = 24
const HOST_FUNCTION_TYPE_INVOKE_CONTRACT = 0
const LEDGER_ENTRY_CONTRACT_DATA = 6
const CONTRACT_DATA_DURABILITY_PERSISTENT = 1
const CONTRACT_EXECUTABLE_WASM = 0
const KEY_TYPE_ED25519 = 0

const CONTRACT_ID_RE = /^C[A-Z2-7]{55}$/
const ACCOUNT_ID_RE = /^G[A-Z2-7]{55}$/
const ASSET_CODE_RE = /^[A-Za-z0-9]{1,12}$/

// ---------------------------------------------------------------------------
// base32 (RFC 4648, upper-case alphabet, padding optional)
// ---------------------------------------------------------------------------

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const B32_LOOKUP: Record<string, number> = {}
for (let i = 0; i < B32_ALPHABET.length; i++) B32_LOOKUP[B32_ALPHABET[i]] = i

export function base32Encode(data: Uint8Array, { padding = false }: { padding?: boolean } = {}): string {
  let bits = 0, value = 0, out = ''
  for (let i = 0; i < data.length; i++) {
    value = (value << 8) | data[i]
    bits += 8
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
    value &= (1 << bits) - 1
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31]
  if (padding) while (out.length % 8) out += '='
  return out
}

export function base32Decode(str: string): Buffer {
  const clean = str.replace(/=+$/, '').toUpperCase()
  const out: number[] = []
  let bits = 0, value = 0
  for (let i = 0; i < clean.length; i++) {
    const v = B32_LOOKUP[clean[i]]
    if (v === undefined) throw new Error(`base32: invalid character "${clean[i]}" in "${str}"`)
    value = (value << 5) | v
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff)
      bits -= 8
      value &= (1 << bits) - 1
    }
  }
  return Buffer.from(out)
}

// ---------------------------------------------------------------------------
// StrKey (SEP-23): version byte + payload + CRC16-XMODEM (little endian), base32 without padding
// ---------------------------------------------------------------------------

export function crc16xmodem(data: Uint8Array): number {
  let crc = 0
  for (let i = 0; i < data.length; i++) {
    crc ^= data[i] << 8
    for (let j = 0; j < 8; j++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff
  }
  return crc
}

export function encodeStrKey(version: number, payload: Uint8Array): string {
  const body = Buffer.concat([Buffer.from([version]), Buffer.from(payload)])
  const checksum = Buffer.alloc(2)
  checksum.writeUInt16LE(crc16xmodem(body), 0)
  return base32Encode(Buffer.concat([body, checksum]))
}

/** Decode a StrKey; validates the checksum and that the encoding is canonical. */
export function decodeStrKey(str: string): { version: number, payload: Buffer } {
  if (typeof str !== 'string' || !str.length) throw new Error(`Invalid StrKey: ${str}`)
  const raw = base32Decode(str)
  if (raw.length < 4) throw new Error(`Invalid StrKey (too short): ${str}`)
  const version = raw[0]
  const payload = raw.slice(1, raw.length - 2)
  const checksum = raw.readUInt16LE(raw.length - 2)
  if (checksum !== crc16xmodem(raw.slice(0, raw.length - 2))) throw new Error(`Invalid StrKey checksum: ${str}`)
  if (encodeStrKey(version, payload) !== str) throw new Error(`Invalid StrKey (non canonical): ${str}`)
  return { version, payload }
}

/** Payload bytes of a StrKey, optionally asserting the version byte. */
export function strKeyToBytes(str: string, expectedVersion?: number): Buffer {
  const { version, payload } = decodeStrKey(str)
  if (expectedVersion !== undefined && version !== expectedVersion)
    throw new Error(`StrKey ${str} has version ${version}, expected ${expectedVersion}`)
  return payload
}

export function isValidStrKey(str: string, version?: number): boolean {
  try {
    const decoded = decodeStrKey(str)
    return version === undefined || decoded.version === version
  } catch {
    return false
  }
}

/** Soroban contract id (`C...`, 56 chars). Format check only; use `isValidStrKey` for checksum validation. */
export function isContractId(str: any): boolean {
  return typeof str === 'string' && CONTRACT_ID_RE.test(str)
}

/** Classic account id (`G...`, 56 chars). Format check only. */
export function isAccountId(str: any): boolean {
  return typeof str === 'string' && ACCOUNT_ID_RE.test(str)
}

// ---------------------------------------------------------------------------
// classic assets
// ---------------------------------------------------------------------------

export interface ClassicAsset {
  /** asset code, `XLM` for the native asset */
  code: string
  /** issuer account, undefined for the native asset */
  issuer?: string
}

export const NATIVE_ASSET: ClassicAsset = { code: 'XLM' }

export function isNativeAsset(asset: ClassicAsset): boolean {
  return !asset.issuer
}

/**
 * Parse `native` / `XLM`, `CODE-ISSUER` (DefiLlama convention), `CODE:ISSUER`
 * (Horizon / stellar.expert convention) or an already parsed `{ code, issuer }`.
 */
export function parseAsset(asset: string | ClassicAsset): ClassicAsset {
  if (asset && typeof asset === 'object') {
    if (!asset.issuer) return NATIVE_ASSET
    return validateAsset({ code: asset.code, issuer: asset.issuer })
  }
  if (typeof asset !== 'string') throw new Error(`Invalid Stellar asset: ${asset}`)
  const s = asset.trim()
  if (s.toLowerCase() === 'native' || s.toUpperCase() === 'XLM') return NATIVE_ASSET
  // issuer is always 56 chars, so split on the last separator to allow codes containing '-'/':' (they cannot, but be safe)
  const sep = Math.max(s.lastIndexOf('-'), s.lastIndexOf(':'))
  if (sep === -1) throw new Error(`Invalid Stellar asset "${asset}": expected CODE-ISSUER, CODE:ISSUER or native`)
  return validateAsset({ code: s.slice(0, sep), issuer: s.slice(sep + 1) })
}

function validateAsset(asset: ClassicAsset): ClassicAsset {
  if (!ASSET_CODE_RE.test(asset.code)) throw new Error(`Invalid Stellar asset code "${asset.code}"`)
  if (!isAccountId(asset.issuer)) throw new Error(`Invalid Stellar asset issuer "${asset.issuer}"`)
  return asset
}

/** `native` or `CODE-ISSUER` (or `CODE:ISSUER` with `separator: ':'`). */
export function assetToString(asset: string | ClassicAsset, { separator = '-' }: { separator?: '-' | ':' } = {}): string {
  const parsed = parseAsset(asset)
  if (isNativeAsset(parsed)) return 'native'
  return `${parsed.code}${separator}${parsed.issuer}`
}

/** Horizon 7-decimal display string -> stroops as a decimal string, using string math (no float rounding). */
export function toRaw(amount: string | number, decimals: number = STELLAR_DECIMALS): string {
  let s = typeof amount === 'number' ? amount.toFixed(decimals) : String(amount).trim()
  if (!s) return '0'
  const negative = s.startsWith('-')
  if (negative) s = s.slice(1)
  const [intPart, fracPart = ''] = s.split('.')
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracPart)) throw new Error(`Invalid decimal amount: ${amount}`)
  const frac = (fracPart + '0'.repeat(decimals)).slice(0, decimals)
  const value = BigInt((intPart || '0') + frac)
  return (negative ? -value : value).toString()
}

/** Stroops -> display string (`"12.3456789"`), trailing zeros trimmed. */
export function fromRaw(raw: string | number | bigint, decimals: number = STELLAR_DECIMALS): string {
  let value = BigInt(raw)
  const negative = value < BigInt(0)
  if (negative) value = -value
  const s = value.toString().padStart(decimals + 1, '0')
  const intPart = s.slice(0, s.length - decimals)
  const frac = s.slice(s.length - decimals).replace(/0+$/, '')
  return (negative ? '-' : '') + intPart + (frac ? '.' + frac : '')
}

// ---------------------------------------------------------------------------
// XDR reader / writer (RFC 4506: big endian, 4-byte alignment)
// ---------------------------------------------------------------------------

const TWO_64 = BigInt(1) << BigInt(64)
const MASK_64 = TWO_64 - BigInt(1)

function padLength(n: number) {
  return n + ((4 - (n % 4)) % 4)
}

export class XdrWriter {
  private chunks: Buffer[] = []

  u32(value: number): this {
    if (!Number.isInteger(value) || value < 0 || value > 0xffffffff) throw new Error(`u32 out of range: ${value}`)
    const b = Buffer.alloc(4)
    b.writeUInt32BE(value, 0)
    this.chunks.push(b)
    return this
  }

  i32(value: number): this {
    if (!Number.isInteger(value) || value < -0x80000000 || value > 0x7fffffff) throw new Error(`i32 out of range: ${value}`)
    const b = Buffer.alloc(4)
    b.writeInt32BE(value, 0)
    this.chunks.push(b)
    return this
  }

  /** unsigned 64-bit, value must already be in range */
  u64(value: bigint | number | string): this {
    const n = BigInt(value)
    if (n < BigInt(0) || n > MASK_64) throw new Error(`u64 out of range: ${value}`)
    return this.u32(Number(n >> BigInt(32))).u32(Number(n & BigInt(0xffffffff)))
  }

  i64(value: bigint | number | string): this {
    const n = BigInt(value)
    if (n < -(BigInt(1) << BigInt(63)) || n > (BigInt(1) << BigInt(63)) - BigInt(1)) throw new Error(`i64 out of range: ${value}`)
    return this.u64(n < BigInt(0) ? n + TWO_64 : n)
  }

  /** fixed length opaque, no length prefix, padded to 4 bytes */
  bytes(data: Uint8Array): this {
    const b = Buffer.from(data)
    this.chunks.push(b)
    const pad = padLength(b.length) - b.length
    if (pad) this.chunks.push(Buffer.alloc(pad))
    return this
  }

  /** variable length opaque: u32 length + data + padding */
  opaque(data: Uint8Array): this {
    return this.u32(data.length).bytes(data)
  }

  string(value: string): this {
    return this.opaque(Buffer.from(value, 'utf8'))
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks)
  }

  toBase64(): string {
    return this.toBuffer().toString('base64')
  }
}

export class XdrReader {
  offset: number
  readonly buf: Buffer

  constructor(input: Buffer | Uint8Array | string, offset = 0) {
    this.buf = typeof input === 'string' ? Buffer.from(input, 'base64') : Buffer.from(input)
    this.offset = offset
  }

  private need(n: number) {
    if (this.offset + n > this.buf.length) throw new Error(`XDR: unexpected end of data (need ${n} bytes at ${this.offset}, have ${this.buf.length})`)
  }

  u32(): number {
    this.need(4)
    const v = this.buf.readUInt32BE(this.offset)
    this.offset += 4
    return v
  }

  i32(): number {
    this.need(4)
    const v = this.buf.readInt32BE(this.offset)
    this.offset += 4
    return v
  }

  u64(): bigint {
    const hi = this.u32(), lo = this.u32()
    return (BigInt(hi) << BigInt(32)) | BigInt(lo)
  }

  i64(): bigint {
    const u = this.u64()
    return u >= (BigInt(1) << BigInt(63)) ? u - TWO_64 : u
  }

  /** `words` big-endian u64 limbs -> unsigned bigint */
  uintN(words: number): bigint {
    let v = BigInt(0)
    for (let i = 0; i < words; i++) v = (v << BigInt(64)) | this.u64()
    return v
  }

  intN(words: number): bigint {
    const bits = BigInt(words * 64)
    const u = this.uintN(words)
    return u >= (BigInt(1) << (bits - BigInt(1))) ? u - (BigInt(1) << bits) : u
  }

  bytes(n: number): Buffer {
    this.need(padLength(n))
    const b = Buffer.from(this.buf.slice(this.offset, this.offset + n))
    this.offset += padLength(n)
    return b
  }

  opaque(): Buffer {
    return this.bytes(this.u32())
  }

  string(): string {
    return this.opaque().toString('utf8')
  }

  get remaining(): number {
    return this.buf.length - this.offset
  }
}

// ---------------------------------------------------------------------------
// ScVal decoding
// ---------------------------------------------------------------------------

export type ScValue = boolean | null | number | bigint | string | ScValue[] | { [key: string]: ScValue } | ScContractInstance | ScError

export interface ScError { error: number, code: number }
export interface ScContractInstance {
  executable: { type: 'wasm', hash: string } | { type: 'stellar_asset' }
  storage: { [key: string]: ScValue }
}

/** Keys of ScMap / instance storage: contracttype enum keys encode as Vec[Symbol(variant), ...] -> use the variant name. */
function mapKey(k: ScValue): string {
  if (Array.isArray(k)) return k.length && typeof k[0] === 'string' ? k[0] : JSON.stringify(k, jsonReplacer)
  if (k !== null && typeof k === 'object') return JSON.stringify(k, jsonReplacer)
  return String(k)
}

function jsonReplacer(_: string, v: any) {
  return typeof v === 'bigint' ? v.toString() : v
}

function readScAddress(r: XdrReader): string {
  const type = r.u32()
  switch (type) {
    case SC_ADDR.ACCOUNT: {
      const keyType = r.u32()
      if (keyType !== KEY_TYPE_ED25519) throw new Error(`Unsupported PublicKey type: ${keyType}`)
      return encodeStrKey(STRKEY_VERSION.ACCOUNT, r.bytes(32))
    }
    case SC_ADDR.CONTRACT: return encodeStrKey(STRKEY_VERSION.CONTRACT, r.bytes(32))
    case SC_ADDR.MUXED_ACCOUNT: {
      // MuxedEd25519Account { uint64 id; uint256 ed25519 } -> M strkey payload = ed25519 ++ id (big endian)
      const id = r.bytes(8), key = r.bytes(32)
      return encodeStrKey(STRKEY_VERSION.MUXED_ACCOUNT, Buffer.concat([key, id]))
    }
    case SC_ADDR.CLAIMABLE_BALANCE: {
      // ClaimableBalanceID { u32 type (CLAIMABLE_BALANCE_ID_TYPE_V0 = 0); Hash v0 } -> B strkey payload = type byte ++ hash
      const idType = r.u32()
      return encodeStrKey(STRKEY_VERSION.CLAIMABLE_BALANCE, Buffer.concat([Buffer.from([idType]), r.bytes(32)]))
    }
    case SC_ADDR.LIQUIDITY_POOL: return encodeStrKey(STRKEY_VERSION.LIQUIDITY_POOL, r.bytes(32))
    default: throw new Error(`Unsupported SCAddressType: ${type}`)
  }
}

/** Read one ScVal from the reader's current position. */
export function readScVal(r: XdrReader): ScValue {
  const type = r.u32()
  switch (type) {
    case SC_VAL.BOOL: return r.u32() !== 0
    case SC_VAL.VOID: return null
    case SC_VAL.ERROR: {
      // SCError { SCErrorType type; union { u32 contractCode | SCErrorCode code } }
      const errType = r.u32()
      return { error: errType, code: r.u32() }
    }
    case SC_VAL.U32: return r.u32()
    case SC_VAL.I32: return r.i32()
    case SC_VAL.U64: case SC_VAL.TIMEPOINT: case SC_VAL.DURATION: return r.u64()
    case SC_VAL.I64: return r.i64()
    case SC_VAL.U128: return r.uintN(2)
    case SC_VAL.I128: return r.intN(2)
    case SC_VAL.U256: return r.uintN(4)
    case SC_VAL.I256: return r.intN(4)
    case SC_VAL.BYTES: return '0x' + r.opaque().toString('hex')
    case SC_VAL.STRING: case SC_VAL.SYMBOL: return r.string()
    case SC_VAL.VEC: {
      if (!r.u32()) return null // SCVec* absent
      const len = r.u32()
      const arr: ScValue[] = []
      for (let i = 0; i < len; i++) arr.push(readScVal(r))
      return arr
    }
    case SC_VAL.MAP: {
      if (!r.u32()) return null // SCMap* absent
      const len = r.u32()
      const map: { [key: string]: ScValue } = {}
      for (let i = 0; i < len; i++) {
        const k = readScVal(r)
        map[mapKey(k)] = readScVal(r)
      }
      return map
    }
    case SC_VAL.ADDRESS: return readScAddress(r)
    case SC_VAL.LEDGER_KEY_CONTRACT_INSTANCE: return null // void body
    case SC_VAL.LEDGER_KEY_NONCE: return r.i64()
    case SC_VAL.CONTRACT_INSTANCE: {
      // SCContractInstance { ContractExecutable executable; SCMap* storage; }
      const execType = r.u32()
      const executable: ScContractInstance['executable'] = execType === CONTRACT_EXECUTABLE_WASM
        ? { type: 'wasm', hash: r.bytes(32).toString('hex') }
        : { type: 'stellar_asset' }
      const storage: { [key: string]: ScValue } = {}
      if (r.u32()) {
        const len = r.u32()
        for (let i = 0; i < len; i++) {
          const k = readScVal(r)
          storage[mapKey(k)] = readScVal(r)
        }
      }
      return { executable, storage }
    }
    default: throw new Error(`Unsupported ScVal type: ${type}`)
  }
}

/**
 * Decode an ScVal from raw XDR bytes or a base64 string.
 * u64/i64/u128/i128/u256/i256 -> bigint, bytes -> `0x` hex, addresses -> StrKey,
 * vec -> array, map -> object keyed by the (stringified) key, void -> null.
 */
export function parseScVal(input: Buffer | Uint8Array | string, offset = 0): ScValue {
  return readScVal(new XdrReader(input, offset))
}

// ---------------------------------------------------------------------------
// ScVal encoding
// ---------------------------------------------------------------------------

export type ScArgType = 'bool' | 'void' | 'u32' | 'i32' | 'u64' | 'i64' | 'timepoint' | 'duration' | 'u128' | 'i128' | 'u256' | 'i256'
  | 'bytes' | 'string' | 'symbol' | 'address' | 'account' | 'vec' | 'map'

/** Explicitly typed contract argument, e.g. `{ type: 'i128', value: '1000' }`. */
export interface ScArg { type: ScArgType, value?: any }

/**
 * Anything `callSoroban` accepts as an argument. Untyped values are mapped as:
 * `G...` string -> address (account), `C...` string -> address (contract), number -> u32,
 * bigint -> i128, boolean -> bool, null/undefined -> void, array -> vec of the same rules.
 * Other strings must be tagged (`{ type: 'symbol' | 'string' | 'bytes', value }`).
 */
export type ScArgInput = ScArg | string | number | bigint | boolean | null | undefined | ScArgInput[]

export function normalizeScArg(arg: ScArgInput): ScArg {
  if (arg === null || arg === undefined) return { type: 'void' }
  if (Array.isArray(arg)) return { type: 'vec', value: arg.map(normalizeScArg) }
  if (typeof arg === 'object') {
    if (!('type' in arg)) throw new Error(`Untyped object argument, pass { type, value }: ${JSON.stringify(arg, jsonReplacer)}`)
    return arg
  }
  if (typeof arg === 'string') {
    if (isAccountId(arg)) return { type: 'account', value: arg }
    if (isContractId(arg)) return { type: 'address', value: arg }
    throw new Error(`Ambiguous string argument "${arg}": tag it as { type: 'symbol' | 'string' | 'bytes' | 'i128' ..., value }`)
  }
  if (typeof arg === 'number') return { type: 'u32', value: arg }
  if (typeof arg === 'bigint') return { type: 'i128', value: arg }
  if (typeof arg === 'boolean') return { type: 'bool', value: arg }
  throw new Error(`Unsupported argument type: ${typeof arg}`)
}

/** ScVal::Symbol */
export function writeSymbol(w: XdrWriter, name: string): XdrWriter {
  if (name.length > 32) throw new Error(`Symbol longer than 32 chars: ${name}`)
  return w.u32(SC_VAL.SYMBOL).string(name)
}

/** Tagged integer ScVal (u32/i32/u64/i64/u128/i128/u256/i256, timepoint/duration) with range check. */
export function writeInt(w: XdrWriter, tag: number, value: bigint | number | string, bits: number, signed: boolean): XdrWriter {
  const n = BigInt(value)
  const b = BigInt(bits)
  const min = signed ? -(BigInt(1) << (b - BigInt(1))) : BigInt(0)
  const max = signed ? (BigInt(1) << (b - BigInt(1))) - BigInt(1) : (BigInt(1) << b) - BigInt(1)
  if (n < min || n > max) throw new Error(`${signed ? 'i' : 'u'}${bits} out of range: ${value}`)
  w.u32(tag)
  if (bits === 32) return signed ? w.i32(Number(n)) : w.u32(Number(n))
  // two's complement, emitted as big-endian u64 limbs (Int128Parts / Int256Parts)
  const u = n < BigInt(0) ? n + (BigInt(1) << b) : n
  for (let shift = bits - 64; shift >= 0; shift -= 64) w.u64((u >> BigInt(shift)) & MASK_64)
  return w
}

/** SCAddress (no ScVal tag) for a `G...` / `C...` StrKey. */
export function writeScAddress(w: XdrWriter, address: string): XdrWriter {
  const { version, payload } = decodeStrKey(address)
  if (version === STRKEY_VERSION.CONTRACT) return w.u32(SC_ADDR.CONTRACT).bytes(payload)
  if (version === STRKEY_VERSION.ACCOUNT) return w.u32(SC_ADDR.ACCOUNT).u32(KEY_TYPE_ED25519).bytes(payload)
  throw new Error(`Unsupported address for SCAddress: ${address}`)
}

/** ScVal::Address */
export function writeAddress(w: XdrWriter, address: string): XdrWriter {
  w.u32(SC_VAL.ADDRESS)
  return writeScAddress(w, address)
}

function toBytes(value: any): Buffer {
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value)
  if (typeof value === 'string') return Buffer.from(value.replace(/^0x/, ''), 'hex')
  throw new Error(`bytes expects Buffer/Uint8Array/hex string, got ${typeof value}`)
}

/** Append one ScVal for a (typed or untyped) argument. */
export function writeScVal(w: XdrWriter, arg: ScArgInput): XdrWriter {
  const { type, value } = normalizeScArg(arg)
  switch (type) {
    case 'void': return w.u32(SC_VAL.VOID)
    case 'bool':
      if (typeof value !== 'boolean') throw new Error(`bool expects boolean, got ${typeof value}`)
      return w.u32(SC_VAL.BOOL).u32(value ? 1 : 0)
    case 'u32': return writeInt(w, SC_VAL.U32, value, 32, false)
    case 'i32': return writeInt(w, SC_VAL.I32, value, 32, true)
    case 'u64': return writeInt(w, SC_VAL.U64, value, 64, false)
    case 'i64': return writeInt(w, SC_VAL.I64, value, 64, true)
    case 'timepoint': return writeInt(w, SC_VAL.TIMEPOINT, value, 64, false)
    case 'duration': return writeInt(w, SC_VAL.DURATION, value, 64, false)
    case 'u128': return writeInt(w, SC_VAL.U128, value, 128, false)
    case 'i128': return writeInt(w, SC_VAL.I128, value, 128, true)
    case 'u256': return writeInt(w, SC_VAL.U256, value, 256, false)
    case 'i256': return writeInt(w, SC_VAL.I256, value, 256, true)
    case 'symbol': return writeSymbol(w, String(value))
    case 'string': return w.u32(SC_VAL.STRING).string(String(value))
    case 'bytes': return w.u32(SC_VAL.BYTES).opaque(toBytes(value))
    case 'address': case 'account': return writeAddress(w, String(value))
    case 'vec': {
      const items: ScArgInput[] = Array.isArray(value) ? value : []
      w.u32(SC_VAL.VEC).u32(1).u32(items.length)
      items.forEach(i => writeScVal(w, i))
      return w
    }
    case 'map': {
      // #[contracttype] struct: SCMap keyed by field-name symbols, host requires ascending key order
      if (!value || typeof value !== 'object') throw new Error(`map expects an object, got ${typeof value}`)
      const entries = Object.entries(value as Record<string, ScArgInput>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      w.u32(SC_VAL.MAP).u32(1).u32(entries.length)
      for (const [key, entry] of entries) {
        writeSymbol(w, key)
        writeScVal(w, entry)
      }
      return w
    }
    default: throw new Error(`Unsupported ScVal arg type: '${type}'`)
  }
}

/** Encode a single ScVal to bytes. */
export function encodeScVal(arg: ScArgInput): Buffer {
  return writeScVal(new XdrWriter(), arg).toBuffer()
}

// ---------------------------------------------------------------------------
// XDR structures used for reads
// ---------------------------------------------------------------------------

/** Classic `Asset` XDR (native / alphanum4 / alphanum12). */
export function writeAsset(w: XdrWriter, asset: string | ClassicAsset): XdrWriter {
  const parsed = parseAsset(asset)
  if (isNativeAsset(parsed)) return w.u32(0)
  const codeLen = parsed.code.length <= 4 ? 4 : 12
  const code = Buffer.alloc(codeLen)
  code.write(parsed.code, 0, 'ascii')
  w.u32(codeLen === 4 ? 1 : 2).bytes(code)
  return w.u32(KEY_TYPE_ED25519).bytes(strKeyToBytes(parsed.issuer!, STRKEY_VERSION.ACCOUNT))
}

export function getNetworkId(passphrase: string = PUBLIC_NETWORK_PASSPHRASE): Buffer {
  return createHash('sha256').update(passphrase, 'utf8').digest()
}

/**
 * Stellar Asset Contract id of a classic asset (or `native`):
 * sha256(HashIDPreimage::ENVELOPE_TYPE_CONTRACT_ID { networkId, ContractIDPreimage::FROM_ASSET(asset) }).
 */
export function getSacContractId({ asset, networkPassphrase = PUBLIC_NETWORK_PASSPHRASE }: { asset: string | ClassicAsset, networkPassphrase?: string }): string {
  const w = new XdrWriter()
  w.u32(ENVELOPE_TYPE_CONTRACT_ID).bytes(getNetworkId(networkPassphrase)).u32(CONTRACT_ID_PREIMAGE_FROM_ASSET)
  writeAsset(w, asset)
  return encodeStrKey(STRKEY_VERSION.CONTRACT, createHash('sha256').update(w.toBuffer()).digest())
}

/**
 * Unsigned TransactionV1Envelope with a single InvokeHostFunction(InvokeContract)
 * operation, as accepted by `simulateTransaction`. `source` defaults to the zero key.
 */
export function buildInvokeContractEnvelope({ contractId, method, args = [], source, fee = 100 }: {
  contractId: string
  method: string
  args?: ScArgInput[]
  source?: string
  fee?: number
}): Buffer {
  if (!isContractId(contractId)) throw new Error(`Invalid contract id: ${contractId}`)
  const w = new XdrWriter()
  w.u32(ENVELOPE_TYPE_TX)
  w.u32(KEY_TYPE_ED25519)                                                              // MuxedAccount.KEY_TYPE_ED25519
  w.bytes(source ? strKeyToBytes(source, STRKEY_VERSION.ACCOUNT) : Buffer.alloc(32))  // source account
  w.u32(fee)
  w.i64(0)                                                                             // seqNum
  w.u32(0)                                                                             // Preconditions.PRECOND_NONE
  w.u32(0)                                                                             // Memo.MEMO_NONE
  w.u32(1)                                                                             // operations<>
  w.u32(0)                                                                             // op.sourceAccount absent
  w.u32(OP_INVOKE_HOST_FUNCTION)
  w.u32(HOST_FUNCTION_TYPE_INVOKE_CONTRACT)
  writeScAddress(w, contractId)                                                        // InvokeContractArgs.contractAddress
  w.string(method)                                                                     // functionName (SCSymbol)
  w.u32(args.length)
  args.forEach(a => writeScVal(w, a))
  w.u32(0)                                                                             // auth<>
  w.u32(0)                                                                             // Transaction.ext v0
  w.u32(0)                                                                             // signatures<>
  return w.toBuffer()
}

/** LedgerKey::ContractData { contract, key: LedgerKeyContractInstance, durability: PERSISTENT } */
export function buildContractInstanceLedgerKey({ contractId }: { contractId: string }): Buffer {
  const w = new XdrWriter()
  w.u32(LEDGER_ENTRY_CONTRACT_DATA)
  writeScAddress(w, contractId)
  w.u32(SC_VAL.LEDGER_KEY_CONTRACT_INSTANCE)
  w.u32(CONTRACT_DATA_DURABILITY_PERSISTENT)
  return w.toBuffer()
}

// ---------------------------------------------------------------------------
// Horizon
// ---------------------------------------------------------------------------

export interface HorizonBalanceRecord {
  balance: string
  asset_type: 'native' | 'credit_alphanum4' | 'credit_alphanum12' | 'liquidity_pool_shares' | string
  asset_code?: string
  asset_issuer?: string
  liquidity_pool_id?: string
  limit?: string
  buying_liabilities?: string
  selling_liabilities?: string
  is_authorized?: boolean
  is_authorized_to_maintain_liabilities?: boolean
  is_clawback_enabled?: boolean
  last_modified_ledger?: number
}

export interface AccountBalance {
  /** `native`, `CODE-ISSUER` or `pool:<liquidity_pool_id>` */
  asset: string
  assetType: string
  code?: string
  issuer?: string
  liquidityPoolId?: string
  /** Horizon display string (7 decimals) */
  balance: string
  /** stroops (balance x 1e7) as decimal string */
  raw: string
  limit?: string
  isAuthorized?: boolean
}

export interface AssetSupply {
  asset: string
  /** authorized + contracts + liquidity pools + claimable balances, stroops */
  supply: string
  decimals: number
  authorized: string
  authorizedToMaintainLiabilities: string
  unauthorized: string
  contracts: string
  liquidityPools: string
  claimableBalances: string
  /** Horizon's own (deprecated) `amount` field, stroops; not part of `supply` */
  amount: string
  numAccounts?: number
  numContracts?: number
  numClaimableBalances?: number
  numLiquidityPools?: number
}

export interface LedgerInfo {
  number: number
  /** unix seconds of `closed_at` */
  timestamp: number
  closedAt: string
  hash: string
  protocolVersion?: number
  /** stroops */
  totalCoins?: string
  successfulTransactionCount?: number
  failedTransactionCount?: number
  operationCount?: number
}

function isNotFoundError(e: any): boolean {
  const message = String(e?.message ?? e ?? '')
  return /\[404\]|not_found|not found/i.test(message)
}

/** GET `path` on Horizon with query `params`; rotates configured endpoints and retries transient failures. */
export async function horizonGet({ path, params }: { path: string, params?: Record<string, any> }): Promise<any> {
  const endpoints = getHorizonEndpoints()
  return getLimiter('STELLAR_HORIZON', HORIZON_CONCURRENCY)(() => httpGet(endpoints, { path, params, retries: Math.max(3, endpoints.length) }))
}

/** Raw Horizon account record (`/accounts/{id}`). Throws on unknown account. */
export async function getAccount({ address }: { address: string }): Promise<any> {
  if (!isAccountId(address)) throw new Error(`Invalid Stellar account id: ${address}`)
  return horizonGet({ path: `/accounts/${address}` })
}

function toAccountBalance(b: HorizonBalanceRecord): AccountBalance {
  const res: AccountBalance = {
    asset: 'native',
    assetType: b.asset_type,
    balance: b.balance,
    raw: toRaw(b.balance),
  }
  if (b.asset_type === 'liquidity_pool_shares') {
    res.asset = `pool:${b.liquidity_pool_id}`
    res.liquidityPoolId = b.liquidity_pool_id
  } else if (b.asset_type !== 'native') {
    res.asset = `${b.asset_code}-${b.asset_issuer}`
    res.code = b.asset_code
    res.issuer = b.asset_issuer
    res.isAuthorized = b.is_authorized
  }
  if (b.limit !== undefined) res.limit = b.limit
  return res
}

/**
 * All balances (native, trustlines, pool shares) of a classic account.
 * A non-existent (never funded) account resolves to `[]`.
 */
export async function getAccountBalances({ address }: { address: string }): Promise<AccountBalance[]> {
  let account: any
  try {
    account = await getAccount({ address })
  } catch (e) {
    if (!isNotFoundError(e)) throw e
    debugLog(`[stellar] account ${address} not found on Horizon, treating as empty`)
    return []
  }
  const balances: HorizonBalanceRecord[] = account?.balances ?? []
  return balances.map(toAccountBalance)
}

/** XLM balance of an account in stroops. */
export async function getNativeBalance({ address }: { address: string }): Promise<string> {
  const balances = await getAccountBalances({ address })
  return balances.find(b => b.asset === 'native')?.raw ?? '0'
}

/**
 * Balance of `asset` held by `address`, in stroops (7 decimals for classic assets and SACs,
 * the token's own decimals for other Soroban tokens).
 *  - `asset` is a `C...` contract id -> Soroban `balance(address)`
 *  - `address` is a `C...` contract holding a classic asset -> `balance` on the asset's SAC
 *  - otherwise the Horizon trustline balance (`0` when there is no trustline / account)
 */
export async function getTokenBalance({ asset, address }: { asset: string | ClassicAsset, address: string }): Promise<string> {
  if (typeof asset === 'string' && isContractId(asset)) return getSorobanTokenBalance({ contractId: asset, address })
  const parsed = parseAsset(asset)
  if (isContractId(address)) return getSorobanTokenBalance({ contractId: getSacContractId({ asset: parsed }), address })
  const key = assetToString(parsed)
  const balances = await getAccountBalances({ address })
  return balances.find(b => b.asset === key)?.raw ?? '0'
}

/** Horizon `/assets` record for a classic asset, or `undefined` when Horizon does not know it. */
export async function getAsset({ code, issuer, asset }: { code?: string, issuer?: string, asset?: string | ClassicAsset }): Promise<any> {
  const parsed = asset !== undefined ? parseAsset(asset) : parseAsset({ code: code!, issuer })
  if (isNativeAsset(parsed)) throw new Error('getAsset: the native asset has no /assets record, use getAssetSupply')
  const res = await horizonGet({ path: '/assets', params: { asset_code: parsed.code, asset_issuer: parsed.issuer, limit: 1 } })
  return res?._embedded?.records?.[0]
}

/**
 * Circulating supply of a classic asset in stroops: authorized trustline balances plus
 * amounts held by Soroban contracts (SAC), liquidity pools and claimable balances.
 * `native` returns the ledger's `total_coins`.
 */
export async function getAssetSupply({ asset, code, issuer }: { asset?: string | ClassicAsset, code?: string, issuer?: string }): Promise<AssetSupply> {
  const parsed = asset !== undefined ? parseAsset(asset) : parseAsset({ code: code!, issuer })
  const key = assetToString(parsed)
  if (isNativeAsset(parsed)) {
    const ledger = await getLatestLedger()
    const total = ledger.totalCoins ?? '0'
    return {
      asset: key, supply: total, decimals: STELLAR_DECIMALS, authorized: total, authorizedToMaintainLiabilities: '0', unauthorized: '0',
      contracts: '0', liquidityPools: '0', claimableBalances: '0', amount: total,
    }
  }
  const record = await getAsset({ asset: parsed })
  if (!record) throw new Error(`Asset ${key} not found on Horizon`)
  const authorized = toRaw(record.balances?.authorized ?? '0')
  const contracts = toRaw(record.contracts_amount ?? '0')
  const liquidityPools = toRaw(record.liquidity_pools_amount ?? '0')
  const claimableBalances = toRaw(record.claimable_balances_amount ?? '0')
  const supply = (BigInt(authorized) + BigInt(contracts) + BigInt(liquidityPools) + BigInt(claimableBalances)).toString()
  return {
    asset: key,
    supply,
    decimals: STELLAR_DECIMALS,
    authorized,
    authorizedToMaintainLiabilities: toRaw(record.balances?.authorized_to_maintain_liabilities ?? '0'),
    unauthorized: toRaw(record.balances?.unauthorized ?? '0'),
    contracts,
    liquidityPools,
    claimableBalances,
    amount: toRaw(record.amount ?? '0'),
    // Horizon >= 2.x dropped `num_accounts` in favour of `accounts.{authorized,...}`
    numAccounts: record.num_accounts ?? record.accounts?.authorized,
    numContracts: record.num_contracts,
    numClaimableBalances: record.num_claimable_balances,
    numLiquidityPools: record.num_liquidity_pools,
  }
}

function toLedgerInfo(record: any): LedgerInfo {
  return {
    number: Number(record.sequence),
    timestamp: Math.floor(Date.parse(record.closed_at) / 1000),
    closedAt: record.closed_at,
    hash: record.hash,
    protocolVersion: record.protocol_version,
    totalCoins: record.total_coins !== undefined ? toRaw(record.total_coins) : undefined,
    successfulTransactionCount: record.successful_transaction_count,
    failedTransactionCount: record.failed_transaction_count,
    operationCount: record.operation_count,
  }
}

/** Horizon ledger by sequence number, or the latest closed ledger. */
export async function getLedger({ sequence = 'latest' }: { sequence?: number | 'latest' } = {}): Promise<LedgerInfo> {
  if (sequence === 'latest') {
    const res = await horizonGet({ path: '/ledgers', params: { order: 'desc', limit: 1 } })
    const record = res?._embedded?.records?.[0]
    if (!record) throw new Error('Horizon returned no ledgers')
    return toLedgerInfo(record)
  }
  if (!Number.isInteger(sequence) || sequence < 1) throw new Error(`Invalid ledger sequence: ${sequence}`)
  return toLedgerInfo(await horizonGet({ path: `/ledgers/${sequence}` }))
}

export async function getLatestLedger(): Promise<LedgerInfo> {
  return getLedger({ sequence: 'latest' })
}

/** Ledgers close every ~5-6s; used only as a first guess in `getLedgerAtTimestamp`. */
const AVG_LEDGER_CLOSE_SECONDS = 5.5

/**
 * Last ledger closed at or before `timestamp` (unix seconds, ms accepted). Horizon has no
 * time filter, so this is an interpolation search over `/ledgers/{seq}` (typically 4-8 requests).
 */
export async function getLedgerAtTimestamp({ timestamp }: { timestamp: number }): Promise<LedgerInfo> {
  if (timestamp > 1e11) timestamp = Math.floor(timestamp / 1000)
  const latest = await getLatestLedger()
  if (timestamp >= latest.timestamp) return latest
  // ledger 1 is the genesis ledger (closed_at 1970), so it is a valid lower bound for any timestamp
  let lo: LedgerInfo = { number: 1, timestamp: 0, closedAt: '1970-01-01T00:00:00Z', hash: '' }
  let hi: LedgerInfo = latest
  for (let iteration = 0; hi.number - lo.number > 1; iteration++) {
    if (iteration > 64) throw new Error(`getLedgerAtTimestamp: did not converge for ${timestamp}`)
    let guess: number
    if (iteration % 2 === 1) {
      guess = lo.number + Math.floor((hi.number - lo.number) / 2) // bisection step guarantees progress
    } else if (lo.number === 1) {
      guess = hi.number - Math.ceil((hi.timestamp - timestamp) / AVG_LEDGER_CLOSE_SECONDS)
    } else {
      const span = hi.timestamp - lo.timestamp
      guess = span > 0 ? lo.number + Math.floor((timestamp - lo.timestamp) * (hi.number - lo.number) / span) : lo.number + 1
    }
    guess = Math.min(Math.max(guess, lo.number + 1), hi.number - 1)
    const ledger = await getLedger({ sequence: guess })
    if (ledger.timestamp <= timestamp) lo = ledger
    else hi = ledger
  }
  if (lo.number === 1) return getLedger({ sequence: 1 })
  return lo
}

// ---------------------------------------------------------------------------
// Soroban RPC
// ---------------------------------------------------------------------------

/** Raw Soroban JSON-RPC call; rotates configured endpoints and retries transport / rate-limit errors. */
export async function sorobanRpc(method: string, params: any = {}): Promise<any> {
  const endpoints = getSorobanEndpoints()
  return getLimiter('STELLAR_SOROBAN', SOROBAN_CONCURRENCY)(() => jsonRpc(method, params, { endpoints, chain: 'stellar' }))
}

export async function getLatestSorobanLedger(): Promise<{ number: number, hash: string, protocolVersion: number }> {
  const res = await sorobanRpc('getLatestLedger')
  return { number: Number(res.sequence), hash: res.id, protocolVersion: Number(res.protocolVersion) }
}

/**
 * `simulateTransaction` on a base64 (or raw) TransactionEnvelope. Returns the RPC result;
 * throws when the simulation itself failed (`result.error`).
 */
export async function simulateTransaction({ transaction, resourceConfig }: { transaction: string | Buffer, resourceConfig?: { instructionLeeway?: number } }): Promise<any> {
  const params: any = { transaction: typeof transaction === 'string' ? transaction : transaction.toString('base64') }
  if (resourceConfig) params.resourceConfig = resourceConfig
  const res = await sorobanRpc('simulateTransaction', params)
  if (res?.error) throw new Error(`Soroban simulation failed: ${String(res.error).slice(0, 500)}`)
  return res
}

/**
 * Read-only contract call via `simulateTransaction`. Returns the decoded ScVal result
 * (see `parseScVal` for the mapping). See `ScArgInput` for how untyped args are encoded.
 */
export async function callSoroban({ contractId, method, args = [], source }: { contractId: string, method: string, args?: ScArgInput[], source?: string }): Promise<ScValue> {
  const envelope = buildInvokeContractEnvelope({ contractId, method, args, source })
  const res = await simulateTransaction({ transaction: envelope })
  const xdr = res?.results?.[0]?.xdr
  if (!xdr) throw new Error(`No result from ${contractId}.${method}()`)
  return parseScVal(xdr)
}

export interface LedgerEntryResult {
  key: string
  xdr: string
  lastModifiedLedgerSeq: number
  liveUntilLedgerSeq?: number
}

/** `getLedgerEntries` for base64 (or raw) LedgerKey XDRs. Missing entries are simply absent from `entries`. */
export async function getLedgerEntries({ keys }: { keys: (string | Buffer)[] }): Promise<{ entries: LedgerEntryResult[], latestLedger: number }> {
  if (!keys.length) return { entries: [], latestLedger: 0 }
  const encoded = keys.map(k => typeof k === 'string' ? k : k.toString('base64'))
  const res = await sorobanRpc('getLedgerEntries', { keys: encoded })
  return { entries: res?.entries ?? [], latestLedger: Number(res?.latestLedger ?? 0) }
}

/** Decoded SCContractInstance (executable + instance storage) of a contract. */
export async function getContractInstance({ contractId }: { contractId: string }): Promise<ScContractInstance> {
  const key = buildContractInstanceLedgerKey({ contractId })
  const { entries } = await getLedgerEntries({ keys: [key] })
  const xdr = entries[0]?.xdr
  if (!xdr) throw new Error(`No instance storage ledger entry for ${contractId}`)
  // LedgerEntryData(CONTRACT_DATA) { ext, SCAddress contract, SCVal key, durability, SCVal val }
  const r = new XdrReader(xdr)
  const type = r.u32()
  if (type !== LEDGER_ENTRY_CONTRACT_DATA) throw new Error(`Unexpected LedgerEntryType ${type} for ${contractId}`)
  r.u32()            // ExtensionPoint
  readScAddress(r)   // contract
  readScVal(r)       // key (LedgerKeyContractInstance, void)
  r.u32()            // durability
  const instance = readScVal(r) as ScContractInstance
  if (!instance || typeof instance !== 'object' || !('storage' in instance)) throw new Error(`Unexpected instance entry for ${contractId}`)
  return instance
}

/**
 * Instance storage of a contract keyed by storage key (enum keys collapse to the variant
 * name). Reads data not reachable through contract functions.
 */
export async function getContractInstanceStorage({ contractId }: { contractId: string }): Promise<{ [key: string]: ScValue }> {
  return (await getContractInstance({ contractId })).storage
}

// ---------------------------------------------------------------------------
// Soroban token interface (SEP-41 / SAC)
// ---------------------------------------------------------------------------

const tokenMetadataCache: { [key: string]: Promise<any> } = {}

function cached<T>(key: string, fn: () => Promise<T>): Promise<T> {
  if (!tokenMetadataCache[key]) {
    tokenMetadataCache[key] = fn().catch(e => {
      delete tokenMetadataCache[key]
      throw e
    })
  }
  return tokenMetadataCache[key]
}

/** `balance(address)` as a decimal string in the token's smallest unit. */
export async function getSorobanTokenBalance({ contractId, address }: { contractId: string, address: string }): Promise<string> {
  const value = await callSoroban({ contractId, method: 'balance', args: [address] })
  return String(value)
}

export async function getSorobanTokenDecimals({ contractId }: { contractId: string }): Promise<number> {
  return cached(`decimals:${contractId}`, async () => Number(await callSoroban({ contractId, method: 'decimals' })))
}

export async function getSorobanTokenSymbol({ contractId }: { contractId: string }): Promise<string> {
  return cached(`symbol:${contractId}`, async () => String(await callSoroban({ contractId, method: 'symbol' })))
}

/** `name()`; a SAC returns `CODE:ISSUER` (or `native`), which is how `getSacClassicAsset` resolves it. */
export async function getSorobanTokenName({ contractId }: { contractId: string }): Promise<string> {
  return cached(`name:${contractId}`, async () => String(await callSoroban({ contractId, method: 'name' })))
}

function isMissingFunctionError(e: any): boolean {
  const message = String(e?.message ?? e ?? '')
  return /MissingValue|InvalidAction|InvalidInput|unknown function|not found|does not exist|no such function|MissingFunction|function.*not.*export/i.test(message)
}

/**
 * `total_supply()` of a Soroban token as a decimal string, or `undefined` when the contract
 * does not implement it (SACs do not; use `getAssetSupply` on the classic asset instead).
 */
export async function getSorobanTokenTotalSupply({ contractId }: { contractId: string }): Promise<string | undefined> {
  try {
    return String(await callSoroban({ contractId, method: 'total_supply' }))
  } catch (e) {
    if (!isMissingFunctionError(e)) throw e
    debugLog(`[stellar] ${contractId} has no total_supply(): ${String((e as any)?.message).slice(0, 160)}`)
    return undefined
  }
}

/** Classic asset wrapped by a Stellar Asset Contract, or `undefined` for a non-SAC token. */
export async function getSacClassicAsset({ contractId }: { contractId: string }): Promise<ClassicAsset | undefined> {
  const name = await getSorobanTokenName({ contractId })
  let asset: ClassicAsset
  try {
    asset = parseAsset(name)
  } catch {
    return undefined
  }
  // the name is only trusted when the derived SAC id matches (a custom token could name itself "USDC:G...")
  return getSacContractId({ asset }) === contractId ? asset : undefined
}

/**
 * Total supply of any Stellar token id used by DefiLlama: `native`, `CODE-ISSUER`, or a
 * `C...` contract (SAC -> Horizon supply of the wrapped asset, other tokens -> `total_supply()`).
 * Resolves to `undefined` when a Soroban token exposes no `total_supply`.
 */
export async function getTokenSupply({ token }: { token: string | ClassicAsset }): Promise<{ supply: string, decimals: number } | undefined> {
  if (typeof token === 'string' && isContractId(token)) {
    const classic = await getSacClassicAsset({ contractId: token })
    if (classic) {
      const { supply, decimals } = await getAssetSupply({ asset: classic })
      return { supply, decimals }
    }
    const supply = await getSorobanTokenTotalSupply({ contractId: token })
    if (supply === undefined) return undefined
    return { supply, decimals: await getSorobanTokenDecimals({ contractId: token }) }
  }
  const { supply, decimals } = await getAssetSupply({ asset: token })
  return { supply, decimals }
}
