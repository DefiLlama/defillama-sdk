import { BigNumber } from "ethers";
import computeTVL from "./computeTVL";
import type { Balances, StringNumber, Address } from "./types";

// We ignore `sum` as it's never used (only in some SDK wrapper code)

export function sumMultiBalanceOf(
  balances: Balances,
  results: {
    ethCallCount?: number;
    output: {
      output: StringNumber;
      success: boolean;
      input: {
        target: Address;
        params: string[];
      };
    }[];
  }
) {
  results.output.map((result) => {
    if (result.success) {
      const address = result.input.target;
      const balance = result.output;

      if (BigNumber.from(balance).lte(0)) {
        return;
      }

      balances[address] = BigNumber.from(balances[address] ?? 0)
        .add(balance)
        .toString();
    }
  });
}

export function sumSingleBalance(
  balances: Balances,
  token: string,
  balance: string
) {
  const prevBalance = BigNumber.from(balances[token] || "0");
  balances[token] = prevBalance.add(BigNumber.from(balance)).toString();
}

function mergeBalances(balances: Balances, balancesToMerge: Balances) {
  Object.entries(balancesToMerge).forEach((balance) => {
    sumSingleBalance(balances, balance[0], balance[1]);
  });
}
type ChainBlocks = {
  [chain: string]: number;
};
export function sumChainTvls(
  chainTvls: Array<
    (
      timestamp: number,
      ethBlock: number,
      chainBlocks: ChainBlocks
    ) => Promise<Balances>
  >
) {
  return async (
    timestamp: number,
    ethBlock: number,
    chainBlocks: ChainBlocks
  ) => {
    const balances = {};
    await Promise.all(
      chainTvls.map(async (chainTvl) => {
        const chainBalances = await chainTvl(timestamp, ethBlock, chainBlocks);
        mergeBalances(balances, chainBalances);
      })
    );
    return balances;
  };
}

export { computeTVL };
