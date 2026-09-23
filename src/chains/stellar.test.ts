import * as stellar from "./stellar";

const USDC_ISSUER = 'GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN'
const USDC_SAC = 'CCW67TSZV3SSS2HXMBQ5JFGCKJNXKZM7UQUWUZPUTHXSTZLEO7SJMI75'
const USDC_ASSET = `USDC-${USDC_ISSUER}`

describe('chains.stellar offline', () => {
  afterEach(() => {
    delete process.env.STELLAR_HORIZON
    delete process.env.STELLAR_SOROBAN_RPC
  })

  test('default endpoints', () => {
    expect(stellar.getHorizonEndpoint()).toBe('https://horizon.stellar.org')
    expect(stellar.getHorizonEndpoints()).toEqual([stellar.DEFAULT_HORIZON])
    expect(stellar.getSorobanEndpoints()).toEqual(stellar.DEFAULT_SOROBAN_ENDPOINTS)
    expect(stellar.STELLAR_DECIMALS).toBe(7)
  })

  test('STELLAR_HORIZON / STELLAR_SOROBAN_RPC env override the defaults', () => {
    process.env.STELLAR_HORIZON = 'https://horizon.example.com'
    process.env.STELLAR_SOROBAN_RPC = 'https://rpc1.example.com,https://rpc2.example.com'
    expect(stellar.getHorizonEndpoint()).toBe('https://horizon.example.com')
    expect(stellar.getHorizonEndpoints()).toEqual(['https://horizon.example.com'])
    expect(stellar.getSorobanEndpoints()).toEqual(['https://rpc1.example.com', 'https://rpc2.example.com'])
    delete process.env.STELLAR_HORIZON
    delete process.env.STELLAR_SOROBAN_RPC
    expect(stellar.getHorizonEndpoint()).toBe(stellar.DEFAULT_HORIZON)
    expect(stellar.getSorobanEndpoints()).toEqual(stellar.DEFAULT_SOROBAN_ENDPOINTS)
  })

  test('base32 round trip (RFC 4648 vectors)', () => {
    // RFC 4648 section 10 test vectors
    expect(stellar.base32Encode(Buffer.from(''))).toBe('')
    expect(stellar.base32Encode(Buffer.from('f'))).toBe('MY')
    expect(stellar.base32Encode(Buffer.from('f'), { padding: true })).toBe('MY======')
    expect(stellar.base32Encode(Buffer.from('fo'))).toBe('MZXQ')
    expect(stellar.base32Encode(Buffer.from('foo'))).toBe('MZXW6')
    expect(stellar.base32Encode(Buffer.from('foob'))).toBe('MZXW6YQ')
    expect(stellar.base32Encode(Buffer.from('fooba'))).toBe('MZXW6YTB')
    expect(stellar.base32Encode(Buffer.from('foobar'), { padding: true })).toBe('MZXW6YTBOI======')
    expect(stellar.base32Decode('MZXW6YTBOI======').toString()).toBe('foobar')
    expect(stellar.base32Decode('MZXW6YTBOI').toString()).toBe('foobar')
    expect(stellar.base32Decode('mzxw6ytboi').toString()).toBe('foobar')

    const bytes = Buffer.from(Array.from({ length: 35 }, (_, i) => (i * 37 + 11) & 0xff))
    expect(stellar.base32Decode(stellar.base32Encode(bytes)).equals(bytes)).toBe(true)
    expect(stellar.base32Decode(stellar.base32Encode(bytes, { padding: true })).equals(bytes)).toBe(true)
    expect(() => stellar.base32Decode('MZXW6YTB0I')).toThrow(/invalid character/)
  })

  test('crc16xmodem', () => {
    expect(stellar.crc16xmodem(Buffer.from('123456789', 'ascii'))).toBe(0x31c3)
    expect(stellar.crc16xmodem(Buffer.from(''))).toBe(0)
  })

  test('decodeStrKey / encodeStrKey round trip', () => {
    const issuer = stellar.decodeStrKey(USDC_ISSUER)
    expect(issuer.version).toBe(stellar.STRKEY_VERSION.ACCOUNT)
    expect(issuer.payload.length).toBe(32)
    expect(stellar.encodeStrKey(stellar.STRKEY_VERSION.ACCOUNT, issuer.payload)).toBe(USDC_ISSUER)

    const sac = stellar.decodeStrKey(USDC_SAC)
    expect(sac.version).toBe(stellar.STRKEY_VERSION.CONTRACT)
    expect(sac.payload.length).toBe(32)
    expect(stellar.encodeStrKey(stellar.STRKEY_VERSION.CONTRACT, sac.payload)).toBe(USDC_SAC)

    expect(stellar.strKeyToBytes(USDC_ISSUER, stellar.STRKEY_VERSION.ACCOUNT).equals(issuer.payload)).toBe(true)
    expect(() => stellar.strKeyToBytes(USDC_ISSUER, stellar.STRKEY_VERSION.CONTRACT)).toThrow(/expected/)

    // corrupt one payload char -> checksum failure
    const corrupted = USDC_ISSUER.slice(0, 10) + (USDC_ISSUER[10] === 'A' ? 'B' : 'A') + USDC_ISSUER.slice(11)
    expect(() => stellar.decodeStrKey(corrupted)).toThrow(/Invalid StrKey/)
    expect(() => stellar.decodeStrKey('')).toThrow(/Invalid StrKey/)
    expect(() => stellar.decodeStrKey('GA')).toThrow(/too short/)
    expect(stellar.isValidStrKey(USDC_ISSUER)).toBe(true)
    expect(stellar.isValidStrKey(USDC_ISSUER, stellar.STRKEY_VERSION.ACCOUNT)).toBe(true)
    expect(stellar.isValidStrKey(USDC_ISSUER, stellar.STRKEY_VERSION.CONTRACT)).toBe(false)
    expect(stellar.isValidStrKey(corrupted)).toBe(false)
  })

  test('isContractId / isAccountId', () => {
    expect(stellar.isContractId(USDC_SAC)).toBe(true)
    expect(stellar.isContractId(USDC_ISSUER)).toBe(false)
    expect(stellar.isContractId(USDC_SAC.slice(0, 55))).toBe(false)
    expect(stellar.isContractId(USDC_SAC.toLowerCase())).toBe(false)
    expect(stellar.isContractId(undefined)).toBe(false)
    expect(stellar.isContractId(42)).toBe(false)

    expect(stellar.isAccountId(USDC_ISSUER)).toBe(true)
    expect(stellar.isAccountId(USDC_SAC)).toBe(false)
    expect(stellar.isAccountId(USDC_ISSUER + 'A')).toBe(false)
    expect(stellar.isAccountId(null)).toBe(false)
  })

  test('parseAsset', () => {
    expect(stellar.parseAsset(USDC_ASSET)).toEqual({ code: 'USDC', issuer: USDC_ISSUER })
    expect(stellar.parseAsset(`USDC:${USDC_ISSUER}`)).toEqual({ code: 'USDC', issuer: USDC_ISSUER })
    expect(stellar.parseAsset(`  USDC-${USDC_ISSUER}  `)).toEqual({ code: 'USDC', issuer: USDC_ISSUER })
    expect(stellar.parseAsset('native')).toEqual({ code: 'XLM' })
    expect(stellar.parseAsset('NATIVE')).toEqual({ code: 'XLM' })
    expect(stellar.parseAsset('XLM')).toEqual({ code: 'XLM' })
    expect(stellar.parseAsset({ code: 'XLM' })).toEqual({ code: 'XLM' })
    expect(stellar.parseAsset({ code: 'USDC', issuer: USDC_ISSUER })).toEqual({ code: 'USDC', issuer: USDC_ISSUER })
    expect(stellar.isNativeAsset(stellar.parseAsset('native'))).toBe(true)
    expect(stellar.isNativeAsset(stellar.parseAsset(USDC_ASSET))).toBe(false)

    expect(() => stellar.parseAsset('USDC')).toThrow(/Invalid Stellar asset/)
    expect(() => stellar.parseAsset(`USDC-${USDC_SAC}`)).toThrow(/issuer/)
    expect(() => stellar.parseAsset(`TOOLONGASSETCODE-${USDC_ISSUER}`)).toThrow(/asset code/)
    expect(() => stellar.parseAsset(`-${USDC_ISSUER}`)).toThrow(/asset code/)
    expect(() => stellar.parseAsset(undefined as any)).toThrow(/Invalid Stellar asset/)
  })

  test('assetToString', () => {
    expect(stellar.assetToString(USDC_ASSET)).toBe(USDC_ASSET)
    expect(stellar.assetToString(`USDC:${USDC_ISSUER}`)).toBe(USDC_ASSET)
    expect(stellar.assetToString({ code: 'USDC', issuer: USDC_ISSUER })).toBe(USDC_ASSET)
    expect(stellar.assetToString(USDC_ASSET, { separator: ':' })).toBe(`USDC:${USDC_ISSUER}`)
    expect(stellar.assetToString('native')).toBe('native')
    expect(stellar.assetToString('XLM')).toBe('native')
    expect(stellar.assetToString({ code: 'XLM' })).toBe('native')
  })

  test('toRaw / fromRaw', () => {
    expect(stellar.toRaw('1.5')).toBe('15000000')
    expect(stellar.toRaw('0.0000001')).toBe('1')
    expect(stellar.toRaw('12.3456789')).toBe('123456789')
    expect(stellar.toRaw('12.34567891')).toBe('123456789') // extra precision truncated
    expect(stellar.toRaw('100')).toBe('1000000000')
    expect(stellar.toRaw('.5')).toBe('5000000')
    expect(stellar.toRaw('-1.5')).toBe('-15000000')
    expect(stellar.toRaw('0')).toBe('0')
    expect(stellar.toRaw('')).toBe('0')
    expect(stellar.toRaw(1.5)).toBe('15000000')
    expect(stellar.toRaw('1.5', 2)).toBe('150')
    expect(stellar.toRaw('922337203685.4775807')).toBe('9223372036854775807')
    expect(() => stellar.toRaw('1e7')).toThrow(/Invalid decimal amount/)
    expect(() => stellar.toRaw('abc')).toThrow(/Invalid decimal amount/)

    expect(stellar.fromRaw('15000000')).toBe('1.5')
    expect(stellar.fromRaw(15000000)).toBe('1.5')
    expect(stellar.fromRaw(BigInt(15000000))).toBe('1.5')
    expect(stellar.fromRaw('1')).toBe('0.0000001')
    expect(stellar.fromRaw('0')).toBe('0')
    expect(stellar.fromRaw('1000000000')).toBe('100')
    expect(stellar.fromRaw('-15000000')).toBe('-1.5')
    expect(stellar.fromRaw('123456789')).toBe('12.3456789')
    expect(stellar.fromRaw('150', 2)).toBe('1.5')

    for (const display of ['1.5', '0.0000001', '12.3456789', '100', '-42.25', '0']) {
      expect(stellar.fromRaw(stellar.toRaw(display))).toBe(display)
    }
  })

  test('XdrWriter / XdrReader primitives', () => {
    const w = new stellar.XdrWriter()
    w.u32(7).i32(-2).u64('18446744073709551615').i64('-1').string('abc').opaque(Buffer.from([1, 2, 3, 4, 5])).bytes(Buffer.from([9]))
    const buf = w.toBuffer()
    expect(buf.length % 4).toBe(0)
    expect(w.toBase64()).toBe(buf.toString('base64'))

    const r = new stellar.XdrReader(buf)
    expect(r.u32()).toBe(7)
    expect(r.i32()).toBe(-2)
    expect(r.u64()).toBe(BigInt('18446744073709551615'))
    expect(r.i64()).toBe(BigInt(-1))
    expect(r.string()).toBe('abc')
    expect(r.opaque().equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(true)
    expect(r.bytes(1).equals(Buffer.from([9]))).toBe(true)
    expect(r.remaining).toBe(0)
    expect(() => r.u32()).toThrow(/unexpected end of data/)

    // base64 input
    const r2 = new stellar.XdrReader(buf.toString('base64'))
    expect(r2.u32()).toBe(7)

    expect(() => new stellar.XdrWriter().u32(-1)).toThrow(/u32 out of range/)
    expect(() => new stellar.XdrWriter().u32(0x100000000)).toThrow(/u32 out of range/)
    expect(() => new stellar.XdrWriter().i32(0x80000000)).toThrow(/i32 out of range/)
    expect(() => new stellar.XdrWriter().u64(-1)).toThrow(/u64 out of range/)
    expect(() => new stellar.XdrWriter().i64(BigInt(1) << BigInt(63))).toThrow(/i64 out of range/)
  })

  test('parseScVal: hand-built ScvU32', () => {
    const xdr = new stellar.XdrWriter().u32(stellar.SC_VAL.U32).u32(123456).toBuffer()
    expect(xdr.toString('hex')).toBe('00000003' + '0001e240')
    expect(stellar.parseScVal(xdr)).toBe(123456)
    expect(stellar.parseScVal(xdr.toString('base64'))).toBe(123456)
    expect(stellar.encodeScVal({ type: 'u32', value: 123456 }).equals(xdr)).toBe(true)
    expect(stellar.encodeScVal(123456).equals(xdr)).toBe(true) // untyped number -> u32
  })

  test('parseScVal: hand-built ScvI128 (Int128Parts hi/lo, two\'s complement)', () => {
    // 1_000_000_000 = hi 0, lo 1e9
    const pos = new stellar.XdrWriter().u32(stellar.SC_VAL.I128).i64(0).u64(1000000000).toBuffer()
    expect(stellar.parseScVal(pos)).toBe(BigInt(1000000000))
    expect(stellar.encodeScVal({ type: 'i128', value: '1000000000' }).equals(pos)).toBe(true)
    expect(stellar.encodeScVal(BigInt(1000000000)).equals(pos)).toBe(true) // untyped bigint -> i128

    // -1 = hi -1, lo 0xffff...
    const neg = new stellar.XdrWriter().u32(stellar.SC_VAL.I128).i64(-1).u64('18446744073709551615').toBuffer()
    expect(stellar.parseScVal(neg)).toBe(BigInt(-1))
    expect(stellar.encodeScVal({ type: 'i128', value: -1 }).equals(neg)).toBe(true)

    // value above 2^64 uses the hi limb
    const big = (BigInt(1) << BigInt(64)) + BigInt(5)
    const bigXdr = new stellar.XdrWriter().u32(stellar.SC_VAL.I128).i64(1).u64(5).toBuffer()
    expect(stellar.parseScVal(bigXdr)).toBe(big)
    expect(stellar.parseScVal(stellar.encodeScVal({ type: 'i128', value: big }))).toBe(big)

    const i128Max = (BigInt(1) << BigInt(127)) - BigInt(1)
    const i128Min = -(BigInt(1) << BigInt(127))
    expect(stellar.parseScVal(stellar.encodeScVal({ type: 'i128', value: i128Max }))).toBe(i128Max)
    expect(stellar.parseScVal(stellar.encodeScVal({ type: 'i128', value: i128Min }))).toBe(i128Min)
    expect(() => stellar.encodeScVal({ type: 'i128', value: i128Max + BigInt(1) })).toThrow(/i128 out of range/)
    expect(() => stellar.encodeScVal({ type: 'u128', value: -1 })).toThrow(/u128 out of range/)
  })

  test('parseScVal: hand-built ScvSymbol', () => {
    // SCSymbol = string<32>: u32 length + bytes + padding to 4
    const xdr = new stellar.XdrWriter().u32(stellar.SC_VAL.SYMBOL).u32(7).bytes(Buffer.from('balance', 'ascii')).toBuffer()
    expect(xdr.toString('hex')).toBe('0000000f' + '00000007' + Buffer.from('balance').toString('hex') + '00')
    expect(stellar.parseScVal(xdr)).toBe('balance')
    expect(stellar.encodeScVal({ type: 'symbol', value: 'balance' }).equals(xdr)).toBe(true)
    expect(() => stellar.encodeScVal({ type: 'symbol', value: 'x'.repeat(33) })).toThrow(/longer than 32/)
    // untyped strings other than G.../C... must be tagged
    expect(() => stellar.encodeScVal('balance')).toThrow(/Ambiguous string argument/)
  })

  test('parseScVal: hand-built ScvVec', () => {
    // SCVec* present (1), 3 items: u32 1, symbol "hi", void
    const w = new stellar.XdrWriter()
    w.u32(stellar.SC_VAL.VEC).u32(1).u32(3)
    w.u32(stellar.SC_VAL.U32).u32(1)
    w.u32(stellar.SC_VAL.SYMBOL).string('hi')
    w.u32(stellar.SC_VAL.VOID)
    const xdr = w.toBuffer()
    expect(stellar.parseScVal(xdr)).toEqual([1, 'hi', null])
    expect(stellar.encodeScVal([1, { type: 'symbol', value: 'hi' }, null]).equals(xdr)).toBe(true)

    // absent SCVec* -> null
    expect(stellar.parseScVal(new stellar.XdrWriter().u32(stellar.SC_VAL.VEC).u32(0).toBuffer())).toBeNull()
    // empty vec
    expect(stellar.parseScVal(stellar.encodeScVal([]))).toEqual([])
    // nested vec
    expect(stellar.parseScVal(stellar.encodeScVal([[1, 2], [BigInt(3)]]))).toEqual([[1, 2], [BigInt(3)]])
  })

  test('encodeScVal -> parseScVal round trip for the remaining types', () => {
    const rt = (arg: stellar.ScArgInput) => stellar.parseScVal(stellar.encodeScVal(arg))
    expect(rt(true)).toBe(true)
    expect(rt(false)).toBe(false)
    expect(rt(null)).toBeNull()
    expect(rt(undefined)).toBeNull()
    expect(rt({ type: 'i32', value: -5 })).toBe(-5)
    expect(rt({ type: 'u64', value: '18446744073709551615' })).toBe(BigInt('18446744073709551615'))
    expect(rt({ type: 'i64', value: '-9223372036854775808' })).toBe(BigInt('-9223372036854775808'))
    expect(rt({ type: 'timepoint', value: 1700000000 })).toBe(BigInt(1700000000))
    expect(rt({ type: 'duration', value: 60 })).toBe(BigInt(60))
    expect(rt({ type: 'u128', value: (BigInt(1) << BigInt(128)) - BigInt(1) })).toBe((BigInt(1) << BigInt(128)) - BigInt(1))
    expect(rt({ type: 'u256', value: (BigInt(1) << BigInt(256)) - BigInt(1) })).toBe((BigInt(1) << BigInt(256)) - BigInt(1))
    expect(rt({ type: 'i256', value: -(BigInt(1) << BigInt(255)) })).toBe(-(BigInt(1) << BigInt(255)))
    expect(rt({ type: 'i256', value: '-123456789012345678901234567890' })).toBe(BigInt('-123456789012345678901234567890'))
    expect(rt({ type: 'string', value: 'hello world' })).toBe('hello world')
    expect(rt({ type: 'bytes', value: '0x0102ff' })).toBe('0x0102ff')
    expect(rt({ type: 'bytes', value: Buffer.from([0xde, 0xad]) })).toBe('0xdead')
    expect(rt(USDC_ISSUER)).toBe(USDC_ISSUER) // untyped G... -> ScvAddress(account)
    expect(rt(USDC_SAC)).toBe(USDC_SAC)       // untyped C... -> ScvAddress(contract)
    expect(rt({ type: 'address', value: USDC_ISSUER })).toBe(USDC_ISSUER)
    expect(rt({ type: 'map', value: { b: 2, a: 1, c: { type: 'symbol', value: 'x' } } })).toEqual({ a: 1, b: 2, c: 'x' })

    // address XDR layout: tag 18, SCAddressType, (PublicKeyType for accounts), 32 bytes
    const acct = stellar.encodeScVal(USDC_ISSUER)
    expect(acct.length).toBe(4 + 4 + 4 + 32)
    expect(acct.readUInt32BE(0)).toBe(stellar.SC_VAL.ADDRESS)
    expect(acct.readUInt32BE(4)).toBe(stellar.SC_ADDR.ACCOUNT)
    expect(acct.readUInt32BE(8)).toBe(0)
    const contract = stellar.encodeScVal(USDC_SAC)
    expect(contract.length).toBe(4 + 4 + 32)
    expect(contract.readUInt32BE(4)).toBe(stellar.SC_ADDR.CONTRACT)

    // map keys are sorted, so the two orders encode identically
    expect(stellar.encodeScVal({ type: 'map', value: { b: 2, a: 1 } }).equals(stellar.encodeScVal({ type: 'map', value: { a: 1, b: 2 } }))).toBe(true)

    expect(() => stellar.parseScVal(new stellar.XdrWriter().u32(99).toBuffer())).toThrow(/Unsupported ScVal type: 99/)
    expect(() => stellar.encodeScVal({ type: 'bool', value: 1 })).toThrow(/bool expects boolean/)
    expect(() => stellar.encodeScVal({ foo: 1 } as any)).toThrow(/Untyped object argument/)
  })

  test('normalizeScArg', () => {
    expect(stellar.normalizeScArg(USDC_ISSUER)).toEqual({ type: 'account', value: USDC_ISSUER })
    expect(stellar.normalizeScArg(USDC_SAC)).toEqual({ type: 'address', value: USDC_SAC })
    expect(stellar.normalizeScArg(5)).toEqual({ type: 'u32', value: 5 })
    expect(stellar.normalizeScArg(BigInt(5))).toEqual({ type: 'i128', value: BigInt(5) })
    expect(stellar.normalizeScArg(true)).toEqual({ type: 'bool', value: true })
    expect(stellar.normalizeScArg(null)).toEqual({ type: 'void' })
    expect(stellar.normalizeScArg([1, null])).toEqual({ type: 'vec', value: [{ type: 'u32', value: 1 }, { type: 'void' }] })
    expect(stellar.normalizeScArg({ type: 'symbol', value: 'x' })).toEqual({ type: 'symbol', value: 'x' })
  })

  test('getSacContractId derives the USDC SAC id from the classic asset', () => {
    expect(stellar.getSacContractId({ asset: USDC_ASSET })).toBe(USDC_SAC)
    expect(stellar.getSacContractId({ asset: `USDC:${USDC_ISSUER}` })).toBe(USDC_SAC)
    expect(stellar.getSacContractId({ asset: { code: 'USDC', issuer: USDC_ISSUER } })).toBe(USDC_SAC)
    // native XLM SAC on pubnet
    expect(stellar.getSacContractId({ asset: 'native' })).toBe('CAS3J7GYLGXMF6TDJBBYYSE3HQ6BBSMLNUQ34T6TZMYMW2EVH34XOWMA')
    // a different network passphrase gives a different id
    const testnet = stellar.getSacContractId({ asset: USDC_ASSET, networkPassphrase: 'Test SDF Network ; September 2015' })
    expect(stellar.isContractId(testnet)).toBe(true)
    expect(testnet).not.toBe(USDC_SAC)
    expect(stellar.getNetworkId().toString('hex')).toBe('7ac33997544e3175d266bd022439b22cdb16508c01163f26e5cb2a3e1045a979')
  })

  test('writeAsset: native / alphanum4 / alphanum12 XDR', () => {
    expect(stellar.writeAsset(new stellar.XdrWriter(), 'native').toBuffer().toString('hex')).toBe('00000000')
    const usdc = stellar.writeAsset(new stellar.XdrWriter(), USDC_ASSET).toBuffer()
    expect(usdc.length).toBe(4 + 4 + 4 + 32)
    expect(usdc.readUInt32BE(0)).toBe(1)
    expect(usdc.slice(4, 8).toString('hex')).toBe(Buffer.from('USDC').toString('hex'))
    expect(usdc.slice(12).equals(stellar.strKeyToBytes(USDC_ISSUER))).toBe(true)
    const long = stellar.writeAsset(new stellar.XdrWriter(), `LONGCODE1-${USDC_ISSUER}`).toBuffer()
    expect(long.length).toBe(4 + 12 + 4 + 32)
    expect(long.readUInt32BE(0)).toBe(2)
    expect(long.slice(4, 16).toString('ascii')).toBe('LONGCODE1\0\0\0')
  })

  test('buildInvokeContractEnvelope / buildContractInstanceLedgerKey', () => {
    const env = stellar.buildInvokeContractEnvelope({ contractId: USDC_SAC, method: 'balance', args: [USDC_ISSUER] })
    const r = new stellar.XdrReader(env)
    expect(r.u32()).toBe(2)                                    // ENVELOPE_TYPE_TX
    expect(r.u32()).toBe(0)                                    // KEY_TYPE_ED25519
    expect(r.bytes(32).equals(Buffer.alloc(32))).toBe(true)    // zero source
    expect(r.u32()).toBe(100)                                  // fee
    expect(r.i64()).toBe(BigInt(0))                            // seqNum
    expect(r.u32()).toBe(0)                                    // PRECOND_NONE
    expect(r.u32()).toBe(0)                                    // MEMO_NONE
    expect(r.u32()).toBe(1)                                    // 1 op
    expect(r.u32()).toBe(0)                                    // no op source
    expect(r.u32()).toBe(24)                                   // INVOKE_HOST_FUNCTION
    expect(r.u32()).toBe(0)                                    // HOST_FUNCTION_TYPE_INVOKE_CONTRACT
    expect(r.u32()).toBe(stellar.SC_ADDR.CONTRACT)
    expect(stellar.encodeStrKey(stellar.STRKEY_VERSION.CONTRACT, r.bytes(32))).toBe(USDC_SAC)
    expect(r.string()).toBe('balance')
    expect(r.u32()).toBe(1)                                    // 1 arg
    expect(stellar.readScVal(r)).toBe(USDC_ISSUER)
    expect(r.u32()).toBe(0)                                    // auth
    expect(r.u32()).toBe(0)                                    // ext
    expect(r.u32()).toBe(0)                                    // signatures
    expect(r.remaining).toBe(0)

    const withSource = stellar.buildInvokeContractEnvelope({ contractId: USDC_SAC, method: 'decimals', source: USDC_ISSUER, fee: 7 })
    const r2 = new stellar.XdrReader(withSource, 8)
    expect(stellar.encodeStrKey(stellar.STRKEY_VERSION.ACCOUNT, r2.bytes(32))).toBe(USDC_ISSUER)
    expect(r2.u32()).toBe(7)
    expect(() => stellar.buildInvokeContractEnvelope({ contractId: USDC_ISSUER, method: 'x' })).toThrow(/Invalid contract id/)

    const key = stellar.buildContractInstanceLedgerKey({ contractId: USDC_SAC })
    const kr = new stellar.XdrReader(key)
    expect(kr.u32()).toBe(6)                                   // CONTRACT_DATA
    expect(kr.u32()).toBe(stellar.SC_ADDR.CONTRACT)
    expect(stellar.encodeStrKey(stellar.STRKEY_VERSION.CONTRACT, kr.bytes(32))).toBe(USDC_SAC)
    expect(kr.u32()).toBe(stellar.SC_VAL.LEDGER_KEY_CONTRACT_INSTANCE)
    expect(kr.u32()).toBe(1)                                   // PERSISTENT
    expect(kr.remaining).toBe(0)
  })

  test('parseScVal: map, error, bytes, contract instance', () => {
    // map keyed by symbols
    const m = new stellar.XdrWriter().u32(stellar.SC_VAL.MAP).u32(1).u32(1)
    m.u32(stellar.SC_VAL.SYMBOL).string('k').u32(stellar.SC_VAL.U32).u32(9)
    expect(stellar.parseScVal(m.toBuffer())).toEqual({ k: 9 })
    // enum key Vec[Symbol('Admin')] collapses to 'Admin'
    const e = new stellar.XdrWriter().u32(stellar.SC_VAL.MAP).u32(1).u32(1)
    e.u32(stellar.SC_VAL.VEC).u32(1).u32(1).u32(stellar.SC_VAL.SYMBOL).string('Admin')
    stellar.writeAddress(e, USDC_ISSUER)
    expect(stellar.parseScVal(e.toBuffer())).toEqual({ Admin: USDC_ISSUER })
    // absent map
    expect(stellar.parseScVal(new stellar.XdrWriter().u32(stellar.SC_VAL.MAP).u32(0).toBuffer())).toBeNull()
    // error
    expect(stellar.parseScVal(new stellar.XdrWriter().u32(stellar.SC_VAL.ERROR).u32(0).u32(3).toBuffer())).toEqual({ error: 0, code: 3 })
    // bytes
    expect(stellar.parseScVal(new stellar.XdrWriter().u32(stellar.SC_VAL.BYTES).opaque(Buffer.from([0xab, 0xcd])).toBuffer())).toBe('0xabcd')
    // contract instance: stellar asset executable, storage { METADATA: {...} }
    const ci = new stellar.XdrWriter().u32(stellar.SC_VAL.CONTRACT_INSTANCE).u32(1).u32(1).u32(1)
    ci.u32(stellar.SC_VAL.SYMBOL).string('METADATA')
    stellar.writeScVal(ci, { type: 'map', value: { decimal: 7, name: { type: 'string', value: 'USDC' } } })
    expect(stellar.parseScVal(ci.toBuffer())).toEqual({ executable: { type: 'stellar_asset' }, storage: { METADATA: { decimal: 7, name: 'USDC' } } })
    // wasm executable with hash, no storage
    const hash = Buffer.alloc(32, 0xaa)
    const wasm = new stellar.XdrWriter().u32(stellar.SC_VAL.CONTRACT_INSTANCE).u32(0).bytes(hash).u32(0)
    expect(stellar.parseScVal(wasm.toBuffer())).toEqual({ executable: { type: 'wasm', hash: 'aa'.repeat(32) }, storage: {} })
  })
})

describe('chains.stellar live', () => {
  test('getAssetSupply USDC > 0 with 7 decimals', async () => {
    const res = await stellar.getAssetSupply({ code: 'USDC', issuer: USDC_ISSUER })
    expect(res.asset).toBe(USDC_ASSET)
    expect(res.decimals).toBe(7)
    expect(/^\d+$/.test(res.supply)).toBe(true)
    expect(BigInt(res.supply) > BigInt(0)).toBe(true)
    expect(BigInt(res.supply)).toBe(BigInt(res.authorized) + BigInt(res.contracts) + BigInt(res.liquidityPools) + BigInt(res.claimableBalances))
    expect(res.numAccounts).toBeGreaterThan(0)
    // the same via the asset string form
    const viaAsset = await stellar.getAssetSupply({ asset: USDC_ASSET })
    expect(viaAsset.asset).toBe(USDC_ASSET)
    expect(viaAsset.decimals).toBe(7)
  })

  test('getAccountBalances for the USDC issuer contains a native entry', async () => {
    const balances = await stellar.getAccountBalances({ address: USDC_ISSUER })
    const native = balances.find(b => b.asset === 'native')
    expect(native).toBeDefined()
    expect(native!.assetType).toBe('native')
    expect(/^\d+$/.test(native!.raw)).toBe(true)
    expect(stellar.toRaw(native!.balance)).toBe(native!.raw)
    const nativeBalance = await stellar.getNativeBalance({ address: USDC_ISSUER })
    expect(/^\d+$/.test(nativeBalance)).toBe(true)
  })

  test('getSorobanTokenDecimals / Symbol / Name on the USDC SAC', async () => {
    expect(await stellar.getSorobanTokenDecimals({ contractId: USDC_SAC })).toBe(7)
    expect(await stellar.getSorobanTokenSymbol({ contractId: USDC_SAC })).toBe('USDC')
    expect(await stellar.getSorobanTokenName({ contractId: USDC_SAC })).toBe(`USDC:${USDC_ISSUER}`)
    expect(await stellar.getSacClassicAsset({ contractId: USDC_SAC })).toEqual({ code: 'USDC', issuer: USDC_ISSUER })
  })

  test('getSorobanTokenBalance returns a numeric string', async () => {
    const balance = await stellar.getSorobanTokenBalance({ contractId: USDC_SAC, address: USDC_ISSUER })
    expect(/^-?\d+$/.test(balance)).toBe(true)
    const viaToken = await stellar.getTokenBalance({ asset: USDC_SAC, address: USDC_ISSUER })
    expect(/^-?\d+$/.test(viaToken)).toBe(true)
  })

  test('getLatestLedger (Horizon) and getLatestSorobanLedger (RPC)', async () => {
    const [horizon, soroban] = await Promise.all([stellar.getLatestLedger(), stellar.getLatestSorobanLedger()])
    expect(horizon.number).toBeGreaterThan(0)
    expect(horizon.timestamp).toBeGreaterThan(1_600_000_000)
    expect(typeof horizon.hash).toBe('string')
    expect(/^\d+$/.test(horizon.totalCoins!)).toBe(true)
    expect(soroban.number).toBeGreaterThan(0)
    expect(soroban.protocolVersion).toBeGreaterThan(0)
    expect(Math.abs(soroban.number - horizon.number)).toBeLessThan(1000)
  })
})
