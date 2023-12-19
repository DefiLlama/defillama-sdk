import { getProvider, Chain } from "../general";
import fetch from "node-fetch";
import type { Address } from "../types";
import { utils, BigNumber, } from "ethers";
import type { Log } from "@ethersproject/abstract-provider";
import { formError, sumSingleBalance } from "../generalUtil";
import { debugLog } from "./debugLog";
import runInPromisePoolOrig from "./promisePool";

export const runInPromisePool = runInPromisePoolOrig

export function sliceIntoChunks(arr: any[], chunkSize = 100) {
  const res = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.slice(i, i + chunkSize);
    res.push(chunk);
  }
  return res;
}

interface TimestampBlock {
  number: number;
  timestamp: number;
}

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

const blockscoutEndpoints: any = {
  celo: 'https://explorer.celo.org',
  kava: 'https://explorer.kava.io',
  onus: 'https://explorer.onuschain.io',
  base: 'https://base.blockscout.com',
  scroll: 'https://blockscout.scroll.io',
}

async function getBlockscoutBlock(timestamp: number, chain: string) {

  const api = `${blockscoutEndpoints[chain]}/api?module=block&action=getblocknobytime&timestamp=${timestamp}&closest=before`
  const res = await fetch(api)
  const data = await res.json()
  if (data.status !== '1')
    throw new Error(data.message)
  return {
    timestamp,
    block: +data.result.blockNumber
  }
}

const blockTimeCache: {
  [chain: string]: {
    [block: number]: TimestampBlock
  }
} = {}

export async function lookupBlock(
  timestamp: number,
  extraParams: {
    chain?: Chain | "terra" | "kava" | "algorand";
  } = {}
) {
  const chain = extraParams?.chain ?? "ethereum"

  if (blockscoutEndpoints[chain]) {
    try {
      const response = await getBlockscoutBlock(timestamp, chain)
      return response
    } catch (e) { // fallback to usual way of fetching logs
      debugLog('error fetching block from blockscout', e)
    }
  }

  if (chain === 'waves') {
    const api = `https://nodes.wavesnodes.com/blocks/heightByTimestamp/${timestamp}`
    const res = await fetch(api)
    const data = await res.json()
    return {
      timestamp,
      block: +data.height
    }
  }

  let low = intialBlocks[chain] ?? 100;
  let lowBlock: TimestampBlock = getLowBlock()
  let highBlock: TimestampBlock = getHighBlock()

  let block: TimestampBlock;
  let i = 0
  let time = Date.now()
  let allowedTimeRange = 15 * 60 // how much imprecision is allowed (15 minutes now)
  let acceptableBlockImprecision = chain === 'ethereum' ? 20 : 200
  let blockImprecision: number
  let imprecision: number

  try {
    let firstBlock, lastBlock
    const provider = getExtraProvider(chain);

    if (['evmos'].includes(chain)) {
      lastBlock = await getBlock(provider, "latest", chain)
      let firstBlockNum = lastBlock.number
      switch (chain) {
        default: firstBlockNum -= 2 * 1e5// evmos hold only the last 200k block data
      }
      firstBlock = await getBlock(provider, firstBlockNum, chain)
    } else {
      [lastBlock, firstBlock] = await Promise.all([
        getBlock(provider, "latest", chain),
        lowBlock ? lowBlock : getBlock(provider, low, chain),
      ])
    }

    lowBlock = firstBlock

    if (!highBlock)
      highBlock = lastBlock

    if (lastBlock.timestamp - timestamp < -30 * 60) {
      throw new Error(
        `Last block of chain "${chain
        }" is further than 30 minutes into the past. Provider is "${(provider as any)?.connection?.url
        }"`
      );
    }

    if (Math.abs(highBlock.timestamp - timestamp) < 60 * 30) {
      // Short-circuit in case we are trying to get the current block
      return {
        block: highBlock.number,
        timestamp: highBlock.timestamp
      };
    }


    updateBlock()

    while (imprecision! > allowedTimeRange && blockImprecision! > acceptableBlockImprecision) { // We lose some precision (max ~15 minutes) but reduce #calls needed 
      ++i
      const blockDiff = highBlock.number - lowBlock.number
      const timeDiff = highBlock.timestamp - lowBlock.timestamp
      const avgBlockTime = timeDiff / blockDiff
      let closeBlock = Math.floor(lowBlock.number + (timestamp - lowBlock.timestamp) / avgBlockTime);
      if (closeBlock > highBlock.number) closeBlock = highBlock.number
      const midBlock = Math.floor((lowBlock.number + highBlock.number) / 2)
      const blocks = await Promise.all([
        getBlock(provider, closeBlock, chain),
        getBlock(provider, midBlock, chain),
      ])
      updateBlock(blocks)
    }

    debugLog(`chain: ${chain} block: ${block!.number} #calls: ${i} imprecision: ${Number((imprecision!) / 60).toFixed(2)} (min) Time Taken: ${Number((Date.now() - time) / 1000).toFixed(2)} (in sec)`)


    if (
      chain !== "bsc" && // this check is there because bsc halted the chain for few days
      Math.abs(block!.timestamp - timestamp) > 3600
    ) {
      throw new Error(
        "Block selected is more than 1 hour away from the requested timestamp"
      );
    }


    return {
      block: block!.number,
      timestamp: block!.timestamp
    };

  } catch (e) {
    throw formError(e)
  }

  function updateBlock(blocks: TimestampBlock[] = []) {
    blocks.forEach(addBlockToCache)
    const getPrecision = (block: TimestampBlock) => block.timestamp - timestamp > 0 ? block.timestamp - timestamp : timestamp - block.timestamp

    blocks.push(highBlock, lowBlock)
    blocks.sort((a, b) => getPrecision(a) - getPrecision(b))
    block = blocks[0]
    // find the closest upper and lower bound between 4 points
    lowBlock = blocks.filter(i => i.timestamp < timestamp).reduce((lowestBlock, block) => (timestamp - lowestBlock.timestamp) < (timestamp - block.timestamp) ? lowestBlock : block)
    highBlock = blocks.filter(i => i.timestamp > timestamp).reduce((highestBlock, block) => (highestBlock.timestamp - timestamp) < (block.timestamp - timestamp) ? highestBlock : block)
    imprecision = getPrecision(block)
    blockImprecision = highBlock.number - lowBlock.number
    // debugLog(`chain: ${chain} block: ${block.number} #calls: ${i} imprecision: ${Number((imprecision)/60).toFixed(2)} (min) block diff: ${blockImprecision} Time Taken: ${Number((Date.now()-time)/1000).toFixed(2)} (in sec)`)
  }

  function getChainBlockTimeCache(chain: string) {
    if (!blockTimeCache[chain])
      blockTimeCache[chain] = {}

    return blockTimeCache[chain]
  }

  function addBlockToCache(block: TimestampBlock) {
    getChainBlockTimeCache(chain)[block.number] = block
  }

  function getLowBlock() {
    return Object.values(getChainBlockTimeCache(chain))
      .filter(i => i.timestamp < timestamp)
      .sort((a, b) => b.timestamp - a.timestamp)[0]
  }

  function getHighBlock() {
    return Object.values(getChainBlockTimeCache(chain))
      .filter(i => i.timestamp > timestamp)
      .sort((a, b) => a.timestamp - b.timestamp)[0]
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
      const partLogs = await getProvider(params.chain, true).getLogs({
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
export async function getTimestamp(height: number, chain: Chain) {
  const provider = getExtraProvider(chain);
  const block = await provider.getBlock(height)
  return block.timestamp
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
