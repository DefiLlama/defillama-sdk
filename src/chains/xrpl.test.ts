import {
  DEFAULT_ENDPOINTS, RIPPLE_EPOCH_OFFSET, getEndpoints,
  decodeCurrency, encodeCurrency, parseToken, formatToken, isRetryableError, rippleTimeToUnix, unixToRippleTime, isValidAddress,
  getObligations, getTokenSupply, getXrpBalance, getLatestLedger, getAccountLines, getTokenBalance, getLedger, getLedgerAtTimestamp, getServerInfo,
} from "./xrpl";

const RLUSD_ISSUER = 'rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5De'
const RLUSD_HEX = '524C555344000000000000000000000000000000'

describe('chains.xrpl pure helpers', () => {
  test('decodeCurrency passes 3-char codes through', () => {
    expect(decodeCurrency('USD')).toBe('USD')
    expect(decodeCurrency('XRP')).toBe('XRP')
  })

  test('decodeCurrency decodes 40-hex non-standard codes', () => {
    expect(decodeCurrency(RLUSD_HEX)).toBe('RLUSD')
    expect(decodeCurrency(RLUSD_HEX.toLowerCase())).toBe('RLUSD')
    expect(decodeCurrency('5853474400000000000000000000000000000000')).toBe('XSGD')
  })

  test('decodeCurrency leaves other strings untouched', () => {
    expect(decodeCurrency('RLUSD')).toBe('RLUSD')
    expect(decodeCurrency('not-hex')).toBe('not-hex')
  })

  test('encodeCurrency is the inverse of decodeCurrency', () => {
    expect(encodeCurrency('USD')).toBe('USD')
    expect(encodeCurrency('RLUSD')).toBe(RLUSD_HEX)
    expect(encodeCurrency(RLUSD_HEX.toLowerCase())).toBe(RLUSD_HEX)
    expect(decodeCurrency(encodeCurrency('DIA-SD-COL1'))).toBe('DIA-SD-COL1')
    expect(encodeCurrency('DIA-SD-COL1')).toHaveLength(40)
    expect(() => encodeCurrency('x'.repeat(21))).toThrow(/too long/)
  })

  test('parseToken accepts "CODE.rISSUER" and objects', () => {
    expect(parseToken(`RLUSD.${RLUSD_ISSUER}`)).toEqual({ currency: 'RLUSD', issuer: RLUSD_ISSUER })
    expect(parseToken(`${RLUSD_HEX}.${RLUSD_ISSUER}`)).toEqual({ currency: RLUSD_HEX, issuer: RLUSD_ISSUER })
    expect(parseToken({ currency: 'USD', issuer: RLUSD_ISSUER })).toEqual({ currency: 'USD', issuer: RLUSD_ISSUER })
    expect(() => parseToken(RLUSD_ISSUER)).toThrow(/invalid token/)
    expect(() => parseToken('.rABC')).toThrow(/invalid token/)
    expect(formatToken({ currency: 'RLUSD', issuer: RLUSD_ISSUER })).toBe(`RLUSD.${RLUSD_ISSUER}`)
  })

  test('ripple epoch conversion', () => {
    expect(RIPPLE_EPOCH_OFFSET).toBe(946684800)
    expect(rippleTimeToUnix(0)).toBe(946684800)
    expect(unixToRippleTime(946684800)).toBe(0)
    expect(unixToRippleTime(rippleTimeToUnix(812345678))).toBe(812345678)
  })

  test('isRetryableError classifies transient vs definitive errors', () => {
    expect(isRetryableError('tooBusy: The server is too busy to help you now.')).toBe(true)
    expect(isRetryableError('slowDown: You are placing too much load on the server.')).toBe(true)
    expect(isRetryableError('Rate limit exceeded')).toBe(true)
    expect(isRetryableError('Request failed with status code 503')).toBe(true)
    expect(isRetryableError('Request failed with status code 429')).toBe(true)
    expect(isRetryableError('timeout of 30000ms exceeded')).toBe(true)
    expect(isRetryableError('connect ECONNREFUSED 1.2.3.4:443')).toBe(true)
    expect(isRetryableError('getaddrinfo EAI_AGAIN xrplcluster.com')).toBe(true)
    expect(isRetryableError('actNotFound: Account not found.')).toBe(false)
    expect(isRetryableError('actMalformed: Account malformed.')).toBe(false)
    expect(isRetryableError('invalidParams: Missing field account.')).toBe(false)
    expect(isRetryableError('lgrNotFound: ledgerNotFound')).toBe(false)
    expect(isRetryableError('')).toBe(false)
  })

  test('isValidAddress checks alphabet, length and checksum', () => {
    expect(isValidAddress(RLUSD_ISSUER)).toBe(true)
    expect(isValidAddress('rK67JczCpaYXVtfw3qJVmqwpSfa1bYTptw')).toBe(true)
    expect(isValidAddress('rrrrrrrrrrrrrrrrrrrrrhoLvTp')).toBe(true) // ACCOUNT_ZERO
    expect(isValidAddress('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5Dz')).toBe(false) // bad checksum
    expect(isValidAddress('rMxCKbEDwqr76QuheSUMdEGf4B9xJ8m5D0')).toBe(false) // '0' not in alphabet
    expect(isValidAddress('0x70e8de73ce538da2beed35d14187f6959a8eca96')).toBe(false)
    expect(isValidAddress('r')).toBe(false)
    expect(isValidAddress('')).toBe(false)
  })
})

describe('chains.xrpl endpoints', () => {
  afterEach(() => {
    delete process.env.XRPL_RPC
  })

  test('defaults are used when XRPL_RPC is unset', () => {
    delete process.env.XRPL_RPC
    expect(getEndpoints()).toEqual(DEFAULT_ENDPOINTS)
    expect(DEFAULT_ENDPOINTS).toContain('https://xrplcluster.com')
  })

  test('XRPL_RPC env endpoints come first, defaults are kept as fallbacks (comma separated)', () => {
    process.env.XRPL_RPC = 'https://my-node.io, https://my-node2.io'
    expect(getEndpoints()).toEqual(['https://my-node.io', 'https://my-node2.io', ...DEFAULT_ENDPOINTS])
  })
})

describe('chains.xrpl live', () => {
  jest.setTimeout(60_000)

  test('getObligations for the RLUSD issuer has a decoded RLUSD key > 0', async () => {
    const obligations = await getObligations({ issuer: RLUSD_ISSUER })
    expect(obligations).toHaveProperty('RLUSD')
    expect(Number(obligations.RLUSD)).toBeGreaterThan(0)
    expect(obligations[RLUSD_HEX]).toBeUndefined()
  })

  test('getTokenSupply RLUSD > 0 for both object and "CODE.rISSUER" forms', async () => {
    const supply = await getTokenSupply({ currency: 'RLUSD', issuer: RLUSD_ISSUER })
    expect(typeof supply).toBe('string')
    expect(Number(supply)).toBeGreaterThan(0)
    const supplyHex = await getTokenSupply(`${RLUSD_HEX}.${RLUSD_ISSUER}`)
    expect(Number(supplyHex)).toBeGreaterThan(0)
    const missing = await getTokenSupply({ currency: 'ZZZ', issuer: RLUSD_ISSUER })
    expect(missing).toBe('0')
  })

  test('getXrpBalance returns a numeric drops string', async () => {
    const balance = await getXrpBalance({ account: RLUSD_ISSUER })
    expect(typeof balance).toBe('string')
    expect(balance).toMatch(/^\d+$/)
    expect(Number(balance)).toBeGreaterThan(0)
  })

  test('getLatestLedger returns a recent ledger', async () => {
    const ledger = await getLatestLedger()
    expect(ledger.number).toBeGreaterThan(0)
    expect(typeof ledger.hash).toBe('string')
    const now = Math.floor(Date.now() / 1000)
    expect(ledger.timestamp).toBeGreaterThan(now - 3600)
    expect(ledger.timestamp).toBeLessThanOrEqual(now + 60)
    const same = await getLedger({ ledgerIndex: ledger.number })
    expect(same.number).toBe(ledger.number)
    expect(same.hash).toBe(ledger.hash)
  })

  test('getLedgerAtTimestamp finds the last ledger at or before a timestamp', async () => {
    const latest = await getLatestLedger()
    const target = latest.timestamp - 600
    const ledger = await getLedgerAtTimestamp({ timestamp: target })
    expect(ledger.timestamp).toBeLessThanOrEqual(target)
    expect(ledger.number).toBeLessThan(latest.number)
    const next = await getLedger({ ledgerIndex: ledger.number + 1 })
    expect(next.timestamp).toBeGreaterThan(target)
  })

  test('getAccountLines for the issuer returns an array (first page only)', async () => {
    const lines = await getAccountLines({ account: RLUSD_ISSUER, limit: 400, maxPages: 1 })
    expect(lines.length).toBe(400)
    expect(Array.isArray(lines)).toBe(true)
    if (lines.length) {
      expect(typeof lines[0].account).toBe('string')
      expect(typeof lines[0].balance).toBe('string')
    }
  })

  test('getTokenBalance reads a trust line against the issuer', async () => {
    const lines = await getAccountLines({ account: RLUSD_ISSUER, limit: 400, maxPages: 1 })
    const holder = lines.find(l => decodeCurrency(l.currency) === 'RLUSD' && Number(l.balance) !== 0)
    if (!holder) return
    const balance = await getTokenBalance({ account: holder.account, currency: 'RLUSD', issuer: RLUSD_ISSUER })
    expect(typeof balance).toBe('string')
    expect(Number(balance)).not.toBeNaN()
  })

  test('getServerInfo returns validated ledger info', async () => {
    const info = await getServerInfo()
    expect(info.info).toBeDefined()
    expect(info.info.validated_ledger.seq).toBeGreaterThan(0)
  })
})
