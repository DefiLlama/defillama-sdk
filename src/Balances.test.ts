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

test("Balances - resizeBy", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  balances.resizeBy(2)
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 600, })
})

test("Balances - resizeBy", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  balances.add('tether', [100, 200], { skipChain: true })
  balances.resizeBy(0.5)
  expect(await balances.getUSDValue()).toEqual(150)
})


test("Balances - clone - resizeBy", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  balances.add('tether', [100, 200], { skipChain: true })
  const balances2 = balances.clone().resizeBy(0.5)
  expect(await balances2.getUSDValue()).toEqual(150)
})

test("Balances - clone", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  balances.add('tether', [100, 200], { skipChain: true })
  expect(balances.clone().getBalances()).toEqual({ 'bsc:0001': 300, 'tether': 300 })
  expect(balances.clone(0.5).getBalances()).toEqual({ 'bsc:0001': 150, 'tether': 150 })
})

test("Balances - subtract", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  balances.add('tether', [100, 200], { skipChain: true })
  balances.subtract({ 'bsc:0001': 100, 'tether': 100 })
  const temp = new Balances({ chain: 'bsc' })
  temp.add('0001', 100)
  temp.add('tether', 100, { skipChain: true })
  balances.subtract(temp)
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 100, 'tether': 100 })
  const temp2 = new Balances({ chain: 'bsc' })
  temp2.add('0001', 1000)
  temp2.add('tether', 1000, { skipChain: true })
  balances.subtract(temp2)
  expect(balances.getBalances()).toEqual({ 'bsc:0001': -900, 'tether': -900 })
  balances.add('0002', 1000)
  balances.removeNegativeBalances()
  expect(balances.getBalances()).toEqual({ 'bsc:0002': 1000 })
})

test("Balances - subtractTokens", async () => {
  const balances = new Balances({ chain: 'bsc' })

  balances.add('0001', [100, 200])
  balances.add('tether', [100, 200], { skipChain: true })
  balances.subtractToken('0001', 100)
  balances.subtractToken('0001', 100)
  balances.subtractToken('tether', 100, { skipChain: true })
  balances.subtractToken('tether', 100, { skipChain: true })
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 100, 'tether': 100 })
})

test("Balances - add with label", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('tether', 100, { skipChain: true, label: 'stablecoins' })
  balances.add('0001', 200, 'myTokens')
  expect(balances.getBalances()).toEqual({ 'tether': 100, 'bsc:0001': 200 })
  const breakdown = balances.getBreakdownBalances()
  expect(breakdown['stablecoins'].getBalances()).toEqual({ 'tether': 100 })
  expect(breakdown['myTokens'].getBalances()).toEqual({ 'bsc:0001': 200 })
})

test("Balances - add multiple tokens with label", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.addTokens(['tether', 'usd-coin'], [100, 200], 'stablecoins', { skipChain: true, })
  expect(balances.getBalances()).toEqual({ 'tether': 100, 'usd-coin': 200 })
  const breakdown = balances.getBreakdownBalances()
  expect(breakdown['stablecoins'].getBalances()).toEqual({ 'tether': 100, 'usd-coin': 200 })
})

test("Balances - addBalances with label and breakdown", async () => {
  const balances1 = new Balances({ chain: 'bsc' })
  balances1.add('tether', 100, { skipChain: true, label: 'stablecoins' })
  balances1.add('0001', 200, 'myTokens')

  const balances2 = new Balances({ chain: 'bsc' })
  balances2.add('tether', 50, 'stablecoins', { skipChain: true, })
  balances2.add('0002', 300, 'myTokens')

  balances1.addBalances(balances2)
  expect(balances1.getBalances()).toEqual({ 'tether': 150, 'bsc:0001': 200, 'bsc:0002': 300 })
  const breakdown = balances1.getBreakdownBalances()
  expect(breakdown['stablecoins'].getBalances()).toEqual({ 'tether': 150 })
  expect(breakdown['myTokens'].getBalances()).toEqual({ 'bsc:0001': 200, 'bsc:0002': 300 })
})

test("Balances - removeTokenBalance affects breakdown", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('tether', 100, { skipChain: true, label: 'stablecoins' })
  balances.add('0001', 200, { label: 'myTokens' })
  balances.removeTokenBalance('tether')
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 200 })
  const breakdown = balances.getBreakdownBalances()
  expect(breakdown['stablecoins'].getBalances()).toEqual({})
  expect(breakdown['myTokens'].getBalances()).toEqual({ 'bsc:0001': 200 })
})

test("Balances - resizeBy affects breakdown", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('tether', 100, { skipChain: true, label: 'stablecoins' })
  balances.add('0001', 200, { label: 'myTokens' })
  balances.resizeBy(2)
  expect(balances.getBalances()).toEqual({ 'tether': 200, 'bsc:0001': 400 })
  const breakdown = balances.getBreakdownBalances()
  expect(breakdown['stablecoins'].getBalances()).toEqual({ 'tether': 200 })
  expect(breakdown['myTokens'].getBalances()).toEqual({ 'bsc:0001': 400 })
})

test("Balances - removeNegativeBalances affects breakdown", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('tether', -100, { skipChain: true, label: 'stablecoins' })
  balances.add('0001', 200, { label: 'myTokens' })
  balances.removeNegativeBalances()
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 200 })
  const breakdown = balances.getBreakdownBalances()
  expect(breakdown['stablecoins'].getBalances()).toEqual({})
  expect(breakdown['myTokens'].getBalances()).toEqual({ 'bsc:0001': 200 })
})

test("Balances - hasBreakdownBalances and getBreakdownBalances", async () => {
  const balances = new Balances({ chain: 'bsc' })
  expect(balances.hasBreakdownBalances()).toBe(false)
  balances.add('tether', 100, 'stablecoins')
  expect(balances.hasBreakdownBalances()).toBe(true)
  const breakdown = balances.getBreakdownBalances()
  expect(Object.keys(breakdown)).toContain('stablecoins')
})
