import { Address, LogArray } from "../types";
import { Chain, ETHER_ADDRESS, getProvider, handleDecimals } from "../general";
import * as Tron from "../abi/tron";

export async function getBalance(params: {
  target: Address;
  block?: number;
  decimals?: number;
  chain?: Chain;
  logArray?: LogArray;
}) {
  if (params.logArray)
    params.logArray.push({
      chain: params.chain ?? "ethereum",
      holder: params.target,
      token: ETHER_ADDRESS,
    });
  if (params.chain === 'tron') return Tron.getBalance(params)
  const balance = await getProvider(params.chain).getBalance(
    params.target,
    params.block
  );
  return {
    output: handleDecimals(balance, params.decimals),
  };
}

export async function getBalances(params: {
  targets: Address[];
  block?: number;
  decimals?: number;
  chain?: Chain;
  logArray?: LogArray;
}) {
  if (params.logArray)
    params.logArray.push(
      ...params.targets.map((holder: Address) => ({
        chain: params.chain ?? "ethereum",
        holder,
        token: ETHER_ADDRESS,
      })),
    );
  if (params.chain === 'tron') return Tron.getBalances(params)
  const balances = params.targets.map(async (target) => ({
    target,
    balance: handleDecimals(
      await getProvider(params.chain).getBalance(target, params.block),
      params.decimals
    ),
  }));
  return {
    output: await Promise.all(balances),
  };
}
