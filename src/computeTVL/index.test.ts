import computeTVL from ".";

test("compute tvl of ethereum and bsc tokens", async () => {
  expect(
    await computeTVL(
      {
        "0x0000000000000000000000000000000000000000": "100000000000000000000", // 100 ETH
        "pancakeswap-token": "1000.51", // 1000 CAKE
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "200000000", // 2 WBTC
      },
      "now"
    )
  ).toBeGreaterThan(1e5);
  expect(
    await computeTVL(
      {
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "200000000", // 2 WBTC
      },
      "now"
    )
  ).toBeGreaterThan(1e3);
  expect(
    await computeTVL(
      {
        "pancakeswap-token": "1000.51", // 1000 CAKE
      },
      "now"
    )
  ).toBeGreaterThan(1e3);
  expect(
    await computeTVL(
      {
        "0x0000000000000000000000000000000000000000": "100000000000000000000", // 100 ETH
      },
      "now"
    )
  ).toBeGreaterThan(1e3);
});
