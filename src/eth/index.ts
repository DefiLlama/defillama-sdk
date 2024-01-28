import { Address } from "../types";
import { Chain, getProvider, handleDecimals } from "../general";

export async function getBalance(params: {
  target: Address;
  block?: number;
  decimals?: number;
  chain?: Chain;
}) {
  const balance = await getProvider(params.chain).getBalance(
    params.target,
    params.block
  );
  return {
    output: handleDecimals(balance, params.decimals),
  };
}

// TODO: Optimize this? (not sure if worth it tho, barely any adapters use it)
export async function getBalances(params: {
  targets: Address[];
  block?: number;
  decimals?: number;
  chain?: Chain;
}) {
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
