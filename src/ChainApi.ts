import { Block, CallOptions, MulticallOptions, FetchListOptions, Balances, } from "./types";
import { Chain, getProvider,  } from "./general";
import{ call, multiCall, fetchList } from './abi/abi2'
import{ getBlock } from './computeTVL/blocks'
import { ethers, } from "ethers";

import { debugLog, debugTable, } from "./util/debugLog";
import { sumSingleBalance } from "./generalUtil";

export class ChainApi {
  block?: Block;
  chain?: Chain | string;
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
  }

  call(params: CallOptions) {
    return call({
      ...params,
      block: this.block,
      chain: this.chain,
    })
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

  add(token: string, balance: any, { skipChain = false} = {}) {
    const chain = !skipChain ? this.chain : undefined
    sumSingleBalance(this._balances, token, balance, chain)
  }

  addTokens(tokens: string[], balances: any[], { skipChain = false} = {}) {
    tokens.forEach((v, i) => this.add(v, balances[i], { skipChain }))
  }

  addBalances(balances: Balances) {
    if (balances === this._balances) return;
    Object.entries(balances).forEach(([token, balance]) => sumSingleBalance(this._balances, token, balance))
  }

  getBalances(): Balances {
    return this._balances
  }
}

export default ChainApi