import * as svm from "./svm";

const USDC = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v'
const USDT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB'
// large USDC holder whose token account is its canonical ATA (verified via getTokenLargestAccounts)
const KNOWN_OWNER = '8Vkgsarud8mSc1gkzayGA7XhNQfq4wDJRxTWDgq8RaJD'
const KNOWN_OWNER_USDC_ATA = 'Cp8wjBC7MVWeMeawTdyPzPdH7ThpBq1vRdBKtVRVTW2B'

function pubkeyBytes(fill: number): Buffer {
  return Buffer.alloc(32, fill)
}

function u64le(value: bigint | number): Buffer {
  const b = Buffer.alloc(8)
  b.writeBigUInt64LE(BigInt(value))
  return b
}

function u32le(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value)
  return b
}

describe('chains.svm config', () => {
  afterEach(() => {
    delete process.env.SOLANA_RPC
    delete process.env.SDK_SOLANA_RPC
    delete process.env.SOLANA_RPC_CLIENT
    delete process.env.ECLIPSE_RPC
  })

  test('isSvmChain', () => {
    for (const chain of ['solana', 'eclipse', 'soon', 'soon_base', 'soon_bsc', 'fogo', 'cookiechain', 'renec']) expect(svm.isSvmChain(chain)).toBe(true)
    expect(svm.isSvmChain('ethereum')).toBe(false)
    expect(svm.svmChains).toEqual(Object.keys(svm.DEFAULT_ENDPOINTS))
  })

  test('defaults are used when no env is set', () => {
    expect(svm.getEndpoint()).toBe(svm.DEFAULT_ENDPOINTS.solana)
    expect(svm.getEndpoints({ chain: 'eclipse' })).toEqual([svm.DEFAULT_ENDPOINTS.eclipse])
  })

  test('<CHAIN>_RPC env overrides defaults (comma separated list)', () => {
    process.env.SOLANA_RPC = 'https://a.io, https://b.io'
    expect(svm.getEndpoints({})).toEqual(['https://a.io', 'https://b.io'])
    process.env.ECLIPSE_RPC = 'https://eclipse.env'
    expect(svm.getEndpoint({ chain: 'eclipse' })).toBe('https://eclipse.env')
  })

  test('SDK_ prefixed env override wins too', () => {
    process.env.SDK_SOLANA_RPC = 'https://sdk.io'
    expect(svm.getEndpoint({ chain: 'solana' })).toBe('https://sdk.io')
  })

  test('SOLANA_RPC_CLIENT is honoured only with isClient', () => {
    process.env.SOLANA_RPC = 'https://server.io'
    process.env.SOLANA_RPC_CLIENT = 'https://client.io'
    expect(svm.getEndpoint({ chain: 'solana' })).toBe('https://server.io')
    expect(svm.getEndpoint({ chain: 'solana', isClient: true })).toBe('https://client.io')
    expect(svm.getEndpoint({ chain: 'eclipse', isClient: true })).toBe(svm.DEFAULT_ENDPOINTS.eclipse)
  })

  test('unknown chain without env throws', () => {
    expect(() => svm.getEndpoints({ chain: 'notachain' })).toThrow(/No RPC endpoint configured/)
  })
})

describe('chains.svm base58', () => {
  test('known vectors', () => {
    expect(svm.base58Encode(new Uint8Array(32))).toBe('1'.repeat(32))
    expect(svm.base58Encode(new Uint8Array(32))).toBe(svm.SYSTEM_PROGRAM_ID)
    expect(Array.from(svm.base58Decode(svm.SYSTEM_PROGRAM_ID))).toEqual(new Array(32).fill(0))
    expect(svm.base58Encode(Buffer.from('hello world'))).toBe('StV1DL6CwTryKyV')
    expect(Buffer.from(svm.base58Decode('StV1DL6CwTryKyV')).toString()).toBe('hello world')
    expect(svm.base58Encode(Buffer.from([0, 0, 1]))).toBe('112')
    expect(Array.from(svm.base58Decode('112'))).toEqual([0, 0, 1])
    expect(svm.base58Encode(new Uint8Array(0))).toBe('')
    expect(svm.base58Decode('').length).toBe(0)
  })

  test('round trips incl. leading zero bytes', () => {
    const cases = [
      Buffer.from([0]),
      Buffer.from([0, 0, 0, 255]),
      Buffer.from([255, 255, 255]),
      Buffer.concat([Buffer.alloc(5), Buffer.from('deadbeef', 'hex')]),
      Buffer.from('00000000ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex'),
    ]
    for (const c of cases) {
      const enc = svm.base58Encode(c)
      expect(Buffer.from(svm.base58Decode(enc))).toEqual(c)
    }
    for (let i = 0; i < 50; i++) {
      const buf = Buffer.alloc(32)
      for (let j = 0; j < 32; j++) buf[j] = j < i % 7 ? 0 : Math.floor(Math.random() * 256)
      expect(Buffer.from(svm.base58Decode(svm.base58Encode(buf)))).toEqual(buf)
    }
  })

  test('program ids decode to 32 bytes', () => {
    for (const id of [svm.TOKEN_PROGRAM_ID, svm.TOKEN_2022_PROGRAM_ID, svm.ASSOCIATED_TOKEN_PROGRAM_ID, svm.STAKE_PROGRAM_ID, svm.SYSVAR_RENT_ID, USDC, USDT]) {
      expect(svm.base58Decode(id).length).toBe(32)
      expect(svm.base58Encode(svm.base58Decode(id))).toBe(id)
      expect(svm.isValidPublicKey(id)).toBe(true)
    }
  })

  test('isValidPublicKey rejects junk', () => {
    expect(svm.isValidPublicKey('0x1234')).toBe(false)
    expect(svm.isValidPublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1vEPjF')).toBe(false)
    expect(svm.isValidPublicKey('abc')).toBe(false)
    expect(svm.isValidPublicKey('')).toBe(false)
    expect(svm.isValidPublicKey(undefined)).toBe(false)
    expect(() => svm.base58Decode('0OIl')).toThrow(/invalid character/)
  })
})

describe('chains.svm codecs', () => {
  test('readBigUInt64LE', () => {
    const buf = Buffer.concat([Buffer.from([1, 2]), u64le(BigInt('18446744073709551615')), u64le(1)])
    expect(svm.readBigUInt64LE(buf, 2)).toBe(BigInt('18446744073709551615'))
    expect(svm.readBigUInt64LE(new Uint8Array(buf), 10)).toBe(BigInt(1))
    expect(() => svm.readBigUInt64LE(buf, 12)).toThrow(/out of range/)
  })

  test('decodeMintAccount', () => {
    const authority = pubkeyBytes(7)
    const buf = Buffer.concat([
      u32le(1), authority,                    // mintAuthorityOption + mintAuthority
      u64le(BigInt('123456789012345678')),    // supply
      Buffer.from([6]),                       // decimals
      Buffer.from([1]),                       // isInitialized
      u32le(0), pubkeyBytes(0),               // freezeAuthorityOption + freezeAuthority
    ])
    expect(buf.length).toBe(svm.MINT_ACCOUNT_SIZE)
    const mint = svm.decodeMintAccount(buf)
    expect(mint).toEqual({
      mintAuthority: svm.base58Encode(authority),
      supply: '123456789012345678',
      decimals: 6,
      isInitialized: true,
      freezeAuthority: null,
    })
    // extra token-2022 extension bytes are ignored
    expect(svm.decodeMintAccount(Buffer.concat([buf, Buffer.alloc(100)])).supply).toBe('123456789012345678')
    expect(() => svm.decodeMintAccount(buf.subarray(0, 80))).toThrow(/need 82 bytes/)
  })

  test('decodeTokenAccount', () => {
    const mint = pubkeyBytes(1)
    const owner = pubkeyBytes(2)
    const delegate = pubkeyBytes(3)
    const buf = Buffer.concat([
      mint, owner,
      u64le(BigInt('9007199254740993')),      // amount (> 2^53)
      u32le(1), delegate,                     // delegateOption + delegate
      Buffer.from([1]),                       // state
      u32le(0), u64le(0),                     // isNativeOption + isNative
      u64le(42),                              // delegatedAmount
      u32le(0), pubkeyBytes(0),               // closeAuthorityOption + closeAuthority
    ])
    expect(buf.length).toBe(svm.TOKEN_ACCOUNT_SIZE)
    expect(svm.decodeTokenAccount(buf)).toEqual({
      mint: svm.base58Encode(mint),
      owner: svm.base58Encode(owner),
      amount: '9007199254740993',
      delegate: svm.base58Encode(delegate),
      state: 1,
      isNative: null,
      delegatedAmount: '42',
      closeAuthority: null,
    })
    expect(() => svm.decodeTokenAccount(buf.subarray(0, 100))).toThrow(/need 165 bytes/)
  })

  test('readScaledUiMultiplier', () => {
    const ext = Buffer.alloc(56)
    ext.writeDoubleLE(1.5, 32)                 // multiplier
    ext.writeBigInt64LE(BigInt(2_000_000_000), 40) // newMultiplierEffectiveTimestamp (far future)
    ext.writeDoubleLE(2.5, 48)                 // newMultiplier
    const tlvHeader = Buffer.concat([Buffer.from([25, 0]), Buffer.from([56, 0])]) // type 25, length 56
    // 82 byte mint padded to 165, account type byte at 165, TLV from 166
    const unrelated = Buffer.concat([Buffer.from([3, 0, 4, 0]), Buffer.alloc(4)]) // some other extension first
    const data = Buffer.concat([Buffer.alloc(165), Buffer.from([1]), unrelated, tlvHeader, ext])
    expect(svm.readScaledUiMultiplier(data, 1_700_000_000)).toBe(1.5)
    expect(svm.readScaledUiMultiplier(data, 2_000_000_000)).toBe(2.5)
    expect(svm.readScaledUiMultiplier(Buffer.alloc(82), 1_700_000_000)).toBe(1)
    expect(svm.readScaledUiMultiplier(Buffer.concat([Buffer.alloc(166), unrelated]), 1_700_000_000)).toBe(1)
    // zero / NaN multipliers never wipe a supply
    ext.writeDoubleLE(0, 32)
    expect(svm.readScaledUiMultiplier(Buffer.concat([Buffer.alloc(166), tlvHeader, ext]), 1_700_000_000)).toBe(1)
  })

  test('i80f48ToNumber', () => {
    const one = BigInt(2) ** BigInt(48)
    expect(svm.i80f48ToNumber(one)).toBe(1)
    expect(svm.i80f48ToNumber({ val: one * BigInt(3) + one / BigInt(2) })).toBe(3.5)
    expect(svm.i80f48ToNumber((one * BigInt(3) + one / BigInt(4)).toString())).toBe(3.25)
    expect(svm.i80f48ToNumber(-(one * BigInt(3) + one / BigInt(2)))).toBe(-3.5)
    // 16 byte little endian i128 of 1.5
    const bytes = Buffer.alloc(16)
    bytes.writeBigUInt64LE(one + one / BigInt(2), 0)
    expect(svm.i80f48ToNumber({ val: Array.from(bytes) })).toBe(1.5)
    expect(svm.readI80F48(Buffer.concat([Buffer.alloc(4), bytes]), 4)).toBe(1.5)
    // negative i128 from bytes: -1.0 == 2^128 - 2^48
    const neg = Buffer.alloc(16, 0xff)
    neg.writeUIntLE(0, 0, 6)
    expect(svm.i80f48ToNumber({ val: neg })).toBe(-1)
  })

  test('decodeStakePool', () => {
    const buf = Buffer.alloc(300)
    buf.writeBigUInt64LE(BigInt('5000000000000'), 258)
    buf.writeBigUInt64LE(BigInt('4000000000000'), 266)
    expect(svm.decodeStakePool(buf)).toEqual({ totalLamports: '5000000000000', poolTokenSupply: '4000000000000' })
  })

  test('extractPubkey', () => {
    const data = Buffer.concat([Buffer.alloc(8), svm.base58Decode(USDC), Buffer.alloc(3)])
    expect(svm.extractPubkey(data.toString('base64'), 8)).toBe(USDC)
    expect(() => svm.extractPubkey(data.toString('base64'), 20)).toThrow(/out of range/)
  })
})

describe('chains.svm PDA derivation', () => {
  test('real keypair addresses are on the curve, PDAs are not', () => {
    expect(svm.isOnCurve(USDC)).toBe(true)
    expect(svm.isOnCurve(svm.TOKEN_PROGRAM_ID)).toBe(true)
    expect(svm.isOnCurve(KNOWN_OWNER)).toBe(true)
    expect(svm.isOnCurve(KNOWN_OWNER_USDC_ATA)).toBe(false)
  })

  test('getAssociatedTokenAddress matches the on-chain ATA', () => {
    expect(svm.getAssociatedTokenAddress({ mint: USDC, owner: KNOWN_OWNER })).toBe(KNOWN_OWNER_USDC_ATA)
    // token-2022 ATAs differ from classic ones
    expect(svm.getAssociatedTokenAddress({ mint: USDC, owner: KNOWN_OWNER, programId: svm.TOKEN_2022_PROGRAM_ID })).not.toBe(KNOWN_OWNER_USDC_ATA)
  })

  test('usesWeb3js reflects whether @solana/web3.js is installed', () => {
    let installed = false
    try { require('@solana/web3.js'); installed = true } catch { }
    expect(svm.usesWeb3js()).toBe(installed)
  })

  test('findProgramAddress / createProgramAddress round trip', () => {
    const [address, bump] = svm.findProgramAddress(['ORACLE', svm.base58Decode(USDC)], svm.TOKEN_PROGRAM_ID)
    expect(svm.isValidPublicKey(address)).toBe(true)
    expect(bump).toBeGreaterThanOrEqual(0)
    expect(bump).toBeLessThanOrEqual(255)
    expect(svm.createProgramAddress(['ORACLE', svm.base58Decode(USDC)], svm.TOKEN_PROGRAM_ID, bump)).toBe(address)
    expect(svm.isOnCurve(address)).toBe(false)
    // deterministic
    expect(svm.findProgramAddress(['ORACLE', svm.base58Decode(USDC)], svm.TOKEN_PROGRAM_ID)).toEqual([address, bump])
  })

  test('seed validation', () => {
    expect(() => svm.createProgramAddress([Buffer.alloc(33)], svm.TOKEN_PROGRAM_ID)).toThrow(/Max seed length/)
    expect(() => svm.createProgramAddress(new Array(17).fill('a'), svm.TOKEN_PROGRAM_ID)).toThrow(/Max seeds/)
    expect(() => svm.createProgramAddress(['a'], 'notakey')).toThrow(/Invalid program id/)
  })
})

describe('chains.svm live (solana mainnet)', () => {
  test('getSlot > 0 and getLatestBlock', async () => {
    const slot = await svm.getSlot()
    expect(slot).toBeGreaterThan(0)
    const block = await svm.getLatestBlock()
    expect(block.number).toBeGreaterThan(0)
    expect(block.timestamp).toBeGreaterThan(1_700_000_000)
  })

  test('getTokenSupply USDC', async () => {
    const res = await svm.getTokenSupply({ token: USDC })
    expect(res.decimals).toBe(6)
    expect(BigInt(res.amount) > BigInt(0)).toBe(true)
    expect(res.uiAmount).toBeGreaterThan(0)
  })

  test('getTokenSupplies keeps order and matches getTokenSupply', async () => {
    const res = await svm.getTokenSupplies({ tokens: [USDC, USDT] })
    expect(res.map(i => i.decimals)).toEqual([6, 6])
    const direct = await svm.getTokenSupply({ token: USDC })
    // supply changes between calls; compare magnitude
    expect(Math.abs(res[0].uiAmount - direct.uiAmount) / direct.uiAmount).toBeLessThan(0.01)
  })

  test('getAccounts preserves order with nulls for unknown accounts', async () => {
    const random = svm.base58Encode(require('crypto').randomBytes(32))
    const res = await svm.getAccounts({ accounts: [USDC, random, USDT] })
    expect(res.length).toBe(3)
    expect(res[0]?.owner).toBe(svm.TOKEN_PROGRAM_ID)
    expect(res[1]).toBeNull()
    expect(res[2]?.owner).toBe(svm.TOKEN_PROGRAM_ID)
    const buffers = await svm.getAccountBuffers({ accounts: [random, USDC] })
    expect(buffers[0]).toBeNull()
    expect(svm.decodeMintAccount(buffers[1]!).decimals).toBe(6)
  })

  test('getTokenAccountsByOwner is consistent with getAssociatedTokenAddress', async () => {
    const accounts = await svm.getTokenAccountsByOwner({ owner: KNOWN_OWNER, mint: USDC })
    expect(accounts.length).toBeGreaterThan(0)
    const ata = svm.getAssociatedTokenAddress({ mint: USDC, owner: KNOWN_OWNER })
    const match = accounts.find(i => i.pubkey === ata)
    expect(match).toBeDefined()
    expect(match!.mint).toBe(USDC)
    expect(match!.owner).toBe(KNOWN_OWNER)
    expect(match!.decimals).toBe(6)
    const balance = await svm.getTokenBalance({ owner: KNOWN_OWNER, mint: USDC })
    expect(BigInt(balance) >= BigInt(match!.amount)).toBe(true)
  })

  test('getTokenAccountBalances aggregated and individual', async () => {
    const agg = await svm.getTokenAccountBalances({ tokenAccounts: [KNOWN_OWNER_USDC_ATA] })
    expect(Object.keys(agg)).toEqual([USDC])
    const ind = await svm.getTokenAccountBalances({ tokenAccounts: [KNOWN_OWNER_USDC_ATA, svm.SYSTEM_PROGRAM_ID], individual: true, allowError: true })
    expect(ind.length).toBe(2)
    expect(ind[0].mint).toBe(USDC)
    expect(ind[0].owner).toBe(KNOWN_OWNER)
    expect(ind[0].amount).toBe(agg[USDC])
    expect(ind[1].mint).toBe('error')
    await expect(svm.getTokenAccountBalances({ tokenAccounts: [svm.SYSTEM_PROGRAM_ID] })).rejects.toThrow(/invalid token account/)
  })

  test('getStakedSol returns a number', async () => {
    const staked = await svm.getStakedSol({ address: KNOWN_OWNER })
    expect(typeof staked).toBe('number')
    expect(staked).toBeGreaterThanOrEqual(0)
  })
})
