import { StringNumber, Address } from "../types";
import { multiCall } from "../abi";
import fetch from "node-fetch";
import { humanizeNumber } from "./humanizeNumber";

type Balances = {
  [tokenAddressOrName: string]: StringNumber | Object;
};

function fetchJson(url: string) {
  return fetch(url).then((res) => res.json());
}

function tokenMulticall(addresses: Address[], abi: string, chain?: "bsc") {
  return multiCall({
    abi,
    calls: addresses.map((address) => ({
      target: address,
      params: [],
    })),
    chain,
  }).then((res) => res.output.filter((call) => call.success));
}

interface TokenPrices {
  [token: string]:
    | {
        usd: number;
      }
    | undefined;
}

type GetCoingeckoLog = () => Promise<any>;
const coingeckoMaxRetries = 3;

async function getTokenPrices(
  originalIds: string[],
  url: string,
  knownTokenPrices: TokenPrices,
  getCoingeckoLock: GetCoingeckoLog,
  prefix: string = ""
): Promise<TokenPrices> {
  let tokenPrices = {} as TokenPrices;
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
    let tempTokenPrices: any;
    for (let j = 0; j < coingeckoMaxRetries; j++) {
      try {
        await getCoingeckoLock();
        tempTokenPrices = await fetchJson(
          `https://api.coingecko.com/api/${url}=${newIds
            .slice(i, i + 100)
            .join(",")}&vs_currencies=usd`
        );
        break;
      } catch (e) {
        if (j >= coingeckoMaxRetries - 1) {
          throw e;
        } else {
          continue;
        }
      }
    }
    Object.assign(tokenPrices, tempTokenPrices);
    Object.entries(tempTokenPrices).forEach((tokenPrice) => {
      knownTokenPrices[prefix + tokenPrice[0]] = tokenPrice[1] as any;
    });
  }
  return tokenPrices;
}

export default async function (
  rawBalances: Balances,
  timestamp: number | "now",
  verbose: boolean = false,
  knownTokenPrices: TokenPrices = {},
  getCoingeckoLock: GetCoingeckoLog = () => Promise.resolve()
) {
  let balances: Balances;
  if (rawBalances instanceof Array) {
    // Handle the cases where balances are returned in toSymbol format
    const callTokenDecimals = (
      await multiCall({
        abi: "erc20:decimals",
        calls: rawBalances.map((token) => ({
          target: token.address,
          params: [],
        })),
      })
    ).output;
    balances = rawBalances.reduce((acc, token, index) => {
      let dec: number;
      if (callTokenDecimals[index].success) {
        dec = Number(callTokenDecimals[index].output);
      } else {
        if (token.address === "0x0000000000000000000000000000000000000000") {
          dec = 18;
        } else {
          dec = NaN;
        }
      }
      acc[token.address] = (Number(token.balance) * 10 ** dec).toString();
      return acc;
    }, {});
  } else {
    balances = rawBalances;
  }
  const normalizedBalances = {} as Balances;
  const ethereumAddresses = [] as Address[];
  const bscAddresses = [] as Address[];
  const nonEthereumTokenIds = [] as string[];
  for (const tokenAddressOrName of Object.keys(balances)) {
    let normalizedAddressOrName = tokenAddressOrName;
    let normalizedBalance = balances[tokenAddressOrName];
    if (tokenAddressOrName === "0x0000000000000000000000000000000000000000") {
      normalizedAddressOrName = "ethereum"; // Normalize ETH
      normalizedBalance = Number(normalizedBalance) / 10 ** 18;
    }
    if (typeof normalizedBalance === "object") {
      normalizedBalances[
        normalizedAddressOrName
      ] = (normalizedBalance as any).toFixed(); // Some adapters return a BigNumber from bignumber.js so the results must be normalized
    } else {
      normalizedBalances[normalizedAddressOrName] = normalizedBalance;
    }
    if (normalizedAddressOrName.startsWith("0x")) {
      ethereumAddresses.push(normalizedAddressOrName);
    } else if (normalizedAddressOrName.startsWith("bsc:")) {
      bscAddresses.push(normalizedAddressOrName.slice("bsc:".length));
    } else {
      nonEthereumTokenIds.push(normalizedAddressOrName);
    }
  }

  const allTokenDecimals = tokenMulticall(ethereumAddresses, "erc20:decimals");
  const allTokenSymbols = tokenMulticall(ethereumAddresses, "erc20:symbol");
  const bscTokenDecimals = tokenMulticall(
    bscAddresses,
    "erc20:decimals",
    "bsc"
  );
  const bscTokenSymbols = tokenMulticall(bscAddresses, "erc20:symbol", "bsc");
  let nonEthereumTokenPrices: TokenPrices;
  let ethereumTokenPrices: TokenPrices;
  let bscTokenPrices: TokenPrices;
  if (timestamp === "now") {
    nonEthereumTokenPrices = await getTokenPrices(
      nonEthereumTokenIds,
      "v3/simple/price?ids",
      knownTokenPrices,
      getCoingeckoLock
    );
    bscTokenPrices = await getTokenPrices(
      bscAddresses,
      "v3/simple/token_price/binance-smart-chain?contract_addresses",
      knownTokenPrices,
      getCoingeckoLock,
      "bsc:"
    );
    ethereumTokenPrices = await getTokenPrices(
      ethereumAddresses,
      "v3/simple/token_price/ethereum?contract_addresses",
      knownTokenPrices,
      getCoingeckoLock
    );
  } else {
    throw new Error("Historical rates are not currently supported");
  }
  const usdAmounts = Object.entries(normalizedBalances).map(
    async ([address, balance]) => {
      let amount: number, price: number | undefined, tokenSymbol: string;
      try {
        if (address.startsWith("0x") || address.startsWith("bsc:")) {
          let chainTokenPrices: typeof ethereumTokenPrices,
            chainTokenSymbols: typeof allTokenSymbols,
            chainTokenDecimals: typeof allTokenDecimals,
            normalizedAddress: Address;
          if (address.startsWith("bsc:")) {
            chainTokenPrices = bscTokenPrices;
            chainTokenSymbols = bscTokenSymbols;
            chainTokenDecimals = bscTokenDecimals;
            normalizedAddress = address.slice("bsc:".length);
          } else {
            chainTokenPrices = ethereumTokenPrices;
            chainTokenSymbols = allTokenSymbols;
            chainTokenDecimals = allTokenDecimals;
            normalizedAddress = address;
          }

          tokenSymbol = (await chainTokenSymbols).find(
            (call) => call.input.target === normalizedAddress
          )?.output;
          if (tokenSymbol === undefined) {
            tokenSymbol = `UNKNOWN (${address})`;
          }
          const tokenDecimals = (await chainTokenDecimals).find(
            (call) => call.input.target === normalizedAddress
          )?.output;
          if (tokenDecimals === undefined) {
            if (verbose) {
              console.warn(
                `Couldn't query decimals() for token ${tokenSymbol} (${address}) so we'll ignore and assume it's amount is 0`
              );
            }
            amount = 0;
          } else {
            amount = Number(balance) / 10 ** Number(tokenDecimals);
          }
          price = chainTokenPrices[normalizedAddress.toLowerCase()]?.usd;
        } else {
          tokenSymbol = address;
          price = nonEthereumTokenPrices[address.toLowerCase()]?.usd;
          amount = Number(balance);
        }
        if (price === undefined) {
          if (verbose) {
            console.log(
              `Couldn't find the price of token at ${address}, assuming a price of 0 for it...`
            );
          }
          price = 0;
        }
        const usdAmount = amount * price;
        return { usdAmount, tokenSymbol };
      } catch (e) {
        console.error(
          `Error on token ${address}, we'll just assume it's price is 0...`,
          e
        );
        return {
          usdAmount: 0,
          tokenSymbol: `ERROR ${address}`,
        };
      }
    }
  );
  return (await Promise.all(usdAmounts)).reduce((sum, token) => {
    if (verbose) {
      console.log(
        token.tokenSymbol.padEnd(25, " "),
        humanizeNumber(token.usdAmount)
      );
    }
    return sum + token.usdAmount;
  }, 0);
}
