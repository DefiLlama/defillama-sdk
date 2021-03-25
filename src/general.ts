import { ethers, BigNumber } from "ethers";

const providers = {
  ethereum: new ethers.providers.AlchemyProvider(
    "mainnet",
    process.env.ALCHEMY_API ?? "50pap1Pw6npcNypxG15YCjj4W_K5kb3Z"
  ),
  bsc: new ethers.providers.JsonRpcProvider(
    "https://bsc-dataseed.binance.org/",
    {
      name: "bsc",
      chainId: 56,
    }
  ),
} as {
  [chain: string]: ethers.providers.BaseProvider;
};

export type Chain = "ethereum" | "bsc";
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
