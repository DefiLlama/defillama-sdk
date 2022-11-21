test("imports", async () => {
  expect(await import("./index")).toMatchInlineSnapshot(`
    {
      "api": {
        "abi": {
          "call": [Function],
          "multiCall": [Function],
        },
        "config": {
          "getProvider": [Function],
          "setProvider": [Function],
        },
        "erc20": {
          "balanceOf": [Function],
          "decimals": [Function],
          "info": [Function],
          "symbol": [Function],
          "totalSupply": [Function],
        },
        "eth": {
          "getBalance": [Function],
          "getBalances": [Function],
        },
        "util": {
          "getLatestBlock": [Function],
          "getLogs": [Function],
          "lookupBlock": [Function],
          "normalizeAddress": [Function],
          "normalizeBalances": [Function],
          "normalizePrefixes": [Function],
        },
      },
      "util": {
        "computeTVL": [Function],
        "mergeBalances": [Function],
        "sumChainTvls": [Function],
        "sumMultiBalanceOf": [Function],
        "sumSingleBalance": [Function],
      },
    }
  `);
});
