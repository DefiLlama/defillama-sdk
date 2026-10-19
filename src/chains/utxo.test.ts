import {
  CHAINS, utxoChains, isUtxoChain, getEndpoints, getChainConfig, PROVIDER_KINDS,
  toBaseUnits, fromBaseUnits, toBigInt, isBitcoinAddress, parseBlockstreamAddressStats, parseBalanceResponse,
  getBalance, getBalances, getLatestBlock, getBlockAtTimestamp, getBitcoinBalanceAt, getUtxos,
} from "./utxo";

const SATOSHI_GENESIS = '1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa'
const BINANCE_COLD = '34xp4vRoCGJym3xR7yCVPFHoCNxv4Twseo'
const BITFINEX_COLD = 'bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97'
const LTC_BITFINEX = 'LXTQdps2Pf83WdAXMinboiqLsEjSWrwJCD'
const DOGE_ADDRESS = 'DH5yaieqoZN36fDVciNyRueRGvGLR3mr7L'
// genesis coinbase address in cashaddr form (same key as SATOSHI_GENESIS)
const BCH_GENESIS_CASHADDR = 'bitcoincash:qp3wjpa3tjlj042z2wv7hahsldgwhwy0rq9sywjpyy'

const isNumericString = (s: any) => typeof s === 'string' && /^\d+$/.test(s)

describe('chains.utxo pure helpers', () => {
  afterEach(() => {
    delete process.env.BITCOIN_EXPLORER_API
    delete process.env.FOOCOIN_EXPLORER_API
    delete process.env.FOOCOIN_WHITELISTED_RPC
    delete process.env.FOOCOIN_DECIMALS
    delete process.env.FOOCOIN_EXPLORER_PROVIDER
  })

  test('config covers the ported chains', () => {
    for (const chain of ['bitcoin', 'bitcoincash', 'litecoin', 'doge', 'dash', 'bsv', 'zcash', 'kaspa', 'mvc']) {
      expect(utxoChains).toContain(chain)
      expect(CHAINS[chain].decimals).toBe(8)
      expect(CHAINS[chain].endpoints.length).toBeGreaterThan(0)
      expect(CHAINS[chain].concurrency).toBeGreaterThan(0)
    }
  })

  test('isUtxoChain', () => {
    expect(isUtxoChain('bitcoin')).toBe(true)
    expect(isUtxoChain('doge')).toBe(true)
    expect(isUtxoChain('ethereum')).toBe(false)
    expect(isUtxoChain('toString')).toBe(false)
    expect(isUtxoChain(undefined)).toBe(false)
  })

  test('isBitcoinAddress', () => {
    expect(isBitcoinAddress('bc1qar0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(true)
    expect(isBitcoinAddress('bc1qgdjqv0av3q56jvd82tkdjpy7gdp9ut8tlqmgrpmv24sq90ecnvqqjwvw97')).toBe(true)
    expect(isBitcoinAddress(SATOSHI_GENESIS)).toBe(true)
    expect(isBitcoinAddress(BINANCE_COLD)).toBe(true)
    expect(isBitcoinAddress('garbage')).toBe(false)
    expect(isBitcoinAddress('bc1qAr0srrr7xfkvy5l643lydnw9re59gtzzwf5mdq')).toBe(false) // mixed case bech32
    expect(isBitcoinAddress('0x0000000000000000000000000000000000000000')).toBe(false)
    expect(isBitcoinAddress(LTC_BITFINEX)).toBe(false)
    expect(isBitcoinAddress(undefined)).toBe(false)
  })

  test('toBaseUnits / fromBaseUnits', () => {
    expect(toBaseUnits('1.5', 8)).toBe('150000000')
    expect(toBaseUnits(1.5, 8)).toBe('150000000')
    expect(toBaseUnits('0.00000001', 8)).toBe('1')
    expect(toBaseUnits('.5', 8)).toBe('50000000')
    expect(toBaseUnits('-2', 8)).toBe('-200000000')
    expect(toBaseUnits('0', 8)).toBe('0')
    expect(toBaseUnits('1.123456789', 8)).toBe('112345678') // truncates
    expect(toBaseUnits('2e-3', 8)).toBe('200000')
    expect(toBaseUnits(BigInt(3), 8)).toBe('300000000')
    expect(toBaseUnits('21000000', 8)).toBe('2100000000000000')
    expect(() => toBaseUnits('abc', 8)).toThrow()
    expect(fromBaseUnits('150000000', 8)).toBe(1.5)
    expect(fromBaseUnits(1, 8)).toBe(1e-8)
    expect(fromBaseUnits(BigInt(0), 8)).toBe(0)
    expect(toBigInt('12.9')).toBe(BigInt(12))
    expect(toBigInt('')).toBe(BigInt(0))
  })

  test('parseBlockstreamAddressStats', () => {
    const stats = parseBlockstreamAddressStats({
      address: SATOSHI_GENESIS,
      chain_stats: { funded_txo_count: 3, funded_txo_sum: 1000, spent_txo_count: 1, spent_txo_sum: 250, tx_count: 4 },
      mempool_stats: { funded_txo_count: 1, funded_txo_sum: 40, spent_txo_count: 0, spent_txo_sum: 0, tx_count: 1 },
    })
    expect(stats).toEqual({ address: SATOSHI_GENESIS, confirmed: '750', unconfirmed: '40', total: '790', txCount: 4 })
    expect(parseBlockstreamAddressStats({ chain_stats: { funded_txo_sum: 5, spent_txo_sum: 0 } }).confirmed).toBe('5')
    expect(() => parseBlockstreamAddressStats({})).toThrow()
    expect(() => parseBlockstreamAddressStats({ chain_stats: {} })).toThrow()
  })

  test('parseBalanceResponse handles every provider dialect', () => {
    const opts = { address: 'addr', decimals: 8 }
    expect(parseBalanceResponse({ chain_stats: { funded_txo_sum: 10, spent_txo_sum: 3 } }, opts)).toBe('7')
    expect(parseBalanceResponse({ balance: 90, final_balance: 100 }, opts)).toBe('90') // blockcypher
    expect(parseBalanceResponse({ final_balance: 100 }, opts)).toBe('100')
    expect(parseBalanceResponse({ balance: 1.5, balanceSat: 150000000 }, opts)).toBe('150000000') // insight
    expect(parseBalanceResponse({ confirmed: 12, unconfirmed: 5 }, opts)).toBe('12') // whatsonchain / mvc
    expect(parseBalanceResponse({ address: 'addr', confirmed: 7699899464, unconfirmed: 0, utxo: 1233, txs: 1232, received: 7699899464 }, opts)).toBe('7699899464') // haskoin
    expect(parseBalanceResponse({ data: { addr: { address: { balance: 42 } } } }, opts)).toBe('42') // blockchair
    expect(parseBalanceResponse({ incoming: '10.5', outgoing: '0.25' }, opts)).toBe('1025000000') // tatum
    expect(parseBalanceResponse({ balance: '123456' }, opts)).toBe('123456') // blockbook v2 / kaspa
    expect(() => parseBalanceResponse({ confirmed: undefined, foo: 1 }, opts)).toThrow()
    expect(() => parseBalanceResponse({ data: { addr: null } }, opts)).toThrow()
    expect(() => parseBalanceResponse(null, opts)).toThrow()
  })

  test('defaults are used when no env is set', () => {
    expect(getEndpoints()).toEqual(CHAINS.bitcoin.endpoints)
    expect(getEndpoints({ chain: 'doge' })).toEqual(CHAINS.doge.endpoints)
    expect(() => getEndpoints({ chain: 'ethereum' })).toThrow()
  })

  test('BITCOIN_EXPLORER_API env endpoints come first, defaults are kept as fallbacks', () => {
    process.env.BITCOIN_EXPLORER_API = 'https://esplora.example.com/api, https://esplora2.example.com/api'
    expect(getEndpoints({ chain: 'bitcoin' })).toEqual(['https://esplora.example.com/api', 'https://esplora2.example.com/api', ...CHAINS.bitcoin.endpoints])
    expect(getEndpoints({ chain: 'litecoin' })).toEqual(CHAINS.litecoin.endpoints)
    delete process.env.BITCOIN_EXPLORER_API
    expect(getEndpoints({ chain: 'bitcoin' })).toEqual(CHAINS.bitcoin.endpoints)
  })

  test('unknown chains are rejected unless enabled through env', () => {
    expect(isUtxoChain('foocoin')).toBe(false)
    expect(() => getChainConfig('foocoin')).toThrow(/FOOCOIN_EXPLORER_API/)
    expect(() => getEndpoints({ chain: 'foocoin' })).toThrow()

    process.env.FOOCOIN_EXPLORER_API = 'https://esplora.foocoin.example/api, https://blockbook.foocoin.example/api/v2'
    expect(isUtxoChain('foocoin')).toBe(true)
    expect(utxoChains).not.toContain('foocoin')
    expect(getEndpoints({ chain: 'foocoin' })).toEqual(['https://esplora.foocoin.example/api', 'https://blockbook.foocoin.example/api/v2'])
    const config = getChainConfig('foocoin')
    expect(config.decimals).toBe(8)
    expect(config.provider).toBe('esplora')
    expect(config.concurrency).toBeGreaterThan(0)

    process.env.FOOCOIN_DECIMALS = '6'
    process.env.FOOCOIN_EXPLORER_PROVIDER = 'Blockbook'
    expect(getChainConfig('foocoin')).toMatchObject({ decimals: 6, provider: 'blockbook' })

    process.env.FOOCOIN_EXPLORER_PROVIDER = 'nope'
    expect(() => getChainConfig('foocoin')).toThrow(/FOOCOIN_EXPLORER_PROVIDER/)
    delete process.env.FOOCOIN_EXPLORER_PROVIDER
    process.env.FOOCOIN_DECIMALS = 'eight'
    expect(() => getChainConfig('foocoin')).toThrow(/FOOCOIN_DECIMALS/)
  })

  test('a whitelisted rpc alone enables an env chain', () => {
    process.env.FOOCOIN_WHITELISTED_RPC = 'https://private.foocoin.example/api'
    expect(isUtxoChain('foocoin')).toBe(true)
    expect(getEndpoints({ chain: 'foocoin' })).toEqual(['https://private.foocoin.example/api'])
  })

  test('provider kinds list matches the config type', () => {
    expect(PROVIDER_KINDS).toContain('haskoin')
    expect(PROVIDER_KINDS).toContain('esplora')
    expect(isUtxoChain('toString')).toBe(false)
    expect(isUtxoChain('__proto__')).toBe(false)
  })
})

describe('chains.utxo live (public explorers)', () => {
  jest.setTimeout(60_000)

  test('getBalance bitcoin genesis address', async () => {
    const balance = await getBalance({ chain: 'bitcoin', address: SATOSHI_GENESIS })
    expect(isNumericString(balance)).toBe(true)
    expect(Number(balance)).toBeGreaterThan(50e8)
  })

  test('getBalances bitcoin returns every address', async () => {
    const balances = await getBalances({ chain: 'bitcoin', addresses: [SATOSHI_GENESIS, BINANCE_COLD] })
    expect(Object.keys(balances).sort()).toEqual([SATOSHI_GENESIS, BINANCE_COLD].sort())
    expect(isNumericString(balances[SATOSHI_GENESIS])).toBe(true)
    expect(Number(balances[SATOSHI_GENESIS])).toBeGreaterThan(50e8)
    expect(isNumericString(balances[BINANCE_COLD])).toBe(true)
  })

  test('getLatestBlock bitcoin', async () => {
    const block = await getLatestBlock({ chain: 'bitcoin' })
    expect(block.number).toBeGreaterThan(800000)
    expect(block.timestamp).toBeGreaterThan(1700000000)
    expect(block.hash).toMatch(/^[0-9a-f]{64}$/)
  })

  test('getBlockAtTimestamp bitcoin 1700000000', async () => {
    const block = await getBlockAtTimestamp({ chain: 'bitcoin', timestamp: 1700000000 })
    expect(block.number).toBeGreaterThanOrEqual(815000)
    expect(block.number).toBeLessThanOrEqual(818000)
    expect(block.timestamp).toBeLessThanOrEqual(1700000000)
  })

  test('getUtxos / getBitcoinBalanceAt (recent) agree with getBalance', async () => {
    // blockstream rejects /utxo for addresses with too many outputs (genesis address), so use a small one
    const utxos = await getUtxos({ chain: 'bitcoin', address: BITFINEX_COLD })
    expect(utxos.length).toBeGreaterThan(0)
    expect(isNumericString(utxos[0].value)).toBe(true)
    const recent = await getBitcoinBalanceAt({ address: BITFINEX_COLD, timestamp: Math.floor(Date.now() / 1e3) })
    const now = await getBalance({ chain: 'bitcoin', address: BITFINEX_COLD })
    expect(isNumericString(recent)).toBe(true)
    expect(recent).toBe(now)
  })

  test('getBalance litecoin', async () => {
    const balance = await getBalance({ chain: 'litecoin', address: LTC_BITFINEX })
    expect(isNumericString(balance)).toBe(true)
  })

  test('getBalance doge', async () => {
    const balance = await getBalance({ chain: 'doge', address: DOGE_ADDRESS })
    expect(isNumericString(balance)).toBe(true)
  })

  test('getBalance zcash (ECC dev fund address, transparent)', async () => {
    const balance = await getBalance({ chain: 'zcash', address: 't3LmX1cxWPPPqL4TZHx42HU3U5ghbFjRiif' })
    expect(isNumericString(balance)).toBe(true)
  })

  test('getBalance bitcoincash accepts cashaddr and legacy forms of the genesis address', async () => {
    const cashaddr = await getBalance({ chain: 'bitcoincash', address: BCH_GENESIS_CASHADDR })
    expect(isNumericString(cashaddr)).toBe(true)
    expect(Number(cashaddr)).toBeGreaterThan(50e8)
    const legacy = await getBalance({ chain: 'bitcoincash', address: SATOSHI_GENESIS })
    expect(legacy).toBe(cashaddr)
  })
})
