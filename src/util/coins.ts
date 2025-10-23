import axios from "axios";
import { getEnvValue } from "./env";
import runInPromisePool from "./promisePool";
import { formError, sleepRandom } from "./common";
import { sliceIntoChunks } from ".";

type CoinsApiData = {
  decimals: number;
  price: number;
  symbol: string;
  timestamp: number;
  PK?: string;
};

type McapsApiData = {
  mcap: number;
  timestamp: number;
};

const coinsApiKey = getEnvValue("COINS_API_KEY")
const bodySize = 100;

function getBodies(readKeys: string[], timestamp: number | "now") {
  const chunks = sliceIntoChunks(readKeys, bodySize);
  return chunks.map(chunk => {
    const body: any = { coins: chunk };
    if (timestamp !== "now") body.timestamp = timestamp;
    return body;
  })
}


async function restCallWrapper(
  request: () => Promise<any>,
  retries: number = 3,
  name: string = "-"
) {

  retries--;

  try {
    const res = await request();
    return res;
  } catch (e: any) {
    if (retries <= 0)
      throw formError(e);
  }
  await sleepRandom(5_000 + 10_000, 5_000);
  return restCallWrapper(request, retries, name);
}

const priceCacheAll: { [timestamp: string]: { [PK: string]: any } } = {
  now: {
    "coingecko:tether": {
      price: 1,
      symbol: "USDT",
      timestamp: Math.floor(Date.now() / 1e3 + 3600), // an hour from script start time
    },
  }
};

const mcapCacheAll: { [timestamp: string]: { [PK: string]: any } } = {};

export async function getPrices(readKeys: string[], timestamp: number | "now"): Promise<{ [address: string]: CoinsApiData }> {
  return getPricesData(readKeys, timestamp, "price") as any
}

async function getPricesData(
  readKeys: string[],
  timestamp: number | "now",
  dataType: "price" | "mcap"
): Promise<any> {
  if (!readKeys.length) return {};
  const cacheAllObject = dataType === "price" ? priceCacheAll : mcapCacheAll
  const subRoute = dataType === "price" ? "prices" : "mcaps"

  const aggregatedRes: { [address: string]: any } = {};
  const timestampString = timestamp.toString()
  const priceCache = cacheAllObject[timestampString] || {};
  if (!cacheAllObject[timestampString]) cacheAllObject[timestampString] = priceCache

  // read data from cache where possible
  readKeys = readKeys.filter((PK: string) => {
    const pkNormalized = PK.toLowerCase()
    let pkData = priceCache[pkNormalized]
    if (pkData) {
      aggregatedRes[PK] = { ...pkData, PK };
      return false;
    }
    return true;
  });

  const bodies = getBodies(readKeys, timestamp);
  await runInPromisePool({
    items: bodies,
    concurrency: 10,
    processor: async (body: any,) => {
      if (!body.coins.length) return;
      const res = await restCallWrapper(() => axios.post(
        `https://coins.llama.fi/${subRoute}`, body, {
        headers: { "Content-Type": "application/json" },
        params: { source: "internal", apikey: coinsApiKey },
      }));
      const data = dataType === "price" ? res.data.coins : res.data

      Object.entries(data).forEach(([PK, value]) => {
        const pkNormalized = PK.toLowerCase()
        priceCache[pkNormalized] = value
      })

      body.coins.forEach((PK: any) => {
        const pkNormalized = PK.toLowerCase()
        const coinData = priceCache[pkNormalized]
        if (coinData) aggregatedRes[PK] = { ...coinData, PK }
      })
    },
  });

  return aggregatedRes;
}


export async function getMcaps(
  readKeys: string[],
  timestamp: number | "now"
): Promise<{ [address: string]: McapsApiData }> {
  return getPricesData(readKeys, timestamp, "mcap") as any
}
