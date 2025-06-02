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

const nullAddress = '0x0000000000000000000000000000000000000000'
export class ChainApi {
  block?: Block;
  chain: Chain | string;
  chainId?: number;
  timestamp?: number;
  provider: Provider;
  _balances: Balances;
  storedKey?: string;
  api: ChainApi

  constructor(params: {
    block?: Block;
    chain?: Chain | string;
    storedKey?: string;
    timestamp?: number;
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
  }

  call(params: CallOptions) {
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
    return multiCall({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  fetchList(params: FetchListOptions) {
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
    if (!this.block) this.block = await getBlockNumber(this.chain as Chain, this.timestamp)
    return this.block as number
  }

  log(...args: any) {
    debugLog(...args)
  }

  logTable(...args: any) {
    debugTable(...args)
  }

  add(token: any, balance: any, { skipChain = false } = {}) {
    this._balances.add(token, balance, { skipChain })
  }

  addToken(token: string, balance: any, { skipChain = false } = {}) {
    this.add(token, balance, { skipChain })
  }

  addGasToken(balance: any) {
    this.add(nullAddress, balance)
  }

  addUSDValue(balance: any) {
    this._balances.addUSDValue(balance)
  }

  addTokens(tokens: string[], balances: any[], { skipChain = false } = {}) {
    this.add(tokens, balances, { skipChain })
  }

  addBalances(balances: Balances | BalancesV1) {
    this._balances.addBalances(balances)
  }

  addCGToken(token: string, balance: any) {
    this._balances.addCGToken(token, balance)
  }

  addTokenVannila(token: string, balance: any) {
    this._balances.addTokenVannila(token, balance)
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

    const bals = await this.multiCall({
      calls: tokensAndOwners.map(i => ({ target: i[0], params: [i[1]] })),
      abi: 'erc20:balanceOf',
    })
    this.addTokens(tokensAndOwners.map(i => i[0]), bals)

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
      ethBals.map(i => this.addToken(nullAddress, i))
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
    params.chain = this.chain
    return getLogs(params)
  }

  getBalancesV2() {
    return this._balances
  }

  async getTransactions(params: GetTransactionOptions) {
    return getTransactions({ ...params, chain: this.chain as string });
  }

  async getTransactionReceipt(tx: string) {
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