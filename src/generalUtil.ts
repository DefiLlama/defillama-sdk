import { BigNumber } from "ethers";
import * as blocks from "./computeTVL/blocks";
import * as humanizeNumber from "./computeTVL/humanizeNumber";
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
  },
  allCallsMustBeSuccessful = true,
  transformAddress = (addr:string)=>addr
) {
  results.output.map((result) => {
    if (result.success) {
      const address = transformAddress(result.input.target);
      const balance = result.output;

      if (BigNumber.from(balance).lte(0)) {
        return;
      }

      balances[address] = BigNumber.from(balances[address] ?? 0)
        .add(balance)
        .toString();
    } else if(allCallsMustBeSuccessful){
      console.error(result)
      throw new Error(`balanceOf multicall failed`)
    }
  });
}

export function sumSingleBalance(
  balances: Balances,
  token: string,
  balance: string | number | BigNumber,
  chain?: string,
) {
  isValidNumber(balance)

  if (+balance === 0) return;
  
  if (chain)
    token = `${chain}:${token}`
  
  if (typeof balance === 'object') {
    if (typeof balance.toString === 'function')
      balance = balance.toString()
    else
      throw new Error('Invalid balance value:' + balance)
  }
  
  if (typeof balance === 'number' || (balances[token] && typeof balances[token] === 'number')) {
    const prevBalance = +(balances.hasOwnProperty(token) ? balances[token] : 0)
    if (typeof prevBalance !== 'number' || isNaN(prevBalance))
      throw new Error(`Trying to merge token balance and coingecko amount for ${token} current balance: ${balance} previous balance: ${balances[token]}`)
    const value = prevBalance + +balance
    isValidNumber(value)
    balances[token] = value
  } else {
    const prevBalance = BigNumber.from(balances.hasOwnProperty(token) ? balances[token] : '0');
    const value = prevBalance.add(BigNumber.from(balance)).toString();
    isValidNumber(+value)
    balances[token] = value
  }

  function isValidNumber(value: any) {
    if ([null, undefined].includes(value) || isNaN(+value))
      throw new Error(`Invalid balance: ${balance}`)
  }
}

export function mergeBalances(balances: Balances, balancesToMerge: Balances) {
  if (balances === balancesToMerge) return;
  Object.entries(balancesToMerge).forEach((balance) => {
    sumSingleBalance(balances, balance[0], balance[1]);
  });
}

export function removeTokenBalance(balances: Balances, token: string, isCaseSensitive = false) {
  const re = new RegExp(token, isCaseSensitive ? undefined : 'i')
  Object.keys(balances).forEach(key => {
    if (re.test(key)) delete balances[key]
  });

  return balances  
}

type ChainBlocks = {
  [chain: string]: number;
};

export function sumChainTvls(
  chainTvls: Array<
    (
      timestamp: number,
      ethBlock: number,
      chainBlocks: ChainBlocks,
      params: any,
    ) => Promise<Balances>
  >
) {
  return async (
    timestamp: number,
    ethBlock: number,
    chainBlocks: ChainBlocks,
    params: any,
  ) => {
    const api = params.api
    await Promise.all(
      chainTvls.map(async (chainTvl) => {
        const chainBalances = await chainTvl(timestamp, ethBlock, chainBlocks, params);
        api.addBalances(chainBalances);
      })
    );
    return api.getBalances()
  };
}

export { blocks, humanizeNumber, };
