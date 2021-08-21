import { ethers, BigNumber } from "ethers";

function createProvider(name: string, defaultRpc: string, chainId: number) {
  return new ethers.providers.FallbackProvider(
    (process.env[name.toUpperCase() + "_RPC"] ?? defaultRpc).split(',').map((url, i) => ({
      provider: new ethers.providers.StaticJsonRpcProvider(
        url,
        {
          name,
          chainId,
        }
      ),
      priority: i
    })),
    1
  )
}

const providers = {
  ethereum: createProvider("ethereum", "https://eth-mainnet.gateway.pokt.network/v1/5f3453978e354ab992c4da79", 1),
  bsc: createProvider("bsc","https://bsc-dataseed.binance.org/",56),
  polygon: createProvider( "polygon","https://rpc-mainnet.maticvigil.com/",137),
  heco: createProvider("heco", "https://http-mainnet.hecochain.com", 128),
  fantom: createProvider("fantom", "https://rpcapi.fantom.network", 250),
  rsk: createProvider("rsk", "https://public-node.rsk.co", 30),
  tomochain: createProvider("tomochain", "https://rpc.tomochain.com", 88),
  xdai: createProvider("xdai", "https://xdai.poanetwork.dev", 100),
  avax: createProvider("avax","https://api.avax.network/ext/bc/C/rpc",43114),
  wan: createProvider("wan", "https://gwan-ssl.wandevs.org:56891", 888),
  harmony: createProvider("harmony", "https://api.s0.t.hmny.io", 1666600000),
  thundercore: createProvider("thundercore", "https://mainnet-rpc.thundercore.com", 108),
  okexchain: createProvider("okexchain", "https://exchainrpc.okex.org", 66),
  optimism: createProvider( "optimism", "https://mainnet.optimism.io/",10),
  arbitrum: createProvider("arbitrum", "https://arb1.arbitrum.io/rpc", 42161),
} as {
  [chain: string]: ethers.providers.BaseProvider;
};

export type Chain =
  | "ethereum"
  | "bsc"
  | "polygon"
  | "heco"
  | "fantom"
  | "rsk"
  | "tomochain"
  | "xdai"
  | "avax"
  | "wan"
  | "harmony"
  | "thundercore"
  | "okexchain"
  | "optimism"
  | "arbitrum";
export function getProvider(chain: Chain = "ethereum") {
  return providers[chain];
}

export const TEN = BigNumber.from(10);

export function handleDecimals(num: BigNumber, decimals?: number): string {
  if (decimals === undefined) {
    return num.toString();
  } else {
    return num.div(TEN.pow(decimals)).toString();
  }
}

export const ETHER_ADDRESS = "0x0000000000000000000000000000000000000000";

export function setProvider(
  chain: Chain,
  provider: ethers.providers.BaseProvider
) {
  providers[chain] = provider;
}
