import {
  DEFAULT_ENDPOINTS, getEndpoints, isIconAddress, isContractAddress, hexToBigInt, hexToNumber, fromLoop, toHex,
  call, getBalance, getTokenBalance, getTokenTotalSupply, getTokenDecimals, getTokenSymbol, getLastBlock, getBlock,
} from "./icon";

const BNUSD = 'cx88fd7df7ddff82f7cc735c871dc519838cb235bb'
const SICX = 'cx2609b924e33ef00b648a409245c7ea394c467824'
const STAKING = 'cx43e2eec79eb76293c298f2b17aec06097be606e0'
const NULL_WALLET = 'hx0000000000000000000000000000000000000000'

describe('chains.icon pure helpers', () => {
  afterEach(() => {
    delete process.env.ICON_RPC
  })

  test('address checks', () => {
    expect(isIconAddress(BNUSD)).toBe(true)
    expect(isIconAddress(NULL_WALLET)).toBe(true)
    expect(isContractAddress(BNUSD)).toBe(true)
    expect(isContractAddress(NULL_WALLET)).toBe(false)
    expect(isIconAddress('0x88fd7df7ddff82f7cc735c871dc519838cb235bb')).toBe(false)
    expect(isIconAddress(undefined)).toBe(false)
  })

  test('hex conversions', () => {
    expect(hexToBigInt('0x12')).toBe(BigInt(18))
    expect(hexToBigInt('-0x10')).toBe(BigInt(-16))
    expect(hexToBigInt('0xde0b6b3a7640000')).toBe(BigInt('1000000000000000000'))
    expect(hexToBigInt('')).toBe(BigInt(0))
    expect(hexToBigInt(undefined)).toBe(BigInt(0))
    expect(hexToBigInt(42)).toBe(BigInt(42))
    expect(hexToNumber('0x12')).toBe(18)
    expect(fromLoop('0xde0b6b3a7640000')).toBe(1)
    expect(fromLoop('0x1bc16d674ec80000')).toBe(2)
    expect(toHex(18)).toBe('0x12')
    expect(toHex(BigInt(255))).toBe('0xff')
    expect(toHex('256')).toBe('0x100')
    expect(toHex(-16)).toBe('-0x10')
  })

  test('endpoints: default, then ICON_RPC first', () => {
    expect(getEndpoints()).toEqual(DEFAULT_ENDPOINTS)
    process.env.ICON_RPC = 'https://icon.example.com'
    expect(getEndpoints()).toEqual(['https://icon.example.com', ...DEFAULT_ENDPOINTS])
  })
})

describe('chains.icon live', () => {
  jest.setTimeout(60_000)

  test('call returns the raw hex and typed helpers decode it', async () => {
    expect(await call({ to: BNUSD, method: 'decimals' })).toBe('0x12')
    expect(await getTokenDecimals({ token: BNUSD })).toBe(18)
    expect(await getTokenSymbol({ token: BNUSD })).toBe('bnUSD')
    const supply = await getTokenTotalSupply({ token: BNUSD })
    expect(supply).toMatch(/^\d+$/)
    expect(BigInt(supply) > BigInt(0)).toBe(true)
  })

  test('call with params', async () => {
    const supply = await call({ to: BNUSD, method: 'xSupply', params: { net: '0x100.icon' } })
    expect(supply).toMatch(/^0x[0-9a-f]+$/)
    const balance = await getTokenBalance({ token: SICX, owner: STAKING })
    expect(balance).toMatch(/^\d+$/)
  })

  test('call at a past height', async () => {
    const head = await getLastBlock()
    const supplyNow = await getTokenTotalSupply({ token: SICX })
    const supplyThen = await getTokenTotalSupply({ token: SICX, height: head.number - 100 })
    expect(supplyThen).toMatch(/^\d+$/)
    expect(supplyNow).toMatch(/^\d+$/)
  })

  test('getBalance returns loop as a decimal string', async () => {
    const balance = await getBalance({ address: STAKING })
    expect(balance).toMatch(/^\d+$/)
  })

  test('getLastBlock / getBlock', async () => {
    const head = await getLastBlock()
    expect(head.number).toBeGreaterThan(100_000_000)
    expect(head.timestamp).toBeGreaterThan(1_700_000_000)
    expect(head.timestamp).toBeLessThan(Date.now() / 1000 + 60)
    const same = await getBlock({ height: head.number })
    expect(same.hash).toBe(head.hash)
  })
})
