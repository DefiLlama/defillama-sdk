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

test("Balances - isEmpty", async () => {
  const balances = new Balances({ chain: 'bsc' })
  expect(balances.isEmpty()).toBe(true)
  balances.add('tether', 100, 'stablecoins')
  expect(balances.isEmpty()).toBe(false)
})

// Simulate a Balances instance that came from a different copy of the package
// (different module realm): `instanceof Balances` is false, but it carries
// `_llamaBalancesObject: true` and exposes `getBalances()` / `hasBreakdownBalances()` etc.
// The duck-type check should still recognize it.
function makeForeignBalances(entries: Record<string, number>): any {
  return {
    _llamaBalancesObject: true,
    _balances: { ...entries },
    _breakdownBalances: {},
    _taggedBalances: {},
    _usdBalances: {},
    chain: 'bsc',
    getBalances() { return this._balances },
    hasBreakdownBalances() { return false },
    getBreakdownBalances() { return {} },
    hasTaggedBalances() { return false },
    getTaggedBalances() { return {} },
  }
}

test("Balances - subtract accepts foreign-realm Balances (duck-type)", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 300)
  balances.add('tether', 300, { skipChain: true })

  const foreign = makeForeignBalances({ 'bsc:0001': 100, 'tether': 50 })
  balances.subtract(foreign)

  expect(balances.getBalances()).toEqual({ 'bsc:0001': 200, 'tether': 250 })
})

test("Balances - subtract ignores self-reference via duck-type", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 300)
  // passing the instance to itself should short-circuit (not double-subtract)
  balances.subtract(balances)
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 300 })
})

test("Balances - subtract with plain BalancesV1 still works", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 300)
  balances.subtract({ 'bsc:0001': 100 })
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 200 })
})

test("Balances - plain object lacking the llama flag is treated as BalancesV1", async () => {
  // Guard against false positives in the duck-type check: a plain map of token->balance
  // without the `_llamaBalancesObject` flag must be iterated as a BalancesV1, not unwrapped
  // via .getBalances() like a Balances instance.
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 300)
  const plain: any = { 'bsc:0001': 100 }
  // Attach a non-enumerable getBalances that would return a wildly different value if
  // (incorrectly) invoked by the duck-type branch.
  Object.defineProperty(plain, 'getBalances', {
    value: () => ({ 'bsc:0001': 999999 }),
    enumerable: false,
  })
  balances.subtract(plain)
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 200 })
})

test("Balances - new instance has _llamaBalancesObject flag", () => {
  const balances = new Balances({ chain: 'bsc' })
  expect((balances as any)._llamaBalancesObject).toBe(true)
})

test("Balances - add/addBalances accept foreign-realm Balances (duck-type)", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 100)

  const foreign = makeForeignBalances({ 'bsc:0001': 50, 'tether': 25 })
  // .add() should route to addBalances() via the duck-type branch
  balances.add(foreign)
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 150, 'tether': 25 })

  const balances2 = new Balances({ chain: 'bsc' })
  balances2.addBalances(makeForeignBalances({ 'bsc:0001': 7 }))
  expect(balances2.getBalances()).toEqual({ 'bsc:0001': 7 })
})

test("Balances - add with tag creates taggedBalances", () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 100, { tag: 'pool-A' })
  balances.add('0002', 200, { tag: 'pool-B' })
  balances.add('0001', 50, { tag: 'pool-A' })

  expect(balances.hasTaggedBalances()).toBe(true)
  const tagged = balances.getTaggedBalances()
  expect(tagged['pool-A'].getBalances()).toEqual({ 'bsc:0001': 150 })
  expect(tagged['pool-B'].getBalances()).toEqual({ 'bsc:0002': 200 })
  // main balances also accumulated
  expect(balances.getBalances()).toEqual({ 'bsc:0001': 150, 'bsc:0002': 200 })
})

test("Balances - add with multiple tags shares entry across tags", () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 100, { tags: ['lp', 'stable'] })
  const tagged = balances.getTaggedBalances()
  expect(tagged['lp'].getBalances()).toEqual({ 'bsc:0001': 100 })
  expect(tagged['stable'].getBalances()).toEqual({ 'bsc:0001': 100 })
})

test("Balances - hasTaggedBalances is false for fresh/empty instance", () => {
  const balances = new Balances({ chain: 'bsc' })
  expect(balances.hasTaggedBalances()).toBe(false)
  expect(balances.getTaggedBalances()).toEqual({})
})

test("Balances - tag + label combined", () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 100, { label: 'myTokens', tag: 'pool-A' })
  expect(balances.getBreakdownBalances()['myTokens'].getBalances()).toEqual({ 'bsc:0001': 100 })
  expect(balances.getTaggedBalances()['pool-A'].getBalances()).toEqual({ 'bsc:0001': 100 })
})

test("Balances - addUSDValue via addCGToken(tether) path", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.addUSDValue(250)
  balances.addUSDValue(250)
  // tether is always ~$1 via coingecko
  expect(await balances.getUSDValue()).toEqual(500)
})

test("Balances - addUSDValue with symbol stores in _usdBalances", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.addUSDValue(100, { symbol: 'FOO' })
  balances.addUSDValue(50, { symbol: 'FOO' })
  balances.addUSDValue(25, { symbol: 'BAR' })
  // _usdBalances is used directly (no price lookup needed)
  expect((balances as any)._usdBalances).toEqual({ 'FOO': 150, 'BAR': 25 })
  expect(await balances.getUSDValue()).toEqual(175)
})

test("Balances - isUSDValue routes directly to _usdBalances (skips price cache)", async () => {
  const balances = new Balances({ chain: 'bsc' })
  // An unknown token that has no price would contribute $0 via the regular path,
  // but with isUSDValue it's taken at face value.
  balances.add('made-up-token-xyz', 123, { isUSDValue: true, skipChain: true })
  expect(balances.getBalances()).toEqual({})
  expect((balances as any)._usdBalances).toEqual({ 'made-up-token-xyz': 123 })
  expect(await balances.getUSDValue()).toEqual(123)
})

test("Balances - getUSDJSONs includes _usdBalances in usdTokenBalances and total", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('tether', 100, { skipChain: true })
  balances.addUSDValue(50, { symbol: 'FOO' })
  const { usdTvl, usdTokenBalances } = await balances.getUSDJSONs()
  expect(usdTvl).toEqual(150)
  expect(usdTokenBalances['FOO']).toEqual(50)
})

test("Balances - getUSDJSONs labelBreakdown reflects label totals", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('tether', 100, { skipChain: true, label: 'stablecoins' })
  balances.add('tether', 200, { skipChain: true, label: 'stablecoins' })
  balances.addCGToken('tether', 50, { label: 'other' })
  const { labelBreakdown, usdTvl } = await balances.getUSDJSONs()
  expect(labelBreakdown).toBeDefined()
  expect(labelBreakdown!['stablecoins']).toEqual(300)
  expect(labelBreakdown!['other']).toEqual(50)
  expect(usdTvl).toEqual(350)
})

test("Balances - getUSDJSONs tagBreakdown reflects tag totals", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('tether', 100, { skipChain: true, tag: 'pool-A' })
  balances.add('tether', 200, { skipChain: true, tag: 'pool-B' })
  // same token shared across tags — tag totals can overlap
  balances.add('tether', 50, { skipChain: true, tags: ['pool-A', 'pool-B'] })
  const res: any = await balances.getUSDJSONs()
  expect(res.tagBreakdown).toBeDefined()
  expect(res.tagBreakdown['pool-A']).toEqual(150)
  expect(res.tagBreakdown['pool-B']).toEqual(250)
  expect(res.usdTvl).toEqual(350)
})

test("Balances - clone mirrors both breakdown and tags", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 100, { tag: 'pool-A', label: 'myTokens' })
  balances.add('0002', 200, { tag: 'pool-B', label: 'myTokens' })
  const cloned = balances.clone()
  expect(cloned.getBalances()).toEqual({ 'bsc:0001': 100, 'bsc:0002': 200 })
  expect(cloned.hasBreakdownBalances()).toBe(true)
  expect(cloned.getBreakdownBalances()['myTokens'].getBalances()).toEqual({ 'bsc:0001': 100, 'bsc:0002': 200 })
  expect(cloned.hasTaggedBalances()).toBe(true)
  expect(cloned.getTaggedBalances()['pool-A'].getBalances()).toEqual({ 'bsc:0001': 100 })
  expect(cloned.getTaggedBalances()['pool-B'].getBalances()).toEqual({ 'bsc:0002': 200 })
})

test("Balances - addBalances merges tags across instances", () => {
  const a = new Balances({ chain: 'bsc' })
  a.add('0001', 100, { tag: 'pool-A' })

  const b = new Balances({ chain: 'bsc' })
  b.add('0001', 50, { tag: 'pool-A' })
  b.add('0002', 300, { tag: 'pool-B' })

  a.addBalances(b)
  expect(a.getBalances()).toEqual({ 'bsc:0001': 150, 'bsc:0002': 300 })
  expect(a.getTaggedBalances()['pool-A'].getBalances()).toEqual({ 'bsc:0001': 150 })
  expect(a.getTaggedBalances()['pool-B'].getBalances()).toEqual({ 'bsc:0002': 300 })
})

test("Balances - removeNegativeBalances cleans _balances, breakdown, and tagged", () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.add('0001', 100)
  balances.add('0002', 50, { label: 'myTokens', tag: 'pool-A' })
  balances.add('0003', 200, { label: 'myTokens', tag: 'pool-B' })
  // push two tokens into negative territory across main, breakdown, and tags
  balances.subtract({ 'bsc:0001': 150, 'bsc:0002': 100 })
  balances.getBreakdownBalances()['myTokens'].subtract({ 'bsc:0002': 100 })
  balances.getTaggedBalances()['pool-A'].subtract({ 'bsc:0002': 100 })

  expect(balances.getBalances()).toEqual({ 'bsc:0001': -50, 'bsc:0002': -50, 'bsc:0003': 200 })
  expect(balances.getBreakdownBalances()['myTokens'].getBalances()).toEqual({ 'bsc:0002': -50, 'bsc:0003': 200 })
  expect(balances.getTaggedBalances()['pool-A'].getBalances()).toEqual({ 'bsc:0002': -50 })

  balances.removeNegativeBalances()

  expect(balances.getBalances()).toEqual({ 'bsc:0003': 200 })
  // breakdown should have been cleaned recursively
  expect(balances.getBreakdownBalances()['myTokens'].getBalances()).toEqual({ 'bsc:0003': 200 })
  // tagged should have been cleaned recursively as well
  expect(balances.getTaggedBalances()['pool-A'].getBalances()).toEqual({})
  expect(balances.getTaggedBalances()['pool-B'].getBalances()).toEqual({ 'bsc:0003': 200 })
})

// --- regression tests for _usdBalances propagation across mutating methods ---

test("Balances - addBalances transfers _usdBalances from source", async () => {
  const a = new Balances({ chain: 'bsc' })
  a.addUSDValue(100, { symbol: 'FOO' })
  a.addUSDValue(25, { symbol: 'BAR' })

  const b = new Balances({ chain: 'bsc' })
  b.addBalances(a)

  expect((b as any)._usdBalances).toEqual({ 'FOO': 100, 'BAR': 25 })
  expect(await b.getUSDValue()).toEqual(125)
})

test("Balances - addBalances accumulates _usdBalances across multiple sources", async () => {
  const dest = new Balances({ chain: 'bsc' })
  dest.addUSDValue(10, { symbol: 'FOO' })

  const src1 = new Balances({ chain: 'bsc' })
  src1.addUSDValue(20, { symbol: 'FOO' })
  src1.addUSDValue(30, { symbol: 'BAR' })

  const src2 = new Balances({ chain: 'bsc' })
  src2.addUSDValue(5, { symbol: 'BAR' })

  dest.addBalances(src1)
  dest.addBalances(src2)

  expect((dest as any)._usdBalances).toEqual({ 'FOO': 30, 'BAR': 35 })
  expect(await dest.getUSDValue()).toEqual(65)
})

test("Balances - clone preserves _usdBalances", async () => {
  const a = new Balances({ chain: 'bsc' })
  a.addUSDValue(100, { symbol: 'FOO' })
  a.add('tether', 50, { skipChain: true })

  const c = a.clone()
  expect((c as any)._usdBalances).toEqual({ 'FOO': 100 })
  expect(c.getBalances()).toEqual({ 'tether': 50 })
  expect(await c.getUSDValue()).toEqual(150)
})

test("Balances - clone with ratio scales both _balances and _usdBalances", async () => {
  const a = new Balances({ chain: 'bsc' })
  a.addUSDValue(100, { symbol: 'FOO' })
  a.add('tether', 200, { skipChain: true })

  const c = a.clone(0.5)
  expect((c as any)._usdBalances).toEqual({ 'FOO': 50 })
  expect(c.getBalances()).toEqual({ 'tether': 100 })
  expect(await c.getUSDValue()).toEqual(150)
})

test("Balances - resizeBy scales _usdBalances", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.addUSDValue(100, { symbol: 'FOO' })
  balances.addUSDValue(40, { symbol: 'BAR' })

  balances.resizeBy(0.5)
  expect((balances as any)._usdBalances).toEqual({ 'FOO': 50, 'BAR': 20 })
  expect(await balances.getUSDValue()).toEqual(70)

  balances.resizeBy(2)
  expect((balances as any)._usdBalances).toEqual({ 'FOO': 100, 'BAR': 40 })
})

test("Balances - subtract subtracts _usdBalances from source Balances instance", async () => {
  const a = new Balances({ chain: 'bsc' })
  a.addUSDValue(100, { symbol: 'FOO' })
  a.addUSDValue(50, { symbol: 'BAR' })

  const b = new Balances({ chain: 'bsc' })
  b.addUSDValue(30, { symbol: 'FOO' })
  b.addUSDValue(10, { symbol: 'BAR' })

  a.subtract(b)
  expect((a as any)._usdBalances).toEqual({ 'FOO': 70, 'BAR': 40 })
  expect(await a.getUSDValue()).toEqual(110)
})

test("Balances - subtract handles mixed _balances and _usdBalances source", async () => {
  const a = new Balances({ chain: 'bsc' })
  a.add('tether', 200, { skipChain: true })
  a.addUSDValue(100, { symbol: 'FOO' })

  const b = new Balances({ chain: 'bsc' })
  b.add('tether', 50, { skipChain: true })
  b.addUSDValue(40, { symbol: 'FOO' })

  a.subtract(b)
  expect(a.getBalances()).toEqual({ 'tether': 150 })
  expect((a as any)._usdBalances).toEqual({ 'FOO': 60 })
  expect(await a.getUSDValue()).toEqual(210)
})

test("Balances - removeTokenBalance cleans _usdBalances", () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.addUSDValue(100, { symbol: 'FOO' })
  balances.addUSDValue(50, { symbol: 'BAR' })
  balances.add('tether', 10, { skipChain: true })

  balances.removeTokenBalance('FOO')
  expect((balances as any)._usdBalances).toEqual({ 'BAR': 50 })
  expect(balances.getBalances()).toEqual({ 'tether': 10 })
})

test("Balances - removeNegativeBalances cleans negative entries from _usdBalances", () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.addUSDValue(100, { symbol: 'FOO' })
  balances.addUSDValue(-50, { symbol: 'BAR' })
  balances.addUSDValue(0, { symbol: 'BAZ' })

  balances.removeNegativeBalances()
  expect((balances as any)._usdBalances).toEqual({ 'FOO': 100 })
})

test("Balances - debug", async () => {
  const balances = new Balances({ chain: 'bsc' })
  balances.addCGToken('tether', 1e6)
  balances.addCGToken('ethereum', 0.01)
  const { debugData: { tokenData } }: any = await balances.getUSDJSONs({ debug: true, debugOptions: { printTokenTable: false } })
  expect(tokenData.length).toBe(1)  // it should skip ethereum as it's less than 1% of total (10,000 USDT)
})
