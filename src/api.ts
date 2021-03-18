export * as util from "./util";
export * as eth from "./eth";
export * as erc20 from "./erc20";
export * as cdp from "./cdp";
export * as abi from "./abi";

/*
  export default {
    abi: {
      call: (options) => abi('call', { ...options }),
      multiCall: (options) => abi('multiCall', { ...options, chunk: {param: 'calls', length: 5000, combine: 'array'} })
    },
    cdp: {
      getAssetsLocked: (options) => cdp('getAssetsLocked', { ...options, chunk: {param: 'targets', length: 1000, combine: 'balances'} }),
      maker: {
        tokens: (options) => maker('tokens', { ...options }),
        getAssetsLocked: (options) => maker('getAssetsLocked', { ...options, chunk: {param: 'targets', length: 3000, combine: 'balances'} })
      },
      compound: {
        tokens: (options) => compound('tokens', { ...options }),
        getAssetsLocked: (options) => compound('getAssetsLocked', { ...options, chunk: {param: 'targets', length: 1000, combine: 'balances'} })
      }
    },
    util: {
      getLogs: (options) => util('getLogs', { ...options }),
      tokenList: () => util('tokenList'),
      kyberTokens: () => util('kyberTokens'),
      getEthCallCount: () => util('getEthCallCount'),
      resetEthCallCount: () => util('resetEthCallCount'),
      toSymbols: (data) => util('toSymbols', { data }),
      unwrap: (options) => util('unwrap', { ...options }),
      lookupBlock: (timestamp) => util('lookupBlock', { timestamp })
    },
    eth: {
      getBalance: (options) => eth('getBalance', options),
      getBalances: (options) => eth('getBalances', options),
    },
    erc20: {
      info: (target) => erc20('info', { target }),
      symbol: (target) => erc20('symbol', { target }),
      decimals: (target) => erc20('decimals', { target }),
      totalSupply: (options) => erc20('totalSupply', { ...options }),
      balanceOf: (options) => erc20('balanceOf', { ...options }),
    }
  }
  */
