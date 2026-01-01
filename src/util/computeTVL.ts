import { sumSingleBalance } from "../generalUtil";
import { Balances } from "../types";
import { getPrices } from "./coins";

type PricesObject = {
  // NOTE: the tokens queried might be case sensitive and can be in mixed case, but while storing them in the cache, we convert them to lowercase
  [key: string]: any
}

const currentPriceCache: PricesObject = {}

const priceCaches: {
  [timestamp: number]: PricesObject
} = {}

let lastPriceUpdate = 0;
const confidenceThreshold = 0.5
const priceUpdateTime = 1000 * 60 * 30 // 30 minutes

export default async function computeTVL(balances: Balances, timestamp?: number, {
  debug = false
}: {
  debug?: boolean
} = {}) {
  const usdTokenBalances: Balances = {}
  const debugData = {
    tokenData: [] as { balance: string | number, price: number, decimals: number, value: number, confidence: number, token: string, symbol: string }[]
  }

  let usdTvl = 0;
  const keys = Object.keys(balances)
    // .filter(i => +balances[i] > 0)
    .filter(i => +balances[i] !== 0)
    .map(tokenToKey)
  await updatePriceCache(keys, timestamp)
  const priceCache = getPriceCache(timestamp)
  Object.entries(balances).forEach(([token, balance]) => {
    // if (+balance <= 0) return;
    if (+balance === 0) return;
    if (!token || token.trim() === '') {
      return;
    }
    const key = tokenToKey(token).toLowerCase()
    let { price, confidence, decimals = 0, symbol = token } = priceCache[key] ?? {}
    if (!price || confidence < confidenceThreshold) return
    const value = +balance * price / (10 ** decimals)
    usdTvl += value
    
    if (symbol === 'ETH') symbol = 'WETH'
    if (!symbol  || symbol.trim() === '') symbol = '-'
    
    sumSingleBalance(usdTokenBalances, symbol, value)
    if (debug && !isNaN(+value)) debugData.tokenData.push({ symbol, value, token, price, confidence,  balance, decimals, })
  })

  return { usdTvl, usdTokenBalances, debugData, }
}

function tokenToKey(token: string) {
  if (token.startsWith("0x")) token = `ethereum:${token}`
  else if (!token.includes(':')) token = `coingecko:${token}`
  return token
}


async function updatePriceCache(keys: string[], timestamp?: number) {
  keys = getUnique(keys)
  const pricesCache = getPriceCache(timestamp)

  if (isNearlyNow(timestamp)) timestamp = undefined // if timestamp is close to now, pull current token prices

  if (!timestamp && lastPriceUpdate && +Date.now() > lastPriceUpdate + priceUpdateTime) {
    lastPriceUpdate = +Date.now()
    Object.keys(pricesCache).forEach(key => delete pricesCache[key]) // clear cache   
  }

  // hardcode cache for USDT
  pricesCache['coingecko:tether'] = {
    "price": 1,
    "symbol": "USDT",
    "confidence": 1
  }
  pricesCache['ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7'] = {
    "price": 1,
    "symbol": "USDT",
    "decimals": 6,
    "confidence": 1
  }

  const missingKeys = keys.filter(key => !pricesCache[key.toLowerCase()])

  const coins = await getPrices(missingKeys, timestamp ?? "now")
  for (const [token, data] of Object.entries(coins)) {
    pricesCache[token.toLowerCase()] = data
  }
  missingKeys.map(i => i.toLowerCase()).filter(i => !pricesCache[i]).forEach(i => pricesCache[i] = {})
}

function getPriceCache(timestamp?: number) {
  if (timestamp) timestamp = getClosestHourlyTimestamp(timestamp)
  if (timestamp && !priceCaches[timestamp]) priceCaches[timestamp] = {}
  return timestamp ? priceCaches[timestamp] : currentPriceCache
}


export function getUnique(addresses: string[]): string[] {
  const set = {} as { [address: string]: boolean }
  addresses.forEach(i => set[i] = true)
  return Object.keys(set)
}

function isNearlyNow(timestamp?: number) {
  if (!timestamp) return true
  return Math.abs(timestamp - +Date.now() / 1000) < 60 * 60
}

function getClosestHourlyTimestamp(timestamp: number) {
  return Math.floor(timestamp / 3600) * 3600
}
