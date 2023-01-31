test("imports", async () => {
  const data = await import('./index')
  const {providers, ...configCopy } = data.api2.config 
  const dataCopy = { ...data, api2: { ...data.api2, config: configCopy } }
  expect(dataCopy).toMatchInlineSnapshot(`
    {
      "ChainApi": [Function],
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
          "getTimestamp": [Function],
          "lookupBlock": [Function],
          "normalizeAddress": [Function],
          "normalizeBalances": [Function],
          "normalizePrefixes": [Function],
          "runInPromisePool": [Function],
          "sliceIntoChunks": [Function],
        },
      },
      "api2": {
        "abi": {
          "call": [Function],
          "fetchList": [Function],
          "multiCall": [Function],
        },
        "config": {
          "ETHER_ADDRESS": "0x0000000000000000000000000000000000000000",
          "TEN": {
            "hex": "0x0a",
            "type": "BigNumber",
          },
          "getProvider": [Function],
          "handleDecimals": [Function],
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
          "getTimestamp": [Function],
          "lookupBlock": [Function],
          "normalizeAddress": [Function],
          "normalizeBalances": [Function],
          "normalizePrefixes": [Function],
          "runInPromisePool": [Function],
          "sliceIntoChunks": [Function],
        },
      },
      "blocks": {
        "chainsForBlocks": [
          "avax",
          "bsc",
          "polygon",
          "xdai",
          "fantom",
          "arbitrum",
        ],
        "getBlock": [Function],
        "getBlocks": [Function],
        "getChainBlocks": [Function],
        "getCurrentBlocks": [Function],
      },
      "humanizeNumber": [Function],
      "log": [Function],
      "util": {
        "blocks": {
          "chainsForBlocks": [
            "avax",
            "bsc",
            "polygon",
            "xdai",
            "fantom",
            "arbitrum",
          ],
          "getBlock": [Function],
          "getBlocks": [Function],
          "getChainBlocks": [Function],
          "getCurrentBlocks": [Function],
        },
        "humanizeNumber": {
          "humanizeNumber": [Function],
        },
        "mergeBalances": [Function],
        "removeTokenBalance": [Function],
        "sumChainTvls": [Function],
        "sumMultiBalanceOf": [Function],
        "sumSingleBalance": [Function],
      },
    }
  `);
});
