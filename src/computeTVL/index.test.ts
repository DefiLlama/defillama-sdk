import computeTVL from ".";

jest.setTimeout(10000);
test("compute tvl of ethereum and bsc tokens", async () => {
  const knownPrices = {};
  expect(
    await computeTVL(
      {
        'polygon:0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063': '221950450500198705642818823',
        'polygon:0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174': '259407791449755',
        'polygon:0xc2132D05D31c914a87C6611C10748AEb04B58e8F': '30134048351547',
        'polygon:0x1BFD67037B42Cf73acF2047067bd4F2C47D9BfD6': '1054552279378',
        'polygon:0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619': '401805530717793535038800',
        'polygon:0x0d500B1d8E8eF31E21C99d1Db9A6444d3ADf1270': '137295205708631220683506183',
        'polygon:0xD6DF932A45C0f255f85145f286eA0b292B21C90B': '270182513024165444207564'
      },
      1625612400,
      true,
      knownPrices
    )
  ).toBeGreaterThan(1e3);
  return
  expect(
    await computeTVL(
      {
        "0x0000000000000000000000000000000000000000": "100000000000000000000", // 100 ETH
        "pancakeswap-token": "1000.51", // 1000 CAKE
        "bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82":
          "100000000000000000000",
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
        "bsc:0x0e09fabb73bd3ade0a17ecc321fd13a19e81ce82":
          "100000000000000000000",
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
