import axios from "axios";
import { ENV_CONSTANTS } from "./env";
import runInPromisePool from "./promisePool";

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

const coinsApiKey = ENV_CONSTANTS["COINS_API_KEY"];
const bodySize = 2; // 100;

function getBodies(readKeys: string[], timestamp: number | "now") {
  const bodies: string[] = [];
  for (let i = 0; i < readKeys.length; i += bodySize) {
    const body = {
      coins: readKeys.slice(i, i + bodySize),
    } as any;
    if (timestamp !== "now") body.timestamp = timestamp;
    bodies.push(JSON.stringify(body));
  }

  return bodies;
}

export async function getPrices(
  readKeys: string[],
  timestamp: number | "now"
): Promise<{ [address: string]: CoinsApiData }> {
  if (!readKeys.length) return {};

  const bodies = getBodies(readKeys, timestamp);
  const tokenData: CoinsApiData[][] = [];
  await runInPromisePool({
    items: bodies,
    concurrency: 10,
    processor: async (body: string) => {
      const res = await axios.post(
        `https://coins.llama.fi/prices?source=internal${
          coinsApiKey ? `?apikey=${coinsApiKey}` : ""
        }`,
        body,
        {
          headers: { "Content-Type": "application/json" },
        }
      );

      const data = (res.data.coins = Object.entries(res.data.coins).map(
        ([PK, value]) => ({
          ...(value as CoinsApiData),
          PK,
        })
      ));

      tokenData.push(data);
    },
  });

  const aggregatedRes: { [address: string]: CoinsApiData } = {};
  const normalizedReadKeys = readKeys.map((k: string) => k.toLowerCase());
  tokenData.map((batch: CoinsApiData[]) => {
    batch.map((a: CoinsApiData) => {
      if (!a.PK) return;
      const i = normalizedReadKeys.indexOf(a.PK.toLowerCase());
      aggregatedRes[readKeys[i]] = a;
    });
  });

  return aggregatedRes;
}

export async function getMcaps(
  readKeys: string[],
  timestamp: number | "now"
): Promise<{ [address: string]: McapsApiData }> {
  if (!readKeys.length) return {};

  const bodies = getBodies(readKeys, timestamp);
  const tokenData: {[key: string]: McapsApiData}[] = [];
  await runInPromisePool({
    items: bodies,
    concurrency: 10,
    processor: async (body: string) => {
      const res = await axios.post(
        `https://coins.llama.fi/mcaps${
          coinsApiKey ? `?apikey=${coinsApiKey}` : ""
        }`,
        body,
        {
          headers: { "Content-Type": "application/json" },
        }
      );
      tokenData.push(res.data as any);
    },
  });

  const aggregatedRes: { [address: string]: McapsApiData } = {};
  const normalizedReadKeys = readKeys.map((k: string) => k.toLowerCase());
  tokenData.map((batch: {[key: string]: McapsApiData}) => {
    Object.keys(batch).map((a: string) => {
      if (!batch[a].mcap) return;
      const i = normalizedReadKeys.indexOf(a.toLowerCase());
      aggregatedRes[readKeys[i]] = batch[a];
    });
  });

  return aggregatedRes;
}