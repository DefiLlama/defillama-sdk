/**
 * Substrate / Polkadot JSON-RPC client with a dependency free SCALE + storage-key codec.
 *
 * Replaces (and unifies) the ad-hoc substrate helpers spread across the llama repos:
 * - DefiLlama-Adapters  `projects/helper/chain/substrate.js` (endpoints, rpc, xxhash64/twox, blake2, ss58,
 *                        SCALE encode/decode, ScaleReader, storage keys, getStorage/Batch/Entries, stateCall,
 *                        System.Account / orml Tokens.Accounts decoding)
 * - DefiLlama-Adapters  `projects/helper/chain/bifrostCurrency.js` (bifrost CurrencyId codec -> `bifrost`)
 * - DefiLlama-Adapters  `projects/helper/chain/polkadot.js` (System.Account key + AccountInfo decoding)
 * - DefiLlama-Adapters  `projects/helper/chain/bittensor.js` (SubtensorModule prefixes, free balance, u64 balances)
 * - server/coins        `src/adapters/other/bittensorSubnets.ts` (state_getKeysPaged pagination, twox128 prefixes)
 *
 * No `@polkadot/*`, `blakejs` or `bs58`: blake2b, xxhash64 and base58 are implemented here.
 * Only plain storage items and (double) maps whose values are made of fixed width integers,
 * options and compacts are decoded; anything that needs chain metadata is decoded by the caller
 * with the SCALE helpers (`ScaleReader`, `decodeUint`, `decodeCompact`).
 *
 * Endpoints: `<CHAIN>_SUBSTRATE_RPC` env first (comma separated), then `DEFAULT_ENDPOINTS`, then
 * `<CHAIN>_RPC` only when the chain is not an EVM chain (astar/acala/moonbeam use `<CHAIN>_RPC` for
 * their EVM RPC). A literal `https://` url can be passed as `chain`.
 *
 * Usage: `sdk.chains.substrate.getSystemAccount({ chain: 'polkadot', address })`
 */
import { debugLog } from "../util/debugLog";
import { getEnvRPC } from "../util/env";
import { isEvmChain } from "../util/LlamaProvider";
import { getEndpoints as resolveEndpoints, getLimiter, jsonRpc, sliceIntoChunks, toEndpointList } from "./rpc";

export const DEFAULT_ENDPOINTS: Record<string, string> = {
  polkadot: 'https://rpc.polkadot.io,https://polkadot-rpc.publicnode.com,https://dot-rpc.stakeworld.io',
  polkadot_assethub: 'https://polkadot-asset-hub-rpc.polkadot.io,https://statemint.api.onfinality.io/public',
  kusama: 'https://kusama-rpc.polkadot.io,https://kusama-rpc.publicnode.com',
  acala: 'https://acala-rpc.aca-api.network',
  karura: 'https://karura-rpc.aca-api.network',
  bifrost: 'https://eu.bifrost-polkadot-rpc.liebi.com',
  bifrost_kusama: 'https://bifrost-rpc.liebi.com,https://api-bifrost-kusama.n.dwellir.com/b523cf66-7a5a-4fe8-8d67-f604fd0492c2',
  bittensor: 'https://entrypoint-finney.opentensor.ai',
  polymesh: 'https://mainnet-rpc.polymesh.network',
  astar: 'https://astar.api.onfinality.io/public,https://rpc.astar.network,https://astar-rpc.dwellir.com',
  sora: 'https://mof2.sora.org',
  hydration: 'https://rpc.hydradx.cloud',
}

const DEFAULT_CONCURRENCY = 10
const DEFAULT_PAGE_SIZE = 1000
const DEFAULT_BATCH_CHUNK = 1000
/** assumed block time (seconds) used to bracket the binary search in getBlockAtTimestamp */
const BLOCK_TIME = 6

export type Bytes = Buffer | Uint8Array | number[] | string

export interface ChainOptions {
  /** chain key (`polkadot`, `bifrost`, ...) or a literal `https://` endpoint (comma separated list allowed) */
  chain: string
  /** total attempts across endpoints (default: max(3, endpoints)) */
  retries?: number
}

// ---------------------------------------------------------------------------
// bytes
// ---------------------------------------------------------------------------

/** `Buffer` from a `0x` hex string, utf8 string, byte array or Buffer/Uint8Array */
export function toBuf(value: Bytes | undefined | null): Buffer {
  if (value === undefined || value === null) return Buffer.alloc(0)
  if (Buffer.isBuffer(value)) return value
  if (value instanceof Uint8Array) return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  if (Array.isArray(value)) return Buffer.from(value)
  if (typeof value === 'string') {
    if (value.startsWith('0x') || value.startsWith('0X')) return Buffer.from(value.slice(2), 'hex')
    return Buffer.from(value, 'utf8')
  }
  throw new Error(`substrate.toBuf: unsupported value ${typeof value}`)
}

/** `0x` prefixed lowercase hex */
export function hex(value: Bytes): string {
  return '0x' + toBuf(value).toString('hex')
}

/** little endian u64 (8 bytes) */
export function u64le(n: bigint | number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(n))
  return b
}

function concat(parts: Uint8Array[]): Buffer {
  return Buffer.concat(parts.map(p => Buffer.isBuffer(p) ? p : Buffer.from(p)))
}

// ---------------------------------------------------------------------------
// xxhash64 / twox
// ---------------------------------------------------------------------------

const P1 = BigInt('11400714785074694791')
const P2 = BigInt('14029467366897019727')
const P3 = BigInt('1609587929392839161')
const P4 = BigInt('9650029242287828579')
const P5 = BigInt('2870177450012600261')
const M64 = (BigInt(1) << BigInt(64)) - BigInt(1)
const B0 = BigInt(0)
const B64 = BigInt(64)

const rotl64 = (x: bigint, r: number) => ((x << BigInt(r)) | (x >> (B64 - BigInt(r)))) & M64
const xxRound = (acc: bigint, input: bigint) => (rotl64((acc + input * P2) & M64, 31) * P1) & M64
const xxMerge = (acc: bigint, val: bigint) => ((acc ^ xxRound(B0, val)) * P1 + P4) & M64

/** xxHash64 of `data` with `seed` -> unsigned 64 bit bigint */
export function xxhash64(data: Bytes, seed: bigint | number = 0): bigint {
  const buf = toBuf(data)
  const s = BigInt(seed) & M64
  const len = buf.length
  let p = 0
  let h: bigint
  if (len >= 32) {
    let v1 = (s + P1 + P2) & M64
    let v2 = (s + P2) & M64
    let v3 = s
    let v4 = (s - P1) & M64
    for (; p + 32 <= len; p += 32) {
      v1 = xxRound(v1, buf.readBigUInt64LE(p))
      v2 = xxRound(v2, buf.readBigUInt64LE(p + 8))
      v3 = xxRound(v3, buf.readBigUInt64LE(p + 16))
      v4 = xxRound(v4, buf.readBigUInt64LE(p + 24))
    }
    h = (rotl64(v1, 1) + rotl64(v2, 7) + rotl64(v3, 12) + rotl64(v4, 18)) & M64
    h = xxMerge(h, v1); h = xxMerge(h, v2); h = xxMerge(h, v3); h = xxMerge(h, v4)
  } else {
    h = (s + P5) & M64
  }
  h = (h + BigInt(len)) & M64
  for (; p + 8 <= len; p += 8) {
    h ^= xxRound(B0, buf.readBigUInt64LE(p))
    h = (rotl64(h, 27) * P1 + P4) & M64
  }
  if (p + 4 <= len) {
    h ^= (BigInt(buf.readUInt32LE(p)) * P1) & M64
    h = (rotl64(h, 23) * P2 + P3) & M64
    p += 4
  }
  for (; p < len; p++) {
    h ^= (BigInt(buf[p]) * P5) & M64
    h = (rotl64(h, 11) * P1) & M64
  }
  h ^= h >> BigInt(33); h = (h * P2) & M64
  h ^= h >> BigInt(29); h = (h * P3) & M64
  h ^= h >> BigInt(32)
  return h
}

/** twox64: xxhash64(data, 0) as 8 LE bytes */
export const twox64 = (data: Bytes): Buffer => u64le(xxhash64(data, 0))
/** twox128: xxhash64(data, 0) ++ xxhash64(data, 1) */
export const twox128 = (data: Bytes): Buffer => concat([u64le(xxhash64(data, 0)), u64le(xxhash64(data, 1))])
/** twox256: xxhash64 with seeds 0..3 */
export const twox256 = (data: Bytes): Buffer => concat([0, 1, 2, 3].map(seed => u64le(xxhash64(data, seed))))

// ---------------------------------------------------------------------------
// blake2b (RFC 7693, keyless, 1..64 byte digest) on 32 bit word pairs
// ---------------------------------------------------------------------------

const BLAKE2B_IV32 = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85,
  0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c,
  0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
])

const SIGMA8 = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
]
// message word index * 2 (each 64 bit word is a pair of 32 bit words)
const SIGMA82 = new Uint8Array(SIGMA8.map(x => x * 2))

// working vector (32 x u32 = 16 x u64) and message block (32 x u32)
const bv = new Uint32Array(32)
const bm = new Uint32Array(32)

// v[a] += v[b] (64 bit, little word first)
function add64AA(v: Uint32Array, a: number, b: number) {
  const o0 = v[a] + v[b]
  let o1 = v[a + 1] + v[b + 1]
  if (o0 >= 0x100000000) o1++
  v[a] = o0
  v[a + 1] = o1
}

// v[a] += (b0, b1) where b0/b1 may be signed 32 bit
function add64AC(v: Uint32Array, a: number, b0: number, b1: number) {
  let o0 = v[a] + b0
  if (b0 < 0) o0 += 0x100000000
  let o1 = v[a + 1] + b1
  if (o0 >= 0x100000000) o1++
  v[a] = o0
  v[a + 1] = o1
}

function get32(arr: Uint8Array, i: number) {
  return arr[i] ^ (arr[i + 1] << 8) ^ (arr[i + 2] << 16) ^ (arr[i + 3] << 24)
}

function b2bG(a: number, b: number, c: number, d: number, ix: number, iy: number) {
  const x0 = bm[ix], x1 = bm[ix + 1], y0 = bm[iy], y1 = bm[iy + 1]
  add64AA(bv, a, b)
  add64AC(bv, a, x0, x1)
  // v[d] = rotr64(v[d] ^ v[a], 32)
  let xor0 = bv[d] ^ bv[a], xor1 = bv[d + 1] ^ bv[a + 1]
  bv[d] = xor1
  bv[d + 1] = xor0
  add64AA(bv, c, d)
  // v[b] = rotr64(v[b] ^ v[c], 24)
  xor0 = bv[b] ^ bv[c]; xor1 = bv[b + 1] ^ bv[c + 1]
  bv[b] = (xor0 >>> 24) ^ (xor1 << 8)
  bv[b + 1] = (xor1 >>> 24) ^ (xor0 << 8)
  add64AA(bv, a, b)
  add64AC(bv, a, y0, y1)
  // v[d] = rotr64(v[d] ^ v[a], 16)
  xor0 = bv[d] ^ bv[a]; xor1 = bv[d + 1] ^ bv[a + 1]
  bv[d] = (xor0 >>> 16) ^ (xor1 << 16)
  bv[d + 1] = (xor1 >>> 16) ^ (xor0 << 16)
  add64AA(bv, c, d)
  // v[b] = rotr64(v[b] ^ v[c], 63)
  xor0 = bv[b] ^ bv[c]; xor1 = bv[b + 1] ^ bv[c + 1]
  bv[b] = (xor1 >>> 31) ^ (xor0 << 1)
  bv[b + 1] = (xor0 >>> 31) ^ (xor1 << 1)
}

interface Blake2bCtx { b: Uint8Array, h: Uint32Array, t: number, c: number, outlen: number }

function blake2bCompress(ctx: Blake2bCtx, last: boolean) {
  let i: number
  for (i = 0; i < 16; i++) {
    bv[i] = ctx.h[i]
    bv[i + 16] = BLAKE2B_IV32[i]
  }
  // low 64 bits of the byte counter (inputs here are far below 2^53 bytes)
  bv[24] = bv[24] ^ ctx.t
  bv[25] = bv[25] ^ (ctx.t / 0x100000000)
  if (last) {
    bv[28] = ~bv[28]
    bv[29] = ~bv[29]
  }
  for (i = 0; i < 32; i++) bm[i] = get32(ctx.b, 4 * i)
  for (i = 0; i < 12; i++) {
    const s = i * 16
    b2bG(0, 8, 16, 24, SIGMA82[s + 0], SIGMA82[s + 1])
    b2bG(2, 10, 18, 26, SIGMA82[s + 2], SIGMA82[s + 3])
    b2bG(4, 12, 20, 28, SIGMA82[s + 4], SIGMA82[s + 5])
    b2bG(6, 14, 22, 30, SIGMA82[s + 6], SIGMA82[s + 7])
    b2bG(0, 10, 20, 30, SIGMA82[s + 8], SIGMA82[s + 9])
    b2bG(2, 12, 22, 24, SIGMA82[s + 10], SIGMA82[s + 11])
    b2bG(4, 14, 16, 26, SIGMA82[s + 12], SIGMA82[s + 13])
    b2bG(6, 8, 18, 28, SIGMA82[s + 14], SIGMA82[s + 15])
  }
  for (i = 0; i < 16; i++) ctx.h[i] = ctx.h[i] ^ bv[i] ^ bv[i + 16]
}

/** blake2b digest of `data`, `outLen` bytes (1..64, default 32), no key */
export function blake2b(data: Bytes, outLen = 32): Buffer {
  if (!(outLen > 0 && outLen <= 64)) throw new Error(`blake2b: illegal output length ${outLen}`)
  const input = toBuf(data)
  const ctx: Blake2bCtx = { b: new Uint8Array(128), h: new Uint32Array(16), t: 0, c: 0, outlen: outLen }
  for (let i = 0; i < 16; i++) ctx.h[i] = BLAKE2B_IV32[i]
  ctx.h[0] ^= 0x01010000 ^ outLen // parameter block: digest length, key length 0, fanout 1, depth 1
  for (let i = 0; i < input.length; i++) {
    if (ctx.c === 128) {
      ctx.t += ctx.c
      blake2bCompress(ctx, false)
      ctx.c = 0
    }
    ctx.b[ctx.c++] = input[i]
  }
  ctx.t += ctx.c
  while (ctx.c < 128) ctx.b[ctx.c++] = 0
  blake2bCompress(ctx, true)
  const out = Buffer.alloc(outLen)
  for (let i = 0; i < outLen; i++) out[i] = ctx.h[i >> 2] >> (8 * (i & 3))
  return out
}

export const blake2_128 = (data: Bytes): Buffer => blake2b(data, 16)
export const blake2_256 = (data: Bytes): Buffer => blake2b(data, 32)
export const blake2_512 = (data: Bytes): Buffer => blake2b(data, 64)

// ---------------------------------------------------------------------------
// base58 / ss58
// ---------------------------------------------------------------------------

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const BASE58_MAP: Record<string, number> = {}
for (let i = 0; i < BASE58_ALPHABET.length; i++) BASE58_MAP[BASE58_ALPHABET[i]] = i

/** base58 (bitcoin alphabet) decode, keeps leading zero bytes */
export function base58Decode(str: string): Buffer {
  if (typeof str !== 'string') throw new Error('base58Decode: expected a string')
  if (!str.length) return Buffer.alloc(0)
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++
  const bytes: number[] = []
  for (let i = zeros; i < str.length; i++) {
    const c = str[i]
    let carry = BASE58_MAP[c]
    if (carry === undefined) throw new Error(`base58Decode: invalid character "${c}"`)
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j] * 58
      bytes[j] = carry & 0xff
      carry >>= 8
    }
    while (carry > 0) {
      bytes.push(carry & 0xff)
      carry >>= 8
    }
  }
  const out = Buffer.alloc(zeros + bytes.length)
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]
  return out
}

/** base58 (bitcoin alphabet) encode */
export function base58Encode(data: Bytes): string {
  const buf = toBuf(data)
  if (!buf.length) return ''
  let zeros = 0
  while (zeros < buf.length && buf[zeros] === 0) zeros++
  const digits: number[] = []
  for (let i = zeros; i < buf.length; i++) {
    let carry = buf[i]
    for (let j = 0; j < digits.length; j++) {
      carry += digits[j] << 8
      digits[j] = carry % 58
      carry = (carry / 58) | 0
    }
    while (carry > 0) {
      digits.push(carry % 58)
      carry = (carry / 58) | 0
    }
  }
  let out = ''
  for (let i = 0; i < zeros; i++) out += '1'
  for (let i = digits.length - 1; i >= 0; i--) out += BASE58_ALPHABET[digits[i]]
  return out
}

const SS58_PREFIX_BYTES = Buffer.from('SS58PRE', 'utf8')

function ss58Checksum(prefixBytes: Buffer, pubkey: Buffer): Buffer {
  return blake2b(concat([SS58_PREFIX_BYTES, prefixBytes, pubkey]), 64).subarray(0, 2)
}

function ss58PrefixBytes(prefix: number): Buffer {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 16383) throw new Error(`ss58: invalid network prefix ${prefix}`)
  if (prefix < 64) return Buffer.from([prefix])
  // 14 bit prefix over two bytes: 01LLLLLL HHHHHHLL (L = low 8 bits, H = high 6 bits)
  return Buffer.from([((prefix & 0xfc) >> 2) | 0x40, (prefix >> 8) | ((prefix & 0x03) << 6)])
}

/** ss58 address -> { prefix, pubkey } (checksum verified) */
export function ss58DecodeFull(address: string): { prefix: number, pubkey: Buffer } {
  const bytes = base58Decode(address)
  if (bytes.length < 3) throw new Error(`ss58Decode: address too short "${address}"`)
  let prefixLen: number
  let prefix: number
  if (bytes[0] < 64) {
    prefixLen = 1
    prefix = bytes[0]
  } else if (bytes[0] < 128) {
    prefixLen = 2
    const lower = ((bytes[0] & 0x3f) << 2) | (bytes[1] >> 6)
    const upper = bytes[1] & 0x3f
    prefix = lower | (upper << 8)
  } else {
    throw new Error(`ss58Decode: reserved address format "${address}"`)
  }
  const pubkey = bytes.subarray(prefixLen, bytes.length - 2)
  const checksum = bytes.subarray(bytes.length - 2)
  const expected = ss58Checksum(bytes.subarray(0, prefixLen), pubkey)
  if (!checksum.equals(expected)) throw new Error(`ss58Decode: bad checksum for "${address}"`)
  return { prefix, pubkey: Buffer.from(pubkey) }
}

/**
 * ss58 address -> 32 byte account id. A Buffer / Uint8Array / `0x` hex account id is
 * returned as-is so callers can accept both address formats.
 */
export function ss58Decode(address: string | Uint8Array): Buffer {
  if (Buffer.isBuffer(address) || address instanceof Uint8Array) return toBuf(address)
  if (typeof address === 'string' && /^0x[0-9a-fA-F]{64}$/.test(address)) return toBuf(address)
  return ss58DecodeFull(address).pubkey
}

/** account id (32 bytes) -> ss58 address with `prefix` (0 = polkadot, 2 = kusama, 42 = generic) */
export function ss58Encode(pubkey: Bytes, prefix = 0): string {
  const key = toBuf(pubkey)
  if (![32, 33, 1, 2, 4, 8].includes(key.length)) throw new Error(`ss58Encode: unexpected public key length ${key.length}`)
  const prefixBytes = ss58PrefixBytes(prefix)
  return base58Encode(concat([prefixBytes, key, ss58Checksum(prefixBytes, key)]))
}

// ---------------------------------------------------------------------------
// SCALE
// ---------------------------------------------------------------------------

export const encodeU8 = (n: number): Buffer => Buffer.from([n & 0xff])
export const encodeU16 = (n: number): Buffer => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b }
export const encodeU32 = (n: number): Buffer => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b }
export const encodeU64 = (n: bigint | number | string): Buffer => u64le(BigInt(n))
export const encodeU128 = (n: bigint | number | string): Buffer => encodeUint(n, 16)

/** little endian unsigned integer of `bytes` bytes */
export function encodeUint(n: bigint | number | string, bytes: number): Buffer {
  let v = BigInt(n)
  if (v < B0) throw new Error(`encodeUint: negative value ${n}`)
  const b = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i++) {
    b[i] = Number(v & BigInt(0xff))
    v >>= BigInt(8)
  }
  if (v !== B0) throw new Error(`encodeUint: ${n} does not fit in ${bytes} bytes`)
  return b
}

/** SCALE Compact<uN> */
export function encodeCompact(value: bigint | number | string): Buffer {
  let n = BigInt(value)
  if (n < B0) throw new Error(`encodeCompact: negative value ${value}`)
  if (n < BigInt(64)) return Buffer.from([Number(n) << 2])
  if (n < BigInt(16384)) return encodeU16((Number(n) << 2) | 1)
  if (n < BigInt(1073741824)) return encodeU32(((Number(n) << 2) | 2) >>> 0)
  const bytes: number[] = []
  while (n > B0) {
    bytes.push(Number(n & BigInt(0xff)))
    n >>= BigInt(8)
  }
  if (bytes.length > 67) throw new Error('encodeCompact: value too large')
  return Buffer.from([((bytes.length - 4) << 2) | 3, ...bytes])
}

/** little endian unsigned integer at `offset`, `bytes` wide (default u128); missing bytes read as 0 */
export function decodeUint(value: Bytes | null | undefined, { offset = 0, bytes = 16 }: { offset?: number, bytes?: number } = {}): bigint {
  if (!value) return B0
  const b = toBuf(value)
  let n = B0
  for (let i = bytes - 1; i >= 0; i--) {
    const byte = b[offset + i]
    n = (n << BigInt(8)) | BigInt(byte === undefined ? 0 : byte)
  }
  return n
}

/** SCALE Compact<uN> at `offset` -> { value, length: bytes consumed } */
export function decodeCompact(value: Bytes, offset = 0): { value: bigint, length: number } {
  const b = toBuf(value)
  if (offset >= b.length) throw new Error('decodeCompact: out of bounds')
  const mode = b[offset] & 0b11
  if (mode === 0) return { value: BigInt(b[offset] >> 2), length: 1 }
  if (mode === 1) return { value: BigInt(b.readUInt16LE(offset) >> 2), length: 2 }
  if (mode === 2) return { value: BigInt(b.readUInt32LE(offset) >>> 2), length: 4 }
  const len = (b[offset] >> 2) + 4
  return { value: decodeUint(b, { offset: offset + 1, bytes: len }), length: len + 1 }
}

/** Sequential SCALE reader for hand decoding structs */
export class ScaleReader {
  buf: Buffer
  offset: number
  constructor(value: Bytes) {
    this.buf = toBuf(value)
    this.offset = 0
  }
  get remaining() { return this.buf.length - this.offset }
  private need(n: number) {
    if (this.offset + n > this.buf.length) throw new Error(`ScaleReader: out of bounds (need ${n} at ${this.offset}, length ${this.buf.length})`)
  }
  /** next `n` raw bytes (view, not a copy) */
  bytes(n: number): Buffer {
    this.need(n)
    const b = this.buf.subarray(this.offset, this.offset + n)
    this.offset += n
    return b
  }
  skip(n: number) { this.need(n); this.offset += n; return this }
  u8(): number { this.need(1); return this.buf[this.offset++] }
  u16(): number { this.need(2); const v = this.buf.readUInt16LE(this.offset); this.offset += 2; return v }
  u32(): number { this.need(4); const v = this.buf.readUInt32LE(this.offset); this.offset += 4; return v }
  u64(): bigint { return decodeUint(this.bytes(8), { bytes: 8 }) }
  u128(): bigint { return decodeUint(this.bytes(16), { bytes: 16 }) }
  u256(): bigint { return decodeUint(this.bytes(32), { bytes: 32 }) }
  i32(): number { this.need(4); const v = this.buf.readInt32LE(this.offset); this.offset += 4; return v }
  i64(): bigint { this.need(8); const v = this.buf.readBigInt64LE(this.offset); this.offset += 8; return v }
  bool(): boolean { return this.u8() === 1 }
  compact(): bigint {
    const { value, length } = decodeCompact(this.buf, this.offset)
    this.offset += length
    return value
  }
  /** Option<T>: `null` when the tag byte is 0 */
  option<T>(fn: (r: ScaleReader) => T): T | null { return this.u8() === 0 ? null : fn(this) }
  /** Vec<T> */
  vec<T>(fn: (r: ScaleReader) => T): T[] {
    const len = Number(this.compact())
    const out: T[] = []
    for (let i = 0; i < len; i++) out.push(fn(this))
    return out
  }
  /** Vec<u8> / BoundedVec<u8> */
  bytesVec(): Buffer { return this.bytes(Number(this.compact())) }
  string(): string { return this.bytesVec().toString('utf8') }
  /** 32 byte AccountId as `0x` hex */
  accountId(): string { return hex(this.bytes(32)) }
  /** H256 as `0x` hex */
  hash(): string { return hex(this.bytes(32)) }
}

// ---------------------------------------------------------------------------
// storage keys
// ---------------------------------------------------------------------------

export interface Hasher {
  encode: (key: Bytes) => Buffer
  /** bytes preceding the raw key in a concat hasher (0 when the key is not recoverable) */
  hashLength: number
  /** true when the raw key follows the hash (Identity / *Concat hashers) */
  concat: boolean
}

export const twox64Concat = (key: Bytes): Buffer => concat([twox64(key), toBuf(key)])
export const blake2_128Concat = (key: Bytes): Buffer => concat([blake2_128(key), toBuf(key)])
export const identity = (key: Bytes): Buffer => toBuf(key)

/** key hashers as used in pallet storage definitions (looked up case-insensitively) */
export const hashers: Record<string, Hasher> = {
  Twox64Concat: { encode: twox64Concat, hashLength: 8, concat: true },
  Blake2_128Concat: { encode: blake2_128Concat, hashLength: 16, concat: true },
  Identity: { encode: identity, hashLength: 0, concat: true },
  Twox128: { encode: twox128, hashLength: 16, concat: false },
  Twox256: { encode: twox256, hashLength: 32, concat: false },
  Blake2_128: { encode: blake2_128, hashLength: 16, concat: false },
  Blake2_256: { encode: blake2_256, hashLength: 32, concat: false },
}
const hashersByName: Record<string, Hasher> = {}
Object.keys(hashers).forEach(name => hashersByName[name.toLowerCase()] = hashers[name])

export const DEFAULT_HASHER = 'Twox64Concat'

export function getHasher(name: string = DEFAULT_HASHER): Hasher {
  const hasher = hashersByName[String(name).toLowerCase()]
  if (!hasher) throw new Error(`substrate: unknown storage hasher "${name}" (known: ${Object.keys(hashers).join(', ')})`)
  return hasher
}

/** twox128(pallet) ++ twox128(item) */
export const storagePrefix = (pallet: string, item: string): Buffer => concat([twox128(pallet), twox128(item)])

export interface StorageKeyParams {
  pallet: string
  item: string
  /** single map key (SCALE encoded bytes / hex); prepended to `keys` */
  key?: Bytes
  /** hasher for `key`, default Twox64Concat */
  hasher?: string
  /** (double / n) map keys in order */
  keys?: { key: Bytes, hasher?: string }[]
}

/** full storage key as `0x` hex */
export function storageKey({ pallet, item, key, hasher = DEFAULT_HASHER, keys = [] }: StorageKeyParams): string {
  const parts: Buffer[] = [storagePrefix(pallet, item)]
  const all = key !== undefined ? [{ hasher, key }, ...keys] : keys
  for (const entry of all) parts.push(getHasher(entry.hasher).encode(entry.key))
  return hex(concat(parts))
}

/** strip the hash part of a concat hasher from an entry's `rest` buffer -> raw SCALE key */
export function stripHasher(rest: Bytes, hasher: string = DEFAULT_HASHER): Buffer {
  return toBuf(rest).subarray(getHasher(hasher).hashLength)
}

// ---------------------------------------------------------------------------
// endpoints / transport
// ---------------------------------------------------------------------------

export function getEndpoints({ chain }: { chain: string }): string[] {
  if (!chain) throw new Error('substrate: chain is required')
  if (chain.includes('://')) return toEndpointList(chain)
  const key = chain.toUpperCase()
  // `<CHAIN>_RPC` is the EVM rpc for chains like astar / acala / moonbeam, only fall back to it for non-EVM chains
  const fallback = isEvmChain(chain) ? undefined : getEnvRPC(chain)
  return resolveEndpoints(chain, DEFAULT_ENDPOINTS[chain], { envKey: `${key}_SUBSTRATE_RPC`, fallback })
}

const chainLabel = (chain: string) => chain.includes('://') ? 'substrate' : chain

/** Raw JSON-RPC call; rotates endpoints, retries transient failures, runs under a per-chain limiter */
export async function rpc({ chain, method, params = [], retries }: ChainOptions & { method: string, params?: any[] }): Promise<any> {
  const endpoints = getEndpoints({ chain })
  const limiter = getLimiter(`SUBSTRATE_${chainLabel(chain).toUpperCase()}`, DEFAULT_CONCURRENCY)
  return limiter(() => jsonRpc(method, params, { chain: chainLabel(chain), endpoints, retries }))
}

// ---------------------------------------------------------------------------
// chain / blocks
// ---------------------------------------------------------------------------

export interface Header {
  number: number
  hash?: string
  parentHash: string
  stateRoot: string
  extrinsicsRoot: string
  digest: any
}

export interface Block {
  number: number
  hash: string
  parentHash: string
  /** unix seconds from the `timestamp.set` inherent (or Timestamp.Now storage); undefined when neither is available */
  timestamp?: number
  /** raw SCALE extrinsics (`0x` hex) */
  extrinsics: string[]
  header: Header
}

export interface RuntimeVersion {
  specName: string
  implName: string
  specVersion: number
  implVersion: number
  transactionVersion: number
  authoringVersion?: number
  apis?: any[]
  [key: string]: any
}

export const getFinalizedHead = ({ chain, retries }: ChainOptions): Promise<string> => rpc({ chain, method: 'chain_getFinalizedHead', retries })

/** block hash of `number` (latest best block when omitted); `null` when unknown */
export async function getBlockHash({ chain, number, retries }: ChainOptions & { number?: number }): Promise<string | null> {
  const params = number === undefined ? [] : [number]
  return rpc({ chain, method: 'chain_getBlockHash', params, retries })
}

function toHeader(raw: any, hash?: string): Header {
  if (!raw) throw new Error('substrate: block/header not found')
  return {
    number: parseInt(raw.number, 16),
    hash,
    parentHash: raw.parentHash,
    stateRoot: raw.stateRoot,
    extrinsicsRoot: raw.extrinsicsRoot,
    digest: raw.digest,
  }
}

/** header at `hash` (finalized head when omitted) */
export async function getHeader({ chain, hash, retries }: ChainOptions & { hash?: string }): Promise<Header> {
  if (!hash) hash = await getFinalizedHead({ chain, retries })
  const raw = await rpc({ chain, method: 'chain_getHeader', params: [hash], retries })
  return toHeader(raw, hash)
}

/** `state_getRuntimeVersion` */
export const getRuntimeVersion = ({ chain, at, retries }: ChainOptions & { at?: string }): Promise<RuntimeVersion> =>
  rpc({ chain, method: 'state_getRuntimeVersion', params: at ? [at] : [], retries })

const MIN_MS = 1e12 // 2001
const MAX_MS = 1e13 // 2286

/**
 * Decode the `timestamp.set` inherent (first bare extrinsic, call index 0, Compact<u64> ms).
 * Returns unix seconds or undefined when the block has no recognisable timestamp inherent.
 */
export function decodeTimestampInherent(extrinsics: string[] | undefined): number | undefined {
  if (!extrinsics?.length) return undefined
  for (const ext of extrinsics.slice(0, 3)) {
    try {
      const r = new ScaleReader(ext)
      r.compact() // length prefix
      const version = r.u8()
      if (version & 0xc0) continue // signed / general extrinsic: not an inherent
      r.u8() // pallet index (chain specific)
      if (r.u8() !== 0) continue // Call::set is index 0 of pallet_timestamp
      const ms = Number(r.compact())
      if (ms >= MIN_MS && ms < MAX_MS) return Math.floor(ms / 1000)
    } catch {
      // not a timestamp inherent
    }
  }
  return undefined
}

/** Timestamp.Now (u64 ms) at `at` -> unix seconds */
export async function getTimestampAt({ chain, at, retries }: ChainOptions & { at?: string }): Promise<number> {
  const value = await getStorage({ chain, pallet: 'Timestamp', item: 'Now', at, retries })
  if (!value) throw new Error(`substrate ${chainLabel(chain)}: Timestamp.Now not found at ${at ?? 'head'}`)
  return Math.floor(Number(decodeUint(value, { bytes: 8 })) / 1000)
}

/** block by `hash` or `number` (finalized head when neither is given), with its timestamp */
export async function getBlock({ chain, hash, number, retries }: ChainOptions & { hash?: string, number?: number }): Promise<Block> {
  if (!hash) {
    if (number !== undefined) {
      const h = await getBlockHash({ chain, number, retries })
      if (!h) throw new Error(`substrate ${chainLabel(chain)}: block ${number} not found`)
      hash = h
    } else hash = await getFinalizedHead({ chain, retries })
  }
  const raw = await rpc({ chain, method: 'chain_getBlock', params: [hash], retries })
  if (!raw?.block) throw new Error(`substrate ${chainLabel(chain)}: block ${hash} not found`)
  const header = toHeader(raw.block.header, hash)
  const extrinsics: string[] = raw.block.extrinsics ?? []
  let timestamp = decodeTimestampInherent(extrinsics)
  if (timestamp === undefined) {
    try {
      timestamp = await getTimestampAt({ chain, at: hash, retries })
    } catch (e: any) {
      debugLog(`[chains.substrate] ${chainLabel(chain)}: no timestamp for block ${header.number}: ${e?.message ?? e}`)
    }
  }
  return { number: header.number, hash, parentHash: header.parentHash, timestamp, extrinsics, header }
}

export const getLatestBlock = (options: ChainOptions): Promise<Block> => getBlock(options)

/**
 * Last block whose timestamp is <= `timestamp` (unix seconds, ms accepted). Brackets the
 * range assuming ~6s blocks then binary searches on Timestamp.Now at each block hash
 * (falls back to the timestamp inherent on nodes with pruned state).
 */
export async function getBlockAtTimestamp({ chain, timestamp, retries }: ChainOptions & { timestamp: number }): Promise<Block> {
  if (!timestamp || !Number.isFinite(timestamp)) throw new Error('substrate getBlockAtTimestamp: invalid timestamp')
  if (timestamp > 1e12) timestamp = Math.floor(timestamp / 1000)
  const latest = await getBlock({ chain, retries })
  if (latest.timestamp === undefined) throw new Error(`substrate ${chainLabel(chain)}: cannot read block timestamps`)
  if (latest.timestamp <= timestamp) return latest

  const hashCache = new Map<number, string>()
  const tsCache = new Map<number, number>()
  tsCache.set(latest.number, latest.timestamp)
  const hashAt = async (n: number) => {
    let h = hashCache.get(n)
    if (!h) {
      const res = await getBlockHash({ chain, number: n, retries })
      if (!res) throw new Error(`substrate ${chainLabel(chain)}: block ${n} not found`)
      hashCache.set(n, res)
      h = res
    }
    return h
  }
  const tsAt = async (n: number): Promise<number> => {
    const cached = tsCache.get(n)
    if (cached !== undefined) return cached
    const h = await hashAt(n)
    let ts: number
    try {
      ts = await getTimestampAt({ chain, at: h, retries })
    } catch (e: any) {
      debugLog(`[chains.substrate] ${chainLabel(chain)}: Timestamp.Now at #${n} failed (${e?.message ?? e}), reading block inherent`)
      const block = await getBlock({ chain, hash: h, retries })
      if (block.timestamp === undefined) throw new Error(`substrate ${chainLabel(chain)}: no timestamp for block ${n}`)
      ts = block.timestamp
    }
    tsCache.set(n, ts)
    return ts
  }

  // bracket: estimated distance in blocks +- 5%, widened until lo <= target < hi
  const estimate = Math.ceil((latest.timestamp - timestamp) / BLOCK_TIME)
  let margin = Math.max(50, Math.ceil(estimate * 0.05))
  let lo = Math.max(0, latest.number - estimate - margin)
  let hi = Math.min(latest.number, latest.number - estimate + margin)
  while ((await tsAt(lo)) > timestamp) {
    if (lo === 0) throw new Error(`substrate ${chainLabel(chain)}: timestamp ${timestamp} predates the chain`)
    margin *= 2
    lo = Math.max(0, lo - margin)
  }
  while (hi < latest.number && (await tsAt(hi)) <= timestamp) {
    margin *= 2
    hi = Math.min(latest.number, hi + margin)
  }
  // invariant: ts(lo) <= target, ts(hi) > target (or hi is latest which is > target)
  while (hi - lo > 1) {
    const mid = lo + Math.floor((hi - lo) / 2)
    if ((await tsAt(mid)) <= timestamp) lo = mid
    else hi = mid
  }
  const block = await getBlock({ chain, hash: await hashAt(lo), retries })
  debugLog(`[chains.substrate] ${chainLabel(chain)} getBlockAtTimestamp(${timestamp}) -> #${block.number} @ ${block.timestamp}`)
  return block
}

// ---------------------------------------------------------------------------
// storage
// ---------------------------------------------------------------------------

export interface StorageOptions extends ChainOptions {
  /** block hash; latest when omitted */
  at?: string
}

/** `state_getStorage` for a raw storage key -> `0x` hex value or null */
export async function getStorageRaw({ chain, key, at, retries }: StorageOptions & { key: Bytes }): Promise<string | null> {
  const res = await rpc({ chain, method: 'state_getStorage', params: [hex(key), at ?? null], retries })
  return res ?? null
}

/** plain item or a single (double) map entry -> raw `0x` hex value or null */
export async function getStorage({ chain, pallet, item, key, hasher, keys, at, retries }: StorageOptions & StorageKeyParams): Promise<string | null> {
  return getStorageRaw({ chain, key: storageKey({ pallet, item, key, hasher, keys }), at, retries })
}

/** `state_queryStorageAt` for many keys -> values in key order (null when unset) */
export async function getStorageBatch({ chain, storageKeys, at, chunkSize = DEFAULT_BATCH_CHUNK, retries }: StorageOptions & { storageKeys: string[], chunkSize?: number }): Promise<(string | null)[]> {
  if (!storageKeys.length) return []
  const out: (string | null)[] = []
  for (const chunk of sliceIntoChunks(storageKeys, chunkSize)) {
    const res = await rpc({ chain, method: 'state_queryStorageAt', params: [chunk, at ?? null], retries })
    const byKey: Record<string, string | null> = {}
    for (const changeSet of res ?? [])
      for (const [k, v] of changeSet.changes ?? []) byKey[String(k).toLowerCase()] = v ?? null
    for (const k of chunk) out.push(byKey[k.toLowerCase()] ?? null)
  }
  return out
}

/** one page of `state_getKeysPaged` */
export async function getKeysPaged({ chain, prefix, pageSize = DEFAULT_PAGE_SIZE, startKey, at, retries }: StorageOptions & { prefix: Bytes, pageSize?: number, startKey?: string | null }): Promise<string[]> {
  const res = await rpc({ chain, method: 'state_getKeysPaged', params: [hex(prefix), pageSize, startKey ?? null, at ?? null], retries })
  return res ?? []
}

/** every storage key under `prefix` (paginates `state_getKeysPaged`) */
export async function getAllKeys({ chain, prefix, pageSize = DEFAULT_PAGE_SIZE, at, retries }: StorageOptions & { prefix: Bytes, pageSize?: number }): Promise<string[]> {
  const allKeys: string[] = []
  let startKey: string | null = null
  while (true) {
    const page = await getKeysPaged({ chain, prefix, pageSize, startKey, at, retries })
    allKeys.push(...page)
    if (page.length < pageSize) break
    startKey = page[page.length - 1]
  }
  return allKeys
}

export interface StorageEntry {
  /** full storage key (`0x` hex) */
  key: string
  /** raw value (`0x` hex) or null */
  value: string | null
  /** key bytes after the pallet/item prefix and the given partial keys (hash ++ raw key for concat hashers) */
  rest: Buffer
}

/**
 * Every entry of a map (optionally under partial `keys` for double maps) -> [{ key, value, rest }].
 * Use `stripHasher(entry.rest, hasher)` to recover the raw SCALE key of concat hashers.
 */
export async function getStorageEntries({ chain, pallet, item, keys = [], pageSize = DEFAULT_PAGE_SIZE, at, retries }: StorageOptions & { pallet: string, item: string, keys?: { key: Bytes, hasher?: string }[], pageSize?: number }): Promise<StorageEntry[]> {
  const prefix = storageKey({ pallet, item, keys })
  const allKeys = await getAllKeys({ chain, prefix, pageSize, at, retries })
  if (!allKeys.length) return []
  const values = await getStorageBatch({ chain, storageKeys: allKeys, at, retries })
  return allKeys.map((key, i) => ({ key, value: values[i], rest: Buffer.from(key.slice(prefix.length), 'hex') }))
}

/** runtime api call (`state_call`), e.g. `stateCall({ chain, method: 'CurrenciesApi_account', data })` -> `0x` hex */
export async function stateCall({ chain, method, data, at, retries }: StorageOptions & { method: string, data: Bytes }): Promise<string> {
  return rpc({ chain, method: 'state_call', params: [method, hex(data), at ?? null], retries })
}

// ---------------------------------------------------------------------------
// common pallets
// ---------------------------------------------------------------------------

export interface AccountInfo {
  nonce: number
  consumers: number
  providers: number
  sufficients: number
  /** balances as decimal bigint strings */
  free: string
  reserved: string
  /** `frozen` (new AccountData) / `miscFrozen` (legacy AccountData) */
  frozen: string
  miscFrozen: string
  /** 4th balance field: `flags` on new runtimes, `feeFrozen` on legacy ones */
  feeFrozen: string
  flags: string
}

/**
 * frame_system AccountInfo: nonce u32, consumers u32, providers u32, sufficients u32,
 * data { free, reserved, frozen|miscFrozen, flags|feeFrozen }. Balances are u128 on most
 * chains; `balanceBytes: 8` for u64 balance chains (e.g. bittensor), auto-detected from
 * the value length when omitted.
 */
export function decodeAccountInfo(value: Bytes | null | undefined, { balanceBytes }: { balanceBytes?: number } = {}): AccountInfo {
  const zero = { nonce: 0, consumers: 0, providers: 0, sufficients: 0, free: '0', reserved: '0', frozen: '0', miscFrozen: '0', feeFrozen: '0', flags: '0' }
  if (!value) return zero
  const buf = toBuf(value)
  if (!buf.length) return zero
  if (!balanceBytes) balanceBytes = buf.length === 16 + 4 * 8 ? 8 : 16
  const r = new ScaleReader(buf)
  const nonce = r.u32()
  const consumers = r.u32()
  const providers = r.u32()
  const sufficients = r.u32()
  const balance = () => r.remaining >= balanceBytes! ? decodeUint(r.bytes(balanceBytes!), { bytes: balanceBytes }).toString() : '0'
  const free = balance()
  const reserved = balance()
  const frozen = balance()
  const flags = balance()
  return { nonce, consumers, providers, sufficients, free, reserved, frozen, miscFrozen: frozen, feeFrozen: flags, flags }
}

/** System.Account of an ss58 address (or raw 32 byte account id) */
export async function getSystemAccount({ chain, address, at, balanceBytes, retries }: StorageOptions & { address: string | Uint8Array, balanceBytes?: number }): Promise<AccountInfo> {
  const value = await getStorage({ chain, pallet: 'System', item: 'Account', key: ss58Decode(address), hasher: 'Blake2_128Concat', at, retries })
  return decodeAccountInfo(value, { balanceBytes })
}

/** free native balance (raw units, decimal string) */
export async function getFreeBalance({ chain, address, at, balanceBytes, retries }: StorageOptions & { address: string | Uint8Array, balanceBytes?: number }): Promise<string> {
  const { free } = await getSystemAccount({ chain, address, at, balanceBytes, retries })
  return free
}

/** Balances.TotalIssuance (raw units, decimal string) */
export async function getTotalIssuance({ chain, at, pallet = 'Balances', retries }: StorageOptions & { pallet?: string }): Promise<string> {
  const value = await getStorage({ chain, pallet, item: 'TotalIssuance', at, retries })
  if (!value) return '0'
  const buf = toBuf(value)
  return decodeUint(buf, { bytes: buf.length >= 16 ? 16 : 8 }).toString()
}

export interface OrmlAccountData {
  free: string
  reserved: string
  frozen: string
}

/** orml_tokens AccountData: free u128, reserved u128, frozen u128 */
export function decodeOrmlAccountData(value: Bytes | null | undefined): OrmlAccountData {
  if (!value) return { free: '0', reserved: '0', frozen: '0' }
  const r = new ScaleReader(value)
  if (!r.remaining) return { free: '0', reserved: '0', frozen: '0' }
  return { free: r.u128().toString(), reserved: r.u128().toString(), frozen: r.u128().toString() }
}

/** orml Tokens.Accounts(AccountId: Blake2_128Concat, CurrencyId: Twox64Concat); `currencyId` is the SCALE encoded id (hex / bytes) */
export async function getTokensAccount({ chain, address, currencyId, at, pallet = 'Tokens', retries }: StorageOptions & { address: string | Uint8Array, currencyId: Bytes, pallet?: string }): Promise<OrmlAccountData> {
  const value = await getStorage({
    chain, pallet, item: 'Accounts', at, retries,
    keys: [{ hasher: 'Blake2_128Concat', key: ss58Decode(address) }, { hasher: 'Twox64Concat', key: currencyId }],
  })
  return decodeOrmlAccountData(value)
}

// ---------------------------------------------------------------------------
// bifrost CurrencyId (bifrost-primitives)
// ---------------------------------------------------------------------------

export interface BifrostCurrencyId {
  variant: string
  raw: Buffer
  symbol?: string
  id?: number
  /** mirrors polkadot.js toHuman(), e.g. { Token: 'KSM' } or { VToken2: '0' } */
  human?: Record<string, string>
}

const BIFROST_CURRENCY: Record<string, number> = {
  Native: 0, VToken: 1, Token: 2, Stable: 3, VSToken: 4, VSBond: 5, LPToken: 6, ForeignAsset: 7,
  Token2: 8, VToken2: 9, VSToken2: 10, VSBond2: 11, StableLpToken: 12, BLP: 13, Lend: 14,
}
const BIFROST_VARIANT_NAMES: Record<number, string> = {}
Object.keys(BIFROST_CURRENCY).forEach(name => BIFROST_VARIANT_NAMES[BIFROST_CURRENCY[name]] = name)

const BIFROST_TOKEN_SYMBOLS: Record<number, string> = { 0: 'ASG', 1: 'BNC', 2: 'KUSD', 3: 'DOT', 4: 'KSM', 5: 'ETH', 6: 'KAR', 7: 'ZLK', 8: 'PHA', 9: 'RMRK', 10: 'MOVR' }
const BIFROST_TOKEN_IDS: Record<string, number> = {}
Object.keys(BIFROST_TOKEN_SYMBOLS).forEach(id => BIFROST_TOKEN_IDS[BIFROST_TOKEN_SYMBOLS[+id]] = +id)
// TokenId (u8) based variants on bifrost-polkadot
const BIFROST_TOKEN2_SYMBOLS: Record<number, string> = { 0: 'DOT', 1: 'GLMR', 2: 'PARA', 3: 'ASTR', 4: 'FIL', 8: 'MANTA', 15: 'ETH' }

function bifrostEncode(variant: string, payload: number): Buffer {
  const index = BIFROST_CURRENCY[variant]
  if (index === undefined) throw new Error(`Unknown bifrost CurrencyId variant ${variant}`)
  if (payload === undefined || Number.isNaN(payload)) throw new Error(`bifrost ${variant}: missing payload`)
  return Buffer.from([index, payload])
}

function bifrostTokenId(symbol: string): number {
  const id = BIFROST_TOKEN_IDS[symbol]
  if (id === undefined) throw new Error(`Unknown bifrost token symbol ${symbol}`)
  return id
}

/** reads one CurrencyId from a ScaleReader */
function bifrostReadCurrencyId(r: ScaleReader): BifrostCurrencyId {
  const start = r.offset
  const variant = BIFROST_VARIANT_NAMES[r.u8()]
  let out: BifrostCurrencyId = { variant, raw: Buffer.alloc(0) }
  switch (variant) {
    case 'Native': case 'VToken': case 'Token': case 'Stable': case 'VSToken': {
      const id = r.u8()
      const symbol = BIFROST_TOKEN_SYMBOLS[id]
      out = { variant, raw: out.raw, id, symbol, human: { [variant]: symbol ?? String(id) } }
      break
    }
    case 'Token2': case 'VToken2': case 'VSToken2': {
      const id = r.u8()
      out = { variant, raw: out.raw, id, symbol: BIFROST_TOKEN2_SYMBOLS[id], human: { [variant]: String(id) } }
      break
    }
    case 'VSBond': r.u8(); r.u32(); r.u32(); r.u32(); break   // (TokenSymbol, ParaId, LeasePeriod, LeasePeriod)
    case 'VSBond2': r.u8(); r.u32(); r.u32(); r.u32(); break  // (TokenId, ParaId, LeasePeriod, LeasePeriod)
    case 'LPToken': r.u8(); r.u8(); r.u8(); r.u8(); break     // (TokenSymbol, u8, TokenSymbol, u8)
    case 'ForeignAsset': case 'StableLpToken': case 'BLP': {
      const id = r.u32()
      out = { variant, raw: out.raw, id, human: { [variant]: String(id) } }
      break
    }
    case 'Lend': {
      const id = r.u8()
      out = { variant, raw: out.raw, id, human: { [variant]: String(id) } }
      break
    }
    default: throw new Error(`Unknown bifrost CurrencyId variant ${variant}`)
  }
  out.raw = Buffer.from(r.buf.subarray(start, r.offset))
  return out
}

/** Bifrost CurrencyId SCALE codec (bifrost-primitives) */
export const bifrost = {
  CURRENCY: BIFROST_CURRENCY,
  VARIANT_NAMES: BIFROST_VARIANT_NAMES,
  TOKEN_SYMBOLS: BIFROST_TOKEN_SYMBOLS,
  TOKEN_IDS: BIFROST_TOKEN_IDS,
  TOKEN2_SYMBOLS: BIFROST_TOKEN2_SYMBOLS,
  /** `encodeCurrencyId('Token', 'KSM')` / `encodeCurrencyId('VToken2', 0)` -> 2 byte SCALE CurrencyId */
  encodeCurrencyId(variant: string, payload: number | string): Buffer {
    const p = typeof payload === 'string' && Number.isNaN(Number(payload)) ? bifrostTokenId(payload) : Number(payload)
    return bifrostEncode(variant, p)
  },
  // explicit `Buffer` return types: newer @types/node infers `Buffer<ArrayBufferLike>`, which breaks
  // consumers compiling against an older @types/node
  token: (symbol: string): Buffer => bifrostEncode('Token', bifrostTokenId(symbol)),
  vToken: (symbol: string): Buffer => bifrostEncode('VToken', bifrostTokenId(symbol)),
  vsToken: (symbol: string): Buffer => bifrostEncode('VSToken', bifrostTokenId(symbol)),
  native: (symbol: string): Buffer => bifrostEncode('Native', bifrostTokenId(symbol)),
  stable: (symbol: string): Buffer => bifrostEncode('Stable', bifrostTokenId(symbol)),
  token2: (id: number): Buffer => bifrostEncode('Token2', id),
  vToken2: (id: number): Buffer => bifrostEncode('VToken2', id),
  vsToken2: (id: number): Buffer => bifrostEncode('VSToken2', id),
  readCurrencyId: bifrostReadCurrencyId,
  decodeCurrencyId: (value: Bytes): BifrostCurrencyId => bifrostReadCurrencyId(new ScaleReader(value)),
}
