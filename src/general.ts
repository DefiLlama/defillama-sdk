import { ethers, BigNumber } from "ethers";

export const provider = new ethers.providers.AlchemyWebSocketProvider(
  "mainnet",
  process.env.ALCHEMY_API ?? "50pap1Pw6npcNypxG15YCjj4W_K5kb3Z"
);

export const ETHERSCAN_API_KEY = process.env.ETHERSCAN_API_KEY;
export const TEN = BigNumber.from(10);
export const e18 = TEN.pow(18);

export function handleDecimals(num: BigNumber, decimals?: number): string {
  if (decimals === undefined) {
    return num.toString();
  } else {
    return num.div(TEN.pow(decimals)).toString();
  }
}

export const ETHER_ADDRESS = "0x0000000000000000000000000000000000000000";
