import { getProvider, Chain } from "../general";
import fetch from "node-fetch";
import rawTokenList from "./tokenList";
import type { Address } from "../types";
import { utils } from "ethers";
import type { Log, Block } from "@ethersproject/abstract-provider";
import { symbol, decimals } from "../erc20";

export async function lookupBlock(
  timestamp: number,
  extraParams: {
    chain?: Chain;
  } = {}
) {
  const provider = getProvider(extraParams.chain);
  const lastBlock = await provider.getBlock("latest");
  if (Math.abs(lastBlock.timestamp - timestamp) < 60) {
    // Short-circuit in case we are trying to get the current block
    return {
      block: lastBlock.number,
      timestamp: lastBlock.timestamp,
    };
  }
  let high = lastBlock.number;
  let low = 0;
  let block: Block;
  do {
    const mid = Math.floor((high + low) / 2);
    block = await provider.getBlock(mid);
    if (block.timestamp < timestamp) {
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  } while (high - low > 4); // We lose some precision (~4 blocks) but reduce #calls needed
  return {
    block: block.number,
    timestamp: block.timestamp,
  };
}

// TODO: Pull the data from somewhere like coingecko
export async function tokenList() {
  return rawTokenList;
}

export async function kyberTokens() {
  const pairs = await fetch(
    `https://api.kyber.network/api/tokens/pairs`
  ).then((res) => res.json());
  const tokens = Object.keys(pairs).reduce(
    (acc, pairName) => {
      const pair = pairs[pairName];
      acc[pair.contractAddress] = {
        symbol: pair.symbol,
        decimals: pair.decimals,
        ethPrice: pair.currentPrice,
      };
      return acc;
    },
    {} as {
      [address: string]: {
        symbol: string;
        decimals: number;
        ethPrice: number;
      };
    }
  );
  return {
    output: tokens,
  };
}

export async function toSymbols(tokenBalances: { [address: string]: string }) {
  const tokens = await tokenList();
  const output = Object.entries(tokenBalances).map(async ([token, balance]) => {
    let tokenData = tokens.find(
      (possibleToken) =>
        possibleToken.contract.toLowerCase() === token.toLowerCase()
    );
    if (token.toLowerCase() === "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee") {
      tokenData = {
        symbol: "ETH",
        contract: "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
        decimals: "18",
      };
    }
    if (tokenData === undefined) {
      try {
        const tokenSymbol = symbol(token);
        const tokenDecimals = decimals(token);
        tokenData = {
          decimals: (await tokenDecimals).output,
          contract: token.toLowerCase(),
          symbol: (await tokenSymbol).output,
        };
      } catch (e) {
        throw new Error(`Failed to get token data for token at ${token}`);
      }
    }
    const decimalBalance = (
      Number(balance) /
      10 ** Number(tokenData?.decimals ?? (await decimals(token)).output)
    ).toFixed(6);
    return {
      symbol: tokenData.symbol,
      address: tokenData.contract,
      balance: decimalBalance,
    };
  });
  return {
    output: await Promise.all(output),
  };
}

// SMALL INCOMPATIBILITY: On the old API we don't return ids but we should
export async function getLogs(params: {
  target: Address;
  topic: string;
  keys: string[]; // This is just used to select only part of the logs
  fromBlock: number;
  toBlock: number; // DefiPulse's implementation is buggy and doesn't take this into account
  topics?: string[]; // This is an outdated part of DefiPulse's API which is still used in some old adapters
  chain?: Chain;
}) {
  const filter = {
    address: params.target,
    topics: params.topics ?? [utils.id(params.topic)],
    fromBlock: params.fromBlock,
    toBlock: params.toBlock, // We don't replicate Defipulse's bug because the results end up being the same anyway and hopefully they'll eventually fix it
  };
  let logs: Log[] = [];
  let blockSpread = params.toBlock - params.fromBlock;
  let currentBlock = params.fromBlock;
  while (currentBlock < params.toBlock) {
    const nextBlock = Math.min(params.toBlock, currentBlock + blockSpread);
    try {
      const partLogs = await getProvider(params.chain).getLogs({
        ...filter,
        fromBlock: currentBlock,
        toBlock: nextBlock,
      });
      logs = logs.concat(partLogs);
      currentBlock = nextBlock;
    } catch (e) {
      if (blockSpread >= 2e3) {
        // We got too many results
        // We could chop it up into 2K block spreads as that is guaranteed to always return but then we'll have to make a lot of queries (easily >1000), so instead we'll keep dividing the block spread by two until we make it
        blockSpread = Math.floor(blockSpread / 2);
      } else {
        throw e;
      }
    }
  }
  if (params.keys.length > 0) {
    if (params.keys[0] !== "topics") {
      throw new Error("Unsupported");
    }
    return {
      output: logs.map((log) => log.topics),
    };
  }
  return {
    output: logs,
  };
}
