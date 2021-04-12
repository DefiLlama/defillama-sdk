import { ethers, BigNumber } from "ethers";

const providers = {
  ethereum: new ethers.providers.AlchemyProvider(
    "mainnet",
    process.env.ALCHEMY_API ?? "50pap1Pw6npcNypxG15YCjj4W_K5kb3Z"
  ),
  bsc: new ethers.providers.JsonRpcProvider(
    process.env.BSC_RPC ?? "https://bsc-dataseed.binance.org/",
    {
      name: "bsc",
      chainId: 56,
    }
  ),
  polygon: new ethers.providers.JsonRpcProvider(
    process.env.POLYGON_RPC ?? "https://rpc-mainnet.maticvigil.com/",
    {
      name: "polygon",
      chainId: 137,
    }
  ),
  heco: new ethers.providers.JsonRpcProvider(
    "https://http-mainnet.hecochain.com",
    {
      name: "heco",
      chainId: 128,
    }
  ),
  fantom: new ethers.providers.JsonRpcProvider(
    "https://rpcapi.fantom.network",
    {
      name: "fantom",
      chainId: 250,
    }
  ),
  rsk: new ethers.providers.JsonRpcProvider("https://public-node.rsk.co", {
    name: "rsk",
    chainId: 30,
  }),
  tomochain: new ethers.providers.JsonRpcProvider("https://rpc.tomochain.com", {
    name: "tomochain",
    chainId: 88,
  }),
  xdai: new ethers.providers.JsonRpcProvider("https://xdai.poanetwork.dev", {
    name: "xdai",
    chainId: 100,
  }),
  avax: new ethers.providers.JsonRpcProvider(
    "https://api.avax.network/ext/bc/C/rpc",
    {
      name: "avax",
      chainId: 43114,
    }
  ),
  /*
  wanchain: new ethers.providers.JsonRpcProvider(
    'https://gwan-ssl.wandevs.org:56891',
    {
      name: "wanchain",
      chainId: 888,
    }
  ),
  */
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
  | "xdai"
  | "tomochain";
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
