import { Balances } from "./Balances";

test("Balances - add gas token", async () => {
  const apiBsc = new Balances({ chain: 'bsc' })
  const apiMoonbeam = new Balances({ chain: 'moonbeam' })

  apiBsc.addGasToken(123)
  apiMoonbeam.addGasToken(123)
  expect(apiBsc.getBalances()).toEqual({ 'bsc:0x0000000000000000000000000000000000000000': 123 })
  expect(apiMoonbeam.getBalances()).toEqual({ 'moonbeam:0x0000000000000000000000000000000000000000': 123 })
})

test("Balances - addBalances", async () => {
  const apiBsc = new Balances({ chain: 'bsc' })
  const apiMoonbeam = new Balances({ chain: 'moonbeam' })

  apiBsc.addGasToken(123)
  apiMoonbeam.addGasToken(123)
  expect(apiBsc.getBalances()).toEqual({ 'bsc:0x0000000000000000000000000000000000000000': 123 })
  expect(apiMoonbeam.getBalances()).toEqual({ 'moonbeam:0x0000000000000000000000000000000000000000': 123 })
  apiBsc.addBalances(apiMoonbeam)
  apiBsc.addBalances(apiBsc)
  apiBsc.addBalances(apiBsc.getBalances())
  expect(apiBsc.getBalances()).toEqual({
    'bsc:0x0000000000000000000000000000000000000000': 123,
    'moonbeam:0x0000000000000000000000000000000000000000': 123
  })
})

test("Balances - add tokens", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.addGasToken(123)
  balances.addGasToken(-100)
  balances.addTokens(['0001', '0002'], [100, 200])
  expect(balances.getBalances()).toEqual({
    'bsc:0x0000000000000000000000000000000000000000': 23,
    'bsc:0001': 100,
    'bsc:0002': 200,
  })
})

test("Balances - removeTokenBalance", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.addGasToken(123)
  balances.removeTokenBalance('0x0000000000000000000000000000000000000000')
  balances.addTokens(['0001', '0002'], [100, 200])
  expect(balances.getBalances()).toEqual({
    'bsc:0001': 100,
    'bsc:0002': 200,
  })
})

test("Balances - add tokens2", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 300, })
})

test("Balances - getUSDValue", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  expect(await balances.getUSDValue()).toEqual(0)

  balances.add('tether', [100, 200], { skipChain: true })
  expect(await balances.getUSDValue()).toEqual(300)
})

test("Balances - addCGToken", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  expect(await balances.getUSDValue()).toEqual(0)

  balances.addCGToken('tether', 100)
  balances.addCGToken('tether', 100)
  balances.addCGToken('tether', 100)
  balances.addCGToken('tether', 100)
  balances.addTokenVannila('tether', 200)
  balances.addTokenVannila('tether', 200)
  balances.addTokenVannila('tether', 200)
  expect(await balances.getUSDValue()).toEqual(1000)
})

test("Balances - balance is missing", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  balances.add('0001', undefined)
  balances.add('0001', 0)
  balances.add('0001', null)
  balances.add('0001', '')
  balances.add('0001', '0')
  expect(await balances.getUSDValue()).toEqual(0)

  balances.add('tether', [100, 200], { skipChain: true })
  expect(await balances.getUSDValue()).toEqual(300)
})

test("Balances - bad input", async () => {
  const balances = new Balances({ chain: 'bsc' })

  expect(() => balances.add('', '123')).toThrowError()
})


test("Balances - static - getUSDValue", async () => {
  expect(await Balances.getUSDValue({ tether: 500 })).toBeCloseTo(500)
  expect(await Balances.getUSDValue({ 'coingecko:usd-coin': 50000 })).toBeCloseTo(50000, -3)
})


test("Balances - static - getUSDString", async () => {
  expect(await Balances.getUSDString({ tether: 500 })).toBe("500")
  expect(await Balances.getUSDString({ 'coingecko:usd-coin': 5 })).toBe("5")
})

test("Balances - static - getBalanceObjects", async () => {
  const res = await Balances.getBalanceObjects({ ethereum: 5 })
  expect(res.usdTvl).toBeGreaterThan(3000)
  expect(res.usdTokenBalances).toBeDefined()
})
