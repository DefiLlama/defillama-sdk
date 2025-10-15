import { getTimestamp } from "./util";
import { types } from "./index";
type Address = types.Address;
type Chain = types.Chain;

test("imports", async () => {
  const data = await import('./index')
  const {providers, ...configCopy } = data.api2.config 
  const dataCopy = { ...data, api2: { ...data.api2, config: configCopy } }
  let _testChainTypeImport: Chain
  let _testAddressTypeImport: Address = '0x'

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
          "tableToString": [Function],
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
          "tableToString": [Function],
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
        "getLatestBlock": [Function],
        "lookupBlock": [Function],
      },
      "cache": {
        "ONE_WEEK": 604800000,
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
        "getAllLogs": [Function],
        "getClient": [Function],
        "search": [Function],
        "writeLog": [Function],
      },
      "erc20": {
        "balanceOf": [Function],
        "decimals": [Function],
        "info": [Function],
        "symbol": [Function],
        "totalSupply": [Function],
      },
      "getEventLogs": [Function],
      "getProvider": [Function],
      "graph": {
        "modifyEndpoint": [Function],
        "request": [Function],
      },
      "humanizeNumber": [Function],
      "indexer": {
        "getLogs": [Function],
        "getTokenTransfers": [Function],
        "getTokens": [Function],
        "getTransactions": [Function],
        "isIndexer2Enabled": [Function],
        "isIndexerEnabled": [Function],
        "supportedChainSet": Set {
          "ethereum",
          "optimism",
          "bsc",
          "xdai",
          "polygon",
          "sonic",
          "op_bnb",
          "fantom",
          "era",
          "polygon_zkevm",
          "base",
          "mode",
          "arbitrum",
          "arbitrum_nova",
          "avax",
          "linea",
          "blast",
          "scroll",
        },
        "supportedChainSet2": Set {
          "ethereum",
          "optimism",
          "bsc",
          "xdai",
          "unichain",
          "polygon",
          "sonic",
          "op_bnb",
          "fantom",
          "era",
          "hyperliquid",
          "polygon_zkevm",
          "soneium",
          "base",
          "mode",
          "arbitrum",
          "arbitrum_nova",
          "avax",
          "linea",
          "berachain",
          "blast",
          "scroll",
        },
      },
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
      "tron": {
        "call": [Function],
        "getBalance": [Function],
        "getBalances": [Function],
        "hexifyTarget": [Function],
        "multiCall": [Function],
        "unhexifyTarget": [Function],
      },
      "types": {},
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
          "getLatestBlock": [Function],
          "lookupBlock": [Function],
        },
        "convertToBigInt": [Function],
        "evmToTronAddress": [Function],
        "fetchJson": [Function],
        "formError": [Function],
        "formErrorString": [Function],
        "getProviderUrl": [Function],
        "getTimestamp": [Function],
        "getUniqueAddresses": [Function],
        "humanizeNumber": {
          "humanizeNumber": [Function],
        },
        "mergeBalances": [Function],
        "normalizeAddress": [Function],
        "postJson": [Function],
        "removeTokenBalance": [Function],
        "runInPromisePool": [Function],
        "shortenString": [Function],
        "sleep": [Function],
        "sleepRandom": [Function],
        "sliceIntoChunks": [Function],
        "sumChainTvls": [Function],
        "sumMultiBalanceOf": [Function],
        "sumSingleBalance": [Function],
        "tableToString": [Function],
        "tronToEvmAddress": [Function],
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
