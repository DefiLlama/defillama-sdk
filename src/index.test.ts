import { getTimestamp } from "./util";

test("imports", async () => {
  const data = await import('./index')
  const {providers, ...configCopy } = data.api2.config 
  const dataCopy = { ...data, api2: { ...data.api2, config: configCopy } }
  expect(dataCopy).toMatchInlineSnapshot(`
    {
      "Balances": [Function],
      "ChainApi": [Function],
      "api": {
        "abi": {
          "bytecodeCall": [Function],
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
          "convertToBigInt": [Function],
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
          "bytecodeCall": [Function],
          "call": [Function],
          "fetchList": [Function],
          "multiCall": [Function],
        },
        "config": {
          "ETHER_ADDRESS": "0x0000000000000000000000000000000000000000",
          "TEN": 10n,
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
          "convertToBigInt": [Function],
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
          "arbitrum",
        ],
        "getBlock": [Function],
        "getBlockNumber": [Function],
        "getBlocks": [Function],
        "getChainBlocks": [Function],
        "getCurrentBlocks": [Function],
      },
      "cache": {
        "compressCache": [Function],
        "currentVersion": "zlib-1.0",
        "deleteCache": [Function],
        "getTempLocalCache": [Function],
        "parseCache": [Function],
        "readCache": [Function],
        "readExpiringJsonCache": [Function],
        "writeCache": [Function],
        "writeExpiringJsonCache": [Function],
      },
      "elastic": {
        "addDebugLog": [Function],
        "addErrorLog": [Function],
        "addRuntimeLog": [Function],
        "getClient": [Function],
        "writeLog": [Function],
      },
      "getEventLogs": [Function],
      "getProvider": [Function],
      "humanizeNumber": [Function],
      "log": [Function],
      "logTable": [Function],
      "sdkCache": {
        "getCache": [Function],
        "retriveCache": [Function],
        "saveCache": [Function],
        "setCache": [Function],
        "startCache": [Function],
      },
      "setProvider": [Function],
      "util": {
        "blocks": {
          "chainsForBlocks": [
            "avax",
            "bsc",
            "polygon",
            "arbitrum",
          ],
          "getBlock": [Function],
          "getBlockNumber": [Function],
          "getBlocks": [Function],
          "getChainBlocks": [Function],
          "getCurrentBlocks": [Function],
        },
        "convertToBigInt": [Function],
        "formError": [Function],
        "formErrorString": [Function],
        "getProviderUrl": [Function],
        "getUniqueAddresses": [Function],
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
test("getTimestamp", async () => {
  type Block = {
    block: number;
    chain: any;
  };
  const blocks: Block[] = [
    { block: 16527520, chain: "ethereum" },
    { block: 20265031, chain: "bsc" },
    { block: 38247545, chain: "polygon" },
    { block: 22, chain: "arbitrum" },
  ];
  const timestamps: number[] = await Promise.all(
    blocks.map((b: Block) => getTimestamp(b.block, b.chain)),
  );
  expect(timestamps).toEqual([1675176719, 1659972621, 1674081829, 1622251195]);
});
