import * as cosmos from "./cosmos";
import { isCosmosChain as legacyIsCosmosChain, getCosmosBlock as legacyGetCosmosBlock, getCosmosProvider as legacyGetCosmosProvider } from "../util/cosmos";

const ENV_KEYS = ['OSMOSIS_LCD', 'OSMOSIS_RPC', 'KAVA_RPC', 'KAVA_LCD', 'CRONOS_RPC', 'FOOCHAIN_LCD', 'FOOCHAIN_RPC', 'FOOCHAIN_TENDERMINT_RPC']

function clearEnv() {
  ENV_KEYS.forEach(k => { delete process.env[k]; delete process.env['SDK_' + k]; delete process.env['LLAMA_SDK_' + k] })
}

describe('chains.cosmos endpoints (offline)', () => {
  beforeEach(clearEnv)
  afterEach(clearEnv)

  test('DEFAULT_ENDPOINTS is a merged map with the well known chains', () => {
    const chains = Object.keys(cosmos.DEFAULT_ENDPOINTS)
    expect(chains.length).toBeGreaterThan(50)
    for (const c of ['osmosis', 'cosmos', 'terra', 'terra2', 'neutron', 'injective', 'sei', 'kava', 'noble', 'celestia', 'dydx', 'provenance'])
      expect(chains).toContain(c)
  })

  test('module defaults are used when no env is set, comma separated values are fallbacks', () => {
    const list = cosmos.getEndpoints({ chain: 'osmosis' })
    expect(list.length).toBeGreaterThan(1)
    expect(list[0]).toBe('https://rest-osmosis.ecostake.com')
    expect(cosmos.getEndpoint({ chain: 'osmosis' })).toBe('https://rest-osmosis.ecostake.com')
  })

  test('<CHAIN>_LCD wins over everything', () => {
    process.env.OSMOSIS_LCD = 'https://lcd-env.io, https://lcd-env2.io'
    process.env.OSMOSIS_RPC = 'https://rpc-env.io'
    expect(cosmos.getEndpoints({ chain: 'osmosis' })).toEqual(['https://lcd-env.io', 'https://lcd-env2.io'])
    expect(cosmos.getEndpoint({ chain: 'osmosis' })).toBe('https://lcd-env.io')
  })

  test('SDK_ prefixed <CHAIN>_LCD is honoured', () => {
    process.env.SDK_OSMOSIS_LCD = 'https://sdk-lcd.io'
    expect(cosmos.getEndpoints({ chain: 'osmosis' })).toEqual(['https://sdk-lcd.io'])
  })

  test('<CHAIN>_RPC is honoured for a non-EVM chain when <CHAIN>_LCD is unset (legacy behaviour)', () => {
    process.env.OSMOSIS_RPC = 'https://rpc-env.io'
    expect(cosmos.getEndpoints({ chain: 'osmosis' })).toEqual(['https://rpc-env.io'])
  })

  test('<CHAIN>_RPC is ignored for EVM chains (kava, cronos) - it points at their EVM json-rpc', () => {
    process.env.KAVA_RPC = 'https://evm.kava.io'
    process.env.CRONOS_RPC = 'https://evm.cronos.org'
    expect(cosmos.getEndpoints({ chain: 'kava' })).toEqual(['https://api2.kava.io'])
    expect(cosmos.getEndpoints({ chain: 'cronos' })).toEqual(['https://rest.mainnet.crypto.org'])
    process.env.KAVA_LCD = 'https://lcd.kava.io'
    expect(cosmos.getEndpoints({ chain: 'kava' })).toEqual(['https://lcd.kava.io'])
  })

  test('unknown chain falls back to rest.cosmos.directory', () => {
    expect(cosmos.getEndpoints({ chain: 'foochain' })).toEqual(['https://rest.cosmos.directory/foochain'])
    expect(cosmos.getEndpoint({ chain: 'foochain' })).toBe('https://rest.cosmos.directory/foochain')
    process.env.FOOCHAIN_RPC = 'https://foo-rpc.io'
    expect(cosmos.getEndpoints({ chain: 'foochain' })).toEqual(['https://foo-rpc.io'])
    process.env.FOOCHAIN_LCD = 'https://foo-lcd.io'
    expect(cosmos.getEndpoints({ chain: 'foochain' })).toEqual(['https://foo-lcd.io'])
  })

  test('getEndpoint honours highGasLimitEndpoints for a contract', () => {
    cosmos.highGasLimitEndpoints['osmo1highgascontract'] = 'https://high-gas.io'
    try {
      expect(cosmos.getEndpoint({ chain: 'osmosis', contract: 'osmo1highgascontract' })).toBe('https://high-gas.io')
      expect(cosmos.getEndpoint({ chain: 'osmosis', contract: 'osmo1other' })).toBe('https://rest-osmosis.ecostake.com')
    } finally {
      delete cosmos.highGasLimitEndpoints['osmo1highgascontract']
    }
  })

  test('tendermint endpoints: env then rpc.cosmos.directory', () => {
    expect(cosmos.tendermint.getEndpoints({ chain: 'foochain' })).toEqual(['https://rpc.cosmos.directory/foochain'])
    process.env.FOOCHAIN_TENDERMINT_RPC = 'https://tm.io'
    expect(cosmos.tendermint.getEndpoints({ chain: 'foochain' })).toEqual(['https://tm.io'])
  })
})

describe('chains.cosmos helpers (offline)', () => {
  test('isCosmosChain', () => {
    for (const c of ['cosmos', 'osmosis', 'terra', 'terra2', 'injective', 'neutron', 'noble', 'celestia', 'akash'])
      expect(cosmos.isCosmosChain(c)).toBe(true)
    // dual EVM chains keep using the EVM provider for blocks
    for (const c of ['kava', 'cronos', 'evmos', 'sei', 'ethereum', 'solana', 'foochain'])
      expect(cosmos.isCosmosChain(c)).toBe(false)
    expect(legacyIsCosmosChain).toBe(cosmos.isCosmosChain)
    expect(legacyGetCosmosBlock).toBe(cosmos.getCosmosBlock)
    expect(legacyGetCosmosProvider).toBe(cosmos.getCosmosProvider)
  })

  test('isContractAddress', () => {
    expect(cosmos.isContractAddress('terra2', 'terra1nsuqsk6kh58ulczatwev87ttq2z6r3pusulg9r24mfj2fvtzd4uq3exn26')).toBe(true)
    expect(cosmos.isContractAddress('osmosis', 'osmo1jv65s3grqf6v6jl3dp4t6c9t9rk99cd80yhvld')).toBe(false)
    expect(cosmos.isContractAddress('cosmos', 'cosmos1jv65s3grqf6v6jl3dp4t6c9t9rk99cd88lyufl')).toBe(false)
    expect(cosmos.isContractAddress('osmosis', 'uosmo')).toBe(false)
    expect(cosmos.isContractAddress('osmosis', 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2')).toBe(false)
    // wrong chain prefix
    expect(cosmos.isContractAddress('osmosis', 'terra1nsuqsk6kh58ulczatwev87ttq2z6r3pusulg9r24mfj2fvtzd4uq3exn26')).toBe(false)
    // unknown chain falls back to the chain name as prefix
    expect(cosmos.isContractAddress('foochain', 'foochain1' + 'q'.repeat(58))).toBe(true)
  })

  test('encodeQuery', () => {
    expect(cosmos.encodeQuery({ token_info: {} })).toBe('eyJ0b2tlbl9pbmZvIjp7fX0=')
    expect(cosmos.encodeQuery('{"token_info":{}}')).toBe('eyJ0b2tlbl9pbmZvIjp7fX0=')
  })

  test('parseBlockTime handles nanosecond precision', () => {
    expect(cosmos.parseBlockTime('2026-09-21T20:20:38.937653764Z')).toBe(Math.floor(Date.parse('2026-09-21T20:20:38.937Z') / 1000))
    expect(cosmos.parseBlockTime('2026-09-21T20:20:38Z')).toBe(Math.floor(Date.parse('2026-09-21T20:20:38Z') / 1000))
  })

  test('chainSubpaths', () => {
    expect(cosmos.chainSubpaths.osmosis).toBe('osmosis')
    expect(cosmos.chainSubpaths.kava).toBe('kava')
    expect(cosmos.chainSubpaths.cosmos).toBeUndefined()
  })
})

describe('chains.cosmos live', () => {
  const now = () => Math.floor(Date.now() / 1000)

  test('totalSupply osmosis uosmo', async () => {
    const supply = await cosmos.totalSupply({ chain: 'osmosis', denom: 'uosmo' })
    expect(typeof supply).toBe('string')
    expect(/^\d+$/.test(supply)).toBe(true)
    expect(Number(supply)).toBeGreaterThan(0)
  })

  test('getDenomBalance / getBalance / getBalances for the cosmos hub distribution module account', async () => {
    const owner = 'cosmos1jv65s3grqf6v6jl3dp4t6c9t9rk99cd88lyufl'
    const balance = await cosmos.getDenomBalance({ chain: 'cosmos', denom: 'uatom', owner })
    expect(/^\d+$/.test(balance)).toBe(true)
    expect(Number(balance)).toBeGreaterThan(0)
    const viaGetBalance = await cosmos.getBalance({ chain: 'cosmos', token: 'uatom', owner })
    expect(/^\d+$/.test(viaGetBalance)).toBe(true)
    const all = await cosmos.getBalances({ chain: 'cosmos', owner })
    expect(Array.isArray(all)).toBe(true)
    expect(all.find(i => i.denom === 'uatom')).toBeTruthy()
    expect(await cosmos.getDenomBalance({ chain: 'cosmos', denom: 'udoesnotexist', owner })).toBe('0')
  })

  test('queryContract / getTokenInfo cw20 token_info on terra2 ASTRO', async () => {
    const contract = 'terra1nsuqsk6kh58ulczatwev87ttq2z6r3pusulg9r24mfj2fvtzd4uq3exn26'
    const info = await cosmos.queryContract({ chain: 'terra2', contract, data: { token_info: {} } })
    expect(info.decimals).toBe(6)
    expect(info.symbol).toBe('ASTRO')
    const info2 = await cosmos.getTokenInfo({ chain: 'terra2', contract })
    expect(info2.decimals).toBe(6)
    const [many] = await cosmos.queryManyContracts({ chain: 'terra2', contracts: [contract], data: { token_info: {} } })
    expect(many.decimals).toBe(6)
    const withRetries = await cosmos.queryContractWithRetries({ chain: 'terra2', contract, data: { token_info: {} } })
    expect(withRetries.decimals).toBe(6)
    const contractInfo = await cosmos.getContractInfo({ chain: 'terra2', contract })
    expect(Number(contractInfo.code_id)).toBeGreaterThan(0)
  })

  test('getLatestBlock cosmos', async () => {
    const block = await cosmos.getLatestBlock({ chain: 'cosmos' })
    expect(block.number).toBeGreaterThan(0)
    expect(block.timestamp).toBeGreaterThan(now() - 24 * 3600)
    expect(block.timestamp).toBeLessThanOrEqual(now() + 60)
  })

  test('isPrunedHeightError distinguishes pruned heights from missing routes', () => {
    // a bare 404 may be an LCD without the v1beta1 route, it must NOT count as pruned
    expect(cosmos.isPrunedHeightError({ response: { status: 404, data: { message: 'Not Found' } } })).toBe(false)
    expect(cosmos.isPrunedHeightError(new Error('[host: x] [404] Not Found'))).toBe(false)
    expect(cosmos.isPrunedHeightError({ response: { status: 500, data: { message: 'height 5 is not available, lowest height is 69555892' } } })).toBe(true)
    expect(cosmos.isPrunedHeightError(new Error('height 999999999999 must be less than or equal to the current blockchain height 12345'))).toBe(true)
    expect(cosmos.isPrunedHeightError(new Error('could not find results for height 5'))).toBe(true)
    expect(cosmos.isPrunedHeightError(Object.assign(new Error('block 5 not found on any route'), { cosmosBlockMissing: true }))).toBe(true)
  })

  test('getBlockTime for a pruned height is null instead of throwing', async () => {
    expect(await cosmos.getBlockTime({ chain: 'osmosis', height: 1 })).toBeNull()
  })

  test('getBlockAtTimestamp osmosis returns the last block at or before the timestamp', async () => {
    // 3 days ago rounded to the hour - fixed within a test run and inside the public nodes' retention window
    const timestamp = Math.floor((now() - 3 * 24 * 3600) / 3600) * 3600
    const block = await cosmos.getBlockAtTimestamp({ chain: 'osmosis', timestamp })
    expect(block.timestamp).toBeLessThanOrEqual(timestamp)
    const [same, next] = await Promise.all([
      cosmos.getBlock({ chain: 'osmosis', height: block.number }),
      cosmos.getBlock({ chain: 'osmosis', height: block.number + 1 }),
    ])
    expect(same.timestamp).toBe(block.timestamp)
    expect(next.timestamp).toBeGreaterThan(timestamp)
  })

  test('legacy getCosmosBlock / getCosmosProvider still work', async () => {
    const block = await legacyGetCosmosBlock('latest', 'cosmos')
    expect(block.number).toBeGreaterThan(0)
    expect(block.timestamp).toBeGreaterThan(now() - 24 * 3600)
    const viaProvider = await legacyGetCosmosProvider('cosmos').getBlock(block.number)
    expect(viaProvider.number).toBe(block.number)
    expect(viaProvider.timestamp).toBe(block.timestamp)
  })
})
