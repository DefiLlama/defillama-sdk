import computeTVL from ".";

jest.setTimeout(10000)
test("compute tvl of ethereum and bsc tokens", async () => {
  const knownPrices = {}
  expect(
    await computeTVL(
      {
        "0x0000000000000000000000000000000000000000": "100000000000000000000", // 100 ETH
        "pancakeswap-token": "1000.51", // 1000 CAKE
        "bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "100000000000000000000",
        "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599": "200000000", // 2 WBTC
      },
      "now",
      false,
      knownPrices
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
        "bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82": "100000000000000000000",
      },
      "now"
    )
  ).toBeGreaterThan(1e3);
  expect(
    await computeTVL(
      {
        "0x0000000000000000000000000000000000000000": "100000000000000000000", // 100 ETH
      },
      "now",
      false,
      knownPrices
    )
  ).toBeGreaterThan(1e3);
});
