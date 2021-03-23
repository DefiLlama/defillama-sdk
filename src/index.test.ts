test("imports", async () => {
  expect(await import("./index")).toMatchInlineSnapshot(`
    Object {
      "api": Object {
        "abi": Object {
          "call": [Function],
          "multiCall": [Function],
        },
        "cdp": Object {
          "aave": Object {
            "getAssetsLocked": [Function],
          },
          "compound": Object {
            "getAssetsLocked": [Function],
          },
          "getAssetsLocked": [Function],
          "maker": Object {
            "getAssetsLocked": [Function],
          },
        },
        "erc20": Object {
          "balanceOf": [Function],
          "decimals": [Function],
          "info": [Function],
          "symbol": [Function],
          "totalSupply": [Function],
        },
        "eth": Object {
          "getBalance": [Function],
          "getBalances": [Function],
        },
        "setProvider": [Function],
        "util": Object {
          "getLogs": [Function],
          "kyberTokens": [Function],
          "lookupBlock": [Function],
          "toSymbols": [Function],
          "tokenList": [Function],
        },
      },
      "util": Object {
        "computeTVL": [Function],
        "sumMultiBalanceOf": [Function],
        "sumSingleBalance": [Function],
      },
    }
  `);
});
