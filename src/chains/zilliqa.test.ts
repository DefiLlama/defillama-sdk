import {
  DEFAULT_ENDPOINTS, getEndpoints, bech32Decode, bech32Encode, isBech32Address, isHexAddress, toHexAddress, toBech32Address, qaToZil, initToObject,
  getAccount, getBalance, getContractInit, getContractSubState, getContractSubStates, getTokenBalance, getTokenBalances, getTokenTotalSupply, getTokenDecimals, getTokenInfo,
  getLatestBlock, getBlock,
} from "./zilliqa";

const ZUSDT = '0x818ca2e217e060ad17b7bd0124a483a1f66930a9'
const WZIL = '0x4306f921c982766810cf342775fd79aa2d0d0e24'
const STZIL = 'zil1umc54ly88xjw4599gtq860le0qvsuwuj72s246' // avely stzil, bech32
const PILLAR = '0x323e8105ba12d46e38d31cd674b6a2d16d76e6d1'

describe('chains.zilliqa pure helpers', () => {
  afterEach(() => {
    delete process.env.ZILLIQA_NATIVE_RPC
  })

  test('bech32 round trip', () => {
    const hex = toHexAddress(STZIL)
    expect(hex).toMatch(/^[0-9a-f]{40}$/)
    expect(bech32Encode('zil', Buffer.from(hex, 'hex'))).toBe(STZIL)
    expect(toBech32Address(hex)).toBe(STZIL)
    expect(toBech32Address('0x' + hex)).toBe(STZIL)
    expect(bech32Decode(STZIL.toUpperCase()).data.toString('hex')).toBe(hex)
  })

  test('bech32 rejects bad checksum and mixed case', () => {
    expect(() => bech32Decode(STZIL.slice(0, -1) + 'q')).toThrow(/checksum/)
    expect(() => bech32Decode('zil1' + STZIL.slice(4).toUpperCase())).toThrow(/mixed case/)
  })

  test('toHexAddress accepts 0x hex, bare hex and bech32', () => {
    expect(toHexAddress(ZUSDT)).toBe('818ca2e217e060ad17b7bd0124a483a1f66930a9')
    expect(toHexAddress('818CA2E217E060AD17B7BD0124A483A1F66930A9')).toBe('818ca2e217e060ad17b7bd0124a483a1f66930a9')
    expect(toHexAddress(toBech32Address(ZUSDT))).toBe('818ca2e217e060ad17b7bd0124a483a1f66930a9')
    expect(() => toHexAddress('0x1234')).toThrow()
    expect(() => toHexAddress('bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4')).toThrow()
  })

  test('isBech32Address / isHexAddress', () => {
    expect(isBech32Address(STZIL)).toBe(true)
    expect(isBech32Address(ZUSDT)).toBe(false)
    expect(isBech32Address('zil1short')).toBe(false)
    expect(isHexAddress(ZUSDT)).toBe(true)
    expect(isHexAddress('818ca2e217e060ad17b7bd0124a483a1f66930a9')).toBe(true)
    expect(isHexAddress(STZIL)).toBe(false)
  })

  test('qaToZil', () => {
    expect(qaToZil('1000000000000')).toBe(1)
    expect(qaToZil(1500000000000)).toBe(1.5)
  })

  test('initToObject', () => {
    expect(initToObject([{ vname: 'decimals', value: '6' }, { vname: 'symbol', value: 'zUSDT' }])).toEqual({ decimals: '6', symbol: 'zUSDT' })
  })

  test('endpoints: default, then ZILLIQA_NATIVE_RPC first', () => {
    expect(getEndpoints()).toEqual(DEFAULT_ENDPOINTS)
    process.env.ZILLIQA_NATIVE_RPC = 'https://zil.example.com'
    expect(getEndpoints()).toEqual(['https://zil.example.com', ...DEFAULT_ENDPOINTS])
  })
})

describe('chains.zilliqa live', () => {
  jest.setTimeout(60_000)

  test('getTokenInfo zUSDT: 6 decimals, symbol, positive supply', async () => {
    const info = await getTokenInfo({ token: ZUSDT })
    expect(info.contract).toBe(ZUSDT)
    expect(info.symbol).toBe('zUSDT')
    expect(info.decimals).toBe(6)
    expect(info.totalSupply).toMatch(/^\d+$/)
    expect(BigInt(info.totalSupply) > BigInt(0)).toBe(true)
    expect(await getTokenDecimals({ token: ZUSDT })).toBe(6)
    expect(await getTokenTotalSupply({ token: ZUSDT })).toBe(info.totalSupply)
  })

  test('getContractInit / getContractSubState', async () => {
    const init = await getContractInit({ contract: WZIL })
    expect(initToObject(init).decimals).toBe('12')
    const sub = await getContractSubState({ contract: WZIL, variable: 'total_supply' })
    expect(sub.total_supply).toMatch(/^\d+$/)
    expect(await getContractSubState({ contract: WZIL, variable: 'no_such_field' })).toBeNull()
  })

  test('bech32 contract address works against the API', async () => {
    const sub = await getContractSubState({ contract: STZIL, variable: 'totalstakeamount' })
    expect(sub.totalstakeamount).toMatch(/^\d+$/)
  })

  test('getContractSubStates batch keeps order and tolerates failures', async () => {
    const res = await getContractSubStates([
      { contract: WZIL, variable: 'total_supply' },
      { contract: STZIL, variable: 'totalstakeamount' },
      { contract: WZIL, variable: 'no_such_field' },
    ])
    expect(res[0].total_supply).toMatch(/^\d+$/)
    expect(res[1].totalstakeamount).toMatch(/^\d+$/)
    expect(res[2] === null || res[2] === undefined).toBe(true)
  })

  test('getTokenBalance / getTokenBalances', async () => {
    const one = await getTokenBalance({ token: WZIL, address: PILLAR })
    expect(one).toMatch(/^\d+$/)
    const many = await getTokenBalances({ tokens: [WZIL, ZUSDT], addresses: [PILLAR] })
    expect(many[WZIL][PILLAR]).toBe(one)
    expect(many[ZUSDT][PILLAR]).toMatch(/^\d+$/)
    expect(await getTokenBalance({ token: ZUSDT, address: '0x0000000000000000000000000000000000000002' })).toBe('0')
  })

  test('getAccount / getBalance', async () => {
    const account = await getAccount({ address: PILLAR })
    expect(account.balance).toMatch(/^\d+$/)
    expect(account.nonce).toBeGreaterThanOrEqual(0)
    expect(await getBalance({ address: PILLAR })).toBe(account.balance)
  })

  test('getLatestBlock / getBlock', async () => {
    const head = await getLatestBlock()
    expect(head.number).toBeGreaterThan(39_000_000)
    expect(head.timestamp).toBeGreaterThan(1_700_000_000)
    const same = await getBlock({ number: head.number })
    expect(same.hash).toBe(head.hash)
  })
})
