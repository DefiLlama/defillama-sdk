import { getProvider, Chain } from "../general";
import axios from "axios";
import { formError, getProviderUrl, } from "../generalUtil";
import { debugLog } from "./debugLog";
import { isCosmosChain, getCosmosProvider } from "./cosmos";
import { getTempLocalCache, ONE_WEEK } from "./cache";
import pLimit from 'p-limit';
import { getParallelGetBlocksLimit } from "./env";

const defaultChains = ["avax", "bsc", "polygon", "arbitrum"] as Chain[]
export const chainsForBlocks = defaultChains;
const blockRetries = 3;

export async function getChainBlocks(timestamp: number | undefined, chains: Chain[] = defaultChains) {
  const chainBlocks = {} as {
    [chain: string]: number;
  };
  const setBlock = async (chain: Chain) => chainBlocks[chain] = await getBlockNumber(chain, timestamp)
  await Promise.all(chains.map(setBlock));
  return chainBlocks;
}

export async function getBlocks(timestamp: number, chains: Chain[] | undefined = undefined) {
  chains = chains?.filter(i => i !== 'ethereum')
  const [ethBlock, chainBlocks] = await Promise.all([getBlockNumber('ethereum', timestamp), getChainBlocks(timestamp, chains)]);
  chainBlocks['ethereum'] = ethBlock;
  return {
    ethereumBlock: ethBlock,
    chainBlocks,
  };
}

export async function getCurrentBlocks(chains: Chain[] | undefined = undefined) {
  if (chains)
    chains = chains.filter(i => i !== "ethereum")

  const block = await getBlock('ethereum')
  const chainBlocks = await getChainBlocks(undefined, chains);
  chainBlocks['ethereum'] = block.block;
  return {
    timestamp: block.timestamp,
    ethereumBlock: block.block,
    chainBlocks,
  };
}

export async function getBlock(chain: Chain, timestamp?: number, options: LookupBlockOptionalParams = {}): Promise<Block> {
  if (!timestamp)
    return getCurrentChainBlock(chain)

  let error
  for (let i = 0; i < blockRetries; i++) {
    try {
      let res = await lookupBlock(timestamp!, { ...options, chain, })
      return res
    } catch (e) {
      error = e
    }
  }
  throw error
}

export async function getBlockNumber(chain: Chain, timestamp?: number): Promise<number> {
  return (await getBlock(chain, timestamp)).block
}

const refreshInterval = 1000 * 60 * 1; // 1 minute
export function getCurrentChainBlock(chain: Chain = 'ethereum'): Promise<Block> {
  const { timestamp, } = currentChainBlockCache[chain] || {}
  const currentTimestamp = Date.now()
  if (!timestamp || currentTimestamp - timestamp > refreshInterval) {
    currentChainBlockCache[chain] = {
      timestamp: currentTimestamp,
      promise: _getCurrentChainBlock()
    }
  }
  return currentChainBlockCache[chain].promise

  async function _getCurrentChainBlock() {
    try {
      const provider = getExtraProvider(chain);
      const { number, timestamp, } = await provider.getBlock('latest') as any
      const response = { block: number, timestamp, number }
      validateCurrentBlock(response, chain)
      currentChainBlockCache[chain] = { timestamp: currentTimestamp, promise: response }
      return response // we are interested only in these fields
    } catch (e) {
      delete currentChainBlockCache[chain]
      if ((e as any)?.message?.includes?.("Last block of chain")) throw e
      throw formError(e)
    }
  }
}


interface TimestampBlock {
  number: number;
  timestamp: number;
}

const algorandBlockProvider = {
  getBlock: async (height: number | "latest"): Promise<TimestampBlock> => {
    if (height !== 'latest')
      return axios(`https://algoindexer.algoexplorerapi.io/v2/blocks/${height}`)
        .then((res: any) => res.data)
        .then((block: any) => ({
          number: block.round,
          timestamp: block.timestamp
        }))
    return axios('https://algoindexer.algoexplorerapi.io/health')
      .then((res: any) => res.data)
      .then((block: any) => algorandBlockProvider.getBlock(block.round))
  }
};

async function fetchBlockFromProvider(
  height: number | "latest",
  chain: string | undefined
) {
  const provider = getExtraProvider(chain ?? "ethereum");
  const block = await provider.getBlock(height);
  if (block === null) {
    throw new Error(`Can't get block of chain ${chain ?? "ethereum"}`);
  }
  return block;
}

function getExtraProvider(chain = "ethereum") {
  if (isCosmosChain(chain))  // maybe check if it is also an evm chain?
    return getCosmosProvider(chain)
  if (chain === "algorand")
    return algorandBlockProvider;

  return getProvider(chain as any);
}

export const getLatestBlock = getCurrentChainBlock

const intialBlocks = {
  planq: 14000000,
  sei: 78353999,
  terra: 4724001,
  crab: 4969901
} as {
  [chain: string]: number | undefined;
};

type ChainBlockCache = {
  [chain: string]: {
    [block: number]: TimestampBlock
  }
}
let lastBlockCacheSave = Date.now()
const blockCacheSaveInterval = 1000 * 60 * 5; // 5 minutes 

const { data: blockTimeCache, saveCacheFile: saveBlockCacheFile }: { data: ChainBlockCache, saveCacheFile: Function } = getTempLocalCache({ file: 'BlockCache.json', defaultData: {}, clearAfter: ONE_WEEK, returnWithSaveFunction: true });

function validateCurrentBlock(block: Block, chain: Chain = 'ethereum') {
  const provider = getExtraProvider(chain);
  const now = Math.floor(Date.now() / 1000)
  const minutesDiff = Math.floor((now - block.timestamp) / 60)
  if (minutesDiff > 60)
    throw new Error(`Last block for ${chain} is ${minutesDiff} minutes behind (${new Date(block.timestamp * 1000)}). Provider is "${getProviderUrl(provider)}"`)
}

type LookupBlockOptionalParams = {
  chain?: Chain | "kava" | "algorand",
  allowedTimeRange?: number,
  acceptableBlockImprecision?: number,
}

const chainLimiters: any = {}

function getChainLimiter(chain: string) {
  if (!chainLimiters[chain]) chainLimiters[chain] = createLimiter(chain)
  return chainLimiters[chain]

  function createLimiter(chain: string) {
    return pLimit(getParallelGetBlocksLimit(chain))
  }
}

export async function lookupBlock(timestamp: number, extraParams?: LookupBlockOptionalParams): Promise<Block> {
  const { chain = "ethereum" } = extraParams ?? {};
  const limiter = getChainLimiter(chain)
  return limiter(() => _lookupBlock(timestamp, extraParams))
}

async function _lookupBlock(
  timestamp: number,
  extraParams?: LookupBlockOptionalParams
): Promise<Block> {
  const { allowedTimeRange = 5 * 60, acceptableBlockImprecision = 10 } = extraParams ?? {};
  const chain = extraParams?.chain ?? "ethereum"
  let time = Date.now()
  if (timestamp > time / 1000) {
    throw new Error(`Requesting for block in the future ${timestamp} is in the future, current time is ${Math.floor(time / 1000)}`);
  }

  if (chain === 'waves') {
    const api = `https://nodes.wavesnodes.com/blocks/heightByTimestamp/${timestamp}`
    const { data } = await axios(api)
    return {
      timestamp,
      block: +data.height,
      number: +data.height,
    }
  }

  let low = intialBlocks[chain] ?? 100;
  let envLowValue = process.env[`${chain.toUpperCase()}_BLOCK_LOW`]
  if (envLowValue)
    low = parseInt(envLowValue)
  let lowBlock: TimestampBlock | undefined = getLowBlock()
  let highBlock: TimestampBlock = getHighBlock()
  if (lowBlock?.number < low) lowBlock = undefined

  let block: TimestampBlock;
  let i = 0
  let blockImprecision: number
  let imprecision: number

  try {
    let firstBlock, lastBlock

    if (['evmos', 'nibiru'].includes(chain)) {
      lastBlock = await getLatestBlock(chain)
      let firstBlockNum = lastBlock.number
      switch (chain) {
        case 'nibiru': firstBlockNum -= 4 * 1e5// nibiru hold only the last 400k block data
        case 'evmos': firstBlockNum -= 2 * 1e5// evmos hold only the last 200k block data
      }
      firstBlock = await fetchBlockFromProvider(firstBlockNum, chain)
    } else {
      [lastBlock, firstBlock] = await Promise.all([
        highBlock ? highBlock : getLatestBlock(chain),
        lowBlock ? lowBlock : fetchBlockFromProvider(low, chain),
      ])
    }

    lowBlock = firstBlock

    if (!highBlock)
      highBlock = lastBlock

    if (Math.abs(highBlock.timestamp - timestamp) < 60 * 5) {
      // Short-circuit in case we are trying to get the current block
      return {
        block: highBlock.number,
        number: highBlock.number,
        timestamp: highBlock.timestamp
      };
    }


    updateBlock()

    while (imprecision! > allowedTimeRange && blockImprecision! > acceptableBlockImprecision && i < 50) { // We lose some precision (max ~15 minutes) but reduce #calls needed 
      ++i
      const blockDiff = highBlock.number - lowBlock.number
      const timeDiff = highBlock.timestamp - lowBlock.timestamp
      const avgBlockTime = timeDiff / blockDiff
      let closeBlock = Math.floor(lowBlock.number + (timestamp - lowBlock.timestamp) / avgBlockTime);
      if (closeBlock > highBlock.number) closeBlock = highBlock.number
      const midBlock = Math.floor((lowBlock.number + highBlock.number) / 2)
      const blocks = await Promise.all([
        fetchBlockFromProvider(closeBlock, chain),
        fetchBlockFromProvider(midBlock, chain),
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
      number: block!.number,
      block: block!.number,
      timestamp: block!.timestamp
    };

  } catch (e) {
    throw formError(e)
  }

  function updateBlock(blocks: TimestampBlock[] = []) {
    blocks.forEach(addBlockToCache)
    const getPrecision = (block: TimestampBlock) => block.timestamp - timestamp > 0 ? block.timestamp - timestamp : timestamp - block.timestamp

    blocks.push(highBlock, lowBlock!)
    blocks.sort((a, b) => getPrecision(a) - getPrecision(b))
    block = blocks[0]
    // find the closest upper and lower bound between 4 points
    lowBlock = blocks.filter(i => i.timestamp < timestamp).reduce((lowestBlock, block) => (timestamp - lowestBlock.timestamp) < (timestamp - block.timestamp) ? lowestBlock : block, lowBlock!)
    highBlock = blocks.filter(i => i.timestamp > timestamp).reduce((highestBlock, block) => (highestBlock.timestamp - timestamp) < (block.timestamp - timestamp) ? highestBlock : block, highBlock!)
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
    const { number, timestamp } = block
    getChainBlockTimeCache(chain)[block.number] = { number, timestamp, }

    // save the block cache every 5 minutes
    if (Date.now() - lastBlockCacheSave > blockCacheSaveInterval) {
      lastBlockCacheSave = Date.now()
      saveBlockCacheFile()
    }
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

export async function getTimestamp(height: number, chain: Chain) {
  const provider = getExtraProvider(chain);
  const block = await provider.getBlock(height)
  return block!.timestamp
}

export type Block = {
  timestamp: number
  block: number
  hash?: string
  number: number // for compatibility with old code, both block and number are the same
}

const currentChainBlockCache: {
  [chain: string]: {
    timestamp: number
    promise: any
  };
} = {}
