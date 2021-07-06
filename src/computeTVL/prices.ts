import fetch from "node-fetch";

function fetchJson(url: string) {
  return fetch(url).then((res) => res.json());
}

export interface TokenPrices {
  [token: string]:
    | {
        usd: number;
      }
    | undefined;
}

export type GetCoingeckoLog = () => Promise<any>;

export async function makeCoingeckoCall(
  url: string,
  coingeckoMaxRetries: number,
  getCoingeckoLock: GetCoingeckoLog
) {
  for (let j = 0; j < coingeckoMaxRetries; j++) {
    try {
      await getCoingeckoLock();
      const values = await fetchJson(url);
      return values;
    } catch (e) {
      if (j >= coingeckoMaxRetries - 1) {
        throw e;
      }
    }
  }
}

export async function getTokenPrices(
  originalIds: string[],
  url: string,
  knownTokenPrices: TokenPrices,
  getCoingeckoLock: GetCoingeckoLog,
  coingeckoMaxRetries: number,
  prefix: string = ""
): Promise<TokenPrices> {
  const tokenPrices = {} as TokenPrices;
  const newIds = originalIds.slice(); // Copy
  for (let i = 0; i < newIds.length; i++) {
    const knownPrice = knownTokenPrices[prefix + newIds[i]];
    if (knownPrice !== undefined) {
      tokenPrices[newIds[i]] = knownPrice;
      newIds.splice(i, 1);
      i--;
    }
  }
  // The url can only contain up to 100 addresses (otherwise we'll get 'URI too large' errors)
  for (let i = 0; i < newIds.length; i += 100) {
    const tempTokenPrices = await makeCoingeckoCall(
      `https://api.coingecko.com/api/${url}=${newIds
        .slice(i, i + 100)
        .join(",")}&vs_currencies=usd`,
      coingeckoMaxRetries,
      getCoingeckoLock
    );
    Object.assign(tokenPrices, tempTokenPrices);
    Object.entries(tempTokenPrices).forEach((tokenPrice) => {
      knownTokenPrices[prefix + tokenPrice[0]] = tokenPrice[1] as any;
    });
  }
  return tokenPrices;
}

const secondsPerHalfDay = Math.round((24 * 3600) / 2);
export async function getHistoricalTokenPrices(
  ids: string[],
  url: string,
  timestamp: number,
  getCoingeckoLock: GetCoingeckoLog,
  coingeckoMaxRetries: number
): Promise<TokenPrices> {
  const tokenPrices = {} as TokenPrices;
  for (const id of ids) {
    const range = await makeCoingeckoCall(
      `${url}/${id}/market_chart/range?vs_currency=usd&from=${
        timestamp - secondsPerHalfDay
      }&to=${timestamp + secondsPerHalfDay}`,
      coingeckoMaxRetries,
      getCoingeckoLock
    );
    if (range.error === undefined && range.prices?.length > 0) {
      let closest = range.prices[0];
      for (const price of range.prices) {
        if (Math.abs(price[0] - timestamp) < Math.abs(closest[0] - timestamp)) {
          closest = price;
        }
      }
      tokenPrices[id.toLowerCase()] = {
        usd: closest[1],
      };
    } else {
      tokenPrices[id.toLowerCase()] = undefined;
    }
  }
  return tokenPrices;
}
