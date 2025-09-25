import { Balances as BalancesV1 } from "./types";
import { Chain, } from "./general";

import { sumSingleBalance, tableToString, } from "./generalUtil";
import computeTVL from "./util/computeTVL";
import { humanizeNumber } from "./computeTVL/humanizeNumber";

const nullAddress = '0x0000000000000000000000000000000000000000'

type BalancesOptions = {
  skipChain?: boolean;
  label?: string;
}

type BalancesOptionsWithLabel = BalancesOptions | string


// the last parameter of add function can be either a string or an object with options (or both as last two parameters)
function getOptions({ optionsOrLabel = {}, options = {} }: { optionsOrLabel?: BalancesOptionsWithLabel; options?: BalancesOptions } = {}): BalancesOptions {
  let label: any

  if (optionsOrLabel) {
    if (typeof optionsOrLabel === 'string') {
      label = optionsOrLabel
    } else {
      options = optionsOrLabel as BalancesOptions
      label = options.label;
    }
  }

  return {
    ...options,
    skipChain: options?.skipChain ?? false,
    label,
  }
}

export class Balances {
  chain: Chain | string;
  timestamp?: number;
  _balances: BalancesV1;
  _breakdownBalances: { [key: string]: Balances };

  constructor(params: {
    chain?: Chain | string;
    timestamp?: number;
  }) {
    this.chain = params.chain ?? 'ethereum'
    this.timestamp = params.timestamp
    this._balances = {}
    this._breakdownBalances = {}
  }

  _add(token: string, balance: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    const { label, skipChain } = getOptions({ optionsOrLabel, options })
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

    // add a leading 0 to the token if it's a starknet token
    if (!skipChain && this.chain === 'starknet' && token.length === 65) {
      token = token.replace('0x', '0x0')
    }
    sumSingleBalance(this._balances, token, balance, chain)

    if (label) {
      this._breakdownBalances[label] = this._breakdownBalances[label] ?? new Balances({ chain: this.chain, timestamp: this.timestamp })
      this._breakdownBalances[label]._add(token, balance, { skipChain })
    }
  }


  add(token: string | string[] | Balances, balance?: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {

    if (token instanceof Balances) {
      if (typeof optionsOrLabel === 'string') throw new Error('When adding a Balances instance, optionsOrLabel must be an object with options, not a string')
      this.addBalances(token, balance as BalancesOptionsWithLabel, optionsOrLabel as BalancesOptions)
      return;
    }

    options = getOptions({ optionsOrLabel, options })

    if (!token) throw new Error('token is required')
    if (!balance) return;

    if (Array.isArray(balance)) {
      if (Array.isArray(token)) {
        this.addTokens(token, balance, options)
        return;
      } else if (typeof token === 'string') {
        balance.forEach((v) => this._add(token, v, options))
        return;
      }
    }

    if (typeof token !== 'string') throw new Error('token must be a string')
    this._add(token, balance, options)
  }

  addToken(token: string, balance: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    this._add(token, balance, options)
  }

  addGasToken(balance: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    this._add(nullAddress, balance, options)
  }

  addCGToken(token: string, balance: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    this.addTokenVannila('coingecko:' + token, balance, options)
  }

  addTokenVannila(token: string, balance: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    this._add(token, balance, { ...options, skipChain: true })
  }

  addUSDValue(balance: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    this.addCGToken('tether', balance, { ...options, skipChain: true })
  }

  addTokens(tokens: string[], balances: any[], optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    if (!Array.isArray(tokens)) throw new Error('tokens must be an array')
    if (!Array.isArray(balances)) throw new Error('balances must be an array')
    if (tokens.length !== balances.length) throw new Error('token and balance must have the same length')

    tokens.forEach((v, i) => this._add(v, balances[i], options))
  }

  addBalances(balances: BalancesV1 | Balances, optionsOrLabel?: BalancesOptionsWithLabel, options?: (BalancesOptions & { skipBreakdown?: boolean })) {
    options = getOptions({ optionsOrLabel, options })
    if (balances instanceof Balances) {
      if (balances === this) return;


      // if balances object has breakdown by label, and overall label is not set, we copy existing breakdown balances into this instance
      if (balances.hasBreakdownBalances() && !options.skipBreakdown && !options.label) {
        this._breakdownBalances = this._breakdownBalances ?? {}
        const { label, ...restOptions } = options
        Object.entries(balances.getBreakdownBalances()).forEach(([label, breakdown]) => {
          this._breakdownBalances[label] = this._breakdownBalances[label] ?? new Balances({ chain: this.chain, timestamp: this.timestamp })
          this._breakdownBalances[label].addBalances(breakdown, restOptions)
        })
      }

      balances = balances.getBalances()

    }
    if (balances === this._balances) return;
    Object.entries(balances).forEach(([token, balance]) => this._add(token, balance, { ...options, skipChain: true }))
  }

  getBalances(): BalancesV1 {
    return this._balances
  }

  removeTokenBalance(token: string) {
    const regex = new RegExp(token, 'i')
    Object.keys(this._balances).forEach((i: string) => {
      if (regex.test(i)) delete this._balances[i]
    })

    this._breakdownBalancesAction('removeTokenBalance', [token])
  }

  async getUSDValue() {
    const { usdTvl } = await computeTVL(this.getBalances(), this.timestamp)
    return usdTvl
  }

  async getUSDString() {
    return Number(await this.getUSDValue()).toFixed(0)
  }

  async getUSDJSONs({ debug = false, debugOptions: {
    printTokenTable = true,
    minTokenUSDValue
  } = {} }: {
    debug?: boolean, debugOptions?: {
      printTokenTable?: boolean
      minTokenUSDValue?: number
    }
  } = {}): Promise<{
    usdTvl: number;
    usdTokenBalances: BalancesV1;
    rawTokenBalances: BalancesV1;
    labelBreakdown?: { [key: string]: number };
    debugData?: { tokenData: { balance: string | number, price: number, decimals: number, value: number, confidence: number, token: string, symbol: string }[] }
  }> {
    const { usdTvl, usdTokenBalances, debugData } = await computeTVL(this.getBalances(), this.timestamp, { debug })
    const response = { usdTvl, usdTokenBalances, rawTokenBalances: this.getBalances(), labelBreakdown: {} }

    if (debug) {
      (response as any).debugData = debugData
      if (!minTokenUSDValue && minTokenUSDValue !== 0) {
        minTokenUSDValue = usdTvl / 100 // default to 1% of total TVL
      }
      let tokenData = (debugData as any).tokenData

      // filter out tokens with value less than minTokenUSDValue
      if (minTokenUSDValue) tokenData = tokenData.filter((i: any) => +i.value >= minTokenUSDValue!)

      tokenData.sort((a: any, b: any) => b.value - a.value)  // sort descending by value

      if (printTokenTable) {
        const dataClone = tokenData.map((i: any) => ({ ...i, value: humanizeNumber(i.value), }))
        console.log(tableToString(dataClone))
      }


      // add a humanized value field so it's easier to read big numbers
      tokenData.forEach((i: any) => {
        i.valueHN = humanizeNumber(i.value)  
      })

      debugData.tokenData = tokenData
    }

    if (!this.hasBreakdownBalances()) return response

    for (const [label, breakdown] of Object.entries(this.getBreakdownBalances())) {
      const breakdownUSD = await breakdown.getUSDValue();
      (response as any).labelBreakdown[label] = breakdownUSD
    }

    return response
  }

  resizeBy(ratio: number) {
    Object.keys(this._balances).forEach((token) => {
      this._balances[token] = Number(this._balances[token]) * ratio
    })

    this._breakdownBalancesAction('resizeBy', [ratio])
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

  clone(ratio = 1, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    const newBalances = new Balances({ chain: this.chain, timestamp: this.timestamp })
    newBalances.addBalances(this, options)
    if (ratio !== 1) newBalances.resizeBy(ratio)
    return newBalances
  }

  subtract(balances: BalancesV1 | Balances, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    if (balances instanceof Balances) {
      if (balances === this) return;
      balances = balances.getBalances()
    }
    Object.entries(balances).forEach(([token, balance]) => {
      this._add(token, Number(balance) * -1, { skipChain: true, label: options!.label })
    })
  }

  subtractToken(token: string, balance: any, optionsOrLabel?: BalancesOptionsWithLabel, options?: BalancesOptions) {
    options = getOptions({ optionsOrLabel, options })
    this._add(token, Number(balance) * -1, options)
  }

  removeNegativeBalances() {
    Object.keys(this._balances).forEach((token) => {
      if (Number(this._balances[token]) <= 0) delete this._balances[token]
    })

    if (this._breakdownBalances) {
      Object.values(this._breakdownBalances).forEach((breakdown: Balances) => breakdown.removeNegativeBalances())
    }
  }

  async _breakdownBalancesAction(action: string, args: any[] = []) {

    if (!this._breakdownBalances)
      return {};

    const response: { [key: string]: any } = {}
    const entries = Object.entries(this._breakdownBalances)
    for (const [label, breakdown] of entries) {
      if (typeof (breakdown as any)[action] === 'function') {
        response[label] = (breakdown as any)[action](...args)
        if (response[label] instanceof Promise) {
          response[label] = await response[label];
        }
      }
    }

    return response
  }

  hasBreakdownBalances() {
    return Object.keys(this._breakdownBalances).length > 0 && Object.values(this._breakdownBalances).some(b => !b.isEmpty())
  }

  isEmpty() {
    return Object.keys(this._balances).length === 0
  }

  getBreakdownBalances() {
    return this._breakdownBalances;
  }
}

export default Balances
