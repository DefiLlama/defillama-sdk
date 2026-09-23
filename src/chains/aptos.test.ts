import * as aptos from "./aptos";

const APT = '0x1::aptos_coin::AptosCoin'
const USDC_FA = '0xbae207659db88bea0cbead6da0ed00aac12edcdda169e591cd41c94180b46f3b'

describe('chains.aptos offline', () => {
  afterEach(() => {
    delete process.env.APTOS_RPC
    delete process.env.MOVE_RPC
    delete process.env.APTOS_ARCHIVAL_RPC
    delete process.env.MOVE_ARCHIVAL_RPC
  })

  test('aptosChains and isAptosChain', () => {
    expect(aptos.aptosChains).toEqual(['aptos', 'move'])
    expect(aptos.isAptosChain('aptos')).toBe(true)
    expect(aptos.isAptosChain('move')).toBe(true)
    expect(aptos.isAptosChain('sui')).toBe(false)
    expect(aptos.isAptosChain(undefined)).toBe(false)
  })

  test('default endpoints', () => {
    expect(aptos.getEndpoint()).toBe('https://fullnode.mainnet.aptoslabs.com')
    expect(aptos.getEndpoint({ chain: 'aptos' })).toBe(aptos.DEFAULT_ENDPOINTS.aptos)
    expect(aptos.getEndpoint({ chain: 'move' })).toBe('https://mainnet.movementnetwork.xyz')
  })

  test('APTOS_RPC / MOVE_RPC env endpoints come first, defaults are kept as fallbacks', () => {
    process.env.APTOS_RPC = 'https://aptos.example.com,https://aptos2.example.com'
    process.env.MOVE_RPC = 'https://move.example.com/'
    expect(aptos.getEndpoint({ chain: 'aptos' })).toBe('https://aptos.example.com')
    expect(aptos.getEndpointList({ chain: 'aptos' })).toEqual(['https://aptos.example.com', 'https://aptos2.example.com', aptos.DEFAULT_ENDPOINTS.aptos])
    expect(aptos.getEndpoint({ chain: 'move' })).toBe('https://move.example.com/')
    expect(aptos.getEndpointList({ chain: 'move' })).toEqual(['https://move.example.com/', aptos.DEFAULT_ENDPOINTS.move])
    delete process.env.APTOS_RPC
    expect(aptos.getEndpoint({ chain: 'aptos' })).toBe(aptos.DEFAULT_ENDPOINTS.aptos)
  })

  test('unknown chain without env throws', () => {
    expect(() => aptos.getEndpoint({ chain: 'notachain' })).toThrow(/No RPC endpoint configured/)
  })

  test('archival endpoints: built-in for aptos, env entries first, empty when none', () => {
    expect(aptos.getArchivalEndpointList()).toEqual(['https://archive.mainnet.aptoslabs.com'])
    expect(aptos.getArchivalEndpointList({ chain: 'move' })).toEqual([])
    process.env.MOVE_ARCHIVAL_RPC = 'https://move-archive.example.com'
    process.env.APTOS_ARCHIVAL_RPC = 'https://aptos-archive.example.com'
    expect(aptos.getArchivalEndpointList({ chain: 'move' })).toEqual(['https://move-archive.example.com'])
    expect(aptos.getArchivalEndpointList({ chain: 'aptos' })).toEqual(['https://aptos-archive.example.com', aptos.ARCHIVAL_ENDPOINTS.aptos])
  })

  test('normalizeAddress pads to 64 hex chars', () => {
    expect(aptos.normalizeAddress('0x1')).toBe('0x0000000000000000000000000000000000000000000000000000000000000001')
    expect(aptos.normalizeAddress('0xA')).toBe('0x000000000000000000000000000000000000000000000000000000000000000a')
    expect(aptos.normalizeAddress('1')).toBe(aptos.normalizeAddress('0x1'))
    expect(aptos.normalizeAddress(USDC_FA)).toBe(USDC_FA)
    expect(aptos.normalizeAddress(USDC_FA.toUpperCase().replace('0X', '0x'))).toBe(USDC_FA)
    expect(() => aptos.normalizeAddress('0xzz')).toThrow(/Invalid aptos address/)
    expect(() => aptos.normalizeAddress('')).toThrow(/Invalid aptos address/)
    expect(() => aptos.normalizeAddress('0x' + '1'.repeat(65))).toThrow(/Invalid aptos address/)
  })

  test('hexToString decodes utf-8 with or without 0x', () => {
    expect(aptos.hexToString('0x41707420436f696e')).toBe('Apt Coin')
    expect(aptos.hexToString('555344')).toBe('USD')
    expect(aptos.hexToString('0x')).toBe('')
  })

  test('octasToApt', () => {
    expect(aptos.octasToApt(100000000)).toBe(1)
    expect(aptos.octasToApt('150000000')).toBe(1.5)
    expect(aptos.octasToApt(BigInt('250000000'))).toBe(2.5)
  })

  test('isFungibleAssetAddress', () => {
    expect(aptos.isFungibleAssetAddress(USDC_FA)).toBe(true)
    expect(aptos.isFungibleAssetAddress('0xa')).toBe(true)
    expect(aptos.isFungibleAssetAddress(APT)).toBe(false)
    expect(aptos.isFungibleAssetAddress('0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>')).toBe(false)
  })

  test('parseTypeTag', () => {
    const simple = aptos.parseTypeTag(APT)
    expect(simple).toMatchObject({ address: '0x1', module: 'aptos_coin', name: 'AptosCoin', typeArgs: [], isStruct: true })

    const generic = aptos.parseTypeTag('0x1::coin::CoinStore<0x1::aptos_coin::AptosCoin>')
    expect(generic).toMatchObject({ address: '0x1', module: 'coin', name: 'CoinStore', typeArgs: [APT], isStruct: true })

    const nested = aptos.parseTypeTag('0xabc::swap::LiquidityPool<0x1::aptos_coin::AptosCoin, 0xdef::pair::Pair<0x1::a::B, u64>, 0xdef::curves::Uncorrelated>')
    expect(nested.name).toBe('LiquidityPool')
    expect(nested.typeArgs).toEqual([APT, '0xdef::pair::Pair<0x1::a::B, u64>', '0xdef::curves::Uncorrelated'])
    expect(aptos.parseTypeTag(nested.typeArgs[1])).toMatchObject({ address: '0xdef', module: 'pair', name: 'Pair', typeArgs: ['0x1::a::B', 'u64'] })

    expect(aptos.parseTypeTag('u64')).toMatchObject({ address: '', module: '', name: 'u64', typeArgs: [], isStruct: false })
    expect(aptos.parseTypeTag('vector<u8>')).toMatchObject({ name: 'vector', typeArgs: ['u8'], isStruct: false })
    expect(() => aptos.parseTypeTag('0x1::coin')).toThrow(/Invalid type tag/)
    expect(() => aptos.parseTypeTag('0x1::coin::CoinStore<0x1::a::B')).toThrow(/Invalid type tag/)
  })
})

describe('chains.aptos live', () => {
  test('getCoinInfo APT has 8 decimals', async () => {
    const info = await aptos.getCoinInfo({ coinType: APT })
    expect(info.decimals).toBe(8)
    expect(info.symbol).toBe('APT')
  })

  test('getCoinSupply APT > 0', async () => {
    const supply = await aptos.getCoinSupply({ coinType: APT })
    expect(/^\d+$/.test(supply)).toBe(true)
    expect(BigInt(supply) > BigInt(0)).toBe(true)
  })

  test('getCoinInfo + getCoinSupply for USDC fungible asset', async () => {
    const info = await aptos.getCoinInfo({ coinType: USDC_FA })
    expect(info.decimals).toBe(6)
    expect(info.symbol).toBe('USDC')
    const supply = await aptos.getCoinSupply({ coinType: USDC_FA })
    expect(/^\d+$/.test(supply)).toBe(true)
    expect(BigInt(supply) > BigInt(0)).toBe(true)
  })

  test('getResource returns data for an existing resource and null for a missing one', async () => {
    const info = await aptos.getResource({ account: '0x1', type: `0x1::coin::CoinInfo<${APT}>` })
    expect(info).not.toBeNull()
    expect(Number(info.decimals)).toBe(8)
    const missing = await aptos.getResource({ account: '0x1', type: '0x1::coin::CoinInfo<0x1::does_not_exist::Nothing>' })
    expect(missing).toBeNull()
  })

  test('getBalance APT for 0x1 is a numeric string', async () => {
    const balance = await aptos.getBalance({ account: '0x1' })
    expect(/^\d+$/.test(balance)).toBe(true)
  })

  test('getLatestBlock and getLedgerInfo', async () => {
    const [block, ledger] = await Promise.all([aptos.getLatestBlock(), aptos.getLedgerInfo()])
    expect(block.number).toBeGreaterThan(0)
    expect(block.timestamp).toBeGreaterThan(1_600_000_000)
    expect(ledger.chainId).toBe(1)
    expect(ledger.ledgerVersion).toBeGreaterThan(0)
  })

  test('getVersionAtTimestamp returns the last version at or before the timestamp', async () => {
    const timestamp = 1704067200 // 2024-01-01T00:00:00Z
    const version = await aptos.getVersionAtTimestamp({ timestamp })
    expect(version).toBeGreaterThan(0)
    const block = await aptos.getBlockByVersion({ version })
    expect(block).not.toBeNull()
    expect(block!.timestamp).toBeLessThanOrEqual(timestamp)
    expect(block!.lastVersion).toBe(version)
    const next = await aptos.getBlockByHeight({ height: block!.number + 1 })
    expect(next).not.toBeNull()
    expect(next!.timestamp).toBeGreaterThan(timestamp)
  })
})
