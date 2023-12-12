import computeTVL from './computeTVL';

test("computeTVL - tether bal", async () => {
  const { usdTvl } = await computeTVL({
    tether: 1000,
    '0xdac17f958d2ee523a2206206994597c13d831ec7': 1000 * 1e6,
    'ethereum:0xdac17f958d2ee523a2206206994597c13d831EC7': '1000000000',
  })

  expect(usdTvl).toEqual(3000);
})

test("computeTVL - Ethereum balance", async () => {
  expect((await computeTVL({ 'ethereum': 5, })).usdTvl).toBeGreaterThan(3000);
  expect((await computeTVL({ 'solana': 5000, })).usdTvl).toBeGreaterThan(3000);
})


test("computeTVL - usdTokenBalances", async () => {
  const { usdTokenBalances } = await computeTVL({
    tether: 1000,
    'ethereum': 5,
    'solana': '1000000000',
  })

  expect(usdTokenBalances.WETH).toBeGreaterThan(3000);
  expect(usdTokenBalances.SOL).toBeGreaterThan(3000);
  expect(usdTokenBalances.USDT).toBeGreaterThan(999);
  expect(usdTokenBalances.ETH).toBeUndefined();
})

test("computeTVL - past Ethereum balance", async () => {
  const timestamp = Math.floor(Date.now() / 1000 - 60 * 60 * 24 * 7)
  expect((await computeTVL({ 'ethereum': 5, }, timestamp)).usdTvl).toBeGreaterThan(3000);
})

test("computeTVL - past Ethereum balance fixed day", async () => {
  const timestamp = 1701701592
  expect((await computeTVL({ 'ethereum': 5, }, timestamp)).usdTvl).toBeGreaterThan(3000);
})
