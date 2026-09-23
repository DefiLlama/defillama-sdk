import { randomBytes } from "crypto";
import {
  DEFAULT_INDEXER, DEFAULT_ALGOD, getIndexerEndpoint, getAlgodEndpoint,
  base32Encode, base32Decode, encodeAddress, decodeAddress, isValidAddress, getApplicationAddress, encodeUint64, sha512_256,
  decodeGlobalStateKey, decodeGlobalStateValue, decodeGlobalState, bytesAsAddress, bytesAsUint64s, parseJsonSafe, encodeBoxName,
  getAssetSupply, getAssetBalance, getAlgoBalance, lookupApplication, lookupAccount, getAccountInfo, getLatestBlock, getBlock, getBlockAtTimestamp, getAppGlobalState,
} from "./algorand";

// value produced by DefiLlama-Adapters projects/helper/chain/algorandUtils/address.js getApplicationAddress(1002541853)
const APP_1002541853_ADDRESS = 'XSKED5VKZZCSYNDWXZJI65JM2HP7HZFJWCOBIMOONKHTK5UVKENBNVDEYM'
const FOLKS_APP_971368268_ADDRESS = '2ZPNLKXWCOUJ2ONYWZEIWOUYRXL36VCIBGJ4ZJ2AAGET5SIRTHKSNFDJJ4'
const ZERO_ADDRESS = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAY5HFKQ'
const USDC_ASSET_ID = 31566704
const USDC_RESERVE = '2UEQTE5QDNXPI7M3TU44G6SYKLFWLPQO7EBZM7K7MHMQQMFI4QJPLHQFHM'
const FOLKS_APP_ID = 971368268

describe('chains.algorand config', () => {
  afterEach(() => {
    delete process.env.ALGORAND_INDEXER
    delete process.env.ALGORAND_RPC
  })

  test('defaults', () => {
    expect(getIndexerEndpoint()).toBe(DEFAULT_INDEXER)
    expect(getAlgodEndpoint()).toBe(DEFAULT_ALGOD)
  })

  test('ALGORAND_INDEXER env override', () => {
    process.env.ALGORAND_INDEXER = 'https://my-indexer.io,https://backup.io'
    expect(getIndexerEndpoint()).toBe('https://my-indexer.io')
    delete process.env.ALGORAND_INDEXER
    expect(getIndexerEndpoint()).toBe(DEFAULT_INDEXER)
  })

  test('ALGORAND_RPC env override for algod', () => {
    process.env.ALGORAND_RPC = 'https://my-algod.io'
    expect(getAlgodEndpoint()).toBe('https://my-algod.io')
  })
})

describe('chains.algorand codec', () => {
  test('base32 round trip with padding', () => {
    expect(base32Encode(new Uint8Array(Buffer.from('foobar')))).toBe('MZXW6YTBOI======')
    expect(base32Encode(new Uint8Array(Buffer.from('f')))).toBe('MY======')
    expect(base32Encode(new Uint8Array())).toBe('')
    expect(Buffer.from(base32Decode('MZXW6YTBOI======')).toString()).toBe('foobar')
    expect(Buffer.from(base32Decode('MZXW6YTBOI')).toString()).toBe('foobar')
    expect(Buffer.from(base32Decode('mzxw6ytboi')).toString()).toBe('foobar')
    for (let len = 0; len < 40; len++) {
      const bytes = new Uint8Array(randomBytes(len))
      expect(Array.from(base32Decode(base32Encode(bytes)))).toEqual(Array.from(bytes))
    }
    expect(() => base32Decode('MZXW6YTB0I')).toThrow(/invalid base32/)
  })

  test('sha512_256', () => {
    // known vector: SHA-512/256("abc")
    expect(Buffer.from(sha512_256(new Uint8Array(Buffer.from('abc')))).toString('hex')).toBe('53048e2681941ef99b2e29b76b4c7dabe4c2d0c634fc6d46e0e2f13107e7af23')
  })

  test('encodeAddress / decodeAddress round trip on random keys', () => {
    for (let i = 0; i < 50; i++) {
      const publicKey = new Uint8Array(randomBytes(32))
      const address = encodeAddress(publicKey)
      expect(address).toHaveLength(58)
      expect(address).toMatch(/^[A-Z2-7]{58}$/)
      const decoded = decodeAddress(address)
      expect(Array.from(decoded.publicKey)).toEqual(Array.from(publicKey))
      expect(decoded.checksum).toHaveLength(4)
      expect(isValidAddress(address)).toBe(true)
    }
    expect(encodeAddress(new Uint8Array(32))).toBe(ZERO_ADDRESS)
    expect(() => encodeAddress(new Uint8Array(31))).toThrow(/32 bytes/)
  })

  test('isValidAddress rejects corrupted checksum and malformed input', () => {
    const address = encodeAddress(new Uint8Array(randomBytes(32)))
    const lastChar = address[57]
    const replacement = lastChar === 'A' ? 'B' : 'A'
    const corrupted = address.slice(0, 57) + replacement
    expect(isValidAddress(corrupted)).toBe(false)
    expect(() => decodeAddress(corrupted)).toThrow(/checksum/)
    // flipping a public key char also invalidates the checksum
    const flipped = (address[0] === 'A' ? 'B' : 'A') + address.slice(1)
    expect(isValidAddress(flipped)).toBe(false)
    expect(isValidAddress(address.slice(0, 57))).toBe(false)
    expect(isValidAddress(address.toLowerCase() + 'X')).toBe(false)
    expect(isValidAddress('')).toBe(false)
    expect(isValidAddress(USDC_RESERVE)).toBe(true)
    expect(isValidAddress(ZERO_ADDRESS)).toBe(true)
  })

  test('encodeUint64', () => {
    expect(Array.from(encodeUint64(0))).toEqual([0, 0, 0, 0, 0, 0, 0, 0])
    expect(Array.from(encodeUint64(1))).toEqual([0, 0, 0, 0, 0, 0, 0, 1])
    expect(Array.from(encodeUint64(1002541853))).toEqual([0, 0, 0, 0, 0x3b, 0xc1, 0x93, 0x1d])
    expect(Array.from(encodeUint64('18446744073709551615'))).toEqual([255, 255, 255, 255, 255, 255, 255, 255])
    expect(Array.from(encodeUint64(BigInt(256)))).toEqual([0, 0, 0, 0, 0, 0, 1, 0])
    expect(() => encodeUint64(-1)).toThrow(/64-bit/)
    expect(() => encodeUint64(1.5)).toThrow(/64-bit/)
    expect(() => encodeUint64('18446744073709551616')).toThrow(/64-bit/)
  })

  test('getApplicationAddress matches the adapters implementation', () => {
    expect(getApplicationAddress(1002541853)).toBe(APP_1002541853_ADDRESS)
    expect(getApplicationAddress('1002541853')).toBe(APP_1002541853_ADDRESS)
    expect(getApplicationAddress(BigInt(1002541853))).toBe(APP_1002541853_ADDRESS)
    expect(getApplicationAddress(FOLKS_APP_ID)).toBe(FOLKS_APP_971368268_ADDRESS)
    expect(isValidAddress(getApplicationAddress(1))).toBe(true)
  })

  test('global state decoding', () => {
    expect(decodeGlobalStateKey(Buffer.from('total_supply').toString('base64'))).toBe('total_supply')
    expect(decodeGlobalStateValue({ type: 2, uint: 42 })).toBe(42)
    expect(decodeGlobalStateValue({ type: 2, uint: '18446744073709551615' })).toBe('18446744073709551615')
    expect(decodeGlobalStateValue({ type: 2, uint: '12' })).toBe(12)
    expect(decodeGlobalStateValue({ type: 2 })).toBe(0)
    const b64 = Buffer.from('hello').toString('base64')
    expect(decodeGlobalStateValue({ type: 1, bytes: b64 })).toBe(b64)
    const state = decodeGlobalState([
      { key: Buffer.from('a').toString('base64'), value: { type: 2, uint: 7 } },
      { key: Buffer.from('b').toString('base64'), value: { type: 1, bytes: b64 } },
    ])
    expect(state).toEqual({ a: 7, b: b64 })
  })

  test('bytesAsAddress / bytesAsUint64s', () => {
    const publicKey = new Uint8Array(randomBytes(32))
    expect(bytesAsAddress(Buffer.from(publicKey).toString('base64'))).toBe(encodeAddress(publicKey))
    expect(() => bytesAsAddress(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/)
    const packed = Buffer.concat([Buffer.from(encodeUint64(5)), Buffer.from(encodeUint64('18446744073709551615'))])
    expect(bytesAsUint64s(packed.toString('base64')).map(String)).toEqual(['5', '18446744073709551615'])
  })

  test('encodeBoxName', () => {
    expect(encodeBoxName('foo')).toBe('str:foo')
    expect(encodeBoxName('b64:Zm9v')).toBe('b64:Zm9v')
    expect(encodeBoxName('int:5')).toBe('int:5')
    expect(encodeBoxName(new Uint8Array([102, 111, 111]))).toBe('b64:Zm9v')
  })

  test('parseJsonSafe keeps uint64 values exact', () => {
    const text = '{"total":18446744073709551615,"small":123,"neg":-5,"float":1.5e3,"str":"18446744073709551615 \\" x","arr":[9007199254740991,9007199254740993]}'
    expect(parseJsonSafe(text)).toEqual({
      total: '18446744073709551615',
      small: 123,
      neg: -5,
      float: 1500,
      str: '18446744073709551615 " x',
      arr: [9007199254740991, '9007199254740993'],
    })
    expect(parseJsonSafe('[1,2,3]')).toEqual([1, 2, 3])
  })
})

describe('chains.algorand live', () => {
  test('getAssetSupply USDC', async () => {
    const supply = await getAssetSupply({ assetId: USDC_ASSET_ID })
    expect(supply.decimals).toBe(6)
    expect(supply.total).toBe('18446744073709551615')
    expect(supply.reserve).toBe(USDC_RESERVE)
    expect(BigInt(supply.circulating) > BigInt(0)).toBe(true)
    expect(BigInt(supply.circulating) < BigInt(supply.total)).toBe(true)
  })

  test('getAssetBalance USDC reserve > 0, unknown asset -> 0', async () => {
    const balance = await getAssetBalance({ address: USDC_RESERVE, assetId: USDC_ASSET_ID })
    expect(BigInt(balance) > BigInt(0)).toBe(true)
    expect(await getAssetBalance({ address: ZERO_ADDRESS, assetId: USDC_ASSET_ID })).toBe('0')
  })

  test('getAlgoBalance', async () => {
    const balance = await getAlgoBalance({ address: USDC_RESERVE })
    expect(BigInt(balance) > BigInt(0)).toBe(true)
  })

  test('lookupApplication Folks Finance', async () => {
    const app = await lookupApplication({ appId: FOLKS_APP_ID })
    expect(app.id).toBe(FOLKS_APP_ID)
    expect(app.params.creator).toBeDefined()
    const state = await getAppGlobalState({ appId: FOLKS_APP_ID })
    expect(Object.keys(state).length).toBeGreaterThan(0)
  })

  test('application escrow address is a real account', async () => {
    const account = await lookupAccount({ address: APP_1002541853_ADDRESS })
    expect(account?.address).toBe(APP_1002541853_ADDRESS)
    const info = await getAccountInfo({ address: 1002541853 })
    expect(info.address).toBe(APP_1002541853_ADDRESS)
    expect(info.assetMapping['1']).toBeDefined()
    // memoised: the same promise is returned
    expect(getAccountInfo({ address: APP_1002541853_ADDRESS })).toBe(getAccountInfo({ address: 1002541853 }))
  })

  test('getLatestBlock / getBlock / getBlockAtTimestamp', async () => {
    const latest = await getLatestBlock()
    expect(latest.number).toBeGreaterThan(0)
    expect(latest.timestamp).toBeGreaterThan(1_600_000_000)
    const block = await getBlock({ round: latest.number })
    expect(Number(block.round)).toBe(latest.number)
    const target = latest.timestamp - 3600
    const found = await getBlockAtTimestamp({ timestamp: target })
    expect(found.number).toBeLessThan(latest.number)
    expect(found.timestamp).toBeGreaterThanOrEqual(target)
    expect(found.timestamp - target).toBeLessThan(60)
  })
})
