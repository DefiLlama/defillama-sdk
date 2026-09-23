import {
  DEFAULT_TZKT, getTzktEndpoint, getTzktEndpoints, getRpcEndpoints, DEFAULT_RPC_ENDPOINTS,
  isTezosAddress, isContractAddress, mutezToTez, toBigInt, parseDecimals, bigMapKeysToObject,
  getToken, getTokenTotalSupply, getBalance, getTokenBalances, getTokenBalance, getHead, getBlock, getBlockAtTimestamp,
  getContractStorage, getBigMapByPath, getBigMapKeys, getContractBalanceRpc,
} from "./tezos";

const USDT = 'KT1XnTn74bUtxHfDtBmm2bGZAQfhPbvKWR8o'
const KUSD = 'KT1K9gCRgaLRFKTErYt1wVxA3Frb9FjasjTV'
const BURN = 'tz1burnburnburnburnburnburnburjAYjjX'

describe('chains.tezos pure helpers', () => {
  afterEach(() => {
    delete process.env.TEZOS_TZKT
    delete process.env.TEZOS_RPC
  })

  test('isTezosAddress', () => {
    expect(isTezosAddress(USDT)).toBe(true)
    expect(isTezosAddress(BURN)).toBe(true)
    expect(isTezosAddress('tz2Q4N7ZMSDiBzPDdmHn3C9rA5TfPQTwpKMU')).toBe(true)
    expect(isTezosAddress('tz3RDC3Jdn4j15J7bBHZd29EUee9gVB1CxD9')).toBe(true)
    expect(isTezosAddress('KT1K9gCRgaLRFKTErYt1wVxA3Frb9FjasjT')).toBe(false) // 35 chars
    expect(isTezosAddress('0x0000000000000000000000000000000000000000')).toBe(false)
    expect(isTezosAddress('tezos')).toBe(false)
    expect(isTezosAddress(undefined)).toBe(false)
  })

  test('isContractAddress', () => {
    expect(isContractAddress(USDT)).toBe(true)
    expect(isContractAddress(KUSD)).toBe(true)
    expect(isContractAddress(BURN)).toBe(false)
    expect(isContractAddress('KT1short')).toBe(false)
  })

  test('mutezToTez', () => {
    expect(mutezToTez('1000000')).toBe(1)
    expect(mutezToTez(1500000)).toBe(1.5)
    expect(mutezToTez(BigInt(0))).toBe(0)
  })

  test('toBigInt', () => {
    expect(toBigInt('123')).toBe(BigInt(123))
    expect(toBigInt(123)).toBe(BigInt(123))
    expect(toBigInt(BigInt(7))).toBe(BigInt(7))
    expect(toBigInt('0x10')).toBe(BigInt(16))
    expect(toBigInt('1e3')).toBe(BigInt(1000))
    expect(toBigInt('12.9')).toBe(BigInt(12))
    expect(toBigInt('')).toBe(BigInt(0))
    expect(toBigInt(undefined)).toBe(BigInt(0))
    expect(toBigInt('123456789012345678901234567890')).toBe(BigInt('123456789012345678901234567890'))
    expect(() => toBigInt('abc')).toThrow()
  })

  test('parseDecimals keeps 0 and handles strings', () => {
    expect(parseDecimals('6')).toBe(6)
    expect(parseDecimals(18)).toBe(18)
    expect(parseDecimals('0')).toBe(0)
    expect(parseDecimals(0)).toBe(0)
    expect(parseDecimals(undefined)).toBeUndefined()
    expect(parseDecimals('')).toBeUndefined()
    expect(parseDecimals('x')).toBeUndefined()
  })

  test('bigMapKeysToObject indexes object keys by hash', () => {
    const res = bigMapKeysToObject([
      { key: 'tz1a', value: '1' },
      { key: { owner: 'tz1b', token_id: '0' }, hash: 'exprHash', value: '2' },
    ])
    expect(res).toEqual({ tz1a: '1', exprHash: '2' })
  })

  test('defaults are used when no env is set', () => {
    expect(getTzktEndpoint()).toBe(DEFAULT_TZKT)
    expect(getTzktEndpoints()).toEqual([DEFAULT_TZKT])
    expect(getRpcEndpoints()).toEqual(DEFAULT_RPC_ENDPOINTS)
  })

  test('TEZOS_TZKT env override wins', () => {
    process.env.TEZOS_TZKT = 'https://tzkt.example.com, https://tzkt2.example.com'
    expect(getTzktEndpoint()).toBe('https://tzkt.example.com')
    expect(getTzktEndpoints()).toEqual(['https://tzkt.example.com', 'https://tzkt2.example.com'])
    delete process.env.TEZOS_TZKT
    expect(getTzktEndpoint()).toBe(DEFAULT_TZKT)
  })

  test('TEZOS_RPC env override wins', () => {
    process.env.TEZOS_RPC = 'https://node.example.com'
    expect(getRpcEndpoints()).toEqual(['https://node.example.com'])
  })
})

describe('chains.tezos live (TzKT)', () => {
  jest.setTimeout(60_000)

  test('getToken USDt has 6 decimals and positive supply', async () => {
    const token = await getToken({ contract: USDT, tokenId: 0 })
    expect(token.contract).toBe(USDT)
    expect(token.tokenId).toBe('0')
    expect(token.decimals).toBe(6)
    expect(token.symbol).toBe('USDt')
    expect(token.standard).toBe('fa2')
    expect(toBigInt(token.totalSupply) > BigInt(0)).toBe(true)
    const supply = await getTokenTotalSupply({ contract: USDT })
    expect(supply).toMatch(/^\d+$/)
  })

  test('getToken kUSD has 18 decimals', async () => {
    const token = await getToken({ contract: KUSD })
    expect(token.decimals).toBe(18)
    expect(token.standard).toBe('fa1.2')
    expect(toBigInt(token.totalSupply) > BigInt(0)).toBe(true)
  })

  test('getBalance returns a mutez string', async () => {
    const balance = await getBalance({ address: KUSD })
    expect(balance).toMatch(/^\d+$/)
  })

  test('getTokenBalances for a known holder returns parsed rows', async () => {
    const rows = await getTokenBalances({ address: BURN, includeTezos: true, maxPages: 2 })
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.length).toBeGreaterThan(1)
    const native = rows.find(r => r.contract === 'tezos')
    expect(native?.standard).toBe('native')
    expect(native?.balance).toMatch(/^\d+$/)
    const token = rows.find(r => r.contract !== 'tezos')!
    expect(isContractAddress(token.contract)).toBe(true)
    expect(token.tokenId).toMatch(/^\d+$/)
    expect(token.balance).toMatch(/^\d+$/)
    expect(['fa1.2', 'fa2']).toContain(token.standard)
  })

  test('getTokenBalance returns raw string, 0 when not held', async () => {
    const rows = await getTokenBalances({ address: BURN, maxPages: 1 })
    const held = rows[0]
    const balance = await getTokenBalance({ address: BURN, contract: held.contract, tokenId: held.tokenId })
    expect(balance).toBe(held.balance)
    const none = await getTokenBalance({ address: KUSD, contract: USDT, tokenId: 999999 })
    expect(none).toBe('0')
  })

  test('getHead returns a positive level', async () => {
    const head = await getHead()
    expect(head.number).toBeGreaterThan(0)
    expect(head.timestamp).toBeGreaterThan(1_600_000_000)
    expect(typeof head.hash).toBe('string')
  })

  test('getBlock / getBlockAtTimestamp', async () => {
    const ts = 1700000000 // 2023-11-14T22:13:20Z
    const block = await getBlockAtTimestamp({ timestamp: ts })
    expect(block.number).toBeGreaterThan(0)
    expect(block.timestamp).toBeLessThanOrEqual(ts)
    expect(ts - block.timestamp).toBeLessThan(120)
    const same = await getBlock({ level: block.number })
    expect(same.hash).toBe(block.hash)
    const iso = await getBlockAtTimestamp({ timestamp: '2023-11-14T22:13:20Z' })
    expect(iso.number).toBe(block.number)
  })

  test('getContractStorage for kUSD returns an object', async () => {
    const storage = await getContractStorage({ contract: KUSD })
    expect(typeof storage).toBe('object')
    expect(storage).not.toBeNull()
    expect(storage.totalSupply).toMatch(/^\d+$/)
  })

  test('getBigMapByPath / getBigMapKeys', async () => {
    const bigmap = await getBigMapByPath({ contract: KUSD, path: 'balances' })
    expect(bigmap.ptr).toBeGreaterThan(0)
    const keys = await getBigMapKeys({ id: bigmap.ptr, limit: 5, maxPages: 1 })
    expect(keys.length).toBe(5)
    expect(isTezosAddress(keys[0].key)).toBe(true)
  })
})

describe('chains.tezos live (node RPC)', () => {
  jest.setTimeout(60_000)

  test('getContractBalanceRpc returns a mutez string', async () => {
    const balance = await getContractBalanceRpc({ address: KUSD })
    expect(balance).toMatch(/^\d+$/)
  })
})
