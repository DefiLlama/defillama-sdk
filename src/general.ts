import { ethers, BigNumber } from "ethers";

const providers = {
  ethereum: new ethers.providers.StaticJsonRpcProvider(
    process.env.ETHEREUM_RPC ??
      "https://eth-mainnet.alchemyapi.io/v2/50pap1Pw6npcNypxG15YCjj4W_K5kb3Z",
    {
      name: "ethereum",
      chainId: 1,
    }
  ),
  bsc: new ethers.providers.StaticJsonRpcProvider(
    process.env.BSC_RPC ?? "https://bsc-dataseed.binance.org/",
    {
      name: "bsc",
      chainId: 56,
    }
  ),
  polygon: new ethers.providers.StaticJsonRpcProvider(
    process.env.POLYGON_RPC ?? "https://rpc-mainnet.maticvigil.com/",
    {
      name: "polygon",
      chainId: 137,
    }
  ),
  heco: new ethers.providers.StaticJsonRpcProvider(
    process.env.HECO_RPC ?? "https://http-mainnet.hecochain.com",
    {
      name: "heco",
      chainId: 128,
    }
  ),
  fantom: new ethers.providers.StaticJsonRpcProvider(
    process.env.FANTOM_RPC ?? "https://rpc.ftm.tools/",
    {
      name: "fantom",
      chainId: 250,
    }
  ),
  rsk: new ethers.providers.StaticJsonRpcProvider(
    process.env.RSK_RPC ?? "https://public-node.rsk.co",
    {
      name: "rsk",
      chainId: 30,
    }
  ),
  tomochain: new ethers.providers.StaticJsonRpcProvider(
    process.env.TOMOCHAIN_RPC ?? "https://rpc.tomochain.com",
    {
      name: "tomochain",
      chainId: 88,
    }
  ),
  xdai: new ethers.providers.StaticJsonRpcProvider(
    process.env.XDAI_RPC ?? "https://xdai.poanetwork.dev",
    {
      name: "xdai",
      chainId: 100,
    }
  ),
  avax: new ethers.providers.StaticJsonRpcProvider(
    process.env.AVAX_RPC ?? "https://api.avax.network/ext/bc/C/rpc",
    {
      name: "avax",
      chainId: 43114,
    }
  ),
  wan: new ethers.providers.StaticJsonRpcProvider(
    process.env.WAN_RPC ?? "https://gwan-ssl.wandevs.org:56891",
    {
      name: "wan",
      chainId: 888,
    }
  ),
  harmony: new ethers.providers.StaticJsonRpcProvider(
    process.env.HARMONY_RPC ?? "https://api.s0.t.hmny.io",
    {
      name: "harmony",
      chainId: 1666600000,
    }
  ),
  thundercore: new ethers.providers.StaticJsonRpcProvider(
    process.env.THUNDERCORE_RPC ?? "https://mainnet-rpc.thundercore.com",
    {
      name: "thundercore",
      chainId: 108,
    }
  ),
  okexchain: new ethers.providers.StaticJsonRpcProvider(
    process.env.OKEXCHAIN_RPC ?? "https://exchainrpc.okex.org",
    {
      name: "okexchain",
      chainId: 66,
    }
  ),
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
  | "okexchain";
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
