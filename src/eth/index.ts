import { Address, LogArray } from "../types";
import { Chain, ETHER_ADDRESS, getProvider, handleDecimals } from "../general";
import * as Tron from "../abi/tron";
import { getMulticallAddress, } from "../abi/multicall3";
import { multiCall } from "../abi/abi2";
import { debugLog } from "../util/debugLog";
import { runInPromisePool } from "../generalUtil";
import { recordBalanceRead } from "../util/callStats";

const isAddress = (target: any) => typeof target === 'string' && /^0x[0-9a-fA-F]{40}$/.test(target)

export async function getBalance(params: {
  target: Address;
  block?: number;
  decimals?: number;
  chain?: Chain;
  logArray?: LogArray;
}) {
  // this is needed eth.getBalances doesnt include staked trx value
  if (params.chain === 'tron') return Tron.getBalance(params)
  recordBalanceRead(params.chain, params.target, ETHER_ADDRESS)
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
  // this is needed eth.getBalances doesnt include staked trx value
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
    // eth_getBalance cannot fail at the contract level, so the only failure permitFailure covers is an address that
    // is not one (balance 0, no rpc call). An rpc failure throws: reporting it as a 0 balance would be a wrong number.
    output = await runInPromisePool({
      items: params.targets,
      concurrency: 7,
      processor: async (target: string) => {
        if (params.permitFailure && !isAddress(target)) return { target, balance: '0' }
        recordBalanceRead(params.chain, target, ETHER_ADDRESS)
        return {
          target,
          balance: handleDecimals(
            await getProvider(params.chain).getBalance(target, params.block),
            params.decimals
          ),
        }
      },
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
