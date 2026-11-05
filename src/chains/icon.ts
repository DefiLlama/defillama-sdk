/**
 * ICON JSON-RPC (v3) client: `icx_call` read-only contract calls, balances, blocks.
 *
 * Replaces the chain access parts of:
 *   - DefiLlama-Adapters  projects/helper/chain/icx.js (call, getICXBalance, toInt, toHex)
 *   - peggedassets-server src/adapters/peggedAssets/helper/icon.ts (getXSupply, getICONSupply)
 *
 * Endpoints: `ICON_RPC` (comma separated) overrides `DEFAULT_ENDPOINTS`.
 *
 * ICON returns every number as a `0x` hex string. Functions here return the raw hex from
 * `call` and decimal strings (base units) from the typed helpers; use `hexToBigInt`,
 * `hexToNumber` or `fromLoop` (1 ICX = 1e18 loop) to convert.
 *
 * Usage: `sdk.chains.icon.call({ to: 'cx88fd...', method: 'totalSupply' })`
 */
import { getEndpoints as resolveEndpoints, isRateLimitError, jsonRpc, JsonRpcError, JsonRpcOptions } from "./rpc";

export const CHAIN = 'icon'
export const DEFAULT_ENDPOINTS: string[] = ['https://ctz.solidwallet.io/api/v3']
export const LOOP_PER_ICX = BigInt('1000000000000000000')

/** Configured endpoints (env `ICON_RPC` first, then `DEFAULT_ENDPOINTS`). */
export function getEndpoints(): string[] {
  return resolveEndpoints(CHAIN, DEFAULT_ENDPOINTS)
}

// ---------------------------------------------------------------------------
// pure helpers
// ---------------------------------------------------------------------------

const ADDRESS_RE = /^(hx|cx)[0-9a-f]{40}$/

/** `hx...` wallet or `cx...` contract address. */
export function isIconAddress(str: any): boolean {
  return typeof str === 'string' && ADDRESS_RE.test(str)
}

export function isContractAddress(str: any): boolean {
  return isIconAddress(str) && str.startsWith('cx')
}

/** `0x`-hex (or decimal) string / number / bigint -> bigint. Negative hex (`-0x..`) is accepted. */
export function hexToBigInt(value: string | number | bigint | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return BigInt(0)
  if (typeof value === 'bigint') return value
  if (typeof value === 'number') return BigInt(Math.trunc(value))
  const s = String(value).trim()
  if (s.startsWith('-0x') || s.startsWith('-0X')) return -BigInt(s.slice(1))
  return BigInt(s)
}

/** Same as `hexToBigInt` but as a JS number (precision is lost above 2^53). */
export function hexToNumber(value: string | number | bigint | null | undefined): number {
  return Number(hexToBigInt(value))
}

/** loop (1e-18 ICX, or any 18-decimal IRC-2 unit) -> whole units as a JS number. */
export function fromLoop(value: string | number | bigint | null | undefined): number {
  return Number(hexToBigInt(value)) / 1e18
}

/** number / bigint / decimal string -> `0x` hex as ICON expects it. */
export function toHex(value: number | bigint | string): string {
  const n = typeof value === 'string' && !value.startsWith('0x') ? BigInt(value) : BigInt(value)
  return (n < BigInt(0) ? '-0x' : '0x') + (n < BigInt(0) ? -n : n).toString(16)
}

// ---------------------------------------------------------------------------
// transport
// ---------------------------------------------------------------------------

export type RpcOptions = Omit<JsonRpcOptions, 'chain' | 'endpoints' | 'defaultEndpoints'>

// ICON answers JSON-RPC errors (reverted call, unknown method, missing block) with HTTP 400, which
// axios reports as a transport error; surface those as JsonRpcError and do not retry them
function rpcErrorBody(e: any): any {
  return e?.response?.status === 400 ? e?.response?.data?.error : undefined
}

/** Raw JSON-RPC call. ICON wants `params` to be an object (never an array), so none becomes `{}`. */
export async function rpc(method: string, params?: Record<string, any>, options: RpcOptions = {}): Promise<any> {
  try {
    return await jsonRpc(method, params ?? {}, {
      ...options, chain: CHAIN, endpoints: getEndpoints(),
      shouldRetry: options.shouldRetry ?? ((e) => !rpcErrorBody(e) && !(e instanceof JsonRpcError && !isRateLimitError(e))),
    })
  } catch (e) {
    const error = rpcErrorBody(e)
    if (error) throw new JsonRpcError(method, error)
    throw e
  }
}

export interface CallOptions extends RpcOptions {
  /** `cx...` contract */
  to: string
  method: string
  /** named params as the contract declares them, e.g. `{ _owner: 'hx...' }` */
  params?: Record<string, any>
  /** block height (number or `0x` hex) for a historical read */
  height?: number | string
  /** sender, defaults to the null wallet */
  from?: string
}

/** `icx_call`: read-only method call, returns the raw result (hex string or object). */
export async function call({ to, method, params, height, from, ...options }: CallOptions): Promise<any> {
  const body: Record<string, any> = {
    to,
    dataType: 'call',
    data: params === undefined ? { method } : { method, params },
  }
  if (from) body.from = from
  if (height !== undefined) body.height = typeof height === 'number' ? toHex(height) : height
  return rpc('icx_call', body, options)
}

// ---------------------------------------------------------------------------
// balances / tokens
// ---------------------------------------------------------------------------

/** Native ICX balance in loop as a decimal string. */
export async function getBalance({ address, height }: { address: string, height?: number | string }): Promise<string> {
  const params: Record<string, any> = { address }
  if (height !== undefined) params.height = typeof height === 'number' ? toHex(height) : height
  return hexToBigInt(await rpc('icx_getBalance', params)).toString()
}

/** IRC-2 `balanceOf(_owner)` in token base units as a decimal string. */
export async function getTokenBalance({ token, owner, height }: { token: string, owner: string, height?: number | string }): Promise<string> {
  return hexToBigInt(await call({ to: token, method: 'balanceOf', params: { _owner: owner }, height })).toString()
}

/** IRC-2 `totalSupply()` in token base units as a decimal string. */
export async function getTokenTotalSupply({ token, height }: { token: string, height?: number | string }): Promise<string> {
  return hexToBigInt(await call({ to: token, method: 'totalSupply', height })).toString()
}

/** IRC-2 `decimals()` as a number. */
export async function getTokenDecimals({ token }: { token: string }): Promise<number> {
  return hexToNumber(await call({ to: token, method: 'decimals' }))
}

/** IRC-2 `symbol()` */
export async function getTokenSymbol({ token }: { token: string }): Promise<string> {
  return String(await call({ to: token, method: 'symbol' }))
}

// ---------------------------------------------------------------------------
// blocks
// ---------------------------------------------------------------------------

export interface BlockInfo {
  number: number
  /** unix timestamp in seconds (ICON reports microseconds) */
  timestamp: number
  hash: string
}

function toBlockInfo(block: any): BlockInfo {
  return {
    number: Number(block.height),
    timestamp: Math.floor(Number(block.time_stamp) / 1e6),
    hash: block.block_hash,
  }
}

/** `icx_getLastBlock` */
export async function getLastBlock(): Promise<BlockInfo> {
  return toBlockInfo(await rpc('icx_getLastBlock'))
}

/** `icx_getBlockByHeight` */
export async function getBlock({ height }: { height: number | string }): Promise<BlockInfo> {
  return toBlockInfo(await rpc('icx_getBlockByHeight', { height: typeof height === 'number' ? toHex(height) : height }))
}
