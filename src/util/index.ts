import { getProvider, Chain } from "../general";
import fetch from "node-fetch";
import type { Address } from "../types";
import { utils, BigNumber, } from "ethers";
import type { Log } from "@ethersproject/abstract-provider";
import { sumSingleBalance } from "../generalUtil";

interface TimestampBlock {
  number: number;
  timestamp: number;
}

const kavaBlockProvider = {
  getBlock: async (height: number | "latest"): Promise<TimestampBlock> =>
    fetch(`https://api.data.kava.io/blocks/${height}`)
      .then((res) => res.json())
      .then((block: any) => ({
        number: Number(block.block.header.height),
        timestamp: Math.round(Date.parse(block.block.header.time) / 1000)
      }))
};

const terraBlockProvider = {
  getBlock: async (height: number | "latest"): Promise<TimestampBlock> =>
    fetch(`https://lcd.terra.dev/blocks/${height}`)
      .then((res) => res.json())
      .then((block: any) => ({
        number: Number(block.block.header.height),
        timestamp: Math.round(Date.parse(block.block.header.time) / 1000),
        
      }))
};

const algorandBlockProvider = {
  getBlock: async (height: number | "latest"): Promise<TimestampBlock> => {
    if (height !== 'latest')
      return fetch(`https://algoindexer.algoexplorerapi.io/v2/blocks/${height}`)
        .then((res) => res.json())
        .then((block: any) => ({
          number: block.round,
          timestamp: block.timestamp
        }))
    return fetch('https://algoindexer.algoexplorerapi.io/health')
      .then((res) => res.json())
      .then((block: any) => algorandBlockProvider.getBlock(block.round))
  }
};

async function getBlock(
  provider: typeof terraBlockProvider,
  height: number | "latest",
  chain: string | undefined
) {
  const block = await provider.getBlock(height);
  if (block === null) {
    throw new Error(`Can't get block of chain ${chain ?? "ethereum"}`);
  }
  return block;
}

function getExtraProvider(chain: string | undefined) {
  if (chain === "terra") {
    return terraBlockProvider;
  } else if (chain === "kava") {
    return kavaBlockProvider;
  } else if (chain === "algorand") {
    return algorandBlockProvider;
  }
  return getProvider(chain as any);
}

export async function getLatestBlock(chain: string) {
  const provider = getExtraProvider(chain);
  return getBlock(provider, "latest", chain);
}

const intialBlocks = {
  terra: 4724001,
  crab: 4969901
} as {
  [chain: string]: number | undefined;
};

export async function lookupBlock(
  timestamp: number,
  extraParams: {
    chain?: Chain | "terra" | "kava" | "algorand";
  } = {}
) {
  const chain = extraParams?.chain?? "ethereum"
  let low = intialBlocks[chain] ?? 100;
  let lowBlock: TimestampBlock, highBlock: TimestampBlock
  try {
    const provider = getExtraProvider(chain);
    const [lastBlock, firstBlock] = await Promise.all([
      getBlock(provider, "latest", chain),
      getBlock(provider, low, chain),
    ]);
    lowBlock = firstBlock
    highBlock = lastBlock
    if (
      lastBlock.timestamp - timestamp < -30 * 60
    ) {
      throw new Error(
        `Last block of chain "${chain
        }" is further than 30 minutes into the past. Provider is "${(provider as any)?.connection?.url
        }"`
      );
    }
    if (Math.abs(lastBlock.timestamp - timestamp) < 60) {
      // Short-circuit in case we are trying to get the current block
      return {
        block: lastBlock.number,
        timestamp: lastBlock.timestamp
      };
    }
    let block: TimestampBlock;
    let i = 0
    let time = Date.now()
    let allowedTimeRange = 15 * 60 // how much imprecision is allowed (15 minutes now)
    let acceptableBlockImprecision = chain === 'ethereum' ? 20 : 200 
    let blockImprecision
    let imprecision
    const getPrecision = (block: TimestampBlock) => block.timestamp -timestamp > 0 ? block.timestamp -timestamp : timestamp - block.timestamp
    do {
      ++i
      const blockDiff = highBlock.number - lowBlock.number
      const timeDiff = highBlock.timestamp - lowBlock.timestamp
      const avgBlockTime = timeDiff / blockDiff
      const closeBlock = Math.floor(lowBlock.number + (timestamp - lowBlock.timestamp)/avgBlockTime);
      const midBlock = Math.floor((lowBlock.number + highBlock.number)/2)
      const blocks = await Promise.all([
        getBlock(provider, closeBlock, chain),
        getBlock(provider, midBlock, chain),
      ])
      blocks.push(highBlock, lowBlock)
      blocks.sort((a, b) => getPrecision(a) - getPrecision(b))
      block = blocks[0]
      // find the closest upper and lower bound between 4 points
      lowBlock = blocks.filter(i => i.timestamp < timestamp).reduce((lowestBlock, block) => (timestamp - lowestBlock.timestamp) < (timestamp - block.timestamp) ? lowestBlock : block)
      highBlock = blocks.filter(i => i.timestamp > timestamp).reduce((highestBlock, block) => (highestBlock.timestamp - timestamp) < (block.timestamp - timestamp) ? highestBlock : block)
      imprecision = getPrecision(block)
      blockImprecision = highBlock.number - lowBlock.number
      // console.log(`chain: ${chain} block: ${block.number} #calls: ${i} imprecision: ${Number((imprecision)/60).toFixed(2)} (min) block diff: ${blockImprecision} Time Taken: ${Number((Date.now()-time)/1000).toFixed(2)} (in sec)`)
    } while (imprecision > allowedTimeRange  && blockImprecision > acceptableBlockImprecision); // We lose some precision (max ~15 minutes) but reduce #calls needed
    if (process.env.LLAMA_DEBUG_MODE)
      console.log(`chain: ${chain} block: ${block.number} #calls: ${i} imprecision: ${Number((imprecision)/60).toFixed(2)} (min) Time Taken: ${Number((Date.now()-time)/1000).toFixed(2)} (in sec)`)
    if (
      chain !== "bsc" && // this check is there because bsc halted the chain for few days
      Math.abs(block.timestamp - timestamp) > 3600
    ) {
      throw new Error(
        "Block selected is more than 1 hour away from the requested timestamp"
      );
    }
    return {
      block: block.number,
      timestamp: block.timestamp
    };
  } catch (e) {
    console.log(e);
    throw new Error(
      `Couldn't find block height for chain ${chain}, RPC node rugged`
    );
  }
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
  if (params.toBlock === undefined || params.fromBlock === undefined) {
    throw new Error(
      "toBlock and fromBlock need to be defined in all calls to getLogs"
    );
  }
  const filter = {
    address: params.target,
    topics: params.topics ?? [utils.id(params.topic)],
    fromBlock: params.fromBlock,
    toBlock: params.toBlock // We don't replicate Defipulse's bug because the results end up being the same anyway and hopefully they'll eventually fix it
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
        toBlock: nextBlock
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
      output: logs.map((log) => log.topics)
    };
  }
  return {
    output: logs
  };
}
export function normalizeAddress(address: string): string {
  // sol amd tezos case sensitive so no normalising
  const prefix = address.substring(0, address.indexOf(":"));
  if (["solana", "tezos"].includes(prefix)) return address;
  return address.toLowerCase();
}
export function normalizePrefixes(address: string): string {
  const prefix = address.substring(0, address.indexOf(":"));
  if (["solana", "tezos"].includes(prefix)) return address;
  return address.startsWith("0x")
    ? `ethereum:${address.toLowerCase()}`
    : !address.includes(":")
      ? `coingecko:${address.toLowerCase()}`
      : address.toLowerCase();
}

const ethereumAddress = "ethereum:0x0000000000000000000000000000000000000000";
const weth = "ethereum:0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2";
export function normalizeBalances(balances: { [address: string]: string }) {
  Object.keys(balances).map((key) => {
    if (+balances[key] === 0) {
      delete balances[key];
      return;
    }

    const normalisedKey = normalizePrefixes(key);
    if (normalisedKey == key) return;

    sumSingleBalance(balances, normalisedKey, balances[key]);
    delete balances[key];
  });

  const eth = balances[ethereumAddress];
  if (eth !== undefined) {
    balances[weth] = BigNumber.from(balances[weth] ?? 0).add(eth).toString();
    delete balances[ethereumAddress];
  }

  return balances;
}
