import { getProvider, Chain } from "../general";
import fetch from "node-fetch";
import type { Address } from "../types";
import { utils } from "ethers";
import type { Log } from "@ethersproject/abstract-provider";

interface TimestampBlock {
  number: number;
  timestamp: number;
}

const kavaBlockProvider = {
  getBlock: async (height: number | "latest") =>
    fetch(`https://api.data.kava.io/blocks/${height}`)
      .then((res) => res.json())
      .then((block) => ({
        number: Number(block.block.header.height),
        timestamp: Math.round(Date.parse(block.block.header.time) / 1000),
      })),
};

const terraBlockProvider = {
  getBlock: async (height: number | "latest") =>
    fetch(`https://lcd.terra.dev/blocks/${height}`)
      .then((res) => res.json())
      .then((block) => ({
        number: Number(block.block.header.height),
        timestamp: Math.round(Date.parse(block.block.header.time) / 1000),
      })),
};

async function getBlock(provider: typeof terraBlockProvider, height: number | "latest", chain:string|undefined){
  const block = await provider.getBlock(height)
  if(block === null){
    throw new Error(`Can't get block of chain ${chain ?? 'ethereum'}`)
  }
  return block
}

function getExtraProvider(chain:string|undefined){
  if(chain === "terra"){
    return terraBlockProvider
  } else if(chain === "kava"){
    return kavaBlockProvider
  }
  return getProvider(chain as any);
}

export async function getLatestBlock(chain:string){
  const provider = getExtraProvider(chain)
  return getBlock(provider, "latest", chain);
}

const intialBlocks = {
  terra: 4724001,
  crab: 4969901
} as {
  [chain: string]:number|undefined
}

export async function lookupBlock(
  timestamp: number,
  extraParams: {
    chain?: Chain | "terra" | "kava";
  } = {}
) {
  try {
    const provider = getExtraProvider(extraParams.chain)
    const lastBlock = await getBlock(provider, "latest", extraParams.chain);
    if (Math.abs(lastBlock.timestamp - timestamp) < 60) {
      // Short-circuit in case we are trying to get the current block
      return {
        block: lastBlock.number,
        timestamp: lastBlock.timestamp,
      };
    }
    let high = lastBlock.number;
    let low = intialBlocks[extraParams?.chain ?? "ethereum"] ?? 0;
    let block: TimestampBlock;
    do {
      const mid = Math.floor((high + low) / 2);
      block = await getBlock(provider, mid, extraParams.chain);
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
  } catch (e) {
    console.log(e)
    throw new Error(`Couldn't find block height for chain ${extraParams.chain ?? 'ethereum'}, RPC node rugged`)
  }
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
  if(params.toBlock === undefined || params.fromBlock === undefined){
    throw new Error("toBlock and fromBlock need to be defined in all calls to getLogs")
  }
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
