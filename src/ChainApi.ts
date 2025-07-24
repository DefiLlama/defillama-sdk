import { bytecodeCall, call, fetchList, multiCall } from './abi/abi2';
import Balances from "./Balances";
import { getBlockNumber } from './computeTVL/blocks';
import { Chain, getProvider } from "./general";
import providerList from './providers.json';
import { Balances as BalancesV1, Block, ByteCodeCallOptions, CallOptions, FetchListOptions, MulticallOptions } from "./types";

import { Provider } from "ethers";
import { getMulticallAddress } from "./abi/multicall3";
import { getBalances } from "./eth";
import { getUniqueAddresses, } from "./generalUtil";
import { debugLog, debugTable, } from "./util/debugLog";
import getLogs, { GetLogsOptions } from "./util/logs";
import { GetTransactionOptions, getTransactions } from "./util/transactions";

type Erc4626SumOptions = { calls: string[], tokenAbi?: string, balanceAbi?: string, balanceCalls?: any[], permitFailure?: boolean, isOG4626?: boolean }


const callStatsByProject: Record<string, DebugStats> = {}

type DebugStats = {
  total: number,
  [key: string]: any,
}

type BalancesV2Options = {
  skipChain?: boolean,
  label?: string,
}

const nullAddress = '0x0000000000000000000000000000000000000000'
export class ChainApi {
  block?: Block;
  chain: Chain | string;
  chainId?: number;
  timestamp?: number;
  provider: Provider;
  _balances: Balances;
  storedKey?: string;
  stats: DebugStats;
  api: ChainApi

  constructor(params: {
    block?: Block;
    chain?: Chain | string;
    storedKey?: string;
    timestamp?: number;
    protocol?: string;
  }) {
    this.block = params.block
    this.chain = params.chain ?? 'ethereum'
    this.timestamp = params.timestamp
    this.provider = getProvider(this.chain as Chain)
    this._balances = new Balances({ chain: this.chain, timestamp: this.timestamp })
    // @ts-ignore
    this.chainId = providerList[this.chain]?.chainId
    this.storedKey = params.storedKey
    this.api = this
    const uKey = `${params.protocol}:${this.storedKey}`
    const stats = {
      meta: {
        chain: this.chain as string,
        storedKey: this.storedKey,
        protocol: params.protocol,
      },
      label: uKey,
      total: 0,
    }
    callStatsByProject[uKey] = stats
    this.stats = stats
  }

  addStat(method: string, value: any = 1, skipTotal = false) {
    if (!skipTotal) this.stats.total += value
    if (!this.stats[method]) this.stats[method] = 0
    this.stats[method] += value
  }

  call(params: CallOptions) {
    this.addStat('call')
    return call({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  batchCall(params: CallOptions[]) {
    return Promise.all(params.map(i => this.call(i)))
  }

  multiCall(params: MulticallOptions) {
    this.addStat('multiCall', params.calls.length, true)
    this.addStat('call')

    return multiCall({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  fetchList(params: FetchListOptions) {
    this.addStat('fetchList')
    return fetchList({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  bytecodeCall(params: ByteCodeCallOptions) {
    return bytecodeCall({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  async getBlock(): Promise<number> {
    this.addStat('getBlock')
    if (!this.block) this.block = await getBlockNumber(this.chain as Chain, this.timestamp)
    return this.block as number
  }

  log(...args: any) {
    debugLog(...args)
  }

  logTable(...args: any) {
    debugTable(...args)
  }

  add(token: any, balance: any, options: BalancesV2Options = {}) {
    this._balances.add(token, balance, options)
  }

  addToken(token: string, balance: any, options: BalancesV2Options = {}) {
    this.add(token, balance, options)
  }

  addGasToken(balance: any, options: BalancesV2Options = {}) {
    this.add(nullAddress, balance, options)
  }

  addUSDValue(balance: any, options: BalancesV2Options = {}) {
    this._balances.addUSDValue(balance, options)
  }

  addTokens(tokens: string[], balances: any[], options: BalancesV2Options = {}) {
    this.add(tokens, balances, options)
  }

  addBalances(balances: Balances | BalancesV1, options: BalancesV2Options = {}) {
    this._balances.addBalances(balances, options)
  }

  addCGToken(token: string, balance: any, options: BalancesV2Options = {}) {
    this._balances.addCGToken(token, balance, options)
  }

  addTokenVannila(token: string, balance: any, options: BalancesV2Options = {}) {
    this._balances.addTokenVannila(token, balance, options)
  }

  getBalances(): BalancesV1 {
    return this._balances.getBalances()
  }

  getChainId(): number | undefined {
    return this.chainId
  }

  removeTokenBalance(token: string) {
    this._balances.removeTokenBalance(token)
  }

  deleteToken(token: string) {
    this._balances.removeTokenBalance(token)
  }

  deleteTokens(tokens: string[]) {
    tokens.forEach(i => this.deleteToken(i))
  }

  async erc4626Sum2(options: Erc4626SumOptions) {
    if (options.isOG4626 !== false) options.isOG4626 = true
    return this.erc4626Sum(options)
  }

  async erc4626Sum({ calls, tokenAbi, balanceAbi, balanceCalls, permitFailure = false, isOG4626 = false }: Erc4626SumOptions) {
    if (isOG4626 && !tokenAbi && !balanceAbi) {
      tokenAbi = 'asset'
      balanceAbi = 'totalAssets'
    }
    if (!tokenAbi) tokenAbi = 'address:token'
    if (!balanceAbi) balanceAbi = 'uint256:balance'
    if (typeof tokenAbi === 'string' && (!tokenAbi.includes(':') && !tokenAbi.includes('('))) tokenAbi = `address:${tokenAbi}`
    if (typeof balanceAbi === 'string' && (!balanceAbi.includes(':') && !balanceAbi.includes('('))) balanceAbi = `uint256:${balanceAbi}`

    const tokens = await this.multiCall({ calls, abi: tokenAbi, permitFailure })
    const balances = await this.multiCall({ calls: calls ?? balanceCalls, abi: balanceAbi, permitFailure })
    if (!permitFailure) this.addTokens(tokens, balances)
    else
      tokens.forEach((i: any, j: number) => {
        if (i && balances[j]) this.addToken(i, balances[j])
      })
    return this.getBalances()
  }

  async sumTokens({
    token,
    tokens = [],
    owners = [],
    owner,
    tokensAndOwners = [],
    tokensAndOwners2 = [],
    blacklistedTokens = [],
    blacklistedOwners = [],
    ownerTokens = [],
    balancesV2Options = {},
  }: {
    token?: string,
    tokens?: string[],
    owner?: string,
    owners?: string[],
    tokensAndOwners?: string[][],
    tokensAndOwners2?: string[][],
    ownerTokens?: any[],
    blacklistedTokens?: string[],
    blacklistedOwners?: string[],
    balancesV2Options?: BalancesV2Options,
  }): Promise<BalancesV1> {

    if (tokensAndOwners2.length)
      tokensAndOwners.push(...tokensAndOwners2[0].map((i: string, j: number) => [i, tokensAndOwners2[1][j]]))

    if (token) tokens.push(token)

    if (tokens.length) {
      if (owner) owners.push(owner)
      tokensAndOwners.push(...tokens.map(i => owners.map(j => [i, j])).flat())
    }

    for (const [tokens, owner] of ownerTokens)
      tokens.forEach((i: any) => tokensAndOwners.push([i, owner]))

    tokensAndOwners = getUniqueTokensAndOwners(tokensAndOwners, this.chain as string)
    blacklistedOwners = getUniqueAddresses(blacklistedOwners)
    blacklistedTokens = getUniqueAddresses(blacklistedTokens)

    tokensAndOwners = tokensAndOwners.filter(i => !blacklistedTokens.includes(i[0]) && !blacklistedOwners.includes(i[1]))
    const ethBalOwners = tokensAndOwners.filter(i => i[0] === nullAddress).map(i => i[1])
    tokensAndOwners = tokensAndOwners.filter(i => i[0] !== nullAddress)

    this.addStat('sumTokens', tokensAndOwners.length + ethBalOwners.length, true)

    const bals = await this.multiCall({
      calls: tokensAndOwners.map(i => ({ target: i[0], params: [i[1]] })),
      abi: 'erc20:balanceOf',
    })
    this.addTokens(tokensAndOwners.map(i => i[0]), bals, balancesV2Options)

    if (ethBalOwners.length) {
      let ethBals: string[] = []
      const multicallAddress = getMulticallAddress(this.chain as string, this.block)
      if (multicallAddress) {
        ethBals = await this.multiCall({
          calls: ethBalOwners,
          target: multicallAddress,
          abi: 'function getEthBalance(address) view returns (uint256)',
        })
      } else {
        const res = await getBalances({ chain: this.chain as string, targets: ethBalOwners, block: this.block as number })
        ethBals = res.output.map((i: any) => i.balance)
      }
      ethBals.map(i => this.addToken(nullAddress, i, balancesV2Options))
    }

    return this.getBalances()
  }

  async getUSDValue() {
    return this._balances.getUSDValue()
  }

  async getUSDString() {
    return this._balances.getUSDString()
  }

  async getUSDJSONs() {
    return this._balances.getUSDJSONs()
  }

  async getLogs(params: GetLogsOptions) {
    this.addStat('getLogs', params.targets?.length || 1)
    params.chain = this.chain
    return getLogs(params)
  }

  getBalancesV2() {
    return this._balances
  }

  async getTransactions(params: GetTransactionOptions) {
    this.addStat('getTransactions')
    return getTransactions({ ...params, chain: this.chain as string });
  }

  async getTransactionReceipt(tx: string) {
    this.addStat('getTransactionReceipt')
    return this.provider.getTransactionReceipt(tx)
  }
}

export default ChainApi

function getUniqueTokensAndOwners(toa: string[][], chain?: string): string[][] {
  if (!toa.length) return []
  const mergedToa = toa.map(i => i.join('~'))
  const uniqueMerged = getUniqueAddresses(mergedToa, chain)
  return uniqueMerged.map(i => i.split('~'))
}

export function getDebugStats() {
  return callStatsByProject
}