import { sliceIntoChunks } from ".";
import { sumSingleBalance } from "../generalUtil";
import { Balances } from "../types";
import axios from "axios";

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

export default async function computeTVL(balances: Balances, timestamp?: number) {
  const usdTokenBalances: Balances = {}

  let usdTvl = 0;
  const keys = Object.keys(balances).filter(i => +balances[i] > 0).map(tokenToKey)
  await updatePriceCache(keys, timestamp)
  const priceCache = getPriceCache(timestamp)
  Object.entries(balances).forEach(([token, balance]) => {
    if (+balance <= 0) return;
    const key = tokenToKey(token).toLowerCase()
    let { price, confidence, decimals = 0, symbol = token } = priceCache[key] ?? {}
    if (!price || confidence < confidenceThreshold) return
    const value = +balance * price / (10 ** decimals)
    usdTvl += value
    if (symbol === 'ETH') symbol = 'WETH'
    sumSingleBalance(usdTokenBalances, symbol, value)
  })
  return { usdTvl, usdTokenBalances }
}

function tokenToKey(token: string) {
  if (token.startsWith("0x")) token = `ethereum:${token}`
  else if (!token.includes(':')) token = `coingecko:${token}`
  return token
}


async function updatePriceCache(keys: string[], timestamp?: number) {
  if (isNearlyNow(timestamp)) timestamp = undefined

  keys = getUnique(keys)
  const pricesCache = getPriceCache(timestamp)
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

  const chunks = sliceIntoChunks(missingKeys, 100)
  for (const chunk of chunks) {
    const coins = await getPrices(chunk)
    for (const [token, data] of Object.entries(coins)) {
      pricesCache[token.toLowerCase()] = data
    }
    chunk.map(i => i.toLowerCase()).filter(i => !pricesCache[i]).forEach(i => pricesCache[i] = {})
  }

  async function getPrices(keys: string[]) {
    if (!timestamp) {
      const { coins } = await axios(`https://coins.llama.fi/prices/current/${keys.join(',')}`).then((res) => res.data)
      return coins
    }

    // fetch post with timestamp in body
    const { coins } = await axios.post("https://coins.llama.fi/prices?source=internal",{ coins: keys, timestamp }).then((res) => res.data)
    return coins
  }

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