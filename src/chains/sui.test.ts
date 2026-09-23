import * as sui from "./sui";

const SUI = '0x2::sui::SUI'
const SUI_PADDED = '0x0000000000000000000000000000000000000000000000000000000000000002::sui::SUI'
const USDC = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7::usdc::USDC'
const CETUS_SWAP_EVENT = '0x1eabed72c53feb3805120a081dc15963c204dc8d091542592abaf7a35689b2fb::pool::SwapEvent'
// Cetus SUI/USDC pool (shared object, owns coin balances via the pool struct, not as an address) - used as a plain address for balances
const KNOWN_ADDRESS = '0xdba34672e30cb065b1f93e3ab55318768fd6fef66c15942c9f7cb846e2f900e7'

// endpoint env keys (getEnvValue also honours the LLAMA_SDK_ / SDK_ prefixes); the shell may have
// SUI_RPC etc. set, so the offline block clears them and restores them for the live block
const ENV_KEYS = ['SUI_GRAPH_RPC', 'SUI_RPC', 'IOTA_RPC', 'IOTA_GRAPH_RPC']
  .flatMap(k => [k, `LLAMA_SDK_${k}`, `SDK_${k}`])

describe('chains.sui offline', () => {
  const saved: Record<string, string | undefined> = {}
  const clearEnv = () => ENV_KEYS.forEach(k => { delete process.env[k] })

  beforeAll(() => {
    ENV_KEYS.forEach(k => { saved[k] = process.env[k] })
    clearEnv()
  })
  afterEach(clearEnv)
  afterAll(() => {
    ENV_KEYS.forEach(k => { if (saved[k] !== undefined) process.env[k] = saved[k] })
  })

  test('suiChains and default endpoints', () => {
    expect(sui.suiChains).toEqual(['sui', 'iota'])
    expect(sui.getGraphqlEndpoint()).toBe('https://graphql.mainnet.sui.io/graphql')
    expect(sui.getGraphqlEndpoint({ chain: 'sui' })).toBe(sui.DEFAULT_GRAPHQL_ENDPOINTS.sui)
    expect(sui.getRpcEndpoint()).toBe('https://sui-rpc.publicnode.com')
    expect(sui.getRpcEndpoint({ chain: 'iota' })).toBe('https://api.mainnet.iota.cafe')
    expect(sui.hasGraphql('sui')).toBe(true)
    expect(sui.hasGraphql('iota')).toBe(false)
    expect(() => sui.getGraphqlEndpoint({ chain: 'iota' })).toThrow(/No RPC endpoint configured/)
    expect(() => sui.getRpcEndpoint({ chain: 'notachain' })).toThrow(/No RPC endpoint configured/)
  })

  test('SUI_GRAPH_RPC / SUI_RPC / IOTA_RPC env override the defaults', () => {
    process.env.SUI_GRAPH_RPC = 'https://graphql.example.com/graphql,https://graphql2.example.com/graphql'
    process.env.SUI_RPC = 'https://sui.example.com'
    process.env.IOTA_RPC = 'https://iota.example.com'
    expect(sui.getGraphqlEndpoint()).toBe('https://graphql.example.com/graphql')
    expect(sui.getGraphqlEndpoints()).toEqual(['https://graphql.example.com/graphql', 'https://graphql2.example.com/graphql'])
    expect(sui.getRpcEndpoint()).toBe('https://sui.example.com')
    expect(sui.getRpcEndpoint({ chain: 'iota' })).toBe('https://iota.example.com')
    // graphql env for a chain without a built-in graphql endpoint enables the graphql path
    process.env.IOTA_GRAPH_RPC = 'https://iota-graphql.example.com/graphql'
    expect(sui.hasGraphql('iota')).toBe(true)
    expect(sui.getGraphqlEndpoint({ chain: 'iota' })).toBe('https://iota-graphql.example.com/graphql')
    delete process.env.SUI_GRAPH_RPC
    delete process.env.SUI_RPC
    delete process.env.IOTA_GRAPH_RPC
    expect(sui.getGraphqlEndpoint()).toBe(sui.DEFAULT_GRAPHQL_ENDPOINTS.sui)
    expect(sui.getRpcEndpoint()).toBe(sui.DEFAULT_RPC_ENDPOINTS.sui)
    expect(sui.hasGraphql('iota')).toBe(false)
  })

  test('hexToBytes / bytesToHex', () => {
    const two = sui.hexToBytes('0x2')
    expect(two).toHaveLength(32)
    expect(two.slice(0, 31).every(b => b === 0)).toBe(true)
    expect(two[31]).toBe(2)
    expect(sui.bytesToHex(two)).toBe('0x' + '0'.repeat(63) + '2')
    expect(sui.hexToBytes('ff', 2)).toEqual([0, 255])
    expect(sui.hexToBytes('0xABCD', 2)).toEqual([0xab, 0xcd])
    expect(() => sui.hexToBytes('0xzz')).toThrow(/Invalid Sui hex value/)
    expect(() => sui.hexToBytes('0x' + '1'.repeat(65))).toThrow(/Invalid Sui hex value/)
    expect(() => sui.hexToBytes('')).toThrow(/Invalid Sui hex value/)
  })

  test('uleb128 encode / decode round trips', () => {
    const cases: [number, number[]][] = [
      [0, [0x00]],
      [127, [0x7f]],
      [128, [0x80, 0x01]],
      [300, [0xac, 0x02]],
      [16384, [0x80, 0x80, 0x01]],
    ]
    for (const [value, bytes] of cases) {
      expect(sui.uleb128Encode(value)).toEqual(bytes)
      expect(sui.uleb128Decode(bytes)).toEqual({ value, length: bytes.length })
    }
    expect(sui.uleb128Encode('300')).toEqual([0xac, 0x02])
    expect(sui.uleb128Encode(BigInt(128))).toEqual([0x80, 0x01])
    expect(sui.uleb128).toBe(sui.uleb128Encode)
    // decode at an offset, trailing bytes ignored
    expect(sui.uleb128Decode([0xff, 0xac, 0x02, 0x99], 1)).toEqual({ value: 300, length: 2 })
    expect(sui.uleb128Decode(Uint8Array.from([0x80, 0x01]))).toEqual({ value: 128, length: 2 })
    expect(() => sui.uleb128Encode(-1)).toThrow(/Invalid uleb128 value/)
    expect(() => sui.uleb128Encode(1.5)).toThrow(/Invalid uleb128 value/)
    expect(() => sui.uleb128Decode([0x80])).toThrow(RangeError)
  })

  test('toLittleEndian / fromLittleEndian round trips (u64 / u128)', () => {
    expect(sui.toU64(1)).toEqual([1, 0, 0, 0, 0, 0, 0, 0])
    expect(sui.toU64(0)).toEqual(new Array(8).fill(0))
    expect(sui.toU64(0x0102)).toEqual([2, 1, 0, 0, 0, 0, 0, 0])
    expect(sui.fromU64([2, 1, 0, 0, 0, 0, 0, 0])).toBe(BigInt(258))

    const u64Max = BigInt('18446744073709551615')
    expect(sui.toU64(u64Max)).toEqual(new Array(8).fill(255))
    expect(sui.fromU64(sui.toU64(u64Max))).toBe(u64Max)
    expect(sui.fromU64(sui.toU64('1234567890123456789'))).toBe(BigInt('1234567890123456789'))

    const u128Value = BigInt('340282366920938463463374607431768211455') // 2^128 - 1
    expect(sui.toU128(u128Value)).toHaveLength(16)
    expect(sui.fromU128(sui.toU128(u128Value))).toBe(u128Value)
    const mixed = BigInt('0x0123456789abcdef0fedcba987654321')
    expect(sui.fromU128(sui.toU128(mixed))).toBe(mixed)
    expect(sui.toU128(mixed)[0]).toBe(0x21)
    expect(sui.toU128(mixed)[15]).toBe(0x01)

    // offsets and sizes
    expect(sui.fromLittleEndian([0xff, 1, 0, 0, 0, 0, 0, 0, 0], 1, 8)).toBe(BigInt(1))
    expect(sui.fromU16([0x34, 0x12])).toBe(BigInt(0x1234))
    expect(sui.toU16(0x1234)).toEqual([0x34, 0x12])

    expect(() => sui.toU64(-1)).toThrow(/out of range/)
    expect(() => sui.toU64(BigInt(1) << BigInt(64))).toThrow(/out of range/)
    expect(() => sui.toU64(1.5)).toThrow(/Invalid u64 value/)
    expect(() => sui.toU64('abc')).toThrow(/Invalid u64 value/)
    expect(() => sui.fromU64([1, 2, 3])).toThrow(RangeError)
  })

  test('splitTypeArgs respects nested generics', () => {
    expect(sui.splitTypeArgs('u64')).toEqual(['u64'])
    expect(sui.splitTypeArgs('')).toEqual([])
    expect(sui.splitTypeArgs('0x2::sui::SUI, 0x2::coin::Coin<0x2::sui::SUI>')).toEqual([SUI, '0x2::coin::Coin<0x2::sui::SUI>'])
    expect(sui.splitTypeArgs('0xa::m::A<0xb::m::B<u8, u16>, u32>,vector<u8>, 0xc::m::C'))
      .toEqual(['0xa::m::A<0xb::m::B<u8, u16>, u32>', 'vector<u8>', '0xc::m::C'])
    expect(() => sui.splitTypeArgs('0xa::m::A<u8')).toThrow(/Unbalanced/)
    expect(() => sui.splitTypeArgs('0xa::m::A>')).toThrow(/Unbalanced/)
  })

  test('parseStructTag', () => {
    expect(sui.parseStructTag(SUI)).toEqual({ address: '0x2', module: 'sui', name: 'SUI', typeParams: [] })
    expect(sui.parseStructTag('0x2::coin::Coin<0x2::sui::SUI>')).toEqual({ address: '0x2', module: 'coin', name: 'Coin', typeParams: [SUI] })
    const nested = sui.parseStructTag('0xabc::pool::Pool<0x2::sui::SUI, 0xdef::lp::LP<0x2::sui::SUI, u64>>')
    expect(nested).toEqual({ address: '0xabc', module: 'pool', name: 'Pool', typeParams: [SUI, '0xdef::lp::LP<0x2::sui::SUI, u64>'] })
    expect(sui.parseStructTag(nested.typeParams[1])).toEqual({ address: '0xdef', module: 'lp', name: 'LP', typeParams: [SUI, 'u64'] })
    expect(() => sui.parseStructTag('0x2::sui')).toThrow(/Invalid Sui struct tag/)
    expect(() => sui.parseStructTag('u64')).toThrow(/Invalid Sui struct tag/)
    expect(() => sui.parseStructTag('0x2::coin::Coin<0x2::sui::SUI')).toThrow(/Invalid Sui struct tag/)
  })

  test('typeTagToBytes', () => {
    // primitives
    expect(sui.typeTagToBytes('bool')).toEqual([0])
    expect(sui.typeTagToBytes('u8')).toEqual([1])
    expect(sui.typeTagToBytes('u64')).toEqual([2])
    expect(sui.typeTagToBytes('u128')).toEqual([3])
    expect(sui.typeTagToBytes('address')).toEqual([4])
    expect(sui.typeTagToBytes('u16')).toEqual([8])
    expect(sui.typeTagToBytes('u32')).toEqual([9])
    expect(sui.typeTagToBytes('u256')).toEqual([10])
    expect(sui.typeTagToBytes('vector<u8>')).toEqual([6, 1])
    expect(sui.typeTagToBytes('vector<vector<u64>>')).toEqual([6, 6, 2])

    // struct: variant 7, 32 byte address, uleb-prefixed module + name, uleb type param count
    const expected = [
      7,
      ...new Array(31).fill(0), 2,
      3, 0x73, 0x75, 0x69,       // "sui"
      3, 0x53, 0x55, 0x49,       // "SUI"
      0,
    ]
    expect(sui.typeTagToBytes(SUI)).toEqual(expected)
    expect(sui.typeTagToBytes(SUI)).toHaveLength(42)
    expect(sui.typeTagToBytes(SUI_PADDED)).toEqual(expected)

    // generic struct: type params appended in order
    const coin = sui.typeTagToBytes('0x2::coin::Coin<0x2::sui::SUI>')
    const coinHead = [7, ...new Array(31).fill(0), 2, 4, ...Array.from(Buffer.from('coin')), 4, ...Array.from(Buffer.from('Coin')), 1]
    expect(coin).toEqual([...coinHead, ...expected])
    expect(() => sui.typeTagToBytes('0x2::sui')).toThrow(/Invalid Sui struct tag/)
  })

  test('normalizeSuiAddress pads to 64 hex chars', () => {
    const two = '0x' + '0'.repeat(63) + '2'
    expect(sui.normalizeSuiAddress('0x2')).toBe(two)
    expect(sui.normalizeSuiAddress('2')).toBe(two)
    expect(sui.normalizeSuiAddress(' 0X2 ')).toBe(two)
    expect(sui.normalizeSuiAddress('0xA')).toBe('0x' + '0'.repeat(63) + 'a')
    expect(sui.normalizeSuiAddress(KNOWN_ADDRESS)).toBe(KNOWN_ADDRESS)
    expect(sui.normalizeSuiAddress(KNOWN_ADDRESS.toUpperCase().replace('0X', '0x'))).toBe(KNOWN_ADDRESS)
    expect(() => sui.normalizeSuiAddress('0xzz')).toThrow(/Invalid Sui address/)
    expect(() => sui.normalizeSuiAddress('')).toThrow(/Invalid Sui address/)
    expect(() => sui.normalizeSuiAddress('0x' + '1'.repeat(65))).toThrow(/Invalid Sui address/)
  })

  test('normalizeCoinType pads the address and keeps the rest', () => {
    expect(sui.normalizeCoinType(SUI)).toBe(SUI_PADDED)
    expect(sui.normalizeCoinType(SUI_PADDED)).toBe(SUI_PADDED)
    expect(sui.normalizeCoinType(USDC)).toBe(USDC)
    expect(sui.normalizeCoinType('0xABC::m::T')).toBe('0x' + '0'.repeat(61) + 'abc::m::T')
    // only the leading address is normalized, generics are left untouched
    expect(sui.normalizeCoinType('0x2::coin::Coin<0x2::sui::SUI>')).toBe('0x' + '0'.repeat(63) + '2::coin::Coin<0x2::sui::SUI>')
    expect(() => sui.normalizeCoinType('zz::m::T')).toThrow(/Invalid Sui address/)
  })

  test('bcsDynamicFieldName', () => {
    // u64 1 -> 01 00 00 00 00 00 00 00
    expect(sui.bcsDynamicFieldName('u64', 1)).toBe('AQAAAAAAAAA=')
    expect(sui.bcsDynamicFieldName('u64', '1')).toBe('AQAAAAAAAAA=')
    expect(sui.bcsDynamicFieldName('u64', BigInt(1))).toBe('AQAAAAAAAAA=')
    expect(sui.bcsDynamicFieldName('u64', 0)).toBe(Buffer.from(new Array(8).fill(0)).toString('base64'))
    expect(sui.bcsDynamicFieldName('u64', 256)).toBe(Buffer.from([0, 1, 0, 0, 0, 0, 0, 0]).toString('base64'))
    expect(sui.bcsDynamicFieldName('u8', 255)).toBe('/w==')
    expect(sui.bcsDynamicFieldName('bool', true)).toBe('AQ==')
    expect(sui.bcsDynamicFieldName('bool', false)).toBe('AA==')
    expect(sui.bcsDynamicFieldName('u128', 1)).toBe(Buffer.from([1, ...new Array(15).fill(0)]).toString('base64'))

    // struct names: String / TypeName are uleb-length prefixed utf8
    expect(sui.bcsDynamicFieldName('0x1::string::String', 'abc')).toBe('A2FiYw==')
    expect(sui.bcsDynamicFieldName('0x1::ascii::String', 'abc')).toBe('A2FiYw==')
    const typeName = sui.bcsDynamicFieldName('0x1::type_name::TypeName', SUI)
    expect(Buffer.from(typeName, 'base64')).toEqual(Buffer.from([SUI.length, ...Buffer.from(SUI)]))
    expect(sui.bcsDynamicFieldName('vector<u8>', [1, 2, 3])).toBe(Buffer.from([3, 1, 2, 3]).toString('base64'))
    expect(sui.bcsDynamicFieldName('vector<u8>', 'abc')).toBe('A2FiYw==')

    // address / ID are the 32 byte address
    const idBcs = sui.bcsDynamicFieldName('0x2::object::ID', '0x2')
    expect(Buffer.from(idBcs, 'base64')).toEqual(Buffer.from(sui.hexToBytes('0x2')))
    expect(sui.bcsDynamicFieldName('address', '0x2')).toBe(idBcs)
    expect(sui.bcsDynamicFieldName('0x2::object::UID', '0x2')).toBe(idBcs)
    expect(sui.bcsDynamicFieldName('0x2::object::ID', KNOWN_ADDRESS)).toBe(Buffer.from(KNOWN_ADDRESS.slice(2), 'hex').toString('base64'))

    expect(() => sui.bcsDynamicFieldName('0xabc::m::Unknown', 1)).toThrow(/unsupported dynamic field name type/)
  })

  test('shortenTypeAddresses mirrors the JSON-RPC type display', () => {
    expect(sui.shortenTypeAddresses(SUI_PADDED)).toBe(SUI)
    expect(sui.shortenTypeAddresses(SUI)).toBe(SUI)
    expect(sui.shortenTypeAddresses(USDC)).toBe(USDC)
    expect(sui.shortenTypeAddresses(`0x${'0'.repeat(63)}2::coin::Coin<${SUI_PADDED}>`)).toBe(`0x2::coin::Coin<${SUI}>`)
    // 64 char addresses starting with a single zero keep that zero
    const leadingZero = '0x0' + 'a'.repeat(63)
    expect(sui.shortenTypeAddresses(`${leadingZero}::m::T`)).toBe(`${leadingZero}::m::T`)
    expect(sui.shortenTypeAddresses(`0x00${'a'.repeat(62)}::m::T`)).toBe(`0x${'a'.repeat(62)}::m::T`)
  })

  test('toAddr prefixes bare hex ids', () => {
    expect(sui.toAddr('6')).toBe('0x6')
    expect(sui.toAddr('0x6')).toBe('0x6')
    expect(sui.toAddr(KNOWN_ADDRESS.slice(2))).toBe(KNOWN_ADDRESS)
    expect(sui.toAddr('not-hex')).toBe('not-hex')
    expect(sui.toAddr('')).toBe('')
  })

  test('formatObject shapes GraphQL contents like JSON-RPC content', () => {
    // without layout: generic struct wrapping, string id -> { id }
    const lite = sui.formatObject({
      json: { id: '0x6', timestamp_ms: '1700000000000', nested: { a: '1' }, list: [{ b: '2' }, '3'] },
      type: { repr: '0x0000000000000000000000000000000000000000000000000000000000000002::clock::Clock' },
    })
    expect(lite).toEqual({
      id: '0x6',
      type: '0x2::clock::Clock',
      dataType: 'moveObject',
      fields: { id: { id: '0x6' }, timestamp_ms: '1700000000000', nested: { fields: { a: '1' } }, list: [{ fields: { b: '2' } }, '3'] },
    })
    // explicit address wins over the embedded id
    expect(sui.formatObject({ json: { id: '0x6' }, type: { repr: '0x2::clock::Clock' } }, '0xabc')!.id).toBe('0xabc')

    // with layout: UID / String / TypeName rewrapped
    const layout = {
      struct: {
        type: '0x2::coin::CoinMetadata<0x2::sui::SUI>',
        fields: [
          { name: 'id', layout: { struct: { type: '0x2::object::UID', fields: [{ name: 'id', layout: { struct: { type: '0x2::object::ID', fields: [{ name: 'bytes', layout: 'address' }] } } }] } } },
          { name: 'decimals', layout: 'u8' },
          { name: 'name', layout: { struct: { type: '0x1::string::String', fields: [{ name: 'bytes', layout: { vector: 'u8' } }] } } },
          { name: 'type_name', layout: { struct: { type: '0x1::type_name::TypeName', fields: [{ name: 'name', layout: { struct: { type: '0x1::ascii::String', fields: [{ name: 'bytes', layout: { vector: 'u8' } }] } } }] } } },
          { name: 'owner', layout: 'address' },
        ],
      },
    }
    const json = { id: '0x9', decimals: 9, name: 'Sui', type_name: { name: SUI_PADDED }, owner: 'ab' }
    const full = sui.formatObject({ json, type: { repr: '0x2::coin::CoinMetadata<0x2::sui::SUI>', layout } }, '0x9')
    expect(full).toEqual({
      id: '0x9',
      type: '0x2::coin::CoinMetadata<0x2::sui::SUI>',
      dataType: 'moveObject',
      fields: {
        id: { id: '0x9' },
        decimals: 9,
        name: 'Sui',
        type_name: { type: '0x1::type_name::TypeName', fields: { name: SUI_PADDED } },
        owner: '0xab',
      },
    })
    expect(sui.formatObject(null)).toBeNull()
    expect(sui.formatObject({ json: {} })).toBeNull()
  })

  test('toParsedJson shapes event json like JSON-RPC parsedJson', () => {
    const layout = {
      struct: {
        type: '0xabc::pool::SwapEvent',
        fields: [
          { name: 'pool', layout: { struct: { type: '0x2::object::ID', fields: [{ name: 'bytes', layout: 'address' }] } } },
          { name: 'amount', layout: 'u64' },
          { name: 'coin', layout: { struct: { type: '0x1::type_name::TypeName', fields: [{ name: 'name', layout: { struct: { type: '0x1::ascii::String', fields: [{ name: 'bytes', layout: { vector: 'u8' } }] } } }] } } },
          { name: 'steps', layout: { vector: { struct: { type: '0xabc::pool::Step', fields: [{ name: 'x', layout: 'u8' }] } } } },
        ],
      },
    }
    const json = { pool: { bytes: '0x1' }, amount: '10', coin: { name: SUI }, steps: [{ x: 1 }, { x: 2 }] }
    expect(sui.toParsedJson(json, layout)).toEqual({ pool: '0x1', amount: '10', coin: { name: SUI }, steps: [{ x: 1 }, { x: 2 }] })
    expect(sui.toParsedJson(json, undefined)).toBe(json)
    expect(sui.toParsedJson(null, layout)).toBeNull()
  })

  test('buildProgrammableMoveCallBytes and buildTransactionDataBytes', () => {
    const kind = sui.buildProgrammableMoveCallBytes({
      packageId: '0x2',
      module: 'clock',
      functionName: 'timestamp_ms',
      sharedObjects: [{ objectId: '0x6', initialSharedVersion: 1 }],
    })
    const expected = [
      0,                                   // ProgrammableTransaction
      1,                                   // 1 input
      1, 1, ...sui.hexToBytes('0x6'), ...sui.toU64(1), 0, // CallArg::Object(SharedObject { id, version, mutable: false })
      1, 0,                                // 1 command: MoveCall
      ...sui.hexToBytes('0x2'),
      5, ...Buffer.from('clock'),
      12, ...Buffer.from('timestamp_ms'),
      0,                                   // no type args
      1, 1, 0, 0,                          // 1 arg: Argument::Input(0)
    ]
    expect(Array.from(kind)).toEqual(expected)

    const tx = sui.buildTransactionDataBytes(kind)
    expect(Array.from(tx)).toEqual([
      0, ...expected,
      ...sui.hexToBytes(sui.DUMMY_SENDER),
      0,
      ...sui.hexToBytes(sui.DUMMY_SENDER),
      ...sui.toU64(1000), ...sui.toU64(50_000_000_000),
      0,
    ])

    expect(() => sui.buildProgrammableMoveCallBytes({ packageId: '', module: 'm', functionName: 'f' })).toThrow(/Missing packageId/)
    expect(() => sui.buildProgrammableMoveCallBytes({ packageId: '0x2', module: 'm', functionName: 'f', arguments: [0] })).toThrow(/exceeds input count/)
    expect(() => sui.buildProgrammableMoveCallBytes({ packageId: '0x2', module: 'm', functionName: 'f', arguments: [{} as any] })).toThrow(/Unsupported Sui move call argument/)
  })

  test('sliceIntoChunks is re-exported', () => {
    expect(sui.sliceIntoChunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]])
  })
})

describe('chains.sui live', () => {
  test('getDynamicFieldObjects returns the Field wrapper for primitive values (suilend registry)', async () => {
    // Suilend lending market registry: Table<u64, ID>; adapters read `fields.value` on every entry
    const parent = '0xdc00dfa5ea142a50f6809751ba8dcf84ae5c60ca5f383e51b3438c9f6d72a86e'
    const fields = await sui.getDynamicFieldObjects({ parent, pageSize: 10, limit: 10 })
    expect(fields.length).toBeGreaterThan(0)
    for (const f of fields) {
      expect(f.type).toContain('::dynamic_field::Field<')
      expect(String(f.fields.value)).toMatch(/^0x[0-9a-f]{64}$/)
      expect(f.name).toBeDefined()
    }
    // single field lookup by name resolves to the same wrapper; the key type is the first generic of Field<K, V>
    const keyType = sui.splitTypeArgs(fields[0].type.slice(fields[0].type.indexOf('<') + 1, -1))[0]
    const first = await sui.getDynamicFieldObject({ parent, name: fields[0].name, nameType: keyType })
    expect(first?.fields.value).toBe(fields[0].fields.value)
  })

  test('getCoinMetadata / getTokenSupply SUI has 9 decimals', async () => {
    const meta = await sui.getCoinMetadata({ coinType: SUI })
    expect(meta.decimals).toBe(9)
    expect(meta.symbol).toBe('SUI')
    const supply = await sui.getTokenSupply({ coinType: SUI })
    expect(supply.decimals).toBe(9)
    expect(/^\d+$/.test(supply.supply)).toBe(true)
    expect(BigInt(supply.supply) > BigInt(0)).toBe(true)
    expect(supply.normalized).toBeGreaterThan(0)
  })

  test('getCoinMetadata / getTokenSupply USDC has 6 decimals and supply > 0', async () => {
    const meta = await sui.getCoinMetadata({ coinType: USDC })
    expect(meta.decimals).toBe(6)
    expect(meta.symbol).toBe('USDC')
    const supply = await sui.getTokenSupply({ coinType: USDC })
    expect(supply.decimals).toBe(6)
    expect(BigInt(supply.supply) > BigInt(0)).toBe(true)
    expect(supply.normalized).toBeGreaterThan(0)
  })

  test('getObject on the Clock (0x6)', async () => {
    const clock = await sui.getObject({ objectId: '0x6' })
    expect(clock).not.toBeNull()
    expect(clock!.type).toContain('clock::Clock')
    expect(clock!.dataType).toBe('moveObject')
    expect(clock!.id).toBe(sui.normalizeSuiAddress('0x6'))
    expect(Number(clock!.fields.timestamp_ms)).toBeGreaterThan(1_600_000_000_000)
    expect(clock!.version).toBeDefined()
  })

  test('getObjects preserves order and returns null for missing objects', async () => {
    const [clock, system, missing] = await sui.getObjects({ objectIds: ['0x6', '0x5', '0x' + 'f'.repeat(64)], skipLayout: true })
    expect(clock).not.toBeNull()
    expect(system).not.toBeNull()
    expect(clock!.type).toContain('clock::Clock')
    expect(system!.type).toContain('sui_system::SuiSystemState')
    expect(missing).toBeNull()
    expect(await sui.getObjects({ objectIds: [] })).toEqual([])
  })

  test('getLatestCheckpoint sequenceNumber > 0', async () => {
    const c = await sui.getLatestCheckpoint()
    expect(c.sequenceNumber).toBeGreaterThan(0)
    expect(c.timestamp).toBeGreaterThan(1_600_000_000)
    expect(c.timestamp).toBeLessThan(Date.now() / 1e3 + 3600)
  })

  test('queryEvents with limit returns an array of parsed events', async () => {
    const events = await sui.queryEvents({ eventType: CETUS_SWAP_EVENT, limit: 5, withMetadata: true })
    expect(Array.isArray(events)).toBe(true)
    expect(events.length).toBeGreaterThan(0)
    expect(events.length).toBeLessThanOrEqual(5)
    const event = events[0] as sui.SuiEvent
    expect(sui.shortenTypeAddresses(event.type)).toBe(CETUS_SWAP_EVENT)
    expect(event.timestamp).toBeGreaterThan(1_600_000_000)
    expect(event.json).toBeDefined()
    expect(typeof event.json.pool).toBe('string')
  })

  test('getAllBalances for a known address returns an array', async () => {
    const balances = await sui.getAllBalances({ owner: KNOWN_ADDRESS })
    expect(Array.isArray(balances)).toBe(true)
    for (const b of balances) {
      expect(typeof b.coinType).toBe('string')
      expect(/^\d+$/.test(b.totalBalance)).toBe(true)
    }
    const balance = await sui.getBalance({ owner: KNOWN_ADDRESS, coinType: SUI })
    expect(/^\d+$/.test(balance)).toBe(true)
  })

  test('iota: call iota_getLatestCheckpointSequenceNumber returns a numeric string', async () => {
    const seq = await sui.call({ chain: 'iota', method: 'iota_getLatestCheckpointSequenceNumber', params: [] })
    expect(typeof seq).toBe('string')
    expect(/^\d+$/.test(seq)).toBe(true)
    expect(Number(seq)).toBeGreaterThan(0)
  })
})
