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

export { computeTVL };
