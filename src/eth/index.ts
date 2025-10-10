import { Address, LogArray } from "../types";
import { Chain, ETHER_ADDRESS, getProvider, handleDecimals } from "../general";
import * as Tron from "../abi/tron";
import { getMulticallAddress, } from "../abi/multicall3";
import { multiCall } from "../abi/abi2";
import { debugLog } from "../util/debugLog";
import { runInPromisePool } from "../generalUtil";

export async function getBalance(params: {
  target: Address;
  block?: number;
  decimals?: number;
  chain?: Chain;
  logArray?: LogArray;
}) {
  if (params.chain === 'tron') return Tron.getBalance(params)
  const balance = await getProvider(params.chain).getBalance(
    params.target,
    params.block
  );

  const output = handleDecimals(balance, params.decimals)

  if (params.logArray)
    params.logArray.push({
      chain: params.chain ?? "ethereum",
      holder: params.target,
      token: ETHER_ADDRESS,
      amount: output
    });

  return {
    output,
  };
}

export async function getBalances(params: {
  targets: Address[];
  block?: number;
  decimals?: number;
  chain?: Chain;
  logArray?: LogArray;
  skipMultiCall?: boolean
  permitFailure?: boolean
}) {
  if (params.chain === 'tron') return Tron.getBalances(params)
  let output: any

  try {
    const multicallContract = getMulticallAddress(params.chain ?? "ethereum", params.block)
    if (!params.skipMultiCall && multicallContract) {
      const multicallResults = await multiCall({
        calls: params.targets as any[],
        target: multicallContract as string,
        abi: 'function getEthBalance(address addr) view returns (uint256)',
        chain: params.chain,
        block: params.block,
        permitFailure: params.permitFailure,
      })
      output = multicallResults.map((value: any, i: any) => ({
        target: params.targets[i],
        balance: handleDecimals(value ?? '0', params.decimals)
      }));
    }
  } catch (e) {
    debugLog('Multicall failed, falling back to single calls for fetching eth balances', e)
  }

  if (!output) {
    output = await runInPromisePool({
      items: params.targets,
      concurrency: 7,
      processor: async (target: string) => ({
        target,
        balance: handleDecimals(
          await getProvider(params.chain).getBalance(target, params.block),
          params.decimals
        ),
      }),
      permitFailure: params.permitFailure
    })

    // If some calls failed, fill their balance with 0
    if (params.permitFailure)
      output.forEach((o: any, idx: number) => {
        if (!o?.balance) output[idx] = { target: params.targets[idx], balance: '0' }
      })

  }

  if (params.logArray)
    params.logArray.push(
      ...params.targets.map((holder: Address, i: number) => ({
        chain: params.chain ?? "ethereum",
        holder,
        token: ETHER_ADDRESS,
        amount: output[i].balance
      })),
    );

  return {
    output,
  };
}
