import {
  DEFAULT_EXPLORER, getEndpoints, normalizeContract,
  getNativeBalances, getNativeBalance, getTokenBalances, getTokenBalance, getToken, getTokenTotalSupply,
} from "./ontology";

const PUSDC = '061a07cd393aac289b8ecfda2c3784b637a2fb33' // poly network bridged USDC, oep4
const POLY_RESERVE = 'AVaijxNJvAXYdNMVSYAfT8wVTh8tNHcTBM'
const ONT_HOLDER = 'AFmseVrdL9f9oyCzZefL9tG6UbvhUMqNMV'

describe('chains.ontology pure helpers', () => {
  afterEach(() => {
    delete process.env.ONTOLOGY_EXPLORER
  })

  test('normalizeContract', () => {
    expect(normalizeContract('0x061A07CD393AAC289B8ECFDA2C3784B637A2FB33')).toBe(PUSDC)
    expect(normalizeContract(` ${PUSDC} `)).toBe(PUSDC)
  })

  test('endpoints: default, then ONTOLOGY_EXPLORER first', () => {
    expect(getEndpoints()).toEqual([DEFAULT_EXPLORER])
    process.env.ONTOLOGY_EXPLORER = 'https://ont.example.com'
    expect(getEndpoints()).toEqual(['https://ont.example.com', DEFAULT_EXPLORER])
  })
})

describe('chains.ontology live', () => {
  jest.setTimeout(60_000)

  test('getNativeBalances lists ont and ong', async () => {
    const rows = await getNativeBalances({ address: ONT_HOLDER })
    const names = rows.map(r => r.asset_name)
    expect(names).toContain('ont')
    expect(names).toContain('ong')
    expect(await getNativeBalance({ address: ONT_HOLDER, asset: 'ont' })).toMatch(/^\d+(\.\d+)?$/)
  })

  test('getToken / getTokenTotalSupply pUSDC', async () => {
    const token = await getToken({ tokenType: 'oep4', contract: '0x' + PUSDC })
    expect(token.symbol).toBe('pUSDC')
    expect(token.decimals).toBe(6)
    const supply = await getTokenTotalSupply({ tokenType: 'oep4', contract: PUSDC })
    expect(Number(supply)).toBeGreaterThan(0)
  })

  test('getToken throws for an unknown contract', async () => {
    // the explorer answers HTTP 500 `{ code: 63001 }` for an unknown contract
    await expect(getToken({ tokenType: 'orc20', contract: '0000000000000000000000000000000000000001' })).rejects.toThrow(/63001/)
  })

  test('getTokenBalances / getTokenBalance', async () => {
    const rows = await getTokenBalances({ address: POLY_RESERVE, tokenType: 'oep4' })
    expect(Array.isArray(rows)).toBe(true)
    const balance = await getTokenBalance({ address: POLY_RESERVE, tokenType: 'oep4', contract: PUSDC })
    expect(balance).toMatch(/^\d+(\.\d+)?$/)
    expect(await getTokenBalance({ address: ONT_HOLDER, tokenType: 'oep4', contract: PUSDC })).toBe('0')
  })
})
