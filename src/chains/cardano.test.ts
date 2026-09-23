import * as path from "path";
import {
  DEFAULT_ENDPOINT, getEndpoint, getEndpointList, getProjectId, parseAssetId, buildAssetId, decodeAssetName,
  isStakeAddress, lovelaceToAda, getAssetDecimals, SHELLEY_SLOT_OFFSET,
  getAssetSupply, getAdaBalance, getLatestBlock, getBlockAtTimestamp, getAddressAssets, getAsset,
} from "./cardano";

const DJED = '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61446a65644d6963726f555344'
const DJED_POLICY = '8db269c3ec630e06ae29f74bc39edd1f87c819f1056206e879a1cd61'
const MINSWAP_POOL = 'addr1z8snz7c4974vzdpxu65ruphl3zjdvtxw8strf2c2tmqnxz2j2c79gy9l76sdg0xwhd7r0c0kna0tycz4y5s6mlenh8pq0xmsha'

/**
 * Live tests need a Blockfrost key. When none is set, borrow the DefiLlama-Adapters default
 * (sibling checkout) instead of pasting a key into this repo; skip the live suite otherwise.
 */
function ensureProjectId(): boolean {
  if (process.env.BLOCKFROST_PROJECT_ID) return true
  try {
    const adaptersEnv = path.resolve(__dirname, '../../../adapters/projects/helper/env.js')
    const { getEnv } = require(adaptersEnv)
    const key = getEnv('BLOCKFROST_PROJECT_ID')
    if (key) process.env.BLOCKFROST_PROJECT_ID = key
  } catch (e) { /* adapters checkout not available */ }
  return !!process.env.BLOCKFROST_PROJECT_ID
}

describe('chains.cardano pure helpers', () => {
  test('parseAssetId splits the DJED asset id', () => {
    const parsed = parseAssetId(DJED)
    expect(parsed.policyId).toBe(DJED_POLICY)
    expect(parsed.policyId).toHaveLength(56)
    expect(parsed.assetNameHex).toBe('446a65644d6963726f555344')
    expect(parsed.assetName).toBe('DjedMicroUSD')
  })

  test('parseAssetId handles lovelace and empty asset names', () => {
    expect(parseAssetId('lovelace')).toEqual({ policyId: '', assetNameHex: '', assetName: 'lovelace' })
    expect(parseAssetId(DJED_POLICY)).toEqual({ policyId: DJED_POLICY, assetNameHex: '', assetName: '' })
    expect(() => parseAssetId('not-hex')).toThrow(/invalid asset id/)
  })

  test('decodeAssetName falls back to hex for non printable names', () => {
    expect(decodeAssetName('000643b0' + Buffer.from('ref', 'utf8').toString('hex'))).toBe('000643b0726566')
    expect(decodeAssetName('4d494e')).toBe('MIN')
  })

  test('buildAssetId is the inverse of parseAssetId', () => {
    const { policyId, assetNameHex, assetName } = parseAssetId(DJED)
    expect(buildAssetId(policyId, assetName)).toBe(DJED)
    expect(buildAssetId(policyId, assetNameHex)).toBe(DJED)
    expect(buildAssetId(policyId, assetNameHex, 'hex')).toBe(DJED)
    expect(buildAssetId(policyId, assetName, 'utf8')).toBe(DJED)
    expect(buildAssetId(policyId)).toBe(DJED_POLICY)
    // ambiguous (hex-looking) utf8 name can be forced
    expect(buildAssetId(policyId, 'abcd', 'utf8')).toBe(DJED_POLICY + '61626364')
    expect(() => buildAssetId('short', 'x')).toThrow(/invalid policy id/)
  })

  test('isStakeAddress / lovelaceToAda', () => {
    expect(isStakeAddress('stake1u9ylzsgxaa6xctf4juup682ar3juj85n8tx3hthnljg47zctvm3rc')).toBe(true)
    expect(isStakeAddress(MINSWAP_POOL)).toBe(false)
    expect(lovelaceToAda('2500000')).toBe(2.5)
    expect(lovelaceToAda(BigInt(1000000))).toBe(1)
  })

  test('getAssetDecimals prefers registry metadata, then on-chain metadata', () => {
    expect(getAssetDecimals({ metadata: { decimals: 6 }, onchain_metadata: { decimals: 0 } } as any)).toBe(6)
    expect(getAssetDecimals({ metadata: null, onchain_metadata: { decimals: '8' } } as any)).toBe(8)
    expect(getAssetDecimals({ metadata: { decimals: null }, onchain_metadata: null } as any)).toBeUndefined()
    expect(getAssetDecimals(null)).toBeUndefined()
  })

  test('Shelley slot offset matches the known epoch 208 boundary', () => {
    expect(SHELLEY_SLOT_OFFSET).toBe(1591566291)
  })
})

describe('chains.cardano config', () => {
  const saved: Record<string, string | undefined> = {}
  const keys = ['BLOCKFROST_PROJECT_ID', 'SDK_BLOCKFROST_PROJECT_ID', 'LLAMA_SDK_BLOCKFROST_PROJECT_ID', 'CARDANO_BLOCKFROST', 'SDK_CARDANO_BLOCKFROST', 'LLAMA_SDK_CARDANO_BLOCKFROST']

  beforeEach(() => {
    keys.forEach(k => { saved[k] = process.env[k]; delete process.env[k] })
  })
  afterEach(() => {
    keys.forEach(k => {
      if (saved[k] === undefined) delete process.env[k]
      else process.env[k] = saved[k]
    })
  })

  test('getProjectId throws when the env var is missing', () => {
    expect(() => getProjectId()).toThrow(/BLOCKFROST_PROJECT_ID/)
    process.env.BLOCKFROST_PROJECT_ID = 'test-key'
    expect(getProjectId()).toBe('test-key')
  })

  test('endpoint defaults to Blockfrost mainnet, CARDANO_BLOCKFROST entries come first', () => {
    expect(getEndpoint()).toBe(DEFAULT_ENDPOINT)
    process.env.CARDANO_BLOCKFROST = 'https://a.example/v0, https://b.example/v0'
    expect(getEndpointList()).toEqual(['https://a.example/v0', 'https://b.example/v0', DEFAULT_ENDPOINT])
    expect(getEndpoint()).toBe('https://a.example/v0')
    delete process.env.CARDANO_BLOCKFROST
    expect(getEndpoint()).toBe(DEFAULT_ENDPOINT)
  })
})

const liveDescribe = ensureProjectId() ? describe : describe.skip

liveDescribe('chains.cardano live (Blockfrost)', () => {
  jest.setTimeout(60_000)

  test('getAssetSupply for DJED', async () => {
    const { supply, decimals } = await getAssetSupply({ assetId: DJED })
    expect(supply).toMatch(/^\d+$/)
    expect(BigInt(supply) > BigInt(0)).toBe(true)
    if (decimals !== undefined) expect(decimals).toBe(6)
  })

  test('getAsset returns null for an unknown asset', async () => {
    expect(await getAsset({ assetId: DJED_POLICY + 'deadbeef' })).toBeNull()
  })

  test('getAdaBalance for a Minswap pool script address', async () => {
    const balance = await getAdaBalance({ address: MINSWAP_POOL })
    expect(balance).toMatch(/^\d+$/)
  })

  test('getAddressAssets returns an array with lovelace', async () => {
    const assets = await getAddressAssets({ address: MINSWAP_POOL })
    expect(Array.isArray(assets)).toBe(true)
    expect(assets.some(i => i.unit === 'lovelace')).toBe(true)
  })

  test('getLatestBlock', async () => {
    const block = await getLatestBlock()
    expect(block.number).toBeGreaterThan(0)
    expect(block.timestamp).toBeGreaterThan(1596059091)
    expect(typeof block.hash).toBe('string')
  })

  test('getBlockAtTimestamp returns the last block at or before the timestamp', async () => {
    const timestamp = 1700000000 // 2023-11-14
    const block = await getBlockAtTimestamp({ timestamp })
    expect(block.timestamp).toBeLessThanOrEqual(timestamp)
    expect(block.timestamp).toBeGreaterThan(timestamp - 3600)
    expect(block.number).toBeGreaterThan(0)
    // Shelley formula check: block slot maps back to its own time
    expect(block.slot + SHELLEY_SLOT_OFFSET).toBe(block.timestamp)
  })
})
