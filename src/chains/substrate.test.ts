import * as substrate from "./substrate";

// Polkadot treasury (modlpy/trsry padded to 32 bytes), prefix 0
const TREASURY = '13UVJyLnbVp9RBZYFwFGyDvVd1y27Tt8tkntv6Q7JVPhFsTB'
const TREASURY_PUBKEY = '0x6d6f646c70792f74727372790000000000000000000000000000000000000000'
// same account id on kusama (prefix 2)
const KUSAMA_TREASURY = 'F3opxRbN5ZbjJNU511Kj2TLuzFcDq9BGduA9TgiECafpg29'
// //Alice dev account, generic prefix 42
const ALICE = '5GrwvaEF5zXb26Fz9rcQpDWS57CtERHpNehXCPcNoHGKutQY'
const ALICE_PUBKEY = '0xd43593c715fdd31c61141abd04a99fd6822c8558854ccde39a5684e7a56da27d'
// twox128('Balances') ++ twox128('TotalIssuance')
const TOTAL_ISSUANCE_KEY = '0xc2261276cc9d1f8598ea4b6a74b15c2f57c875e4cff74148e4628f264b974c80'

const h = (b: Buffer | Uint8Array) => Buffer.from(b).toString('hex')

describe('chains.substrate offline', () => {
  afterEach(() => {
    delete process.env.POLKADOT_SUBSTRATE_RPC
    delete process.env.NOTACHAIN_RPC
    delete process.env.ASTAR_RPC
    delete process.env.ASTAR_SUBSTRATE_RPC
  })

  test('DEFAULT_ENDPOINTS has the main chains', () => {
    for (const chain of ['polkadot', 'kusama', 'bifrost', 'bittensor', 'hydration'])
      expect(substrate.DEFAULT_ENDPOINTS[chain]).toMatch(/^https:\/\//)
    expect(substrate.getEndpoints({ chain: 'polkadot' })).toEqual(substrate.DEFAULT_ENDPOINTS.polkadot.split(','))
    expect(substrate.getEndpoints({ chain: 'bittensor' })).toEqual(['https://entrypoint-finney.opentensor.ai'])
  })

  test('POLKADOT_SUBSTRATE_RPC env overrides the defaults', () => {
    process.env.POLKADOT_SUBSTRATE_RPC = 'https://dot.example.com, https://dot2.example.com'
    expect(substrate.getEndpoints({ chain: 'polkadot' })).toEqual(['https://dot.example.com', 'https://dot2.example.com'])
    delete process.env.POLKADOT_SUBSTRATE_RPC
    expect(substrate.getEndpoints({ chain: 'polkadot' })).toEqual(substrate.DEFAULT_ENDPOINTS.polkadot.split(','))
  })

  test('<CHAIN>_RPC is only a fallback for non-EVM chains', () => {
    expect(() => substrate.getEndpoints({ chain: 'notachain' })).toThrow(/No RPC endpoint configured/)
    process.env.NOTACHAIN_RPC = 'https://notachain.example.com'
    expect(substrate.getEndpoints({ chain: 'notachain' })).toEqual(['https://notachain.example.com'])
    // astar is an EVM chain: ASTAR_RPC is its EVM rpc and must not be picked up
    process.env.ASTAR_RPC = 'https://evm.astar.example.com'
    expect(substrate.getEndpoints({ chain: 'astar' })).toEqual(substrate.DEFAULT_ENDPOINTS.astar.split(','))
    process.env.ASTAR_SUBSTRATE_RPC = 'https://substrate.astar.example.com'
    expect(substrate.getEndpoints({ chain: 'astar' })).toEqual(['https://substrate.astar.example.com'])
  })

  test('literal url as chain', () => {
    expect(substrate.getEndpoints({ chain: 'https://a.example.com,https://b.example.com' })).toEqual(['https://a.example.com', 'https://b.example.com'])
    expect(() => substrate.getEndpoints({ chain: '' })).toThrow(/chain is required/)
  })

  test('toBuf / hex / u64le', () => {
    expect(h(substrate.toBuf('0x0102'))).toBe('0102')
    expect(h(substrate.toBuf('0X0aFF'))).toBe('0aff')
    expect(h(substrate.toBuf('System'))).toBe('53797374656d')
    expect(h(substrate.toBuf([1, 2, 3]))).toBe('010203')
    expect(h(substrate.toBuf(new Uint8Array([9, 8]).subarray(1)))).toBe('08')
    expect(substrate.toBuf(undefined).length).toBe(0)
    expect(substrate.toBuf(null).length).toBe(0)
    expect(substrate.hex(Buffer.from([0xab, 0xcd]))).toBe('0xabcd')
    expect(h(substrate.u64le(1))).toBe('0100000000000000')
    expect(h(substrate.u64le(BigInt('0x0102030405060708')))).toBe('0807060504030201')
  })

  test('xxhash64 / twox', () => {
    expect(h(substrate.twox128('System'))).toBe('26aa394eea5630e07c48ae0c9558cef7')
    expect(h(substrate.twox128('Account'))).toBe('b99d880ec681799c0cf30e8886371da9')
    expect(h(substrate.twox128('Balances'))).toBe('c2261276cc9d1f8598ea4b6a74b15c2f')
    expect(h(substrate.twox128('TotalIssuance'))).toBe('57c875e4cff74148e4628f264b974c80')
    expect(h(substrate.twox128('Timestamp'))).toBe('f0c365c3cf59d671eb72da0e7a4113c4')
    expect(h(substrate.twox128('Now'))).toBe('9f1f0515f462cdcf84e0f1d6045dfcbb')
    // twox64 is the first half of twox128, twox256 extends it with seeds 2 and 3
    expect(h(substrate.twox64('System'))).toBe('26aa394eea5630e0')
    expect(substrate.twox256('System').length).toBe(32)
    expect(h(substrate.twox256('System').subarray(0, 16))).toBe('26aa394eea5630e07c48ae0c9558cef7')
    expect(substrate.xxhash64('System', 0)).toBe(BigInt('0xe03056ea4e39aa26'))
    expect(substrate.xxhash64('System', 1)).toBe(BigInt('0xf7ce58950cae487c'))
    // reference vectors: xxh64('', 0) and a 32+ byte input (main loop)
    expect(substrate.xxhash64('', 0)).toBe(BigInt('0xef46db3751d8e999'))
    expect(substrate.xxhash64('Nobody inspects the spammish repetition', 0)).toBe(BigInt('0xfbcea83c8a378bf1'))
  })

  test('blake2b', () => {
    expect(h(substrate.blake2_256(''))).toBe('0e5751c026e543b2e8ab2eb06099daa1d1e5df47778f7787faab45cdf12fe3a8')
    expect(h(substrate.blake2_128(''))).toBe('cae66941d9efbd404e4d88758ea67670')
    expect(h(substrate.blake2_256('abc'))).toBe('bddd813c634239723171ef3fee98579b94964e3bb1cb3e427262c8c068d52319')
    expect(h(substrate.blake2_512(''))).toBe('786a02f742015903c6c6fd852552d272912f4740e15847618a86e217f71f5419d25e1031afee585313896444934eb04b903a685b1448b755d56f701afe9be2ce')
    expect(h(substrate.blake2_512('abc'))).toBe('ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d17d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923')
    // multi block input (> 128 bytes) against node's blake2b512
    const long = Buffer.alloc(300, 7)
    const ref = require('crypto').createHash('blake2b512').update(long).digest('hex')
    expect(h(substrate.blake2b(long, 64))).toBe(ref)
    expect(() => substrate.blake2b('', 0)).toThrow(/illegal output length/)
    expect(() => substrate.blake2b('', 65)).toThrow(/illegal output length/)
  })

  test('base58 round trip keeps leading zero bytes', () => {
    const buf = Buffer.from([0, 0, 0, 1, 2, 3, 255])
    const str = substrate.base58Encode(buf)
    expect(str.startsWith('111')).toBe(true)
    expect(h(substrate.base58Decode(str))).toBe(h(buf))
    expect(substrate.base58Encode(Buffer.from([0]))).toBe('1')
    expect(h(substrate.base58Decode('1'))).toBe('00')
    expect(substrate.base58Encode('')).toBe('')
    expect(substrate.base58Decode('').length).toBe(0)
    expect(substrate.base58Encode(Buffer.from('Hello World!', 'utf8'))).toBe('2NEpo7TZRRrLZSi2U')
    expect(substrate.base58Decode('2NEpo7TZRRrLZSi2U').toString('utf8')).toBe('Hello World!')
    expect(() => substrate.base58Decode('0OIl')).toThrow(/invalid character/)
  })

  test('ss58 decode / encode', () => {
    const pubkey = substrate.ss58Decode(TREASURY)
    expect(pubkey.length).toBe(32)
    expect(substrate.hex(pubkey)).toBe(TREASURY_PUBKEY)
    expect(substrate.ss58DecodeFull(TREASURY)).toEqual({ prefix: 0, pubkey: substrate.toBuf(TREASURY_PUBKEY) })
    expect(substrate.ss58Encode(pubkey, 0)).toBe(TREASURY)
    expect(substrate.ss58Encode(pubkey)).toBe(TREASURY)
    expect(substrate.ss58Encode(pubkey, 2)).toBe(KUSAMA_TREASURY)
    expect(substrate.ss58DecodeFull(KUSAMA_TREASURY)).toEqual({ prefix: 2, pubkey: substrate.toBuf(TREASURY_PUBKEY) })
    expect(substrate.hex(substrate.ss58Decode(ALICE))).toBe(ALICE_PUBKEY)
    expect(substrate.ss58Encode(ALICE_PUBKEY, 42)).toBe(ALICE)
    // raw account ids pass through
    expect(substrate.hex(substrate.ss58Decode(TREASURY_PUBKEY))).toBe(TREASURY_PUBKEY)
    expect(substrate.hex(substrate.ss58Decode(substrate.toBuf(TREASURY_PUBKEY)))).toBe(TREASURY_PUBKEY)
    // two byte prefixes (>= 64) round trip
    for (const prefix of [64, 69, 2032, 16383]) {
      const address = substrate.ss58Encode(ALICE_PUBKEY, prefix)
      expect(substrate.ss58DecodeFull(address)).toEqual({ prefix, pubkey: substrate.toBuf(ALICE_PUBKEY) })
    }
    // bad checksum / bad input
    const tampered = TREASURY.slice(0, -1) + (TREASURY.endsWith('A') ? 'B' : 'A')
    expect(() => substrate.ss58Decode(tampered)).toThrow(/bad checksum/)
    expect(() => substrate.ss58Decode('11')).toThrow(/too short/)
    expect(() => substrate.ss58Encode(Buffer.alloc(31), 0)).toThrow(/unexpected public key length/)
    expect(() => substrate.ss58Encode(pubkey, 16384)).toThrow(/invalid network prefix/)
  })

  test('fixed width encoders / decodeUint', () => {
    expect(h(substrate.encodeU8(0x1ff))).toBe('ff')
    expect(h(substrate.encodeU16(0x1234))).toBe('3412')
    expect(h(substrate.encodeU32(0x12345678))).toBe('78563412')
    expect(h(substrate.encodeU32(0xffffffff))).toBe('ffffffff')
    expect(h(substrate.encodeU64('1'))).toBe('0100000000000000')
    expect(h(substrate.encodeU128(BigInt(1) << BigInt(64)))).toBe('00000000000000000100000000000000')
    expect(h(substrate.encodeUint(258, 3))).toBe('020100')
    expect(() => substrate.encodeUint(256, 1)).toThrow(/does not fit/)
    expect(() => substrate.encodeUint(-1, 1)).toThrow(/negative/)
    expect(substrate.decodeUint('0x0201', { bytes: 2 })).toBe(BigInt(258))
    expect(substrate.decodeUint('0xff0201', { offset: 1, bytes: 2 })).toBe(BigInt(258))
    expect(substrate.decodeUint('0x01', { bytes: 16 })).toBe(BigInt(1)) // short buffers read as zero padded
    expect(substrate.decodeUint(null)).toBe(BigInt(0))
    expect(substrate.decodeUint('0x' + 'ff'.repeat(16))).toBe((BigInt(1) << BigInt(128)) - BigInt(1))
  })

  test('SCALE compact encode matches the spec', () => {
    const vectors: [bigint | number, string][] = [
      [0, '00'],
      [1, '04'],
      [42, 'a8'],
      [63, 'fc'],
      [64, '0101'],
      [69, '1501'],
      [16383, 'fdff'],
      [16384, '02000100'],
      [1073741823, 'feffffff'],
      [1073741824, '0300000040'],
      [4294967295, '03ffffffff'],
      [BigInt(2) ** BigInt(32), '070000000001'],
      [BigInt('0xffffffffffffffff'), '13ffffffffffffffff'],
      [BigInt(1) << BigInt(64), '17000000000000000001'],
      [(BigInt(1) << BigInt(128)) - BigInt(1), '33' + 'ff'.repeat(16)],
    ]
    for (const [value, expected] of vectors) {
      expect(h(substrate.encodeCompact(value))).toBe(expected)
      const decoded = substrate.decodeCompact('0x' + expected)
      expect(decoded.value).toBe(BigInt(value))
      expect(decoded.length).toBe(expected.length / 2)
    }
    expect(() => substrate.encodeCompact(-1)).toThrow(/negative/)
    expect(() => substrate.encodeCompact(BigInt(1) << BigInt(536))).toThrow(/too large/)
    // decode with offset and trailing bytes
    expect(substrate.decodeCompact('0xaa0101bb', 1)).toEqual({ value: BigInt(64), length: 2 })
    expect(() => substrate.decodeCompact('0x', 0)).toThrow(/out of bounds/)
  })

  test('ScaleReader', () => {
    const buf = Buffer.concat([
      substrate.encodeU8(7),
      substrate.encodeU16(0xbeef),
      substrate.encodeU32(0xdeadbeef),
      substrate.encodeU64(BigInt('0x1122334455667788')),
      substrate.encodeCompact(16384),
      substrate.encodeU128(BigInt(10) ** BigInt(30)),
      Buffer.from([1]), substrate.encodeU32(5),      // Option<u32> = Some(5)
      Buffer.from([0]),                              // Option<u32> = None
      substrate.encodeCompact(3), Buffer.from([1, 2, 3]), // Vec<u8>
      substrate.encodeCompact(2), substrate.encodeU16(1), substrate.encodeU16(2), // Vec<u16>
      substrate.encodeCompact(3), Buffer.from('DOT', 'utf8'),
      Buffer.from([1]), Buffer.from([0]),            // bool, bool
      substrate.encodeU32(0xffffffff),               // i32 -1
    ])
    const r = new substrate.ScaleReader(buf)
    expect(r.u8()).toBe(7)
    expect(r.u16()).toBe(0xbeef)
    expect(r.u32()).toBe(0xdeadbeef)
    expect(r.u64()).toBe(BigInt('0x1122334455667788'))
    expect(r.compact()).toBe(BigInt(16384))
    expect(r.u128()).toBe(BigInt(10) ** BigInt(30))
    expect(r.option(x => x.u32())).toBe(5)
    expect(r.option(x => x.u32())).toBeNull()
    expect(h(r.bytesVec())).toBe('010203')
    expect(r.vec(x => x.u16())).toEqual([1, 2])
    expect(r.string()).toBe('DOT')
    expect(r.bool()).toBe(true)
    expect(r.bool()).toBe(false)
    expect(r.i32()).toBe(-1)
    expect(r.remaining).toBe(0)
    expect(() => r.u8()).toThrow(/out of bounds/)

    const r2 = new substrate.ScaleReader(TREASURY_PUBKEY + 'ff'.repeat(8))
    expect(r2.accountId()).toBe(TREASURY_PUBKEY)
    expect(r2.i64()).toBe(BigInt(-1))
    expect(r2.skip(0).remaining).toBe(0)
    expect(() => r2.skip(1)).toThrow(/out of bounds/)
  })

  test('storage keys', () => {
    const pubkey = substrate.toBuf(TREASURY_PUBKEY)
    const expected = '0x' + h(substrate.twox128('System')) + h(substrate.twox128('Account')) + h(substrate.blake2_128(pubkey)) + h(pubkey)
    expect(substrate.storageKey({ pallet: 'System', item: 'Account', key: pubkey, hasher: 'Blake2_128Concat' })).toBe(expected)
    expect(substrate.storageKey({ pallet: 'System', item: 'Account', key: TREASURY_PUBKEY, hasher: 'blake2_128concat' })).toBe(expected)
    expect(substrate.storageKey({ pallet: 'System', item: 'Account', keys: [{ key: pubkey, hasher: 'Blake2_128Concat' }] })).toBe(expected)
    expect(expected.length).toBe(2 + 2 * (16 + 16 + 16 + 32))

    expect(substrate.hex(substrate.storagePrefix('Balances', 'TotalIssuance'))).toBe(TOTAL_ISSUANCE_KEY)
    expect(substrate.storageKey({ pallet: 'Balances', item: 'TotalIssuance' })).toBe(TOTAL_ISSUANCE_KEY)

    // default hasher is Twox64Concat
    const era = substrate.encodeU32(1000)
    expect(substrate.storageKey({ pallet: 'Staking', item: 'ErasValidatorReward', key: era }))
      .toBe(substrate.hex(Buffer.concat([substrate.storagePrefix('Staking', 'ErasValidatorReward'), substrate.twox64(era), era])))
    expect(h(substrate.twox64Concat(era))).toBe(h(substrate.twox64(era)) + h(era))
    expect(h(substrate.blake2_128Concat(era))).toBe(h(substrate.blake2_128(era)) + h(era))
    expect(h(substrate.identity(era))).toBe(h(era))

    // double map: orml Tokens.Accounts(AccountId: Blake2_128Concat, CurrencyId: Twox64Concat)
    const currency = substrate.bifrost.token('KSM')
    const doubleKey = substrate.storageKey({ pallet: 'Tokens', item: 'Accounts', keys: [{ key: pubkey, hasher: 'Blake2_128Concat' }, { key: currency, hasher: 'Twox64Concat' }] })
    expect(doubleKey).toBe(substrate.hex(Buffer.concat([substrate.storagePrefix('Tokens', 'Accounts'), substrate.blake2_128Concat(pubkey), substrate.twox64Concat(currency)])))

    // stripHasher recovers the raw key from a concat hasher `rest`
    expect(h(substrate.stripHasher(substrate.twox64Concat(era)))).toBe(h(era))
    expect(h(substrate.stripHasher(substrate.blake2_128Concat(pubkey), 'Blake2_128Concat'))).toBe(h(pubkey))
    expect(h(substrate.stripHasher(era, 'Identity'))).toBe(h(era))
    expect(substrate.getHasher('twox128').hashLength).toBe(16)
    expect(substrate.getHasher('Twox128').concat).toBe(false)
    expect(() => substrate.getHasher('sha256')).toThrow(/unknown storage hasher/)
    expect(() => substrate.storageKey({ pallet: 'A', item: 'B', key: era, hasher: 'nope' })).toThrow(/unknown storage hasher/)
  })

  test('decodeAccountInfo', () => {
    const u128 = (n: bigint | number) => substrate.encodeU128(n)
    const value = Buffer.concat([
      substrate.encodeU32(12), substrate.encodeU32(1), substrate.encodeU32(2), substrate.encodeU32(3),
      u128(BigInt('123456789012345678901234567890')), u128(5), u128(6), u128(BigInt(1) << BigInt(127)),
    ])
    expect(value.length).toBe(16 + 4 * 16)
    const info = substrate.decodeAccountInfo(substrate.hex(value))
    expect(info).toEqual({
      nonce: 12, consumers: 1, providers: 2, sufficients: 3,
      free: '123456789012345678901234567890', reserved: '5', frozen: '6', miscFrozen: '6',
      flags: (BigInt(1) << BigInt(127)).toString(), feeFrozen: (BigInt(1) << BigInt(127)).toString(),
    })
    // u64 balances (bittensor) auto-detected from the length
    const value64 = Buffer.concat([
      substrate.encodeU32(1), substrate.encodeU32(0), substrate.encodeU32(1), substrate.encodeU32(0),
      substrate.encodeU64(1000), substrate.encodeU64(0), substrate.encodeU64(0), substrate.encodeU64(0),
    ])
    expect(substrate.decodeAccountInfo(value64)).toMatchObject({ nonce: 1, providers: 1, free: '1000', reserved: '0' })
    expect(substrate.decodeAccountInfo(value64, { balanceBytes: 8 }).free).toBe('1000')
    // missing trailing fields read as 0
    const short = Buffer.concat([substrate.encodeU32(1), substrate.encodeU32(0), substrate.encodeU32(1), substrate.encodeU32(0), u128(77)])
    expect(substrate.decodeAccountInfo(short)).toMatchObject({ free: '77', reserved: '0', frozen: '0', flags: '0' })
    const zero = substrate.decodeAccountInfo(null)
    expect(zero).toMatchObject({ nonce: 0, free: '0', reserved: '0', frozen: '0', flags: '0' })
    expect(substrate.decodeAccountInfo('0x')).toEqual(zero)
  })

  test('decodeOrmlAccountData', () => {
    const value = Buffer.concat([substrate.encodeU128(10), substrate.encodeU128(20), substrate.encodeU128(30)])
    expect(substrate.decodeOrmlAccountData(value)).toEqual({ free: '10', reserved: '20', frozen: '30' })
    expect(substrate.decodeOrmlAccountData(null)).toEqual({ free: '0', reserved: '0', frozen: '0' })
    expect(substrate.decodeOrmlAccountData('0x')).toEqual({ free: '0', reserved: '0', frozen: '0' })
  })

  test('decodeTimestampInherent', () => {
    const ms = 1700000000123
    const body = Buffer.concat([Buffer.from([0x04, 0x03, 0x00]), substrate.encodeCompact(ms)]) // unsigned v4, pallet 3, call 0
    const inherent = substrate.hex(Buffer.concat([substrate.encodeCompact(body.length), body]))
    expect(substrate.decodeTimestampInherent([inherent])).toBe(1700000000)
    // not first, still found within the first three
    expect(substrate.decodeTimestampInherent(['0x0400ff', '0x00', inherent])).toBe(1700000000)
    // signed extrinsic (0x84) is skipped, so is a call index != 0 and a nonsense timestamp
    const signed = substrate.hex(Buffer.concat([substrate.encodeCompact(body.length), Buffer.from([0x84]), body.subarray(1)]))
    expect(substrate.decodeTimestampInherent([signed])).toBeUndefined()
    const otherCall = substrate.hex(Buffer.concat([substrate.encodeCompact(body.length), Buffer.from([0x04, 0x03, 0x01]), substrate.encodeCompact(ms)]))
    expect(substrate.decodeTimestampInherent([otherCall])).toBeUndefined()
    const tiny = Buffer.concat([Buffer.from([0x04, 0x03, 0x00]), substrate.encodeCompact(5)])
    expect(substrate.decodeTimestampInherent([substrate.hex(Buffer.concat([substrate.encodeCompact(tiny.length), tiny]))])).toBeUndefined()
    expect(substrate.decodeTimestampInherent([])).toBeUndefined()
    expect(substrate.decodeTimestampInherent(undefined)).toBeUndefined()
    expect(substrate.decodeTimestampInherent(['0x'])).toBeUndefined()
  })

  test('bifrost CurrencyId codec', () => {
    const { bifrost } = substrate
    expect(h(bifrost.token('KSM'))).toBe('0204')
    expect(h(bifrost.vToken('DOT'))).toBe('0103')
    expect(h(bifrost.native('BNC'))).toBe('0001')
    expect(h(bifrost.vToken2(0))).toBe('0900')
    expect(h(bifrost.token2(1))).toBe('0801')
    expect(h(bifrost.encodeCurrencyId('Token', 'KSM'))).toBe('0204')
    expect(h(bifrost.encodeCurrencyId('VToken2', '0'))).toBe('0900')
    expect(() => bifrost.token('NOPE')).toThrow(/Unknown bifrost token symbol/)
    expect(() => bifrost.encodeCurrencyId('Nope', 1)).toThrow(/Unknown bifrost CurrencyId variant/)

    expect(bifrost.decodeCurrencyId('0x0204')).toEqual({ variant: 'Token', raw: Buffer.from([2, 4]), id: 4, symbol: 'KSM', human: { Token: 'KSM' } })
    expect(bifrost.decodeCurrencyId('0x0900')).toEqual({ variant: 'VToken2', raw: Buffer.from([9, 0]), id: 0, symbol: 'DOT', human: { VToken2: '0' } })
    expect(bifrost.decodeCurrencyId('0x0705000000')).toMatchObject({ variant: 'ForeignAsset', id: 5, human: { ForeignAsset: '5' } })
    expect(bifrost.decodeCurrencyId('0x0705000000').raw.length).toBe(5)
    // VSBond: (TokenSymbol u8, ParaId u32, LeasePeriod u32, LeasePeriod u32) = 14 bytes
    const r = new substrate.ScaleReader('0x05' + '04' + 'd0070000' + '0d000000' + '14000000' + '0204')
    expect(bifrost.readCurrencyId(r)).toMatchObject({ variant: 'VSBond' })
    expect(r.offset).toBe(14)
    expect(bifrost.readCurrencyId(r).symbol).toBe('KSM')
    expect(() => bifrost.decodeCurrencyId('0xff')).toThrow(/Unknown bifrost CurrencyId variant/)
  })
})

describe('chains.substrate live', () => {
  const chain = 'polkadot'

  test('getFinalizedHead / getHeader / getRuntimeVersion', async () => {
    const head = await substrate.getFinalizedHead({ chain })
    expect(head).toMatch(/^0x[0-9a-f]{64}$/)
    const header = await substrate.getHeader({ chain, hash: head })
    expect(header.number).toBeGreaterThan(20_000_000)
    expect(header.hash).toBe(head)
    expect(header.parentHash).toMatch(/^0x[0-9a-f]{64}$/)
    const version = await substrate.getRuntimeVersion({ chain, at: head })
    expect(version.specName).toBe('polkadot')
    expect(version.specVersion).toBeGreaterThan(1_000_000)
  })

  test('getLatestBlock is recent', async () => {
    const block = await substrate.getLatestBlock({ chain })
    const now = Math.floor(Date.now() / 1000)
    expect(block.number).toBeGreaterThan(20_000_000)
    expect(block.hash).toMatch(/^0x[0-9a-f]{64}$/)
    expect(block.extrinsics.length).toBeGreaterThan(0)
    expect(block.timestamp).toBeGreaterThan(now - 3600)
    expect(block.timestamp).toBeLessThanOrEqual(now + 60)
    // timestamp inherent agrees with Timestamp.Now storage
    expect(await substrate.getTimestampAt({ chain, at: block.hash })).toBe(block.timestamp)
    const byNumber = await substrate.getBlock({ chain, number: block.number })
    expect(byNumber.hash).toBe(block.hash)
    expect(await substrate.getBlockHash({ chain, number: block.number })).toBe(block.hash)
  })

  test('getSystemAccount / getFreeBalance treasury > 0', async () => {
    const info = await substrate.getSystemAccount({ chain, address: TREASURY })
    expect(BigInt(info.free) > BigInt(0)).toBe(true)
    expect(info.providers).toBeGreaterThan(0)
    const free = await substrate.getFreeBalance({ chain, address: TREASURY_PUBKEY })
    expect(/^\d+$/.test(free)).toBe(true)
    expect(BigInt(free) > BigInt(0)).toBe(true)
  })

  test('getTotalIssuance > 0 and equals the raw storage value', async () => {
    const at = await substrate.getFinalizedHead({ chain })
    const supply = await substrate.getTotalIssuance({ chain, at })
    expect(/^\d+$/.test(supply)).toBe(true)
    expect(BigInt(supply) > BigInt(0)).toBe(true)
    // since the Asset Hub migration the bulk of DOT is issued on polkadot_assethub: > 1e9 DOT with 10 decimals
    const assetHubSupply = await substrate.getTotalIssuance({ chain: 'polkadot_assethub' })
    expect(BigInt(assetHubSupply) > BigInt(10) ** BigInt(19)).toBe(true)
    const raw = await substrate.getStorageRaw({ chain, key: TOTAL_ISSUANCE_KEY, at })
    expect(raw).toMatch(/^0x[0-9a-f]{32}$/)
    expect(substrate.decodeUint(raw).toString()).toBe(supply)
    const [batched] = await substrate.getStorageBatch({ chain, storageKeys: [TOTAL_ISSUANCE_KEY], at })
    expect(batched).toBe(raw)
    expect(await substrate.getStorage({ chain, pallet: 'Balances', item: 'DoesNotExist', at })).toBeNull()
    expect(await substrate.getStorageBatch({ chain, storageKeys: [] })).toEqual([])
  })

  test('getStorageEntries paginates a map (asset hub Staking.ErasValidatorReward, pageSize 5)', async () => {
    // staking lives on polkadot_assethub since the Asset Hub migration; ErasValidatorReward keeps HistoryDepth (84) eras
    const assetHub = 'polkadot_assethub'
    const at = await substrate.getFinalizedHead({ chain: assetHub })
    const entries = await substrate.getStorageEntries({ chain: assetHub, pallet: 'Staking', item: 'ErasValidatorReward', pageSize: 5, at })
    expect(entries.length).toBeGreaterThan(10)
    expect(entries.length).toBeLessThan(200)
    const prefix = substrate.storageKey({ pallet: 'Staking', item: 'ErasValidatorReward' })
    const eras: number[] = []
    for (const entry of entries) {
      expect(entry.key.startsWith(prefix)).toBe(true)
      expect(entry.rest.length).toBe(8 + 4) // twox64 ++ u32 era
      const era = substrate.stripHasher(entry.rest, 'Twox64Concat').readUInt32LE(0)
      eras.push(era)
      expect(entry.value).toMatch(/^0x[0-9a-f]{32}$/)
      expect(substrate.decodeUint(entry.value) > BigInt(0)).toBe(true)
    }
    expect(new Set(eras).size).toBe(eras.length)
    expect(Math.max(...eras) - Math.min(...eras)).toBe(eras.length - 1) // contiguous eras
    const keys = await substrate.getKeysPaged({ chain: assetHub, prefix, pageSize: 5, at })
    expect(keys.length).toBe(5)
    expect(keys).toEqual(entries.slice(0, 5).map(e => e.key))
    // the relay chain no longer has the map
    expect(await substrate.getStorageEntries({ chain, pallet: 'Staking', item: 'ErasValidatorReward', pageSize: 5 })).toEqual([])
  })

  test('getBlockAtTimestamp finds the last block before now - 1h', async () => {
    const target = Math.floor(Date.now() / 1000) - 3600
    const block = await substrate.getBlockAtTimestamp({ chain, timestamp: target })
    expect(block.timestamp).toBeDefined()
    expect(block.timestamp!).toBeLessThanOrEqual(target)
    expect(block.timestamp!).toBeGreaterThan(target - 60)
    const next = await substrate.getBlock({ chain, number: block.number + 1 })
    expect(next.timestamp!).toBeGreaterThan(target)
    // ms input is accepted
    const sameBlock = await substrate.getBlockAtTimestamp({ chain, timestamp: target * 1000 })
    expect(sameBlock.number).toBe(block.number)
  })

  test('stateCall runs a runtime api', async () => {
    const res = await substrate.stateCall({ chain, method: 'Core_version', data: '0x' })
    expect(res).toMatch(/^0x[0-9a-f]+$/)
    const r = new substrate.ScaleReader(res)
    expect(r.string()).toBe('polkadot') // spec_name
  })
})
