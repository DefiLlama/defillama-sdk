import { bytecodeCall, call, fetchList, multiCall } from './abi/abi2';
import Balances from "./Balances";
import { getBlockNumber } from './computeTVL/blocks';
import { Chain, getProvider } from "./general";
import providerList from './providers.json';
import { Balances as BalancesV1, Block, ByteCodeCallOptions, CallOptions, FetchListOptions, MulticallOptions } from "./types";

import { Provider } from "ethers";
import { getBalances } from "./eth";
import { getUniqueAddresses, } from "./util/common";
import { debugLog, debugTable, } from "./util/debugLog";
import getLogs, { GetLogsOptions } from "./util/logs";
import { GetTransactionOptions, getTransactions } from "./util/transactions";

type Erc4626SumOptions = { calls: string[], tokenAbi?: string, balanceAbi?: string, balanceCalls?: any[], permitFailure?: boolean, isOG4626?: boolean }

type GetTokenBalancesOptions = {
  token?: string,
  tokens?: string[],
  owner?: string,
  owners?: string[],
  tokensAndOwners?: [string, string][],
  tokensAndOwners2?: [string[], string[]],
  ownerTokens?: [string[], string][],
  blacklistedTokens?: string[],
  blacklistedOwners?: string[],
  skipDuplicates?: boolean,
  permitFailure?: boolean,
  withTokenData?: boolean,
}

type SumTokensOptions = GetTokenBalancesOptions & {
  balancesV2Options?: BalancesV2Options,
}

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
    const uKey = this.storedKey ? `${params.protocol}:${this.storedKey}` : (params.protocol ? `${params.protocol}` : `chain-${this.chain}`)
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

  // autoset block if timestamp is older than 2 hours
  async _setBlockFromTimestamp() {
    if (this.timestamp && !this.block) {
      const twoHoursAgo = Date.now() / 1000 - 2 * 60 * 60
      if (this.timestamp > twoHoursAgo) return;
      await this.getBlock()
    }
  }

  async call(params: CallOptions) {
    await this._setBlockFromTimestamp()

    this.addStat('call')
    return call({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  async batchCall(params: CallOptions[]) {
    return Promise.all(params.map(i => this.call(i)))
  }

  async multiCall(params: MulticallOptions) {
    this.addStat('multiCall', params.calls.length, true)
    this.addStat('call')

    await this._setBlockFromTimestamp()

    return multiCall({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  async fetchList(params: FetchListOptions) {
    this.addStat('fetchList')
    await this._setBlockFromTimestamp()

    return fetchList({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  async bytecodeCall(params: ByteCodeCallOptions) {
    await this._setBlockFromTimestamp()

    return bytecodeCall({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  async getBlock(): Promise<number> {
    if (!this.block) this.addStat('getBlock')

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

  async getTokenBalances({
    token,
    tokens = [],
    owners = [],
    owner,
    tokensAndOwners = [],
    tokensAndOwners2 = [] as any,
    blacklistedTokens = [],
    blacklistedOwners = [],
    ownerTokens = [],
    skipDuplicates = false,
    permitFailure = false,
    withTokenData = false,
  }: GetTokenBalancesOptions) {

    await this._setBlockFromTimestamp()

    if (tokensAndOwners2.length)
      tokensAndOwners.push(...tokensAndOwners2[0].map((i: string, j: number) => [i, tokensAndOwners2[1][j]]) as any)

    if (token) tokens.push(token)

    if (tokens.length) {
      if (owner) owners.push(owner)
      tokensAndOwners.push(...tokens.map(i => owners.map(j => [i, j])).flat() as any)
    }

    for (const [tokens, owner] of ownerTokens)
      tokens.forEach((i: any) => tokensAndOwners.push([i, owner]))

    if (skipDuplicates)
      tokensAndOwners = getUniqueTokensAndOwners(tokensAndOwners, this.chain as string) as any
    blacklistedOwners = getUniqueAddresses(blacklistedOwners)
    blacklistedTokens = getUniqueAddresses(blacklistedTokens)

    tokensAndOwners = tokensAndOwners.filter(i => !blacklistedTokens.includes(i[0]) && !blacklistedOwners.includes(i[1]))


    const tokenBalances = [] as [token: string, balance: string][]
    const erc20TokensResponseIndex = [] as number[]
    const ethBalanceResponseIndex = [] as number[]
    const erc20TokensAndOwners = [] as any
    const ethBalOwners = [] as string[]

    tokensAndOwners.forEach((i, j) => {
      if (i[0] !== nullAddress) {
        erc20TokensAndOwners.push(i)
        erc20TokensResponseIndex.push(j)
      } else {
        ethBalOwners.push(i[1])
        ethBalanceResponseIndex.push(j)
      }
    })

    this.addStat('sumTokens', erc20TokensAndOwners.length + ethBalOwners.length, true)

    const bals = await this.multiCall({
      calls: erc20TokensAndOwners.map(([token, owner]: any) => ({ target: token, params: [owner] })),
      abi: 'erc20:balanceOf',
      permitFailure,
    })
    bals.forEach((i: any, j: number) => {
      if (!i) i = '0'
      const token = erc20TokensAndOwners[j][0]
      const responseIndex = erc20TokensResponseIndex[j]
      tokenBalances[responseIndex] = [token, i]
    })

    if (ethBalOwners.length) {
      let ethBals: string[] = (await getBalances({ chain: this.chain as string, targets: ethBalOwners, block: this.block as number, permitFailure })).output.map((i: any) => i.balance)

      ethBals.map((i, idx) => tokenBalances[ethBalanceResponseIndex[idx]] = [nullAddress, i])
    }

    if (!withTokenData) return tokenBalances.map(i => i[1])

    return tokenBalances
  }

  async sumTokens({
    balancesV2Options = {},
    ...tokenBalanceOptions
  }: SumTokensOptions): Promise<BalancesV1> {
    const tokenBalances = await this.getTokenBalances({ ...tokenBalanceOptions, skipDuplicates: true, withTokenData: true })
    tokenBalances.forEach(([token, balance]) => this.addToken(token, balance, balancesV2Options))

    return this.getBalances()
  }

  async getERC20TokenBalances(options: GetTokenBalancesOptions) {
    return this.getTokenBalances(options)
  }

  async getGasTokenBalance(owner: string, options?: GetTokenBalancesOptions) {
    return (await this.getGasTokenBalances({ ...options, owner, }))[0]
  }

  async getGasTokenBalances(options: GetTokenBalancesOptions) {
    return this.getTokenBalances({ ...options, token: nullAddress })
  }

  async getEthBalance(owner: string, options?: GetTokenBalancesOptions) {
    return this.getGasTokenBalance(owner, options ?? {})
  }

  async getEthBalances(options: GetTokenBalancesOptions) {
    return this.getGasTokenBalances(options)
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

  getStats() {
    return this.stats
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