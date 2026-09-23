import {
  Address, parseAddress, normalizeAddress, toRawAddress, isAddress, compareAddress, addressToInt, convertIntToAddress,
  crc16, BitReader, parseBoc, readAddressFromSlice, tryReadAddressFromSlice, serializeAddress, decodeBase64, decodeStackItem,
  DEFAULT_ENDPOINTS, getToncenterEndpoint, getTonapiEndpoint,
  getJettonMaster, getJettonSupply, getTonBalance, getMasterchainInfo, call, getJettonBalances, jettonBalancesByAddress,
} from "./ton";

const USDT = 'EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs'
const USDT_RAW = '0:b113a994b5024a16719f69139328eb759596c38a25f59028b146fecdc3621dfe'
const USDT_NON_BOUNCEABLE = 'UQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_p0p'

/** single-cell BoC whose data is `addr_std$10 anycast:0 wc:int8 hash:bits256` (what runGetMethod returns for a slice) */
function buildAddressBoc(address: string): string {
  const addr = Address.parse(address)
  const bits: number[] = [1, 0, 0]
  const wc = addr.workChain & 0xff
  for (let i = 7; i >= 0; i--) bits.push((wc >> i) & 1)
  for (const byte of addr.hash) for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  // 267 data bits -> completion tag then zero padding up to 272
  bits.push(1)
  while (bits.length % 8) bits.push(0)
  const data = Buffer.alloc(bits.length / 8)
  bits.forEach((b, i) => { if (b) data[i >> 3] |= 1 << (7 - (i & 7)) })
  const d1 = 0 // no refs, not exotic, level 0
  const d2 = Math.floor(267 / 8) + Math.ceil(267 / 8) // 33 + 34
  const cell = Buffer.concat([Buffer.from([d1, d2]), data])
  const header = Buffer.from([0xb5, 0xee, 0x9c, 0x72, 0x01 /* size=1, no idx/crc */, 0x01 /* offBytes */, 1 /* cells */, 1 /* roots */, 0 /* absent */, cell.length, 0 /* root idx */])
  return Buffer.concat([header, cell]).toString('base64')
}

describe('chains.ton codec', () => {
  test('crc16 known vector (xmodem of "abc")', () => {
    expect(crc16(Buffer.from('abc'))).toBe(0x9dd6)
    expect(crc16(Buffer.alloc(0))).toBe(0)
  })

  test('Address parses friendly form and round trips', () => {
    const a = Address.parse(USDT)
    expect(a.workChain).toBe(0)
    expect(a.toRawString()).toBe(USDT_RAW)
    expect(a.toString()).toBe(USDT)
    expect(parseAddress(USDT).equals(a)).toBe(true)
    expect(toRawAddress(USDT)).toBe(USDT_RAW)
  })

  test('non-bounceable form differs but parses to the same raw address', () => {
    const nb = normalizeAddress(USDT, { bounceable: false })
    expect(nb).toBe(USDT_NON_BOUNCEABLE)
    expect(nb).not.toBe(USDT)
    expect(nb.startsWith('UQ')).toBe(true)
    const parsed = Address.parseFriendly(nb)
    expect(parsed.isBounceable).toBe(false)
    expect(parsed.isTestOnly).toBe(false)
    expect(parsed.address.toRawString()).toBe(USDT_RAW)
    expect(Address.parseFriendly(USDT).isBounceable).toBe(true)
  })

  test('raw form parses and normalises back to friendly; url-unsafe base64 supported', () => {
    expect(normalizeAddress(USDT_RAW)).toBe(USDT)
    expect(normalizeAddress(USDT_RAW.toUpperCase().replace('0:', '0:'))).toBe(USDT)
    const std = Address.parse(USDT).toString({ urlSafe: false })
    expect(std).toBe(USDT.replace(/-/g, '+').replace(/_/g, '/'))
    expect(Address.parse(std).toString()).toBe(USDT)
  })

  test('test-only flag and masterchain workchain round trip', () => {
    const a = Address.parse(USDT)
    const t = a.toString({ testOnly: true })
    expect(t).not.toBe(USDT)
    const parsed = Address.parseFriendly(t)
    expect(parsed.isTestOnly).toBe(true)
    expect(parsed.address.equals(a)).toBe(true)
    const mc = Address.parseRaw('-1:' + '00'.repeat(31) + '01')
    expect(mc.workChain).toBe(-1)
    expect(Address.parse(mc.toString()).workChain).toBe(-1)
    expect(Address.parse(mc.toString()).toRawString()).toBe(mc.toRawString())
  })

  test('isAddress rejects garbage and bad checksums', () => {
    expect(isAddress(USDT)).toBe(true)
    expect(isAddress(USDT_RAW)).toBe(true)
    expect(isAddress('0x1234')).toBe(false)
    expect(isAddress('not an address')).toBe(false)
    expect(isAddress('')).toBe(false)
    expect(isAddress(undefined)).toBe(false)
    expect(isAddress('EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDa')).toBe(false) // checksum flipped
    expect(isAddress('x'.repeat(48))).toBe(false)
    expect(isAddress('0:' + 'zz'.repeat(32))).toBe(false)
    expect(() => Address.parse('garbage')).toThrow(/Unknown address type/)
  })

  test('compareAddress friendly vs raw vs non-bounceable', () => {
    expect(compareAddress(USDT, USDT_RAW)).toBe(true)
    expect(compareAddress(USDT, USDT_NON_BOUNCEABLE)).toBe(true)
    expect(compareAddress(USDT, Address.parse(USDT))).toBe(true)
    expect(compareAddress(USDT, '0:' + '00'.repeat(32))).toBe(false)
    expect(compareAddress(USDT, 'garbage')).toBe(false)
    expect(compareAddress(undefined, USDT)).toBe(false)
  })

  test('addressToInt / convertIntToAddress round trip', () => {
    const n = addressToInt(USDT)
    expect(typeof n).toBe('bigint')
    expect(n).toBe(BigInt('0x' + USDT_RAW.slice(2)))
    expect(convertIntToAddress(n).toString()).toBe(USDT)
    expect(convertIntToAddress(n.toString()).toRawString()).toBe(USDT_RAW)
    expect(convertIntToAddress(BigInt(1)).toRawString()).toBe('0:' + '00'.repeat(31) + '01')
    expect(convertIntToAddress(BigInt(1), -1).workChain).toBe(-1)
  })

  test('BitReader reads bits msb first across byte boundaries', () => {
    const r = new BitReader(Buffer.from([0b10110010, 0xff, 0x00, 0x80]))
    expect(r.readBit()).toBe(1)
    expect(r.readBits(3)).toBe(0b011)
    expect(r.readBits(4)).toBe(0b0010)
    expect(r.byteOffset).toBe(1)
    expect(r.readBits(12)).toBe(0xff0)
    expect(r.bitOffset).toBe(4)
    expect(r.readInt(8)).toBe(8) // 0000 1000
    expect(r.remainingBits).toBe(4)
    expect(() => r.readBits(8)).toThrow(/overflow/)
    const s = new BitReader(Buffer.from([0xff]))
    expect(s.readInt(8)).toBe(-1)
    const big = new BitReader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]))
    expect(big.readBigUint(64)).toBe(BigInt('0xffffffffffffffff'))
    expect(new BitReader(Buffer.from([0x12, 0x34])).readBytes(2)).toEqual(Buffer.from([0x12, 0x34]))
  })

  test('parseBoc and readAddressFromSlice decode an addr_std cell', () => {
    const boc = buildAddressBoc(USDT)
    const parsed = parseBoc(decodeBase64(boc))
    expect(parsed.cells).toBe(1)
    expect(parsed.roots).toBe(1)
    expect(parsed.root).toEqual([0])
    expect(parsed.cellData.length).toBe(36)
    expect(readAddressFromSlice(boc)).toBe(USDT)
    const mc = Address.parseRaw('-1:' + 'ab'.repeat(32))
    expect(readAddressFromSlice(buildAddressBoc(mc.toString()))).toBe(mc.toString())
    expect(() => parseBoc(Buffer.from([1, 2, 3, 4, 5]))).toThrow(/magic/)
    expect(tryReadAddressFromSlice('AAAA')).toBeNull()
  })

  test('serializeAddress matches Address.toString', () => {
    const a = Address.parse(USDT)
    expect(serializeAddress(a.workChain, a.hash)).toBe(USDT)
    expect(serializeAddress(a.workChain, a.hash, { bounceable: false })).toBe(USDT_NON_BOUNCEABLE)
  })

  test('decodeStackItem: num -> number / bigint, cell -> address, others raw', () => {
    expect(decodeStackItem(['num', '0x10'])).toBe(16)
    expect(decodeStackItem(['num', '-0x1'])).toBe(-1)
    expect(decodeStackItem(['num', '0x' + 'f'.repeat(32)])).toBe(BigInt('0x' + 'f'.repeat(32)))
    expect(decodeStackItem(['cell', { bytes: buildAddressBoc(USDT) }])).toBe(USDT)
    expect(decodeStackItem(['slice', buildAddressBoc(USDT)])).toBe(USDT)
    const tuple: [string, any] = ['tuple', { elements: [] }]
    expect(decodeStackItem(tuple)).toBe(tuple)
    const junkCell: [string, any] = ['cell', { bytes: 'AAAA' }]
    expect(decodeStackItem(junkCell)).toBe(junkCell)
  })

  test('jettonBalancesByAddress re-keys tonapi balances', () => {
    const res = jettonBalancesByAddress([
      { balance: '5', price: { prices: { USD: 1.5 } }, wallet_address: { address: '0:1' }, jetton: { address: '0:abc', name: 'x', symbol: 'X', decimals: 9 } },
    ])
    expect(res['0:abc']).toEqual({ balance: '5', price: 1.5, decimals: 9 })
  })
})

describe('chains.ton config', () => {
  afterEach(() => {
    delete process.env.TON_RPC
    delete process.env.TON_API_RPC
  })

  test('defaults', () => {
    expect(getToncenterEndpoint()).toBe(DEFAULT_ENDPOINTS.toncenter)
    expect(getTonapiEndpoint()).toBe(DEFAULT_ENDPOINTS.tonapi)
  })

  test('TON_RPC / TON_API_RPC override defaults', () => {
    process.env.TON_RPC = 'https://toncenter.example.com'
    process.env.TON_API_RPC = 'https://tonapi.example.com,https://tonapi2.example.com'
    expect(getToncenterEndpoint()).toBe('https://toncenter.example.com')
    expect(getTonapiEndpoint()).toBe('https://tonapi.example.com')
  })
})

describe('chains.ton live', () => {
  jest.setTimeout(60_000)
  let master: any

  test('getJettonMaster USDT has supply and 6 decimals', async () => {
    master = await getJettonMaster({ address: USDT })
    expect(compareAddress(master.address, USDT)).toBe(true)
    expect(Number(master.total_supply)).toBeGreaterThan(0)
    expect(Number(master.jetton_content?.decimals)).toBe(6)
  })

  test('getJettonSupply returns supply string and decimals 6', async () => {
    const { supply, decimals } = await getJettonSupply({ address: USDT })
    expect(supply).toMatch(/^\d+$/)
    expect(decimals).toBe(6)
  })

  test('getTonBalance of USDT master is a numeric string', async () => {
    const balance = await getTonBalance({ address: USDT })
    expect(balance).toMatch(/^\d+$/)
  })

  test('getMasterchainInfo last seqno > 0', async () => {
    const info = await getMasterchainInfo()
    expect(Number(info.last.seqno)).toBeGreaterThan(0)
  })

  test('call get_jetton_data matches the indexed supply and decodes the admin address', async () => {
    const stack = await call({ target: USDT, method: 'get_jetton_data' })
    expect(stack.length).toBeGreaterThanOrEqual(5)
    const supply = Number(stack[0])
    const indexed = Number(master.total_supply)
    expect(supply).toBeGreaterThan(0)
    expect(Math.abs(supply - indexed) / indexed).toBeLessThan(0.01)
    if (master.admin_address) {
      expect(typeof stack[2]).toBe('string')
      expect(compareAddress(stack[2], master.admin_address)).toBe(true)
    }
  })

  test('tonapi getJettonBalances returns an array', async () => {
    // ston.fi router, holds many jettons
    const balances = await getJettonBalances({ address: 'EQB3ncyBUTjZUA5EnFKR5_EnOMI9V1tTEAAPaiU71gc4TiUt' })
    expect(Array.isArray(balances)).toBe(true)
    if (balances.length) {
      expect(balances[0].balance).toMatch(/^\d+$/)
      expect(isAddress(balances[0].jetton.address)).toBe(true)
    }
  })
})
