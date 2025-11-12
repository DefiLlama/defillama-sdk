// keep no dependency here else it will create circular dependencies


import axios, { AxiosError } from "axios";
import * as ethers from 'ethers'
import * as TronAddressFormatter from 'tron-format-address'
import type { Balances, StringNumber, Address } from "../types";
import { ENV_CONSTANTS, getBoolEnvValue } from "./env";
import crypto from 'crypto';


export function convertToBigInt(value: any) {
  const balance = value
  if (!value) return BigInt(0)
  if (typeof value === 'bigint') return value;
  if (typeof value === 'number') value = value.toString()
  if (typeof value === 'string') {
    if (!value.startsWith('0x') && value.includes('e')) {// Convert scientific notation to standard notation
      let [base, e] = value.split('e');
      const [lead, decimal] = base.split('.');
      let final;
      let exponent = +e;

      if (exponent >= 0) {
        final = lead + (decimal || '') + '0'.repeat(exponent - (decimal || '').length);
      } else {
        // NOTE: unforutenately BigInt doesn't support negative exponents, so this ends up being 0
        exponent = exponent * -1
        final = BigInt(lead) / BigInt('1' + Array(exponent).fill(0).join(''))
      }
      return BigInt(final)
    }
    return BigInt(value)
  }
  if (typeof value === 'string') return BigInt(value);
  throw new Error(`Invalid balance: ${balance}`)
}

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

      if (BigInt(balance) <= 0) {
        return;
      }

      balances[address] = (BigInt(balances[address] ?? 0) + BigInt(balance)).toString();
    } else if (allCallsMustBeSuccessful) {
      console.error(result)
      throw new Error(`balanceOf multicall failed`)
    }
  });
}

export function sumSingleBalance(
  balances: Balances,
  token: string,
  balance: string | number | BigInt,
  chain?: string,
) {
  if (typeof balance === 'bigint') balance = balance.toString()
  isValidNumber(balance)

  if (+balance === 0) return;

  if (chain)
    token = `${chain}:${token}`

  if (typeof balance === 'object') {
    if (typeof balance.toString === 'function')
      balance = balance.toString()
    else
      throw new Error('Invalid balance value:' + balance + ' ' + token)
  }

  if (typeof balance === 'number' || (balances[token] && typeof balances[token] === 'number')) {
    const prevBalance = +(balances.hasOwnProperty(token) ? balances[token] : 0)
    if (typeof prevBalance !== 'number' || isNaN(prevBalance))
      throw new Error(`Trying to merge token balance and coingecko amount for ${token} current balance: ${balance} previous balance: ${balances[token]}`)
    const value = prevBalance + +balance
    isValidNumber(value)
    balances[token] = value
  } else {
    const prevBalance = convertToBigInt(balances[token]);
    const value = (prevBalance + convertToBigInt(balance))
    isValidNumber(Number(value))
    balances[token] = Number(value).toString()
  }

  function isValidNumber(value: any) {
    if (typeof value === 'bigint') return;
    if ([null, undefined].includes(value) || isNaN(+value))
      throw new Error(`Invalid balance: ${balance} - ${token}`)
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
}

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


export function getUniqueAddresses(addresses: string[], chain?: string): string[] {
  if (!addresses.length) return []
  const isTronAddress = chain === 'tron' && addresses[0].includes('T')
  const toLowerCase = !isTronAddress
  const set = {} as { [address: string]: boolean }
  addresses.forEach(i => set[toLowerCase ? i.toLowerCase() : i] = true)
  return Object.keys(set)
}

export function getProviderUrl(provider: any) {
  if (provider?.isCustomLlamaProvider) return provider.rpcs.map((i: any) => i.url).join(', ')
  if (provider instanceof ethers.FallbackProvider) provider = (provider.providerConfigs[0].provider as ethers.JsonRpcApiProvider)
  if (provider instanceof ethers.JsonRpcProvider) return provider._getConnection().url
  return ''
}

export function formErrorString(e: any, errorParams: any = {}) {

  if (e instanceof AxiosError) {
    let message = `[host: ${shortenString(e?.config?.url ?? '', 120)}] `
    // if (e?.config?.method === 'post' && e?.config?.data)
    //   message += shortenString(`method: POST data: ${e?.config?.data} `)

    if (e?.response?.data) {
      if (e.response.status) message += `[${e.response.status}] `
      let dataString = shortenString(JSON.stringify(e.response.data))
      if (typeof e.response.data === 'object') {
        if (e.response.data.error?.message)
          dataString = shortenString('' + e.response.data.error.message)
        else if (e.response.data.message)
          dataString = shortenString('' + e.response.data.message)
      }
      if (dataString.startsWith('"<!DOCTYPE html>') || dataString.startsWith('"<html')) dataString = 'HTML error page'
      message += dataString
      return message
    }

    if (e?.message)
      return shortenString(message + e.message)
  }


  const isGraphError = typeof e === 'object' && e?.stack?.includes('graphql-request') && e.response?.errors?.length

  if (isGraphError)
    return shortenString(`GraphQL request failed! ${e.response.errors.map((i: any) => i.message).join(', ')}`)

  if (!e) {
    if (errorParams.promisePoolErrors) {
      const errors = errorParams.promisePoolErrors.map((i: any) => formErrorString(i))
      return `Promise pool failed! \n ${errors.join('\n')}`
    }
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

  if (e.llamaRPCError) {
    const errorString = `Llama RPC error! method: ${e.method} `
    const errors = e.errors.map((i: any) => `- host: ${i?.host} error: ${typeof i?.error === 'string' ? i?.error : i?.error?.message}`)
    return errorString + '\n' + errors.join('\n')
  }

  let errorString = e.toString()
  if (typeof e !== 'object') return errorString

  if (((e.reason || e.method || e.shortMessage) && e.code) || errorParams.result === '0x') { // ethers.js error

    const errorMessage = e.info?.error?.message ?? e.message ?? e.shortMessage ?? e.errorName ?? e.reason ?? ''
    let method = e.method ?? e.info?.request?.method ?? errorParams.abi
    if (e.body) {
      try {
        e.body = JSON.parse(e.body)
      } catch (e) { }
      if (e.body?.error?.message) return e.body.error.message
    }
    if (!method && e.requestBody) {
      try {
        e.requestBody = JSON.parse(e.requestBody)
      } catch (e) { }
      method = e.requestBody?.method
    } else

      if (!e.provider && errorParams.provider) e.provider = errorParams.provider

    let providerUrl = getProviderUrl(e.provider ?? errorParams.provider)
    if (e.serverError) return `host: ${providerUrl} ${e.serverError.toString()}`

    if (e.results) {
      let errors = e.results.filter((i: any) => i.error).map((i: any) => i.error)
      if (errors.length) {
        const eStrings = errors.map((i: any) => formError(i))
        return `Failed to call method: ${method} provider: ${providerUrl}
         ${eStrings.join('\n')}`
      }
    } else if (e.code === 'CALL_EXCEPTION' || errorParams.isCallError) {
      let extraInfo = 'target: ' + errorParams.target
      if (errorParams.params && Array.isArray(errorParams.params) && errorParams.params.length) extraInfo += shortenString(' params: ' + errorParams.params.join(', '))
      return `Failed to call: ${method} ${extraInfo} on chain: [${errorParams.chain}] rpc: ${providerUrl}  call reverted, reason: ${errorMessage}   ${e.errorArgs ?? ''}`
    } else if (e.code === 'BAD_DATA') {

      if (!method) method = e?.info?.payload?.method
      let extraInfo = 'target: ' + errorParams.target
      return `Failed method: ${method} ${shortenString(extraInfo)} on chain: [${errorParams.chain}] rpc: ${providerUrl}  reason: ${errorMessage}   ${e.errorArgs ?? ''}`
    }
    if (method === 'eth_blockNumber') return `host: ${providerUrl} reason: ${e.reason} code: ${e.code}`
    if (method === 'getBlockNumber') return `Failed to call ${method} ${providerUrl} reason: ${e.reason} code: ${e.code}`

    return `Failed to call ${method} on ${providerUrl} reason: ${e.reason} code: ${e.code}`
  }
  return errorString
}

export function shortenString(str: string, length?: number) {

  if (!length) {
    if (!isNaN(+ENV_CONSTANTS.DEFAULT_SHORTEN_STRING_LENGTH!)) length = +ENV_CONSTANTS.DEFAULT_SHORTEN_STRING_LENGTH!
    if (!length || isNaN(length)) length = 120
  }

  return str.length > length! ? str.slice(0, length).concat('...') : str
}

export function formError(e: any, errorParams: any = {}): Error {

  if (e instanceof Error && getBoolEnvValue('DEBUG_ERROR_STACK')) {
    console.error(e)
  }

  const errorParamsSet = Object.keys(errorParams).length
  if (e?._isCustomError || (!errorParamsSet && typeof e === 'object' && !Object.keys(e).length)) return e // already formatted or vannila error
  const error: any = new Error(formErrorString(e, errorParams));
  try {
    if (errorParams.isMultiCallError)
      error._underlyingErrors = errorParams?.failedQueries?.map((i: any) => shortenString(i.error.toString()));
    else
      error._underlyingError = shortenString(e.toString())
  } catch (e) { }
  error._isCustomError = true;
  error.message = shortenString(error.message, 2999)
  error.stack = ''
  return error as Error
}

export async function fetchJson(url: string, params: any = {}) {
  const res = await axios(url, params).catch(e => { throw formError(e) })
  return res.data
}

export async function postJson(url: string, data: any = {}, params: any = {}) {
  const res = await axios.post(url, data, params).catch(e => { throw formError(e) })
  return res.data
}

export function tronToEvmAddress(address: string) {
  if (!address.startsWith('0x')) return TronAddressFormatter.toHex(address)
  return address
}

export function evmToTronAddress(address: string) {
  if (address.startsWith('0x')) return TronAddressFormatter.fromHex(address)
  return address
}

export function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function sleepRandom(max: number, min = 0) {
  const ms = Math.floor(Math.random() * (max - min + 1)) + min;
  return sleep(ms)
}


// convert all the tron addresses in the params to evm addresses (from Txxx to 0x...)
export function fixTronCallParams(params: any) {
  const wrappedHexify = (v: any) => {
    if (typeof v === 'string' && v.startsWith('T')) return tronToEvmAddress(v)
    return v
  }
  if (typeof params === 'object') {
    if (params.target) params.target = tronToEvmAddress(params.target)
    if (Array.isArray(params.params)) params.params = params.params.map(wrappedHexify)
    if (typeof params.params === 'string') params.params = wrappedHexify(params.params)
  }

  if (Array.isArray(params.calls))
    params.calls.forEach(fixTronCallParams)
}


export function getHash(str: string | string[]) {
  if (Array.isArray(str)) str = str.join('-')
  return crypto.createHash('sha256').update(str).digest('hex').substring(0, 32)
}