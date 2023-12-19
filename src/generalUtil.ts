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
  transformAddress = (addr: string) => addr
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
    } else if (allCallsMustBeSuccessful) {
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

export function getUniqueAddresses(addresses: string[], chain?: string): string[] {
  if (!addresses.length) return []
  const isTronAddress = chain === 'tron' && addresses[0].startsWith('T')
  const toLowerCase = !isTronAddress
  const set = {} as { [address: string]: boolean }
  addresses.forEach(i => set[toLowerCase ? i.toLowerCase() : i] = true)
  return Object.keys(set)
}


export function formErrorString(e: any, errorParams: any = {}) {
  if (!e) {
    if (errorParams.isMultiCallError) {
      const targetStr = errorParams.target ? `[target: ${errorParams.target}]` : ''
      let errorString = `Multicall failed! \n [chain: ${errorParams.chain ?? "ethereum"}] [fail count: ${errorParams.failedQueries?.length}] [abi: ${errorParams.abi}] ${targetStr} `
      errorParams.failedQueries?.forEach((i: any) => {
        i = i.input
        let target = !targetStr ? `   target: ${i.target}` : ''
        let params = i.params && i.params.length ? `params: ${i.params.length === 1 ? i.params[0] : i.params.join(', ')}]` : ''
        errorString += `\n ${target} ${params}`
      })
      // truncate error string to 310 chars
      return errorString.length > 310 ? errorString.slice(0, 310).concat('...') : errorString
    }
    return ''
  }

  let errorString = e.toString()
  if (typeof e !== 'object') return errorString

  if ((e.reason || e.method) && e.code) { // ethers.js error

    let method = e.method
    if (!method && e.requestBody) {
      try {
        e.requestBody = JSON.parse(e.requestBody)
      } catch (e) { }
      method = e.requestBody?.method
    }

    if (!e.provider && errorParams.provider) e.provider = errorParams.provider

    let providerUrl = e?.url ?? ((e.provider as any)?.providerConfigs ?? [])[0]?.provider?.connection?.url
    if (!providerUrl) // in case of historical queries against archive nodes
      providerUrl = (e.provider as any)?.connection?.url
    if (e.serverError) return `host: ${providerUrl} ${e.serverError.toString()}`

    if (e.results) {
      let errors = e.results.filter((i: any) => i.error).map((i: any) => i.error)
      if (errors.length) {
        const eStrings = errors.map((i: any) => formError(i))
        return `Failed to call ${method} errors:
         ${eStrings.join('\n')}`
      }
    } else if (e.code === 'CALL_EXCEPTION' && errorParams.chain && errorParams.result === '0x') {
      let extraInfo = 'target: ' + errorParams.target
      if (errorParams.params && errorParams.params.length) extraInfo += ' params: ' + errorParams.params.join(', ')
      return `Failed to call ${method} ${extraInfo} on chain: [${errorParams.chain}] rpc: ${providerUrl}  call reverted ${e.errorName ?? ''}   ${e.errorArgs ?? ''}`
    }
    if (method === 'eth_blockNumber') return `host: ${providerUrl} reason: ${e.reason} code: ${e.code}`
    if (method === 'getBlockNumber') return `Failed to call ${method} ${providerUrl} reason: ${e.reason} code: ${e.code}`

    return `Failed to call ${method} on ${providerUrl} reason: ${e.reason} code: ${e.code}`
  }
  return errorString
}

export function formError(e: any, errorParams: any = {}): Error {
  const error: Error = new Error(formErrorString(e, errorParams));
  if (errorParams.isMultiCallError)
    (error as any)._underlyingErrors = errorParams?.failedQueries?.map((i: any) => i.error);
  else
    (error as any)._underlyingError = e;
  (error as any)._isCustomError = true;
  return error
}