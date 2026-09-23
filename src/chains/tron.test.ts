import { getWalletEndpoints, isTronAddress, getTrxBalance, getLatestBlock, getBlock, getAccount, tronToEvmAddress, evmToTronAddress, DEFAULT_WALLET_ENDPOINTS } from "./tron";

const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'

describe('chains.tron offline', () => {
  afterEach(() => {
    delete process.env.TRON_WALLET_RPC
    delete process.env.TRON_WHITELISTED_RPC
  })

  test('isTronAddress', () => {
    expect(isTronAddress(USDT)).toBe(true)
    expect(isTronAddress('41' + tronToEvmAddress(USDT).slice(2))).toBe(true)
    expect(isTronAddress('0x' + '1'.repeat(40))).toBe(false)
    expect(isTronAddress('nope')).toBe(false)
  })

  test('address conversion round trip', () => {
    expect(evmToTronAddress(tronToEvmAddress(USDT))).toBe(USDT)
  })

  test('TRON_WALLET_RPC env endpoints come first, default is kept as fallback', () => {
    process.env.TRON_WALLET_RPC = 'https://a.io,https://b.io'
    expect(getWalletEndpoints()).toEqual(['https://a.io', 'https://b.io', DEFAULT_WALLET_ENDPOINTS])
  })

  test('TRON_WHITELISTED_RPC replaces env and default', () => {
    process.env.TRON_WALLET_RPC = 'https://a.io'
    process.env.TRON_WHITELISTED_RPC = 'https://wl.io'
    expect(getWalletEndpoints()).toEqual(['https://wl.io'])
  })

  test('default wallet endpoint', () => {
    expect(getWalletEndpoints()).toEqual([DEFAULT_WALLET_ENDPOINTS])
    expect(DEFAULT_WALLET_ENDPOINTS).toContain('trongrid')
  })
})

describe('chains.tron live', () => {
  test('getAccount + getTrxBalance', async () => {
    const account = await getAccount({ address: USDT })
    expect(account.address).toBeDefined()
    const balance = await getTrxBalance({ address: USDT })
    expect(Number(balance)).toBeGreaterThanOrEqual(0)
  })

  test('blocks', async () => {
    const latest = await getLatestBlock()
    expect(latest.number).toBeGreaterThan(60_000_000)
    const block = await getBlock({ number: latest.number - 10 })
    expect(block.number).toBe(latest.number - 10)
    expect(block.timestamp).toBeLessThanOrEqual(latest.timestamp)
  })
})
