/**
 * Zilliqa native (Scilla) JSON-RPC client.
 *
 * Replaces the chain access parts of:
 *   - DefiLlama-Adapters  projects/helper/chain/zilliqa.js (call, formQuery, getContractState,
 *     getBalance, getZilliqaBalance, getBalances)
 *   - peggedassets-server src/adapters/peggedAssets/helper/zilliqa.ts (getZilliqaTokenSupply)
 *
 * Endpoints: `ZILLIQA_NATIVE_RPC` (comma separated) overrides the default. The chain's
 * `ZILLIQA_RPC` key is its EVM endpoint in providers.json, so it is deliberately not used here,
 * the same way cosmos uses `<CHAIN>_LCD`. api.zilliqa.com serves both.
 *
 * Addresses: the API wants bare 40-char hex. Every function accepts `0x`-prefixed hex, bare hex
 * or bech32 (`zil1...`) and normalises with `toHexAddress`. Balances come back as raw base units
 * (Qa for ZIL, 1e12 per ZIL; token base units for ZRC-2) as decimal strings.
 *
 * Usage: `sdk.chains.zilliqa.getTokenBalance({ token: '0x818c...', address: 'zil1...' })`
 */
import { getEndpoints as resolveEndpoints, jsonRpc, jsonRpcBatch, JsonRpcError, JsonRpcOptions } from "./rpc";

export const CHAIN = 'zilliqa'
export const DEFAULT_ENDPOINTS: string[] = ['https://api.zilliqa.com']
export const QA_PER_ZIL = 1_000_000_000_000
export const BECH32_HRP = 'zil'

/** Configured endpoints (env `ZILLIQA_NATIVE_RPC` first, then `DEFAULT_ENDPOINTS`). */
export function getEndpoints(): string[] {
  return resolveEndpoints(CHAIN, DEFAULT_ENDPOINTS, { envKey: 'ZILLIQA_NATIVE_RPC' })
}

// ---------------------------------------------------------------------------
// bech32 (BIP-173) - zilliqa uses hrp `zil` with a 20 byte payload
// ---------------------------------------------------------------------------

const BECH32_CHARSET = 'qpzry9x8gf2tvdw0s3jn54khce6mua7l'
const BECH32_GENERATOR = [0x3b6a57b2, 0x26508e6d, 0x1ea119fa, 0x3d4233dd, 0x2a1462b3]

function bech32Polymod(values: number[]): number {
  let chk = 1
  for (const v of values) {
    const top = chk >>> 25
    chk = ((chk & 0x1ffffff) << 5) ^ v
    for (let i = 0; i < 5; i++) if ((top >>> i) & 1) chk ^= BECH32_GENERATOR[i]
  }
  return chk >>> 0
}

function bech32HrpExpand(hrp: string): number[] {
  const res: number[] = []
  for (const c of hrp) res.push(c.charCodeAt(0) >>> 5)
  res.push(0)
  for (const c of hrp) res.push(c.charCodeAt(0) & 31)
  return res
}

function convertBits(data: number[], from: number, to: number, pad: boolean): number[] {
  let acc = 0
  let bits = 0
  const res: number[] = []
  const maxv = (1 << to) - 1
  for (const value of data) {
    if (value < 0 || value >>> from !== 0) throw new Error('bech32: invalid value')
    acc = (acc << from) | value
    bits += from
    while (bits >= to) {
      bits -= to
      res.push((acc >>> bits) & maxv)
    }
  }
  if (pad) {
    if (bits > 0) res.push((acc << (to - bits)) & maxv)
  } else if (bits >= from || ((acc << (to - bits)) & maxv)) {
    throw new Error('bech32: invalid padding')
  }
  return res
}

/** Decode a bech32 string into `{ hrp, data }` where `data` is the 8-bit payload. */
export function bech32Decode(str: string): { hrp: string, data: Buffer } {
  if (str !== str.toLowerCase() && str !== str.toUpperCase()) throw new Error('bech32: mixed case')
  str = str.toLowerCase()
  const pos = str.lastIndexOf('1')
  if (pos < 1 || pos + 7 > str.length) throw new Error('bech32: invalid separator position')
  const hrp = str.slice(0, pos)
  const values: number[] = []
  for (const c of str.slice(pos + 1)) {
    const v = BECH32_CHARSET.indexOf(c)
    if (v === -1) throw new Error(`bech32: invalid character ${c}`)
    values.push(v)
  }
  if (bech32Polymod([...bech32HrpExpand(hrp), ...values]) !== 1) throw new Error('bech32: bad checksum')
  return { hrp, data: Buffer.from(convertBits(values.slice(0, -6), 5, 8, false)) }
}

/** Encode an 8-bit payload as bech32 with `hrp`. */
export function bech32Encode(hrp: string, data: Uint8Array): string {
  const values = convertBits([...data], 8, 5, true)
  const polymod = bech32Polymod([...bech32HrpExpand(hrp), ...values, 0, 0, 0, 0, 0, 0]) ^ 1
  const checksum: number[] = []
  for (let i = 0; i < 6; i++) checksum.push((polymod >>> (5 * (5 - i))) & 31)
  return hrp + '1' + [...values, ...checksum].map(v => BECH32_CHARSET[v]).join('')
}

// ---------------------------------------------------------------------------
// addresses
// ---------------------------------------------------------------------------

const HEX_ADDRESS_RE = /^(0x)?[0-9a-f]{40}$/i

export function isBech32Address(str: any): boolean {
  if (typeof str !== 'string' || !str.toLowerCase().startsWith(BECH32_HRP + '1') || str.length !== 42) return false
  try {
    return bech32Decode(str).data.length === 20
  } catch {
    return false
  }
}

export function isHexAddress(str: any): boolean {
  return typeof str === 'string' && HEX_ADDRESS_RE.test(str)
}

/** bech32 (`zil1...`), `0x` hex or bare hex -> bare lowercase hex (what the API expects). */
export function toHexAddress(address: string): string {
  if (typeof address !== 'string') throw new Error(`zilliqa: invalid address ${address}`)
  const str = address.trim()
  if (str.toLowerCase().startsWith(BECH32_HRP + '1')) {
    const { hrp, data } = bech32Decode(str)
    if (hrp !== BECH32_HRP || data.length !== 20) throw new Error(`zilliqa: invalid bech32 address ${address}`)
    return data.toString('hex')
  }
  if (!HEX_ADDRESS_RE.test(str)) throw new Error(`zilliqa: invalid address ${address}`)
  return (str.startsWith('0x') || str.startsWith('0X') ? str.slice(2) : str).toLowerCase()
}

/** Any accepted address form -> `zil1...` bech32. */
export function toBech32Address(address: string): string {
  return bech32Encode(BECH32_HRP, Buffer.from(toHexAddress(address), 'hex'))
}

/** Qa (1e-12 ZIL) -> ZIL as a JS number. */
export function qaToZil(qa: string | number | bigint): number {
  return Number(BigInt(qa)) / QA_PER_ZIL
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

export type RpcOptions = Omit<JsonRpcOptions, 'chain' | 'endpoints' | 'defaultEndpoints'>

/** Raw JSON-RPC call against the configured endpoints (rotated + retried). */
export async function rpc(method: string, params: any[] = [], options: RpcOptions = {}): Promise<any> {
  return jsonRpc(method, params, { ...options, chain: CHAIN, endpoints: getEndpoints(), id: options.id ?? '1' })
}

export interface BatchCall {
  method: string
  params?: any[]
  id?: string | number
}

/**
 * JSON-RPC batch, results in call order. Failed entries resolve to `undefined`
 * (the API answers errors per item, e.g. an unknown substate).
 */
export async function rpcBatch(calls: BatchCall[], options: RpcOptions & { chunkSize?: number } = {}): Promise<any[]> {
  return jsonRpcBatch(calls.map((c, i) => ({ ...c, id: c.id ?? String(i) })), { ...options, chain: CHAIN, endpoints: getEndpoints(), permitFailure: true })
}

function isAccountNotCreated(e: any): boolean {
  return e instanceof JsonRpcError && /not created/i.test(e.message)
}

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

/** `GetBalance`: `{ balance (Qa string), nonce }`; `{ balance: '0', nonce: 0 }` for an unused address. */
export async function getAccount({ address }: { address: string }): Promise<{ balance: string, nonce: number }> {
  try {
    const res = await rpc('GetBalance', [toHexAddress(address)])
    return { balance: String(res?.balance ?? '0'), nonce: Number(res?.nonce ?? 0) }
  } catch (e) {
    if (isAccountNotCreated(e)) return { balance: '0', nonce: 0 }
    throw e
  }
}

/** Native ZIL balance in Qa as a decimal string. */
export async function getBalance({ address }: { address: string }): Promise<string> {
  return (await getAccount({ address })).balance
}

// ---------------------------------------------------------------------------
// contracts
// ---------------------------------------------------------------------------

/** `GetSmartContractInit`: the immutable init params as `[{ vname, type, value }]`. */
export async function getContractInit({ contract }: { contract: string }): Promise<{ vname: string, type: string, value: any }[]> {
  return rpc('GetSmartContractInit', [toHexAddress(contract)])
}

/** `[{ vname, value }]` -> `{ vname: value }`. */
export function initToObject(init: { vname: string, value: any }[]): Record<string, any> {
  const res: Record<string, any> = {}
  for (const { vname, value } of init ?? []) res[vname] = value
  return res
}

/** `GetSmartContractState`: the whole mutable state. Large for tokens; prefer `getContractSubState`. */
export async function getContractState({ contract }: { contract: string }): Promise<any> {
  return rpc('GetSmartContractState', [toHexAddress(contract)])
}

/**
 * `GetSmartContractSubState`: one state variable, optionally narrowed by map `indices`.
 * Resolves to `{ [variable]: value }` or `null` when the variable / index does not exist.
 */
export async function getContractSubState({ contract, variable, indices = [] }: { contract: string, variable: string, indices?: string[] }): Promise<any> {
  return rpc('GetSmartContractSubState', [toHexAddress(contract), variable, indices])
}

/** Several `GetSmartContractSubState` in one batch; missing entries are `undefined`. */
export async function getContractSubStates(items: { contract: string, variable: string, indices?: string[] }[], options?: RpcOptions & { chunkSize?: number }): Promise<any[]> {
  return rpcBatch(items.map(i => ({ method: 'GetSmartContractSubState', params: [toHexAddress(i.contract), i.variable, i.indices ?? []] })), options)
}

// ---------------------------------------------------------------------------
// ZRC-2 tokens
// ---------------------------------------------------------------------------

export interface TokenInfo {
  contract: string
  symbol?: string
  name?: string
  decimals?: number
  /** raw total supply in token base units */
  totalSupply: string
}

/** Raw ZRC-2 balance of `address` for `token`; `'0'` when the holder is unknown. */
export async function getTokenBalance({ token, address }: { token: string, address: string }): Promise<string> {
  const holder = '0x' + toHexAddress(address)
  const res = await getContractSubState({ contract: token, variable: 'balances', indices: [holder] })
  return String(res?.balances?.[holder] ?? '0')
}

/**
 * Raw ZRC-2 balances for every `token` x `address` pair, one batch request.
 * Returns `{ [tokenHex]: { [addressHex]: balance } }` with `0x`-prefixed lowercase keys.
 */
export async function getTokenBalances({ tokens, addresses }: { tokens: string[], addresses: string[] }): Promise<Record<string, Record<string, string>>> {
  const pairs: { token: string, holder: string }[] = []
  for (const token of tokens) for (const address of addresses) pairs.push({ token: '0x' + toHexAddress(token), holder: '0x' + toHexAddress(address) })
  const results = await getContractSubStates(pairs.map(p => ({ contract: p.token, variable: 'balances', indices: [p.holder] })))
  const res: Record<string, Record<string, string>> = {}
  pairs.forEach(({ token, holder }, i) => {
    res[token] = res[token] ?? {}
    res[token][holder] = String(results[i]?.balances?.[holder] ?? '0')
  })
  return res
}

function findSupplyInState(state: any): string | undefined {
  if (!state || typeof state !== 'object') return
  if (state.total_supply !== undefined) return String(state.total_supply)
  const key = Object.keys(state).find(k => k.toLowerCase().includes('supply'))
  if (!key) return
  const raw = state[key]
  if (raw === null || raw === undefined) return
  if (typeof raw === 'object') return raw._balance !== undefined ? String(raw._balance) : undefined
  return String(raw)
}

/**
 * Raw ZRC-2 total supply. Reads the `total_supply` substate; contracts that name the
 * field differently fall back to a full state scan for a `*supply*` key.
 */
export async function getTokenTotalSupply({ token }: { token: string }): Promise<string> {
  const sub = await getContractSubState({ contract: token, variable: 'total_supply' })
  if (sub?.total_supply !== undefined) return String(sub.total_supply)
  const supply = findSupplyInState(await getContractState({ contract: token }))
  if (supply === undefined) throw new Error(`zilliqa: no total supply field on ${token}`)
  return supply
}

/** `decimals` from the init params (ZRC-2); undefined when the contract has none. */
export async function getTokenDecimals({ token }: { token: string }): Promise<number | undefined> {
  const init = initToObject(await getContractInit({ contract: token }))
  if (init.decimals === undefined || init.decimals === null || init.decimals === '') return
  const n = Number(init.decimals)
  return Number.isFinite(n) ? n : undefined
}

/** symbol / name / decimals (init params) + raw total supply. */
export async function getTokenInfo({ token }: { token: string }): Promise<TokenInfo> {
  const [init, totalSupply] = await Promise.all([getContractInit({ contract: token }), getTokenTotalSupply({ token })])
  const params = initToObject(init)
  const decimals = params.decimals === undefined ? undefined : Number(params.decimals)
  return {
    contract: '0x' + toHexAddress(token),
    symbol: params.symbol,
    name: params.name,
    decimals: Number.isFinite(decimals as number) ? decimals : undefined,
    totalSupply,
  }
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

export interface BlockInfo {
  /** tx block number */
  number: number
  /** unix timestamp in seconds (the API reports microseconds) */
  timestamp: number
  hash: string
}

function toBlockInfo(block: any): BlockInfo {
  return {
    number: Number(block?.header?.BlockNum),
    timestamp: Math.floor(Number(block?.header?.Timestamp) / 1e6),
    hash: block?.body?.BlockHash,
  }
}

/** `GetLatestTxBlock` */
export async function getLatestBlock(): Promise<BlockInfo> {
  return toBlockInfo(await rpc('GetLatestTxBlock', ['']))
}

/** `GetTxBlock` by number. */
export async function getBlock({ number }: { number: number | string }): Promise<BlockInfo> {
  return toBlockInfo(await rpc('GetTxBlock', [String(number)]))
}
