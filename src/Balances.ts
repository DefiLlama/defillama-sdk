import { Balances as BalancesV1 } from "./types";
import { Chain, } from "./general";

import { sumSingleBalance, } from "./generalUtil";
import computeTVL from "./util/computeTVL";

const nullAddress = '0x0000000000000000000000000000000000000000'
export class Balances {
  chain: Chain | string;
  timestamp?: number;
  _balances: BalancesV1;

  constructor(params: {
    chain?: Chain | string;
    timestamp?: number;
  }) {
    this.chain = params.chain ?? 'ethereum'
    this.timestamp = params.timestamp
    this._balances = {}
  }

  _add(token: string, balance: any, { skipChain = false } = {}) {
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


  add(token: string | string[], balance: any, { skipChain = false } = {}) {
    if (!token) throw new Error('token is required')
    if (!balance) return;

    if (Array.isArray(balance)) {
      if (Array.isArray(token)) {
        this.addTokens(token, balance, { skipChain })
        return;
      } else if (typeof token === 'string') {
        balance.forEach((v) => this._add(token, v, { skipChain }))
        return;
      }
    }

    if (typeof token !== 'string') throw new Error('token must be a string')
    this._add(token, balance, { skipChain })
  }

  addToken(token: string, balance: any, { skipChain = false } = {}) {
    this._add(token, balance, { skipChain })
  }

  addGasToken(balance: any) {
    this._add(nullAddress, balance)
  }

  addCGToken(token: string, balance: any) {
    this.addTokenVannila('coingecko:' + token, balance)
  }

  addTokenVannila(token: string, balance: any) {
    this._add(token, balance, { skipChain: true })
  }

  addTokens(tokens: string[], balances: any[], { skipChain = false } = {}) {
    if (!Array.isArray(tokens)) throw new Error('tokens must be an array')
    if (!Array.isArray(balances)) throw new Error('balances must be an array')
    if (tokens.length !== balances.length) throw new Error('token and balance must have the same length')

    tokens.forEach((v, i) => this._add(v, balances[i], { skipChain }))
  }

  addBalances(balances: BalancesV1 | Balances) {
    if (balances instanceof Balances) {
      if (balances === this) return;
      balances = balances.getBalances()
    }
    if (balances === this._balances) return;
    Object.entries(balances).forEach(([token, balance]) => this._add(token, balance, { skipChain: true }))
  }

  getBalances(): BalancesV1 {
    return this._balances
  }

  removeTokenBalance(token: string) {
    const regex = new RegExp(token, 'i')
    Object.keys(this._balances).forEach((i: string) => {
      if (regex.test(i)) delete this._balances[i]
    })
  }

  async getUSDValue() {
    const { usdTvl } = await computeTVL(this.getBalances(), this.timestamp)
    return usdTvl
  }

  async getUSDString() {
    return Number(await this.getUSDValue()).toFixed(0)
  }

  async getUSDJSONs() {
    const { usdTvl, usdTokenBalances } = await computeTVL(this.getBalances(), this.timestamp)
    return { usdTvl, usdTokenBalances, rawTokenBalances: this.getBalances() }
  }

  resizeBy(ratio: number) {
    Object.keys(this._balances).forEach((token) => {
      this._balances[token] = Number(this._balances[token]) * ratio
    })
    return this
  }

  static async getUSDValue(balances: BalancesV1, timestamp?: number) {
    return (await computeTVL(balances, timestamp)).usdTvl
  }

  static async getUSDString(balances: BalancesV1, timestamp?: number) {
    return Number(await Balances.getUSDValue(balances, timestamp)).toFixed(0)
  }

  static async getBalanceObjects(balances: BalancesV1, timestamp?: number) {
    return computeTVL(balances, timestamp)
  }

  static async getUSDJSONs(balances: BalancesV1, timestamp?: number) {
    const { usdTvl, usdTokenBalances } = await computeTVL(balances, timestamp)
    return { usdTvl, usdTokenBalances, rawTokenBalances: balances }
  }

  clone(ratio = 1) {
    const newBalances = new Balances({ chain: this.chain, timestamp: this.timestamp })
    newBalances.addBalances(this)
    if (ratio !== 1) newBalances.resizeBy(ratio)
    return newBalances
  }

  subtract(balances: BalancesV1 | Balances) {
    if (balances instanceof Balances) {
      if (balances === this) return;
      balances = balances.getBalances()
    }
    Object.entries(balances).forEach(([token, balance]) => {
      this._add(token, Number(balance) * -1, { skipChain: true })
    })
  }

  subtractToken(token: string, balance: any, { skipChain = false } = {}) {
    this._add(token, Number(balance) * -1, { skipChain })
  }

  removeNegativeBalances() {
    Object.keys(this._balances).forEach((token) => {
      if (Number(this._balances[token]) <= 0) delete this._balances[token]
    })
  }
}

export default Balances
