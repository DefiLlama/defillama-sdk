import { Block, CallOptions, MulticallOptions, FetchListOptions, Balances, ByteCodeCallOptions } from "./types";
import { Chain, getProvider, } from "./general";
import { call, multiCall, fetchList, bytecodeCall } from './abi/abi2'
import { getBlock } from './computeTVL/blocks'
import { ethers, } from "ethers";
import providerList from './providers.json'

import { debugLog, debugTable, } from "./util/debugLog";
import { sumSingleBalance, getUniqueAddresses, } from "./generalUtil";
import { getMulticallAddress } from "./abi/multicall3";
import { getBalances } from "./eth";

const nullAddress = '0x0000000000000000000000000000000000000000'
export class ChainApi {
  block?: Block;
  chain: Chain | string;
  chainId?: number;
  timestamp?: number;
  provider: ethers.providers.BaseProvider;
  _balances: Balances;

  constructor(params: {
    block?: Block;
    chain?: Chain | string;
    timestamp?: number;
  }) {
    this.block = params.block
    this.chain = params.chain ?? 'ethereum'
    this.timestamp = params.timestamp
    this.provider = getProvider(this.chain as Chain)
    this._balances = {}
    // @ts-ignore
    this.chainId = providerList[this.chain]?.chainId
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
    if (!this.block) this.block = (await getBlock(this.chain as Chain, this.timestamp)).block
    return this.block as number
  }

  log(...args: any) {
    debugLog(...args)
  }

  logTable(...args: any) {
    debugTable(...args)
  }

  add(token: string, balance: any, { skipChain = false } = {}) {
    token = token.replace(/\//g, ':')
    const isIBCToken = token.startsWith('ibc:')
    let chain: string | undefined = this.chain
    if (skipChain || isIBCToken) {
      chain = undefined
    }
    if (chain === 'injective' && token.startsWith('peggy0x')) {
      chain = 'ethereum'
      token = token.replace('peggy', '')
    }
    sumSingleBalance(this._balances, token, balance, chain)
  }

  addToken(token: string, balance: any, { skipChain = false } = {}) {
    this.add(token, balance, { skipChain })
  }

  addTokens(tokens: string[], balances: any[], { skipChain = false } = {}) {
    tokens.forEach((v, i) => this.add(v, balances[i], { skipChain }))
  }

  addBalances(balances: Balances) {
    if (balances === this._balances) return;
    Object.entries(balances).forEach(([token, balance]) => sumSingleBalance(this._balances, token, balance))
  }

  getBalances(): Balances {
    return this._balances
  }

  getChainId(): number | undefined {
    return this.chainId
  }

  removeTokenBalance(token: string) {
    const regex = new RegExp(token, 'i')
    Object.keys(this._balances).forEach((i: string) => {
      if (regex.test(i)) delete this._balances[i]
    })
  }

  async sumTokens({
    tokens = [],
    owners = [],
    owner,
    tokensAndOwners = [],
    tokensAndOwners2 = [],
    blacklistedTokens = [],
    blacklistedOwners = [],
    ownerTokens = [],
  }: {
    tokens?: string[],
    owner?: string,
    owners?: string[],
    tokensAndOwners?: string[][],
    tokensAndOwners2?: string[][],
    ownerTokens?: any[],
    blacklistedTokens?: string[],
    blacklistedOwners?: string[],
  }): Promise<Balances> {

    if (tokensAndOwners2.length)
      tokensAndOwners.push(...tokensAndOwners2[0].map((i: string, j: number) => [i, tokensAndOwners2[1][j]]))

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
}

export default ChainApi


function getUniqueTokensAndOwners(toa: string[][], chain?: string): string[][] {
  if (!toa.length) return []
  const mergedToa = toa.map(i => i.join('~'))
  const uniqueMerged = getUniqueAddresses(mergedToa, chain)
  return uniqueMerged.map(i => i.split('~'))
}