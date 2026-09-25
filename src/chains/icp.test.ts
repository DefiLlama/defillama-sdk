import { createHash } from "crypto";
import * as icp from "./icp";

const ICP_LEDGER = 'ryjl3-tyaaa-aaaaa-aaaba-cai'
const CKBTC_LEDGER = 'mxzaz-hqaaa-aaaar-qaada-cai'
const CKBTC_MINTER = 'mqygn-kiaaa-aaaar-qaadq-cai'
const MANAGEMENT_CANISTER = 'aaaaa-aa'

const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex')

describe('chains.icp offline', () => {
  afterEach(() => {
    delete process.env.ICP_RPC
  })

  describe('CBOR', () => {
    test('encodeCborHead picks the shortest argument encoding', () => {
      expect(hex(icp.encodeCborHead(0, 0))).toBe('00')
      expect(hex(icp.encodeCborHead(0, 23))).toBe('17')
      expect(hex(icp.encodeCborHead(0, 24))).toBe('1818')
      expect(hex(icp.encodeCborHead(0, 255))).toBe('18ff')
      expect(hex(icp.encodeCborHead(0, 256))).toBe('190100')
      expect(hex(icp.encodeCborHead(0, 65536))).toBe('1a00010000')
      expect(hex(icp.encodeCborHead(0, BigInt('4294967296')))).toBe('1b0000000100000000')
      expect(hex(icp.encodeCborHead(2, 3))).toBe('43')
      expect(() => icp.encodeCborHead(0, -1)).toThrow(/non-negative/)
    })

    test('encodeCbor matches RFC 8949 test vectors', () => {
      expect(hex(icp.encodeCbor(0))).toBe('00')
      expect(hex(icp.encodeCbor(10))).toBe('0a')
      expect(hex(icp.encodeCbor(100))).toBe('1864')
      expect(hex(icp.encodeCbor(1000))).toBe('1903e8')
      expect(hex(icp.encodeCbor(1000000))).toBe('1a000f4240')
      expect(hex(icp.encodeCbor(BigInt('1000000000000')))).toBe('1b000000e8d4a51000')
      expect(hex(icp.encodeCbor(-1))).toBe('20')
      expect(hex(icp.encodeCbor(-10))).toBe('29')
      expect(hex(icp.encodeCbor(-100))).toBe('3863')
      expect(hex(icp.encodeCbor(-1000))).toBe('3903e7')
      expect(hex(icp.encodeCbor(false))).toBe('f4')
      expect(hex(icp.encodeCbor(true))).toBe('f5')
      expect(hex(icp.encodeCbor(null))).toBe('f6')
      expect(hex(icp.encodeCbor(undefined))).toBe('f6')
      expect(hex(icp.encodeCbor(''))).toBe('60')
      expect(hex(icp.encodeCbor('a'))).toBe('6161')
      expect(hex(icp.encodeCbor('IETF'))).toBe('6449455446')
      expect(hex(icp.encodeCbor('ü'))).toBe('62c3bc')
      expect(hex(icp.encodeCbor(Buffer.from([1, 2, 3, 4])))).toBe('4401020304')
      expect(hex(icp.encodeCbor([]))).toBe('80')
      expect(hex(icp.encodeCbor([1, 2, 3]))).toBe('83010203')
      expect(hex(icp.encodeCbor([1, [2, 3], [4, 5]]))).toBe('8301820203820405')
      expect(hex(icp.encodeCbor({}))).toBe('a0')
      expect(hex(icp.encodeCbor({ a: 1, b: [2, 3] }))).toBe('a26161016162820203')
      expect(() => icp.encodeCbor(1.5)).toThrow(/integers/)
      expect(() => icp.encodeCbor(() => 1)).toThrow(/Unsupported CBOR value type/)
    })

    test('round trips small / large / negative ints', () => {
      for (const n of [0, 1, 23, 24, 255, 256, 65535, 65536, 4294967295, 4294967296, Number.MAX_SAFE_INTEGER, -1, -24, -25, -256, -65537, Number.MIN_SAFE_INTEGER]) {
        expect(icp.decodeCbor(icp.encodeCbor(n))).toBe(n)
      }
      const big = BigInt('18446744073709551615') // 2^64 - 1
      expect(icp.decodeCbor(icp.encodeCbor(big))).toBe(big)
      const bigNeg = BigInt('-18446744073709551616') // -2^64
      expect(icp.decodeCbor(icp.encodeCbor(bigNeg))).toBe(bigNeg)
      // a bigint within the safe range decodes back to a number
      expect(icp.decodeCbor(icp.encodeCbor(BigInt(42)))).toBe(42)
      expect(() => icp.encodeCbor(BigInt('18446744073709551616'))).toThrow()
    })

    test('round trips byte strings, text, arrays, maps and nested structures', () => {
      const bytes = Buffer.from([0, 1, 2, 250, 255])
      const decodedBytes = icp.decodeCbor(icp.encodeCbor(bytes))
      expect(decodedBytes).toBeInstanceOf(Uint8Array)
      expect(hex(decodedBytes)).toBe(hex(bytes))
      expect(hex(icp.decodeCbor(icp.encodeCbor(Uint8Array.from([9, 8]))))).toBe('0908')
      expect(icp.decodeCbor(icp.encodeCbor(''))).toBe('')
      expect(icp.decodeCbor(icp.encodeCbor('hello é世界'))).toBe('hello é世界')
      expect(icp.decodeCbor(icp.encodeCbor('x'.repeat(300)))).toBe('x'.repeat(300))
      expect(icp.decodeCbor(icp.encodeCbor([1, 'two', [3, null], true]))).toEqual([1, 'two', [3, null], true])
      expect(icp.decodeCbor(icp.encodeCbor(new Array(30).fill(7)))).toEqual(new Array(30).fill(7))

      const nested = {
        content: {
          request_type: 'query',
          canister_id: Buffer.from([0, 0, 0, 0, 0, 0, 0, 2, 1, 1]),
          method_name: 'icrc1_decimals',
          arg: Buffer.from(icp.EMPTY_ARGS),
          sender: Buffer.from([4]),
          ingress_expiry: BigInt('1700000000000000000'),
          list: [1, -2, 'three', { deep: [[]] }],
        },
      }
      const decoded = icp.decodeCbor(icp.encodeCbor(nested))
      expect(decoded.content.request_type).toBe('query')
      expect(hex(decoded.content.canister_id)).toBe('00000000000000020101')
      expect(decoded.content.method_name).toBe('icrc1_decimals')
      expect(hex(decoded.content.arg)).toBe(hex(icp.EMPTY_ARGS))
      expect(hex(decoded.content.sender)).toBe('04')
      expect(decoded.content.ingress_expiry).toBe(BigInt('1700000000000000000'))
      expect(decoded.content.list).toEqual([1, -2, 'three', { deep: [[]] }])
    })

    test('decodeCbor handles tags, indefinite lengths, floats and simple values', () => {
      // self describe tag 55799 followed by the map { "a": 1 }
      expect(icp.decodeCbor(Buffer.from('d9d9f7a1616101', 'hex'))).toEqual({ a: 1 })
      // indefinite length text "strea" + "ming"
      expect(icp.decodeCbor(Buffer.from('7f657374726561646d696e67ff', 'hex'))).toBe('streaming')
      // indefinite length byte string
      expect(hex(icp.decodeCbor(Buffer.from('5f42010243030405ff', 'hex')))).toBe('0102030405')
      // indefinite length array and map
      expect(icp.decodeCbor(Buffer.from('9f018202039f0405ffff', 'hex'))).toEqual([1, [2, 3], [4, 5]])
      expect(icp.decodeCbor(Buffer.from('bf61610161629f0203ffff', 'hex'))).toEqual({ a: 1, b: [2, 3] })
      // floats
      expect(icp.decodeCbor(Buffer.from('fa47c35000', 'hex'))).toBe(100000)
      expect(icp.decodeCbor(Buffer.from('fb3ff199999999999a', 'hex'))).toBe(1.1)
      // simple values
      expect(icp.decodeCbor(Buffer.from('f7', 'hex'))).toBeUndefined()
      expect(icp.decodeCbor(Buffer.from('f6', 'hex'))).toBeNull()
      // cursor advances across consecutive items
      const state = { i: 0 }
      const buf = Buffer.concat([icp.encodeCbor(1), icp.encodeCbor('b')])
      expect(icp.decodeCbor(buf, state)).toBe(1)
      expect(icp.decodeCbor(buf, state)).toBe('b')
      expect(state.i).toBe(buf.length)
      expect(() => icp.decodeCbor(buf, state)).toThrow(/Unexpected end/)
      expect(() => icp.decodeCbor(Buffer.from('1c', 'hex'))).toThrow(/additional info/)
    })
  })

  describe('LEB128', () => {
    test('uleb128 known vectors', () => {
      expect(hex(icp.encodeUleb128(0))).toBe('00')
      expect(hex(icp.encodeUleb128(127))).toBe('7f')
      expect(hex(icp.encodeUleb128(128))).toBe('8001')
      expect(hex(icp.encodeUleb128(624485))).toBe('e58e26')
      expect(hex(icp.encodeUleb128('300'))).toBe('ac02')
      expect(() => icp.encodeUleb128(-1)).toThrow(/non-negative/)
    })

    test('sleb128 known vectors', () => {
      expect(hex(icp.encodeSleb128(0))).toBe('00')
      expect(hex(icp.encodeSleb128(1))).toBe('01')
      expect(hex(icp.encodeSleb128(-1))).toBe('7f')
      expect(hex(icp.encodeSleb128(63))).toBe('3f')
      expect(hex(icp.encodeSleb128(64))).toBe('c000')
      expect(hex(icp.encodeSleb128(-64))).toBe('40')
      expect(hex(icp.encodeSleb128(-65))).toBe('bf7f')
      expect(hex(icp.encodeSleb128(-123456))).toBe('c0bb78')
      // candid type opcodes
      expect(hex(icp.encodeSleb128(icp.CANDID_TYPE.nat))).toBe('7d')
      expect(hex(icp.encodeSleb128(icp.CANDID_TYPE.text))).toBe('71')
      expect(hex(icp.encodeSleb128(icp.CANDID_TYPE.principal))).toBe('68')
      expect(hex(icp.encodeSleb128(icp.CANDID_TYPE.record))).toBe('6c')
    })

    test('uleb128 / sleb128 round trip incl. values beyond 2^64', () => {
      const values = [
        '0', '1', '127', '128', '255', '256', '16383', '16384', '4294967295', '4294967296',
        '9007199254740991', '9007199254740992',
        '18446744073709551615', '18446744073709551616', '36893488147419103232',
        '340282366920938463463374607431768211456', // 2^128
        '115792089237316195423570985008687907853269984665640564039457584007913129639935', // 2^256 - 1
      ].map(v => BigInt(v))
      for (const v of values) {
        const u = icp.encodeUleb128(v)
        const cursor = { i: 0 }
        expect(icp.decodeUleb128(u, cursor)).toBe(v)
        expect(cursor.i).toBe(u.length)
        for (const s of [v, -v]) {
          const enc = icp.encodeSleb128(s)
          const c = { i: 0 }
          expect(icp.decodeSleb128(enc, c)).toBe(s)
          expect(c.i).toBe(enc.length)
        }
      }
      expect(() => icp.decodeUleb128(Buffer.from([0x80]), { i: 0 })).toThrow(/Unexpected end/)
      expect(() => icp.decodeSleb128(Buffer.from([0x80, 0x80]), { i: 0 })).toThrow(/Unexpected end/)
    })
  })

  describe('principal / crc32 / base32', () => {
    test('crc32 check value', () => {
      expect(icp.crc32(Buffer.from('123456789', 'ascii'))).toBe(0xcbf43926)
      expect(icp.crc32(Buffer.alloc(0))).toBe(0)
    })

    test('base32 round trip', () => {
      expect(icp.bytesToBase32(Buffer.alloc(0))).toBe('')
      expect(icp.bytesToBase32(Buffer.from('foobar', 'ascii'))).toBe('mzxw6ytboi')
      expect(Buffer.from(icp.base32ToBytes('MZXW6YTBOI======')).toString('ascii')).toBe('foobar')
      expect(Buffer.from(icp.base32ToBytes('mzxw6-ytboi')).toString('ascii')).toBe('foobar')
      for (const len of [0, 1, 2, 3, 4, 5, 6, 29, 33]) {
        const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 37 + 11) & 0xff)
        expect(hex(icp.base32ToBytes(icp.bytesToBase32(bytes)))).toBe(hex(bytes))
      }
      expect(() => icp.base32ToBytes('a1')).toThrow(/Invalid base32 character/)
    })

    test('principal text <-> bytes known vectors', () => {
      const vectors: [string, string][] = [
        [ICP_LEDGER, '00000000000000020101'],
        [CKBTC_LEDGER, '00000000023000060101'],
        [CKBTC_MINTER, '00000000023000070101'],
        [MANAGEMENT_CANISTER, ''],
      ]
      for (const [text, bytesHex] of vectors) {
        const bytes = icp.principalTextToBytes(text)
        expect(hex(bytes)).toBe(bytesHex)
        expect(icp.principalBytesToText(bytes)).toBe(text)
        expect(icp.principalBytesToText(Buffer.from(bytesHex, 'hex'))).toBe(text)
      }
      expect(icp.principalTextToBytes(MANAGEMENT_CANISTER).length).toBe(0)
      // case insensitive on input, lowercase on output
      expect(hex(icp.principalTextToBytes(ICP_LEDGER.toUpperCase()))).toBe('00000000000000020101')
      expect(hex(icp.principalTextToBytes('ryjl3tyaaaaaaaaaaabacai'))).toBe('00000000000000020101')
    })

    test('principal round trip for arbitrary byte lengths', () => {
      for (const len of [0, 1, 4, 10, 28, 29]) {
        const bytes = Uint8Array.from({ length: len }, (_, i) => (i * 101 + 7) & 0xff)
        const text = icp.principalBytesToText(bytes)
        expect(text).toMatch(/^[a-z2-7]{1,5}(-[a-z2-7]{1,5})*$/)
        expect(hex(icp.principalTextToBytes(text))).toBe(hex(bytes))
        expect(icp.isPrincipal(text)).toBe(true)
      }
      expect(() => icp.principalBytesToText(Buffer.alloc(30))).toThrow(/too long/)
    })

    test('principalTextToBytes rejects malformed input', () => {
      expect(() => icp.principalTextToBytes('')).toThrow(/Invalid principal/)
      expect(() => icp.principalTextToBytes('aaaa')).toThrow(/too short/)
      // checksum mismatch: flip one character of a valid principal
      expect(() => icp.principalTextToBytes('syjl3-tyaaa-aaaaa-aaaba-cai')).toThrow(/checksum mismatch/)
      expect(() => icp.principalTextToBytes('ryjl3-tyaaa-aaaaa-aaaba-cbi')).toThrow(/checksum mismatch/)
      expect(() => icp.principalTextToBytes('ryjl3-tyaaa-aaaaa-aaaba-ca1')).toThrow(/Invalid base32 character/)
      expect(() => icp.principalTextToBytes(undefined as any)).toThrow(/Invalid principal/)
    })

    test('isPrincipal', () => {
      expect(icp.isPrincipal(ICP_LEDGER)).toBe(true)
      expect(icp.isPrincipal(CKBTC_LEDGER)).toBe(true)
      expect(icp.isPrincipal(MANAGEMENT_CANISTER)).toBe(true)
      expect(icp.isPrincipal(ICP_LEDGER.toUpperCase())).toBe(true)
      expect(icp.isPrincipal('')).toBe(false)
      expect(icp.isPrincipal('garbage')).toBe(false)
      expect(icp.isPrincipal('syjl3-tyaaa-aaaaa-aaaba-cai')).toBe(false)
      expect(icp.isPrincipal('ryjl3-tyaaa-aaaaa-aaaba-caj')).toBe(false) // trailing padding bits differ
      expect(icp.isPrincipal('ryjl3tyaaaaaaaaaaabacai')).toBe(false) // valid bytes, wrong grouping
      expect(icp.isPrincipal('0x0000000000000000000000000000000000000000')).toBe(false)
      expect(icp.isPrincipal(123 as any)).toBe(false)
      expect(icp.isPrincipal(null)).toBe(false)
      expect(icp.isPrincipal(undefined)).toBe(false)
      expect(icp.isPrincipal({} as any)).toBe(false)
    })

    test('accountIdentifierFromPrincipal follows the ledger spec', () => {
      const spec = (principal: string, sub: Buffer = Buffer.alloc(32)) => {
        const h = createHash('sha224')
          .update(Buffer.concat([Buffer.from([0x0a]), Buffer.from('account-id', 'ascii'), Buffer.from(icp.principalTextToBytes(principal)), sub]))
          .digest()
        const c = icp.crc32(h)
        return Buffer.concat([Buffer.from([(c >>> 24) & 0xff, (c >>> 16) & 0xff, (c >>> 8) & 0xff, c & 0xff]), h]).toString('hex')
      }
      const ledgerAccount = icp.accountIdentifierFromPrincipal(ICP_LEDGER)
      expect(ledgerAccount).toBe(spec(ICP_LEDGER))
      expect(ledgerAccount).toBe('883eef7c44be51afe4a4420d4df4beff708f3cf2f5de5efcc9f58680bb0f3690')
      expect(ledgerAccount).toMatch(/^[0-9a-f]{64}$/)
      expect(icp.accountIdentifierFromPrincipal(CKBTC_LEDGER)).toBe('eff69ed8f9fc03ceba97e6f4e1a9d1a32641fcd49aba96922c51a7dca91a4c6e')
      expect(icp.accountIdentifierFromPrincipal(MANAGEMENT_CANISTER)).toBe('2d0e897f7e862d2b57d9bc9ea5c65f9a24ac6c074575f47898314b8d6cb0929d')

      // raw principal bytes, explicit / null / empty subaccount all equal the default
      expect(icp.accountIdentifierFromPrincipal(icp.principalTextToBytes(ICP_LEDGER))).toBe(ledgerAccount)
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, null)).toBe(ledgerAccount)
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, Buffer.alloc(32))).toBe(ledgerAccount)
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, '00'.repeat(32))).toBe(ledgerAccount)
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, [])).toBe(ledgerAccount)

      // short subaccounts are right-padded (left zero filled) to 32 bytes
      const sub1 = Buffer.alloc(32)
      sub1[31] = 1
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, [1])).toBe(spec(ICP_LEDGER, sub1))
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, '0x01')).toBe(spec(ICP_LEDGER, sub1))
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, sub1)).toBe(spec(ICP_LEDGER, sub1))
      expect(icp.accountIdentifierFromPrincipal(ICP_LEDGER, sub1)).not.toBe(ledgerAccount)
      expect(() => icp.accountIdentifierFromPrincipal(ICP_LEDGER, Buffer.alloc(33))).toThrow(/at most 32 bytes/)
      expect(() => icp.accountIdentifierFromPrincipal(ICP_LEDGER, 'zz')).toThrow(/Invalid hex subaccount/)
    })
  })

  describe('Candid', () => {
    test('hashCandidLabel / buildLabelHashMap', () => {
      expect(icp.hashCandidLabel('owner')).toBe(947296307)
      expect(icp.hashCandidLabel('subaccount')).toBe(1349681965)
      expect(icp.hashCandidLabel('')).toBe(0)
      expect(icp.hashCandidLabel('a')).toBe(97)
      expect(icp.buildLabelHashMap(['owner', 'subaccount'])).toEqual({ 947296307: 'owner', 1349681965: 'subaccount' })
      expect(icp.buildLabelHashMap()).toEqual({})
    })

    test('encodeCandid([]) is DIDL 0 0 (EMPTY_ARGS)', () => {
      expect(hex(icp.EMPTY_ARGS)).toBe('4449444c0000')
      expect(hex(icp.encodeCandid([]))).toBe(hex(icp.EMPTY_ARGS))
      expect(hex(icp.encodeCandid())).toBe(hex(icp.EMPTY_ARGS))
      expect(icp.decodeCandid(icp.EMPTY_ARGS)).toEqual([])
    })

    test('primitive encodings match the Candid spec', () => {
      expect(hex(icp.encodeCandid([{ type: 'nat', value: 300 }]))).toBe('4449444c00017dac02')
      expect(hex(icp.encodeCandid([{ type: 'int', value: -1 }]))).toBe('4449444c00017c7f')
      expect(hex(icp.encodeCandid([{ type: 'bool', value: true }]))).toBe('4449444c00017e01')
      expect(hex(icp.encodeCandid([{ type: 'text', value: 'hi' }]))).toBe('4449444c000171026869')
      expect(hex(icp.encodeCandid([{ type: 'nat8', value: 8 }]))).toBe('4449444c00017b08')
      expect(hex(icp.encodeCandid([{ type: 'nat64', value: 1 }]))).toBe('4449444c0001780100000000000000')
      expect(hex(icp.encodeCandid([{ type: 'null', value: null }]))).toBe('4449444c00017f')
      expect(hex(icp.encodeCandid([{ type: 'principal', value: MANAGEMENT_CANISTER }]))).toBe('4449444c0001680100')
      expect(hex(icp.encodeCandid([{ type: 'principal', value: ICP_LEDGER }]))).toBe('4449444c000168010a00000000000000020101')
      // vec nat8 -> one composite type table entry
      expect(hex(icp.encodeCandid([{ type: 'blob', value: [1, 2] }]))).toBe('4449444c016d7b0100020102')
      expect(hex(icp.encodeCandid([{ type: { vec: 'nat8' }, value: Uint8Array.from([1, 2]) }]))).toBe('4449444c016d7b0100020102')
      // opt nat: none / some
      expect(hex(icp.encodeCandid([{ type: { opt: 'nat' }, value: null }]))).toBe('4449444c016e7d010000')
      expect(hex(icp.encodeCandid([{ type: { opt: 'nat' }, value: [5] }]))).toBe('4449444c016e7d01000105')
      expect(hex(icp.encodeCandid([{ type: { opt: 'nat' }, value: 5 }]))).toBe('4449444c016e7d01000105')
    })

    test('ICRC-1 account record: encode then decode round trip', () => {
      const accountType: icp.CandidType = { record: { owner: 'principal', subaccount: { opt: 'blob' } } }
      const encoded = icp.encodeCandid([{ type: accountType, value: { owner: CKBTC_MINTER, subaccount: null } }])
      // DIDL, 3 types: vec nat8 (0), opt 0 (1), record { owner: principal; subaccount: opt } (2)
      expect(hex(encoded)).toBe(
        '4449444c' + '03' +
        '6d7b' +
        '6e00' +
        '6c02' + 'b3b0dac303' + '68' + 'ad86ca8305' + '01' +
        '0102' +
        '010a00000000023000070101' + '00',
      )
      const [decoded] = icp.decodeCandid(encoded, icp.buildLabelHashMap(['owner', 'subaccount']))
      expect(decoded).toEqual({ owner: CKBTC_MINTER, subaccount: [] })

      // some(subaccount) and a missing opt field
      const sub = Uint8Array.from({ length: 32 }, (_, i) => i)
      const withSub = icp.decodeCandid(
        icp.encodeCandid([{ type: accountType, value: { owner: ICP_LEDGER, subaccount: sub } }]),
        icp.buildLabelHashMap(['owner', 'subaccount']),
      )[0]
      expect(withSub.owner).toBe(ICP_LEDGER)
      expect(withSub.subaccount).toHaveLength(1)
      expect(withSub.subaccount[0]).toEqual(Array.from(sub))
      const missingOpt = icp.decodeCandid(icp.encodeCandid([{ type: accountType, value: { owner: ICP_LEDGER } }]))[0]
      expect(missingOpt).toEqual({ '947296307': ICP_LEDGER, '1349681965': [] })
      expect(() => icp.encodeCandid([{ type: accountType, value: { subaccount: null } }])).toThrow(/Missing record field "owner"/)
    })

    test('nat / int / text / bool / vec nat8 / fixed width round trips', () => {
      const big = BigInt('340282366920938463463374607431768211456')
      const args: icp.CandidValue[] = [
        { type: 'nat', value: big },
        { type: 'nat', value: 0 },
        { type: 'nat', value: '123456789012345678901234567890' },
        { type: 'int', value: -big },
        { type: 'int', value: 42 },
        { type: 'text', value: 'ckBTC ₿' },
        { type: 'text', value: '' },
        { type: 'bool', value: true },
        { type: 'bool', value: false },
        { type: { vec: 'nat8' }, value: [0, 1, 254, 255] },
        { type: 'blob', value: '0xdeadbeef' },
        { type: 'nat8', value: 255 },
        { type: 'nat16', value: 65535 },
        { type: 'nat32', value: 4294967295 },
        { type: 'nat64', value: BigInt('18446744073709551615') },
        { type: 'int8', value: -128 },
        { type: 'int16', value: -32768 },
        { type: 'int32', value: -2147483648 },
        { type: 'int64', value: BigInt('-9223372036854775808') },
        { type: 'float64', value: 1.5 },
        { type: 'float32', value: -2.5 },
        { type: 'null', value: null },
        { type: 'principal', value: ICP_LEDGER },
        { type: { vec: 'text' }, value: ['a', 'b'] },
        { type: { vec: 'nat' }, value: [1, big] },
        { type: { opt: 'text' }, value: ['x'] },
        { type: { opt: 'text' }, value: [] },
      ]
      const decoded = icp.decodeCandid(icp.encodeCandid(args))
      expect(decoded).toEqual([
        big, BigInt(0), BigInt('123456789012345678901234567890'),
        -big, BigInt(42),
        'ckBTC ₿', '',
        true, false,
        [0, 1, 254, 255],
        [0xde, 0xad, 0xbe, 0xef],
        255, 65535, 4294967295, BigInt('18446744073709551615'),
        -128, -32768, -2147483648, BigInt('-9223372036854775808'),
        1.5, -2.5,
        null,
        ICP_LEDGER,
        ['a', 'b'],
        [BigInt(1), big],
        ['x'], [],
      ])
      expect(() => icp.encodeCandid([{ type: 'nat8', value: 256 }])).toThrow(/out of range/)
      expect(() => icp.encodeCandid([{ type: 'nat', value: 1.5 }])).toThrow(/integer/)
      expect(() => icp.encodeCandid([{ type: 'unknown' as any, value: 1 }])).toThrow(/Unsupported Candid type/)
      expect(() => icp.encodeCandid([{ type: 'empty', value: 1 }])).toThrow(/empty/)
    })

    test('variant and nested record round trips', () => {
      const metadataValue: icp.CandidType = { variant: { Nat: 'nat', Int: 'int', Text: 'text', Blob: 'blob' } }
      const row: icp.CandidType = { record: { 0: 'text', 1: metadataValue } }
      const encoded = icp.encodeCandid([{
        type: { vec: row },
        value: [
          { 0: 'icrc1:symbol', 1: { Text: 'ckBTC' } },
          { 0: 'icrc1:decimals', 1: { Nat: 8 } },
          { 0: 'icrc1:logo', 1: { Blob: [1, 2, 3] } },
          { 0: 'x:int', 1: { Int: -7 } },
        ],
      }])
      const [rows] = icp.decodeCandid(encoded, icp.buildLabelHashMap(['Nat', 'Int', 'Text', 'Blob']))
      expect(rows).toEqual([
        { 0: 'icrc1:symbol', 1: { Text: 'ckBTC' } },
        { 0: 'icrc1:decimals', 1: { Nat: BigInt(8) } },
        { 0: 'icrc1:logo', 1: { Blob: [1, 2, 3] } },
        { 0: 'x:int', 1: { Int: BigInt(-7) } },
      ])

      // unit variant given as a string, and error cases
      const unit: icp.CandidType = { variant: { Ok: 'nat', Err: 'null' } }
      expect(icp.decodeCandid(icp.encodeCandid([{ type: unit, value: 'Err' }]), icp.buildLabelHashMap(['Ok', 'Err']))[0]).toEqual({ Err: null })
      expect(icp.decodeCandid(icp.encodeCandid([{ type: unit, value: { Ok: 5 } }]), icp.buildLabelHashMap(['Ok', 'Err']))[0]).toEqual({ Ok: BigInt(5) })
      expect(() => icp.encodeCandid([{ type: unit, value: 'Nope' }])).toThrow(/Unknown variant tag/)
      expect(() => icp.encodeCandid([{ type: unit, value: { Ok: 1, Err: null } }])).toThrow(/exactly one key/)
      expect(() => icp.encodeCandid([{ type: { record: { a: 'nat' } }, value: 1 }])).toThrow(/record value must be an object/)
      expect(() => icp.encodeCandid([{ type: { vec: 'nat' }, value: 1 }])).toThrow(/vec value must be an array/)
      expect(() => icp.encodeCandid([{ type: { opt: 'nat' }, value: [1, 2] }])).toThrow(/single element array/)
    })

    test('type table is deduplicated across arguments', () => {
      const encoded = icp.encodeCandid([
        { type: { opt: 'blob' }, value: null },
        { type: { opt: 'blob' }, value: [[1]] },
        { type: 'blob', value: [] },
      ])
      // 2 table entries (vec nat8, opt 0), 3 args referencing them
      expect(hex(encoded)).toBe('4449444c02' + '6d7b' + '6e00' + '03' + '010100' + '00' + '01' + '0101' + '00')
      expect(icp.decodeCandid(encoded)).toEqual([[], [[1]], []])
    })

    test('decodeCandid rejects malformed payloads', () => {
      expect(() => icp.decodeCandid(Buffer.from('nope', 'ascii'))).toThrow(/Invalid Candid payload/)
      expect(() => icp.decodeCandid(Buffer.from('4449444c000100', 'hex'))).toThrow(/Unknown Candid type ref/)
      expect(() => icp.decodeCandid(Buffer.from('4449444c00017e02', 'hex'))).toThrow(/Invalid Candid bool/)
      expect(() => icp.decodeCandid(Buffer.from('4449444c016e7d010002', 'hex'))).toThrow(/Invalid Candid opt tag/)
      expect(() => icp.decodeCandid(Buffer.from('4449444c00016800', 'hex'))).toThrow(/Invalid Candid principal tag/)
      expect(() => icp.decodeCandid(Buffer.from('4449444c00016f', 'hex'))).toThrow(/empty/)
    })
  })

  describe('endpoints', () => {
    test('default endpoints', () => {
      expect(icp.CHAIN).toBe('icp')
      expect(icp.DEFAULT_ENDPOINTS).toEqual(['https://icp-api.io', 'https://ic0.app'])
      expect(icp.getEndpoints()).toEqual(icp.DEFAULT_ENDPOINTS)
      expect(icp.ICP_LEDGER).toBe(ICP_LEDGER)
    })

    test('ICP_RPC env endpoints come first, defaults are kept as fallbacks', () => {
      process.env.ICP_RPC = 'https://icp.example.com,https://icp2.example.com/'
      expect(icp.getEndpoints()).toEqual(['https://icp.example.com', 'https://icp2.example.com/', ...icp.DEFAULT_ENDPOINTS])
      process.env.ICP_RPC = 'https://single.example.com'
      expect(icp.getEndpoints()).toEqual(['https://single.example.com', ...icp.DEFAULT_ENDPOINTS])
      delete process.env.ICP_RPC
      expect(icp.getEndpoints()).toEqual(icp.DEFAULT_ENDPOINTS)
    })

    test('queryCanister validates its input before hitting the network', async () => {
      await expect(icp.queryCanister({ canisterId: ICP_LEDGER } as any)).rejects.toThrow(/method is required/)
      await expect(icp.queryCanister({ canisterId: 'garbage', method: 'x' })).rejects.toThrow(/Invalid principal/)
      await expect(icp.callCandid({ canisterId: ICP_LEDGER, method: 'x', args: [1], argTypes: [] })).rejects.toThrow(/length mismatch/)
      await expect(icp.getIcpAccountBalance({ accountIdentifierHex: 'abcd' })).rejects.toThrow(/32 bytes/)
    })

    test('IcpRejectError carries the reject details', () => {
      const err = new icp.IcpRejectError(ICP_LEDGER, 'foo', { status: 'rejected', reject_code: 3, reject_message: 'no such method', error_code: 'IC0302' })
      expect(err).toBeInstanceOf(Error)
      expect(err.name).toBe('IcpRejectError')
      expect(err.message).toMatch(/ryjl3-tyaaa-aaaaa-aaaba-cai did not reply to foo: no such method/)
      expect(err.canisterId).toBe(ICP_LEDGER)
      expect(err.method).toBe('foo')
      expect(err.status).toBe('rejected')
      expect(err.rejectCode).toBe(3)
      expect(err.rejectMessage).toBe('no such method')
      expect(err.errorCode).toBe('IC0302')
    })
  })
})

describe('chains.icp live', () => {
  jest.setTimeout(60_000)

  test('ckBTC ledger: decimals, symbol, name, total supply', async () => {
    const [decimals, symbol, name, supply] = await Promise.all([
      icp.getIcrcDecimals({ ledger: CKBTC_LEDGER }),
      icp.getIcrcSymbol({ ledger: CKBTC_LEDGER }),
      icp.getIcrcName({ ledger: CKBTC_LEDGER }),
      icp.getIcrcTotalSupply({ ledger: CKBTC_LEDGER }),
    ])
    expect(decimals).toBe(8)
    expect(symbol).toBe('ckBTC')
    expect(name).toBe('ckBTC')
    expect(/^\d+$/.test(supply)).toBe(true)
    expect(BigInt(supply) > BigInt(0)).toBe(true)
  })

  test('ICP ledger: decimals and symbol', async () => {
    const [decimals, symbol] = await Promise.all([
      icp.getIcrcDecimals({ ledger: ICP_LEDGER }),
      icp.getIcrcSymbol({ ledger: ICP_LEDGER }),
    ])
    expect(decimals).toBe(8)
    expect(symbol).toBe('ICP')
  })

  test('getIcrcBalance of the ckBTC minter on the ckBTC ledger is a numeric string', async () => {
    const balance = await icp.getIcrcBalance({ ledger: CKBTC_LEDGER, owner: CKBTC_MINTER })
    expect(/^\d+$/.test(balance)).toBe(true)
    const withDefaultSub = await icp.getIcrcBalance({ ledger: CKBTC_LEDGER, owner: CKBTC_MINTER, subaccount: Buffer.alloc(32) })
    expect(/^\d+$/.test(withDefaultSub)).toBe(true)
  })

  test('getIcrcMetadata for ckBTC has icrc1:symbol and icrc1:decimals', async () => {
    const metadata = await icp.getIcrcMetadata({ ledger: CKBTC_LEDGER })
    expect(metadata['icrc1:symbol']).toBe('ckBTC')
    expect(metadata['icrc1:decimals']).toBe('8')
    expect(Object.keys(metadata)).toEqual(expect.arrayContaining(['icrc1:symbol', 'icrc1:decimals', 'icrc1:name']))
  })

  test('getIcpAccountBalance for the ledger account of a principal is a numeric string', async () => {
    const account = icp.accountIdentifierFromPrincipal(CKBTC_MINTER)
    const balance = await icp.getIcpAccountBalance({ accountIdentifierHex: account })
    expect(/^\d+$/.test(balance)).toBe(true)
  })

  test('queryCanisterDecoded positional form and raw queryCanister', async () => {
    const decimals = await icp.queryCanisterDecoded(CKBTC_LEDGER, 'icrc1_decimals')
    expect(decimals).toBe(8)
    const raw = await icp.queryCanister({ canisterId: CKBTC_LEDGER, methodName: 'icrc1_symbol' })
    expect(Buffer.from(raw.slice(0, 4)).toString('ascii')).toBe('DIDL')
    expect(icp.decodeCandid(raw)).toEqual(['ckBTC'])
  })

  test('a missing method is surfaced as IcpRejectError without retry', async () => {
    await expect(icp.queryCanister({ canisterId: CKBTC_LEDGER, method: 'no_such_method_xyz' })).rejects.toBeInstanceOf(icp.IcpRejectError)
  })
})
