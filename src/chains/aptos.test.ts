import axios from "axios";
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

describe('chains.aptos indexer (mocked)', () => {
  let postSpy: jest.SpyInstance
  afterEach(() => {
    postSpy?.mockRestore()
    delete process.env.APTOS_INDEXER
    delete process.env.APTOS_API_KEY
  })

  test('indexer endpoints: env first, defaults kept as fallbacks, empty for chains without one', () => {
    const aptosDefaults = ['https://api.mainnet.aptoslabs.com/v1/graphql', 'https://indexer.mainnet.aptoslabs.com/v1/graphql']
    expect(aptos.getIndexerEndpointList()).toEqual(aptosDefaults)
    expect(aptos.getIndexerEndpointList({ chain: 'move' })).toEqual(['https://indexer.mainnet.movementnetwork.xyz/v1/graphql'])
    process.env.APTOS_INDEXER = 'https://idx1.example.com/v1/graphql,https://idx2.example.com/v1/graphql'
    expect(aptos.getIndexerEndpointList()).toEqual(['https://idx1.example.com/v1/graphql', 'https://idx2.example.com/v1/graphql', ...aptosDefaults])
    expect(aptos.getIndexerEndpointList({ chain: 'notachain' })).toEqual([])
  })

  test('indexerQuery rotates to the next endpoint on a transport error and sends the bearer key', async () => {
    process.env.APTOS_INDEXER = 'https://idx1.example.com/v1/graphql,https://idx2.example.com/v1/graphql'
    process.env.APTOS_API_KEY = 'secret'
    const urls: string[] = []
    postSpy = jest.spyOn(axios, 'post').mockImplementation(async (url: any, body: any, config: any) => {
      urls.push(url)
      expect(config.headers.Authorization).toBe('Bearer secret')
      expect(body.query).toContain('ping')
      if (urls.length === 1) throw Object.assign(new Error('boom'), { response: { status: 503 } })
      return { data: { data: { ping: 1 } } }
    })
    await expect(aptos.indexerQuery({ query: '{ ping }' })).resolves.toEqual({ ping: 1 })
    expect(urls).toEqual(['https://idx1.example.com/v1/graphql', 'https://idx2.example.com/v1/graphql'])
  })

  test('graphql errors fail fast, rate-limit errors are retried', async () => {
    let calls = 0
    postSpy = jest.spyOn(axios, 'post').mockImplementation(async () => {
      calls++
      return { data: { errors: [{ message: 'field "nope" not found' }] } }
    })
    await expect(aptos.indexerQuery({ query: '{ nope }' })).rejects.toThrow(/field "nope" not found/)
    expect(calls).toBe(1)

    postSpy.mockRestore()
    calls = 0
    postSpy = jest.spyOn(axios, 'post').mockImplementation(async () => {
      calls++
      if (calls === 1) return { data: { errors: [{ message: 'rate limit exceeded' }] } }
      return { data: { data: { ok: true } } }
    })
    await expect(aptos.indexerQuery({ query: '{ ok }' })).resolves.toEqual({ ok: true })
    expect(calls).toBe(2)
  })

  test('getFungibleAssetBalances pads owners, chunks and paginates', async () => {
    const seenOwners: string[][] = []
    postSpy = jest.spyOn(axios, 'post').mockImplementation(async (_url: any, body: any) => {
      const { owners, offset, limit } = body.variables
      seenOwners.push(owners)
      // first chunk has two pages, second chunk one
      const rows = owners.length === 2 && offset === 0
        ? Array.from({ length: limit }, (_, i) => ({ owner_address: owners[0], asset_type: `0x${i}`, amount: 1 }))
        : [{ owner_address: owners[0], asset_type: '0xa', amount: '5' }]
      return { data: { data: { current_fungible_asset_balances: rows } } }
    })
    const res = await aptos.getFungibleAssetBalances({ owners: ['0x1', '0x2', '0x3'], chunkSize: 2, pageSize: 2 })
    expect(seenOwners[0]).toEqual([aptos.normalizeAddress('0x1'), aptos.normalizeAddress('0x2')])
    expect(seenOwners).toHaveLength(3) // chunk 1: 2 pages, chunk 2: 1 page
    expect(res).toHaveLength(2 + 1 + 1)
    expect(res[res.length - 1]).toEqual({ owner: aptos.normalizeAddress('0x3'), assetType: '0xa', amount: '5' })
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
