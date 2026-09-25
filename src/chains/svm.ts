/**
 * Solana-VM family client (solana, eclipse, soon, soon_base, soon_bsc, fogo,
 * cookiechain, renec) over raw JSON-RPC. No hard `@solana/web3.js` dependency: base58,
 * SPL token layouts, PDA derivation (with a real ed25519 on-curve check) and the
 * Token-2022 ScaledUiAmount extension are implemented here. When `@solana/web3.js`
 * is installed in the host repo (optional peer dependency) PDA derivation is
 * delegated to it, see `usesWeb3js`.
 *
 * Replaces the RPC / codec parts of:
 *   - DefiLlama-Adapters  projects/helper/solana.js (getConnection, getProvider,
 *     getAssociatedTokenAddress, getTokenSupplies, getTokenAccountBalances,
 *     getMultipleAccounts, getEndpoint, readBigUInt64LE, getStakedSol,
 *     getSolBalanceFromStakePool, runInChunks, i80f48ToNumber)
 *   - DefiLlama-Adapters  projects/helper/svmChainConfig.js (chain -> env key map)
 *   - DefiLlama-Adapters  projects/helper/env.js (SVM `<CHAIN>_RPC` defaults)
 *   - DefiLlama-Adapters  projects/helper/utils/solana/layout.js (mint / tokenAccount decoders)
 *   - defillama-server    coins/src/adapters/solana/utils.ts (getTokenSupplies,
 *     getTokenAccountBalances, getMultipleAccounts, getMultipleAccountBuffers)
 *   - defillama-server    defi/l2/utils.ts (readScaledUiMultiplier, getSolanaTokenSupply)
 *   - peggedassets-server src/adapters/peggedAssets/helper/solana.js (getTokenSupply, getTokenBalance)
 *   - dimension-adapters  helpers/solana.ts (getTokenSupply, getTokenBalance)
 *   - dimension-adapters  fees/marginfi/index.ts (readI80F48, getProgramAccounts with retry)
 *   - dimension-adapters  fees/exponent/index.ts (extractPubkey)
 *   - dimension-adapters  fees/neutral-trade/index.ts (b58decode, b58encode, derivePDA)
 *   - dimension-adapters  fees/solstice-usx/index.ts (getSignaturesForAddress)
 *   - dimension-adapters  fees/save-staked-sol/index.ts (getAccountInfo, stake pool lamports)
 *
 * TVL coupling (Balances / ChainApi / coingecko maps / sumTokens) is intentionally
 * left out; every function returns raw chain values.
 *
 * Usage: `sdk.chains.svm.getTokenSupply({ chain: 'solana', token })`
 */
import { createHash } from "crypto";
import { getEnvValue } from "../util/env";
import { debugLog } from "../util/debugLog";
import { getEndpoints as resolveEndpoints, getLimiter, jsonRpc, runInChunks, } from "./rpc";

// ---------------------------------------------------------------------------
// config
// ---------------------------------------------------------------------------

/** Built-in endpoints, overridable with `<CHAIN>_RPC` (also `SDK_` / `LLAMA_SDK_` prefixed). */
export const DEFAULT_ENDPOINTS: Record<string, string> = {
  solana: "https://api.mainnet-beta.solana.com",
  soon: "https://rpc.mainnet.soo.network/rpc",
  soon_base: "https://rpc.soonbase.soo.network/rpc",
  soon_bsc: "https://rpc.svmbnbmainnet.soo.network/rpc",
  eclipse: "https://mainnetbeta-rpc.eclipse.xyz",
  renec: "https://api-mainnet-beta.renec.foundation:8899/",
  fogo: "https://mainnet.fogo.io",
  cookiechain: "https://rpc.cookiescan.io",
}

export const svmChains: string[] = Object.keys(DEFAULT_ENDPOINTS)
const svmChainSet = new Set(svmChains)

export function isSvmChain(chain: string): boolean {
  return svmChainSet.has(chain)
}

export interface ChainOptions {
  /** chain key, default 'solana' */
  chain?: string
}

export interface EndpointOptions extends ChainOptions {
  /** solana only: prefer `SOLANA_RPC_CLIENT` when set (mirrors adapters' getConnection) */
  isClient?: boolean
}

/**
 * Endpoint list for a chain: `<CHAIN>_RPC` env wins, then `DEFAULT_ENDPOINTS`.
 * For solana with `isClient`, `SOLANA_RPC_CLIENT` is checked first.
 */
export function getEndpoints({ chain = 'solana', isClient = false }: EndpointOptions = {}): string[] {
  if (isClient && chain === 'solana') {
    const client = getEnvValue('SOLANA_RPC_CLIENT')
    if (client) return client.split(',').map(i => i.trim()).filter(Boolean)
  }
  return resolveEndpoints(chain, DEFAULT_ENDPOINTS[chain])
}

export function getEndpoint(options: EndpointOptions = {}): string {
  return getEndpoints(options)[0]
}

// ---------------------------------------------------------------------------
// constants
// ---------------------------------------------------------------------------

export const TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA'
export const TOKEN_2022_PROGRAM_ID = 'TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb'
export const ASSOCIATED_TOKEN_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'
export const STAKE_PROGRAM_ID = 'Stake11111111111111111111111111111111111111'
export const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111'
export const SYSVAR_RENT_ID = 'SysvarRent111111111111111111111111111111111'

export const MINT_ACCOUNT_SIZE = 82
export const TOKEN_ACCOUNT_SIZE = 165
export const LAMPORTS_PER_SOL = 1_000_000_000

// ---------------------------------------------------------------------------
// base58
// ---------------------------------------------------------------------------

const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
const B58_MAP: Record<string, number> = {}
for (let i = 0; i < B58_ALPHABET.length; i++) B58_MAP[B58_ALPHABET[i]] = i

/** Bitcoin-style base58 (leading zero bytes become leading '1's). */
export function base58Encode(bytes: Uint8Array | Buffer): string {
  if (!bytes.length) return ''
  let zeros = 0
  while (zeros < bytes.length && bytes[zeros] === 0) zeros++
  // upper bound on output length: log(256)/log(58) ~ 1.37
  const size = Math.ceil(((bytes.length - zeros) * 138) / 100) + 1
  const digits = new Uint8Array(size)
  let length = 0
  for (let i = zeros; i < bytes.length; i++) {
    let carry = bytes[i]
    let j = 0
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 256 * digits[k]
      digits[k] = carry % 58
      carry = Math.floor(carry / 58)
    }
    length = j
  }
  let start = size - length
  while (start < size && digits[start] === 0) start++
  let out = '1'.repeat(zeros)
  for (let i = start; i < size; i++) out += B58_ALPHABET[digits[i]]
  return out
}

export function base58Decode(str: string): Uint8Array {
  if (typeof str !== 'string') throw new Error('base58Decode: expected string')
  if (!str.length) return new Uint8Array(0)
  let zeros = 0
  while (zeros < str.length && str[zeros] === '1') zeros++
  const size = Math.ceil(((str.length - zeros) * 733) / 1000) + 1 // log(58)/log(256) ~ 0.733
  const bytes = new Uint8Array(size)
  let length = 0
  for (let i = zeros; i < str.length; i++) {
    let carry = B58_MAP[str[i]]
    if (carry === undefined) throw new Error(`base58Decode: invalid character "${str[i]}"`)
    let j = 0
    for (let k = size - 1; (carry !== 0 || j < length) && k >= 0; k--, j++) {
      carry += 58 * bytes[k]
      bytes[k] = carry & 0xff
      carry >>= 8
    }
    length = j
  }
  let start = size - length
  while (start < size && bytes[start] === 0) start++
  const out = new Uint8Array(zeros + (size - start))
  out.set(bytes.subarray(start), zeros)
  return out
}

export function isValidPublicKey(str: any): boolean {
  if (typeof str !== 'string' || str.length < 32 || str.length > 44) return false
  try {
    return base58Decode(str).length === 32
  } catch {
    return false
  }
}

function toPubkeyBytes(key: string | Uint8Array | Buffer, label = 'public key'): Buffer {
  const bytes = typeof key === 'string' ? base58Decode(key) : key
  if (bytes.length !== 32) throw new Error(`Invalid ${label}: ${typeof key === 'string' ? key : `${bytes.length} bytes`}`)
  return Buffer.from(bytes)
}

// ---------------------------------------------------------------------------
// numeric codecs
// ---------------------------------------------------------------------------

/** Little-endian u64 -> bigint, works on any Uint8Array (not only Buffer). */
export function readBigUInt64LE(buffer: Uint8Array, offset = 0): bigint {
  const first = buffer[offset]
  const last = buffer[offset + 7]
  if (first === undefined || last === undefined) throw new Error(`readBigUInt64LE: out of range (offset ${offset}, length ${buffer.length})`)
  const lo = first + buffer[offset + 1] * 2 ** 8 + buffer[offset + 2] * 2 ** 16 + buffer[offset + 3] * 2 ** 24
  const hi = buffer[offset + 4] + buffer[offset + 5] * 2 ** 8 + buffer[offset + 6] * 2 ** 16 + last * 2 ** 24
  return BigInt(lo) + (BigInt(hi) << BigInt(32))
}

function readU32LE(buffer: Uint8Array, offset: number): number {
  return (buffer[offset] + buffer[offset + 1] * 2 ** 8 + buffer[offset + 2] * 2 ** 16 + buffer[offset + 3] * 2 ** 24) >>> 0
}

const TWO_POW_48 = BigInt(2) ** BigInt(48)
const TWO_POW_127 = BigInt(2) ** BigInt(127)
const TWO_POW_128 = BigInt(2) ** BigInt(128)
const MASK_48 = TWO_POW_48 - BigInt(1)

/**
 * Fixed point I80F48 (signed i128, 48 fractional bits) -> number.
 * Accepts a bigint / decimal string, `{ val }` / `{ value }` wrappers (anchor BN
 * style) or the 16 little-endian bytes of the raw i128.
 */
export function i80f48ToNumber(i80f48: { val?: bigint | string | number[] | Uint8Array, value?: any } | bigint | string | number[] | Uint8Array): number {
  let raw: any = i80f48
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && !(raw instanceof Uint8Array)) raw = raw.val ?? raw.value
  let value: bigint
  if (Array.isArray(raw) || raw instanceof Uint8Array) {
    if (raw.length !== 16) throw new Error(`i80f48ToNumber: expected 16 bytes, got ${raw.length}`)
    value = BigInt(0)
    for (let i = 15; i >= 0; i--) value = (value << BigInt(8)) + BigInt(raw[i])
    if (value >= TWO_POW_127) value -= TWO_POW_128
  } else if (typeof raw === 'bigint') {
    value = raw
  } else if (typeof raw === 'string' || typeof raw === 'number') {
    value = BigInt(raw)
  } else if (raw && typeof raw.toString === 'function') {
    value = BigInt(raw.toString())
  } else {
    throw new Error('i80f48ToNumber: unsupported input')
  }
  const integerPart = value >> BigInt(48)
  const fractionalPart = value & MASK_48
  return Number(integerPart) + Number(fractionalPart) / Number(TWO_POW_48)
}

/** Little-endian I80F48 at `offset` (marginfi WrappedI80F48). */
export function readI80F48(buf: Buffer, offset: number): number {
  return i80f48ToNumber(buf.subarray(offset, offset + 16))
}

// ---------------------------------------------------------------------------
// SPL token layouts
// ---------------------------------------------------------------------------

export interface MintAccount {
  mintAuthority: string | null
  supply: string
  decimals: number
  isInitialized: boolean
  freezeAuthority: string | null
}

export interface TokenAccount {
  mint: string
  owner: string
  amount: string
  delegate: string | null
  /** 0 uninitialized, 1 initialized, 2 frozen */
  state: number
  isNative: string | null
  delegatedAmount: string
  closeAuthority: string | null
}

/** Decode an SPL / Token-2022 mint account (first 82 bytes; extensions are ignored). */
export function decodeMintAccount(buf: Buffer | Uint8Array): MintAccount {
  if (!buf || buf.length < MINT_ACCOUNT_SIZE) throw new Error(`decodeMintAccount: need ${MINT_ACCOUNT_SIZE} bytes, got ${buf?.length ?? 0}`)
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return {
    mintAuthority: readU32LE(b, 0) ? base58Encode(b.subarray(4, 36)) : null,
    supply: readBigUInt64LE(b, 36).toString(),
    decimals: b[44],
    isInitialized: b[45] !== 0,
    freezeAuthority: readU32LE(b, 46) ? base58Encode(b.subarray(50, 82)) : null,
  }
}

/** Decode an SPL / Token-2022 token account (first 165 bytes; extensions are ignored). */
export function decodeTokenAccount(buf: Buffer | Uint8Array): TokenAccount {
  if (!buf || buf.length < TOKEN_ACCOUNT_SIZE) throw new Error(`decodeTokenAccount: need ${TOKEN_ACCOUNT_SIZE} bytes, got ${buf?.length ?? 0}`)
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf)
  return {
    mint: base58Encode(b.subarray(0, 32)),
    owner: base58Encode(b.subarray(32, 64)),
    amount: readBigUInt64LE(b, 64).toString(),
    delegate: readU32LE(b, 72) ? base58Encode(b.subarray(76, 108)) : null,
    state: b[108],
    isNative: readU32LE(b, 109) ? readBigUInt64LE(b, 113).toString() : null,
    delegatedAmount: readBigUInt64LE(b, 121).toString(),
    closeAuthority: readU32LE(b, 129) ? base58Encode(b.subarray(133, 165)) : null,
  }
}

// Token-2022 ExtensionType::ScaledUiAmountConfig (=25): displayed balance = raw x multiplier.
// A mint is padded to the 165-byte Account length; account_type sits at 165 and the TLV
// extension list begins at 166.
const T22_TLV_START = 166
const EXT_SCALED_UI_AMOUNT = 25

/**
 * Currently-effective UI multiplier of a Token-2022 mint with the ScaledUiAmount
 * extension, or 1 for a classic SPL mint / a mint without this extension.
 */
export function readScaledUiMultiplier(data: Buffer, nowSeconds: number = Math.floor(Date.now() / 1000)): number {
  if (!data || data.length <= TOKEN_ACCOUNT_SIZE) return 1
  let off = T22_TLV_START
  while (off + 4 <= data.length) {
    const extType = data.readUInt16LE(off)
    const len = data.readUInt16LE(off + 2)
    const dataStart = off + 4
    if (extType === EXT_SCALED_UI_AMOUNT && dataStart + 56 <= data.length) {
      // authority(32) multiplier:f64(8) newMultiplierEffectiveTimestamp:i64(8) newMultiplier:f64(8)
      const p = dataStart + 32
      const multiplier = data.readDoubleLE(p)
      const effectiveTs = Number(data.readBigInt64LE(p + 8))
      const newMultiplier = data.readDoubleLE(p + 16)
      const m = nowSeconds >= effectiveTs ? newMultiplier : multiplier
      return Number.isFinite(m) && m > 0 ? m : 1 // never zero/NaN out a real supply
    }
    if (extType === 0 && len === 0) break // uninitialized padding
    off = dataStart + len
  }
  return 1
}

/** SPL stake pool: `total_lamports` u64 at offset 258, `pool_token_supply` u64 at 266. */
export function decodeStakePool(buf: Buffer): { totalLamports: string, poolTokenSupply: string } {
  if (!buf || buf.length < 274) throw new Error(`decodeStakePool: need 274 bytes, got ${buf?.length ?? 0}`)
  return {
    totalLamports: readBigUInt64LE(buf, 258).toString(),
    poolTokenSupply: readBigUInt64LE(buf, 266).toString(),
  }
}

/** Read the 32-byte pubkey at `offset` of a base64 encoded account payload. */
export function extractPubkey(base64Data: string, offset: number): string {
  const buffer = Buffer.from(base64Data, 'base64')
  if (buffer.length < offset + 32) throw new Error(`extractPubkey: offset ${offset} out of range (length ${buffer.length})`)
  return base58Encode(buffer.subarray(offset, offset + 32))
}

// ---------------------------------------------------------------------------
// ed25519 / PDA derivation
// ---------------------------------------------------------------------------

const P = (BigInt(1) << BigInt(255)) - BigInt(19)
const ONE = BigInt(1)
const ZERO = BigInt(0)

function mod(a: bigint, m: bigint = P): bigint {
  const r = a % m
  return r < ZERO ? r + m : r
}

function modPow(base: bigint, exp: bigint, m: bigint = P): bigint {
  let result = ONE
  base = mod(base, m)
  while (exp > ZERO) {
    if (exp & ONE) result = (result * base) % m
    base = (base * base) % m
    exp >>= ONE
  }
  return result
}

function modInv(a: bigint, m: bigint = P): bigint {
  // p is prime: a^(p-2)
  return modPow(a, m - BigInt(2), m)
}

// d = -121665 / 121666 mod p
const ED25519_D = mod(-BigInt(121665) * modInv(BigInt(121666)))
const LEGENDRE_EXP = (P - ONE) / BigInt(2)

/**
 * True when the 32 bytes decompress to a point on the ed25519 curve
 * (curve25519-dalek `CompressedEdwardsY::decompress` semantics). A PDA must be
 * off-curve so it can never have a private key.
 */
export function isOnCurve(pubkey: string | Uint8Array | Buffer): boolean {
  const bytes = toPubkeyBytes(pubkey)
  let y = ZERO
  for (let i = 31; i >= 0; i--) y = (y << BigInt(8)) + BigInt(bytes[i])
  y &= (ONE << BigInt(255)) - ONE // drop the sign bit
  y = mod(y)
  const y2 = (y * y) % P
  const u = mod(y2 - ONE)             // y^2 - 1
  const v = mod(ED25519_D * y2 + ONE) // d*y^2 + 1
  // x^2 = u / v ; sqrt_ratio_i: valid when u == 0, invalid when v == 0 (u != 0),
  // otherwise valid iff u/v is a quadratic residue
  if (u === ZERO) return true
  if (v === ZERO) return false
  const x2 = (u * modInv(v)) % P
  return modPow(x2, LEGENDRE_EXP) === ONE
}

const PDA_MARKER = Buffer.from('ProgramDerivedAddress')
const MAX_SEED_LENGTH = 32
const MAX_SEEDS = 16

/**
 * `@solana/web3.js` is an optional peer dependency: when the host repo has it
 * installed (DefiLlama-Adapters, server/coins) PDA derivation is delegated to
 * `PublicKey.createProgramAddressSync` / `findProgramAddressSync`, and the
 * hand-rolled ed25519 check above is only the fallback for repos without it.
 * Set `SVM_DISABLE_WEB3JS=true` to force the built-in implementation.
 */
let web3js: any | null | undefined
function loadWeb3js(): any | null {
  if (web3js !== undefined) return web3js
  if (getEnvValue('SVM_DISABLE_WEB3JS') === 'true') return (web3js = null)
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    web3js = require('@solana/web3.js')
    if (typeof web3js?.PublicKey?.findProgramAddressSync !== 'function') web3js = null
  } catch {
    web3js = null
  }
  return web3js
}

/** True when PDA derivation is delegated to an installed `@solana/web3.js`. */
export function usesWeb3js(): boolean {
  return !!loadWeb3js()
}

function toSeedBuffer(seed: Buffer | Uint8Array | string): Buffer {
  const buf = typeof seed === 'string' ? Buffer.from(seed, 'utf8') : Buffer.from(seed)
  if (buf.length > MAX_SEED_LENGTH) throw new Error(`Max seed length exceeded (${buf.length} > ${MAX_SEED_LENGTH})`)
  return buf
}

/** sha256(seeds || programId || "ProgramDerivedAddress"); throws when the result is on-curve. */
export function createProgramAddress(seeds: (Buffer | Uint8Array | string)[], programId: string, bump?: number): string {
  if (seeds.length > MAX_SEEDS) throw new Error(`Max seeds exceeded (${seeds.length} > ${MAX_SEEDS})`)
  const web3 = loadWeb3js()
  if (web3) {
    const allSeeds = seeds.map(toSeedBuffer)
    if (bump !== undefined) allSeeds.push(Buffer.from([bump]))
    return web3.PublicKey.createProgramAddressSync(allSeeds, new web3.PublicKey(programId)).toBase58()
  }
  const hash = createHash('sha256')
  for (const seed of seeds) hash.update(toSeedBuffer(seed))
  if (bump !== undefined) {
    if (!Number.isInteger(bump) || bump < 0 || bump > 255) throw new Error(`Invalid bump seed: ${bump}`)
    hash.update(Buffer.from([bump]))
  }
  hash.update(toPubkeyBytes(programId, 'program id'))
  hash.update(PDA_MARKER)
  const digest = hash.digest()
  if (isOnCurve(digest)) throw new Error('Invalid seeds, address must fall off the curve')
  return base58Encode(digest)
}

/** Find the first off-curve address for `seeds`, walking bump 255 -> 0. */
export function findProgramAddress(seeds: (Buffer | Uint8Array | string)[], programId: string): [string, number] {
  const web3 = loadWeb3js()
  if (web3) {
    const [address, bump] = web3.PublicKey.findProgramAddressSync(seeds.map(toSeedBuffer), new web3.PublicKey(programId))
    return [address.toBase58(), bump]
  }
  for (let bump = 255; bump >= 0; bump--) {
    try {
      return [createProgramAddress(seeds, programId, bump), bump]
    } catch (e: any) {
      if (!String(e?.message).includes('off the curve')) throw e
    }
  }
  throw new Error('Unable to find a viable program address nonce')
}

export function getAssociatedTokenAddress({ mint, owner, programId = TOKEN_PROGRAM_ID, associatedTokenProgramId = ASSOCIATED_TOKEN_PROGRAM_ID }: { mint: string, owner: string, programId?: string, associatedTokenProgramId?: string }): string {
  const [address] = findProgramAddress([
    toPubkeyBytes(owner, 'owner'),
    toPubkeyBytes(programId, 'program id'),
    toPubkeyBytes(mint, 'mint'),
  ], associatedTokenProgramId)
  return address
}

// ---------------------------------------------------------------------------
// rpc
// ---------------------------------------------------------------------------

export type Commitment = 'processed' | 'confirmed' | 'finalized'
export type Encoding = 'base64' | 'base58' | 'base64+zstd' | 'jsonParsed'

export interface AccountInfo<T = any> {
  lamports: number
  owner: string
  /** `[payload, encoding]` for binary encodings, an object for `jsonParsed` */
  data: T
  executable: boolean
  rentEpoch: number
  space?: number
}

export interface CallOptions extends ChainOptions {
  method: string
  params?: any[]
  /** appended as `{ commitment }` to the last params object when set */
  commitment?: Commitment
  timeout?: number
  retries?: number
}

const DEFAULT_CONCURRENCY = 10

function limiterFor(chain: string) {
  return getLimiter(chain.toUpperCase(), DEFAULT_CONCURRENCY)
}

/** Raw JSON-RPC call against the chain's endpoints (rate limited per chain, retried). */
export async function call({ chain = 'solana', method, params = [], commitment, timeout, retries }: CallOptions): Promise<any> {
  const endpoints = getEndpoints({ chain, isClient: true })
  if (commitment) params = withCommitment(params, commitment)
  return limiterFor(chain)(() => jsonRpc(method, params, { chain, endpoints, timeout, retries }))
}

function withCommitment(params: any[], commitment: Commitment): any[] {
  const last = params[params.length - 1]
  if (last && typeof last === 'object' && !Array.isArray(last)) return [...params.slice(0, -1), { ...last, commitment }]
  return [...params, { commitment }]
}

export async function getSlot({ chain = 'solana', commitment }: ChainOptions & { commitment?: Commitment } = {}): Promise<number> {
  return call({ chain, method: 'getSlot', params: [], commitment })
}

export async function getBlockTime({ chain = 'solana', slot }: ChainOptions & { slot: number }): Promise<number | null> {
  const res = await call({ chain, method: 'getBlockTime', params: [slot] })
  return res === null || res === undefined ? null : Number(res)
}

export async function getBlockHeight({ chain = 'solana', commitment }: ChainOptions & { commitment?: Commitment } = {}): Promise<number> {
  return call({ chain, method: 'getBlockHeight', params: [], commitment })
}

/** Latest slot and its block time (walks back over skipped slots without a time). */
export async function getLatestBlock({ chain = 'solana', commitment }: ChainOptions & { commitment?: Commitment } = {}): Promise<{ number: number, timestamp: number }> {
  let slot = await getSlot({ chain, commitment })
  for (let i = 0; i < 10; i++) {
    const timestamp = await getBlockTime({ chain, slot }).catch((e) => {
      debugLog(`[chains.svm] ${chain} getBlockTime(${slot}) failed: ${e?.message}`)
      return null
    })
    if (timestamp) return { number: slot, timestamp }
    slot--
  }
  throw new Error(`[chains.svm] ${chain}: unable to resolve block time for the latest slots`)
}

export async function getEpochInfo({ chain = 'solana', commitment }: ChainOptions & { commitment?: Commitment } = {}): Promise<{ absoluteSlot: number, blockHeight: number, epoch: number, slotIndex: number, slotsInEpoch: number, transactionCount?: number }> {
  return call({ chain, method: 'getEpochInfo', params: [], commitment })
}

/** Lamport balance of a single account. */
export async function getBalance({ chain = 'solana', account, commitment }: ChainOptions & { account: string, commitment?: Commitment }): Promise<number> {
  const res = await call({ chain, method: 'getBalance', params: [account], commitment })
  return Number(res?.value ?? 0)
}

/** Lamport balances of many accounts (batched `getMultipleAccounts`, 0 for missing accounts). */
export async function getBalances({ chain = 'solana', accounts, commitment }: ChainOptions & { accounts: string[], commitment?: Commitment }): Promise<number[]> {
  const infos = await getAccounts({ chain, accounts, commitment, dataSlice: { offset: 0, length: 0 } })
  return infos.map(i => i ? Number(i.lamports) : 0)
}

export async function getAccountInfo({ chain = 'solana', account, encoding = 'base64', commitment, dataSlice }: ChainOptions & { account: string, encoding?: Encoding, commitment?: Commitment, dataSlice?: { offset: number, length: number } }): Promise<AccountInfo | null> {
  const config: any = { encoding }
  if (dataSlice) config.dataSlice = dataSlice
  const res = await call({ chain, method: 'getAccountInfo', params: [account, config], commitment })
  return res?.value ?? null
}

/** Base64 payload of one account as a Buffer, or null when it does not exist. */
export async function getAccountBuffer({ chain = 'solana', account, commitment }: ChainOptions & { account: string, commitment?: Commitment }): Promise<Buffer | null> {
  const info = await getAccountInfo({ chain, account, encoding: 'base64', commitment })
  return accountDataToBuffer(info)
}

export interface GetAccountsOptions extends ChainOptions {
  accounts: string[]
  encoding?: Encoding
  commitment?: Commitment
  dataSlice?: { offset: number, length: number }
  /** accounts per `getMultipleAccounts` call, default 99 (public node max is 100) */
  chunkSize?: number
  /** parallel chunks, default 5 */
  concurrency?: number
  /** ms to wait between chunks when `concurrency` is 1 */
  sleepTime?: number
}

/** Batched `getMultipleAccounts`; result is in input order with `null` for missing accounts. */
export async function getAccounts({ chain = 'solana', accounts, encoding = 'base64', commitment, dataSlice, chunkSize = 99, concurrency = 5, sleepTime = 0 }: GetAccountsOptions): Promise<(AccountInfo | null)[]> {
  if (!accounts.length) return []
  const config: any = { encoding }
  if (dataSlice) config.dataSlice = dataSlice
  debugLog(`[chains.svm] ${chain} getAccounts: ${accounts.length} accounts in chunks of ${chunkSize}`)
  return runInChunks(accounts, async (chunk) => {
    const res = await call({ chain, method: 'getMultipleAccounts', params: [chunk, config], commitment })
    const value: (AccountInfo | null)[] = res?.value ?? []
    if (value.length !== chunk.length) throw new Error(`[chains.svm] ${chain} getMultipleAccounts returned ${value.length} entries for ${chunk.length} accounts`)
    return value
  }, { chunkSize, concurrency, sleepTime })
}

function accountDataToBuffer(info: AccountInfo | null | undefined): Buffer | null {
  if (!info) return null
  const data = info.data
  if (Array.isArray(data)) return data[1] === 'base58' ? Buffer.from(base58Decode(data[0])) : Buffer.from(data[0], 'base64')
  if (typeof data === 'string') return Buffer.from(data, 'base64')
  return null
}

/** Raw account payloads as Buffers, in input order (`null` for missing accounts). */
export async function getAccountBuffers(options: Omit<GetAccountsOptions, 'encoding'>): Promise<(Buffer | null)[]> {
  const infos = await getAccounts({ ...options, encoding: 'base64' })
  return infos.map(accountDataToBuffer)
}

export interface ProgramAccount<T = any> {
  pubkey: string
  account: AccountInfo<T>
}

export interface GetProgramAccountsOptions extends ChainOptions {
  programId: string
  filters?: ({ memcmp: { offset: number, bytes: string, encoding?: string } } | { dataSize: number })[]
  encoding?: Encoding
  dataSlice?: { offset: number, length: number }
  commitment?: Commitment
  withContext?: boolean
  /** attempts, default 5 (public nodes rate limit this call) */
  retries?: number
  timeout?: number
}

export async function getProgramAccounts(options: GetProgramAccountsOptions & { withContext: true }): Promise<{ context: { slot: number }, value: ProgramAccount[] }>
export async function getProgramAccounts(options: GetProgramAccountsOptions & { withContext?: false }): Promise<ProgramAccount[]>
export async function getProgramAccounts({ chain = 'solana', programId, filters, encoding = 'base64', dataSlice, commitment, withContext, retries = 5, timeout = 120_000 }: GetProgramAccountsOptions): Promise<any> {
  const config: any = { encoding }
  if (filters?.length) config.filters = filters
  if (dataSlice) config.dataSlice = dataSlice
  if (withContext) config.withContext = true
  const res = await call({ chain, method: 'getProgramAccounts', params: [programId, config], commitment, retries, timeout })
  if (withContext) return res
  if (!Array.isArray(res)) throw new Error(`[chains.svm] ${chain} getProgramAccounts(${programId}) returned no array`)
  return res
}

export interface TokenSupply {
  amount: string
  decimals: number
  uiAmount: number
  uiAmountString?: string
}

export async function getTokenSupply({ chain = 'solana', token, commitment }: ChainOptions & { token: string, commitment?: Commitment }): Promise<TokenSupply> {
  const res = await call({ chain, method: 'getTokenSupply', params: [token], commitment })
  const value = res?.value
  if (!value) throw new Error(`[chains.svm] ${chain} getTokenSupply(${token}): empty result`)
  return { amount: String(value.amount), decimals: Number(value.decimals), uiAmount: Number(value.uiAmount ?? value.uiAmountString ?? 0), uiAmountString: value.uiAmountString }
}

function supplyFromMint(mint: MintAccount): TokenSupply {
  const uiAmount = Number(mint.supply) / 10 ** mint.decimals
  return { amount: mint.supply, decimals: mint.decimals, uiAmount, uiAmountString: String(uiAmount) }
}

export interface GetTokenSuppliesOptions extends ChainOptions {
  tokens: string[]
  commitment?: Commitment
  chunkSize?: number
  concurrency?: number
  sleepTime?: number
  /** resolve failed / missing mints to `null` instead of throwing */
  allowError?: boolean
}

/**
 * Supplies for many mints in input order (one batched `getMultipleAccounts` +
 * `decodeMintAccount`, falling back to `getTokenSupply` for mints that fail to decode).
 */
export async function getTokenSupplies(options: GetTokenSuppliesOptions & { allowError: true }): Promise<(TokenSupply | null)[]>
export async function getTokenSupplies(options: GetTokenSuppliesOptions & { allowError?: false }): Promise<TokenSupply[]>
export async function getTokenSupplies({ chain = 'solana', tokens, commitment, chunkSize, concurrency, sleepTime, allowError = false }: GetTokenSuppliesOptions): Promise<any> {
  if (!tokens.length) return []
  const buffers = await getAccountBuffers({ chain, accounts: tokens, commitment, chunkSize, concurrency, sleepTime })
  return Promise.all(buffers.map(async (buf, i) => {
    if (buf) {
      try {
        return supplyFromMint(decodeMintAccount(buf))
      } catch (e: any) {
        debugLog(`[chains.svm] ${chain} mint ${tokens[i]} failed to decode (${e?.message}), falling back to getTokenSupply`)
      }
    } else {
      debugLog(`[chains.svm] ${chain} mint ${tokens[i]}: account not found, falling back to getTokenSupply`)
    }
    try {
      return await getTokenSupply({ chain, token: tokens[i], commitment })
    } catch (e) {
      if (allowError) return null
      throw e
    }
  }))
}

export interface TokenAccountBalance {
  mint: string
  amount: string
  owner: string
  /** only set with `withDecimals` */
  decimals?: number
}

export interface GetTokenAccountBalancesOptions extends ChainOptions {
  tokenAccounts: string[]
  /** return one entry per token account (input order) instead of a `{ [mint]: amount }` sum */
  individual?: boolean
  /** skip missing / undecodable accounts instead of throwing (individual mode: `{ mint: 'error', amount: '0' }` placeholder keeps positions) */
  allowError?: boolean
  /** individual mode: look up the mints once and fill `decimals` (one extra batched call) */
  withDecimals?: boolean
  commitment?: Commitment
  chunkSize?: number
  concurrency?: number
  sleepTime?: number
}

/** Token balances of the given token accounts, aggregated per mint (raw amount strings) or individually. */
export async function getTokenAccountBalances(options: GetTokenAccountBalancesOptions & { individual: true }): Promise<TokenAccountBalance[]>
export async function getTokenAccountBalances(options: GetTokenAccountBalancesOptions & { individual?: false }): Promise<Record<string, string>>
export async function getTokenAccountBalances({ chain = 'solana', tokenAccounts, individual = false, allowError = false, withDecimals = false, commitment, chunkSize, concurrency, sleepTime }: GetTokenAccountBalancesOptions): Promise<any> {
  const buffers = tokenAccounts.length ? await getAccountBuffers({ chain, accounts: tokenAccounts, commitment, chunkSize, concurrency, sleepTime }) : []
  const individualBalances: TokenAccountBalance[] = []
  const balances: Record<string, bigint> = {}
  buffers.forEach((buf, i) => {
    const account = tokenAccounts[i]
    let decoded: TokenAccount
    try {
      if (!buf) throw new Error('account not found')
      decoded = decodeTokenAccount(buf)
    } catch (e: any) {
      debugLog(`[chains.svm] ${chain} token account ${account}: ${e?.message}`)
      if (!allowError) throw new Error(`[chains.svm] ${chain} invalid token account ${account}: ${e?.message}`)
      if (individual) individualBalances.push({ mint: 'error', amount: '0', owner: '' })
      return
    }
    if (individual) individualBalances.push({ mint: decoded.mint, amount: decoded.amount, owner: decoded.owner })
    else balances[decoded.mint] = (balances[decoded.mint] ?? BigInt(0)) + BigInt(decoded.amount)
  })
  if (!individual) {
    const res: Record<string, string> = {}
    for (const mint of Object.keys(balances)) res[mint] = balances[mint].toString()
    return res
  }
  if (withDecimals) {
    const mints = [...new Set(individualBalances.map(i => i.mint).filter(i => i !== 'error'))]
    const supplies = await getTokenSupplies({ chain, tokens: mints, commitment, allowError: true })
    const decimals: Record<string, number> = {}
    mints.forEach((mint, i) => { if (supplies[i]) decimals[mint] = supplies[i]!.decimals })
    individualBalances.forEach(i => { if (decimals[i.mint] !== undefined) i.decimals = decimals[i.mint] })
  }
  return individualBalances
}

export interface ParsedTokenAccount {
  pubkey: string
  mint: string
  owner: string
  amount: string
  decimals: number
  uiAmount: number
  programId: string
  state?: string
}

/**
 * Token accounts of `owner` (jsonParsed). With neither `mint` nor `programId`,
 * both the Token and Token-2022 programs are queried.
 */
export async function getTokenAccountsByOwner({ chain = 'solana', owner, mint, programId, commitment }: ChainOptions & { owner: string, mint?: string, programId?: string, commitment?: Commitment }): Promise<ParsedTokenAccount[]> {
  const filters: any[] = []
  if (mint) filters.push({ mint })
  else if (programId) filters.push({ programId })
  else filters.push({ programId: TOKEN_PROGRAM_ID }, { programId: TOKEN_2022_PROGRAM_ID })
  const results = await Promise.all(filters.map(filter => call({ chain, method: 'getTokenAccountsByOwner', params: [owner, filter, { encoding: 'jsonParsed' }], commitment })))
  const out: ParsedTokenAccount[] = []
  for (const res of results) {
    for (const entry of res?.value ?? []) {
      const info = entry?.account?.data?.parsed?.info
      if (!info) continue
      out.push({
        pubkey: entry.pubkey,
        mint: info.mint,
        owner: info.owner,
        amount: String(info.tokenAmount?.amount ?? '0'),
        decimals: Number(info.tokenAmount?.decimals ?? 0),
        uiAmount: Number(info.tokenAmount?.uiAmount ?? 0),
        programId: entry.account.owner,
        state: info.state,
      })
    }
  }
  return out
}

/** Raw token amount (string) of `mint` held by `owner`, summed over all of the owner's token accounts. */
export async function getTokenBalance({ chain = 'solana', owner, mint, commitment }: ChainOptions & { owner: string, mint: string, commitment?: Commitment }): Promise<string> {
  const accounts = await getTokenAccountsByOwner({ chain, owner, mint, commitment })
  return accounts.reduce((sum, i) => sum + BigInt(i.amount), BigInt(0)).toString()
}

export interface SignatureInfo {
  signature: string
  slot: number
  blockTime: number | null
  err: any
  memo: string | null
  confirmationStatus?: string
}

export async function getSignaturesForAddress({ chain = 'solana', address, before, until, limit = 1000, commitment }: ChainOptions & { address: string, before?: string, until?: string, limit?: number, commitment?: Commitment }): Promise<SignatureInfo[]> {
  const config: any = { limit }
  if (before) config.before = before
  if (until) config.until = until
  const res = await call({ chain, method: 'getSignaturesForAddress', params: [address, config], commitment })
  return Array.isArray(res) ? res : []
}

export async function getTransaction({ chain = 'solana', signature, encoding = 'json', maxSupportedTransactionVersion = 0, commitment }: ChainOptions & { signature: string, encoding?: 'json' | 'jsonParsed' | 'base64' | 'base58', maxSupportedTransactionVersion?: number, commitment?: Commitment }): Promise<any> {
  return call({ chain, method: 'getTransaction', params: [signature, { encoding, maxSupportedTransactionVersion }], commitment })
}

/**
 * Lamports in all stake accounts whose stake authority (default, as in the
 * adapters helper) or withdraw authority is `address`.
 */
export async function getStakedSol({ chain = 'solana', address, authority = 'staker', commitment }: ChainOptions & { address: string, authority?: 'staker' | 'withdrawer', commitment?: Commitment }): Promise<number> {
  // StakeStateV2: u32 enum tag, then Meta { rent_exempt_reserve: u64, authorized: { staker: Pubkey, withdrawer: Pubkey }, .. }
  const offset = authority === 'withdrawer' ? 4 + 8 + 32 : 4 + 8
  const stakeAccounts = await getProgramAccounts({
    chain,
    programId: STAKE_PROGRAM_ID,
    filters: [{ memcmp: { offset, bytes: address } }],
    dataSlice: { offset: 0, length: 1 }, // only lamports are needed
    commitment,
  })
  return stakeAccounts.reduce((total, { account }) => total + Number(account.lamports), 0)
}

/** `total_lamports` of an SPL stake pool account (lamports, as number). */
export async function getSolBalanceFromStakePool({ chain = 'solana', address, commitment }: ChainOptions & { address: string, commitment?: Commitment }): Promise<number> {
  const buf = await getAccountBuffer({ chain, account: address, commitment })
  if (!buf) throw new Error(`[chains.svm] ${chain} stake pool ${address} not found`)
  return Number(decodeStakePool(buf).totalLamports)
}
