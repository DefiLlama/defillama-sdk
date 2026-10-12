import { getProvider, Chain } from "../general";
import { fetchJson, formError, getProviderUrl, } from "./common";
import { debugLog } from "./debugLog";
import { isCosmosChain, getCosmosProvider } from "./cosmos";
import { getTempLocalCache, ONE_WEEK } from "./cache";
import pLimit from 'p-limit';
import { getParallelGetBlocksLimit, ENV_CONSTANTS, shouldSkipBlockValidation } from "./env";

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
      return fetchJson(`https://algoindexer.algoexplorerapi.io/v2/blocks/${height}`)
        .then((block: any) => ({
          number: block.round,
          timestamp: block.timestamp
        }))
    return fetchJson('https://algoindexer.algoexplorerapi.io/health')
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
  sei: 150023881,
  terra: 4724001,
  crab: 4969901
} as {
  [chain: string]: number | undefined;
};

// pruned nodes don't serve old blocks, we find the earliest available block per chain and remember it for this process
const earliestAvailableBlock: {
  [chain: string]: number | undefined
} = {}
const prunedBlockBuffer = 1000 // pruning keeps moving forward, so stay a bit ahead of the reported height

// known formats:
//   sei:                    "requested height 150022713 has been pruned; earliest available is 229666772"
//   sei (pre evm):          "EVM is only supported from block 79123881 onwards"
//   publicnode:             "pruned history unavailable: requested 100, earliest available 51000000"
//   cosmos/tendermint/evm:  "height 100 is not available, lowest height is 47180386" (often in error.data)
const earliestBlockPatterns = [
  /(?:earliest|lowest|oldest|first)\s+(?:available\s+)?(?:block\s+|height\s+)?(?:number\s+)?(?:available\s+)?(?:is\s+|:\s*|=\s*)?#?(\d+)/i,
  /(?:supported|available)\s+(?:from|since|after)\s+(?:block\s+|height\s+)?#?(\d+)/i,
]

// errors get wrapped by ethers/axios/formError, so the node's message can sit in any nested field
function getErrorText(e: any, depth = 0, seen = new Set<any>()): string {
  if (typeof e === 'string') return e
  if (!e || typeof e !== 'object' || depth > 4 || seen.has(e)) return ''
  seen.add(e)
  return Object.getOwnPropertyNames(e)
    .filter(key => key !== 'stack')
    .map(key => getErrorText(e[key], depth + 1, seen))
    .filter(Boolean)
    .join(' ')
}

function getEarliestAvailableFromError(e: any, requested: number): number | undefined {
  const text = getErrorText(e)
  const found = earliestBlockPatterns
    .map(pattern => text.match(pattern)?.[1])
    .filter(Boolean)
    .map(Number)
    .filter(block => block > requested)
  return found.length ? Math.max(...found) : undefined
}

// last resort for nodes that return null/not found without telling where the history starts
async function searchEarliestAvailableBlock(low: number, chain: string): Promise<number | undefined> {
  const { number: latest } = await getLatestBlock(chain)
  let hi = latest - prunedBlockBuffer
  if (hi <= low || !(await isBlockAvailable(hi))) return // node is broken, not pruned
  while (hi - low > prunedBlockBuffer) {
    const mid = Math.floor((low + hi) / 2)
    if (await isBlockAvailable(mid)) hi = mid
    else low = mid
  }
  return hi

  async function isBlockAvailable(block: number) {
    try {
      await fetchBlockFromProvider(block, chain)
      return true
    } catch (e) {
      const earliest = getEarliestAvailableFromError(e, block)
      if (earliest) low = Math.max(low, earliest - 1) // node told us, skip ahead
      return false
    }
  }
}

// fetches the given block, or the earliest available block if the node has pruned it
async function fetchAvailableBlock(low: number, chain: string) {
  low = Math.max(low, earliestAvailableBlock[chain] ?? 0) // already known to be pruned, don't ask again
  let originalError
  // a few hops: sei first reports the evm start block, then the pruned height
  for (let i = 0; i < 3; i++) {
    try {
      return await fetchBlockFromProvider(low, chain)
    } catch (e) {
      originalError = originalError ?? e
      const earliest = getEarliestAvailableFromError(e, low)
      if (!earliest) break
      low = earliestAvailableBlock[chain] = earliest + prunedBlockBuffer
      debugLog(`chain: ${chain} block is pruned, using earliest available block ${low}`)
    }
  }

  // parallel probes can all land in the pruned range, run a single search per chain
  if (!earliestBlockSearches[chain]) {
    earliestBlockSearches[chain] = searchEarliestAvailableBlock(low, chain)
      .catch(() => undefined)
      .finally(() => delete earliestBlockSearches[chain])
  }
  const earliest = await earliestBlockSearches[chain]
  if (!earliest) throw originalError
  if ((earliestAvailableBlock[chain] ?? 0) < earliest + prunedBlockBuffer) {
    earliestAvailableBlock[chain] = earliest + prunedBlockBuffer
    debugLog(`chain: ${chain} block is pruned, found earliest available block ${earliestAvailableBlock[chain]} by searching`)
  }
  return fetchBlockFromProvider(earliestAvailableBlock[chain]!, chain)
}

const earliestBlockSearches: {
  [chain: string]: Promise<number | undefined> | undefined
} = {}

type ChainBlockCache = {
  [chain: string]: {
    [block: number]: TimestampBlock
  }
}
let lastBlockCacheSave = Date.now()
const blockCacheSaveInterval = 1000 * 60 * 5; // 5 minutes 

const { data: blockTimeCache, saveCacheFile: saveBlockCacheFile }: { data: ChainBlockCache, saveCacheFile: Function } = getTempLocalCache({ file: 'BlockCache-v1.json', defaultData: {}, clearAfter: ONE_WEEK, returnWithSaveFunction: true });

function validateCurrentBlock(block: Block, chain: Chain = 'ethereum') {
  // sometimes the chain is halted or facing issues, so we skip the validation for those chains
  if (shouldSkipBlockValidation(chain)) return;

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

// concurrent lookups for the same chain & timestamp share one search
const inflightLookups: {
  [key: string]: Promise<Block> | undefined
} = {}

export async function lookupBlock(timestamp: number, extraParams?: LookupBlockOptionalParams): Promise<Block> {
  const { chain = "ethereum", allowedTimeRange, acceptableBlockImprecision } = extraParams ?? {};
  const key = [chain, timestamp, allowedTimeRange, acceptableBlockImprecision].join(':')
  if (!inflightLookups[key]) {
    const limiter = getChainLimiter(chain)
    inflightLookups[key] = limiter(() => _lookupBlock(timestamp, extraParams))
      .finally(() => delete inflightLookups[key])
  }
  return inflightLookups[key]!
}

const earliestAvailableBlockRange: {
  [chain: string]: number | undefined
} = {
  nibiru: 4 * 1e5,// nibiru hold only the last 400k block data
  evmos:  2 * 1e5,
}

// block time measured over the most recent blocks, a far better predictor of the near past than the all time average
const blockTimeSampleSize = 10_000
const blockTimeCacheDuration = 1000 * 60 * 60 // 1 hour
const recentBlockTimes: {
  [chain: string]: { blockTime: number, updatedAt: number } | undefined
} = {}

async function getRecentBlockTime(chain: string, anchor: TimestampBlock, floor: number, onBlock: (block: TimestampBlock) => void): Promise<number> {
  const cached = recentBlockTimes[chain]
  if (cached && Date.now() - cached.updatedAt < blockTimeCacheDuration) return cached.blockTime

  const sample = await fetchAvailableBlock(Math.max(floor, anchor.number - blockTimeSampleSize), chain)
  onBlock(sample)
  const blockTime = (anchor.timestamp - sample.timestamp) / (anchor.number - sample.number)
  if (!(blockTime > 0) || !isFinite(blockTime)) return 2 // not enough history to measure, rough guess, don't cache
  recentBlockTimes[chain] = { blockTime, updatedAt: Date.now() }
  return blockTime
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
    const data = await fetchJson(api)
    return {
      timestamp,
      block: +data.height,
      number: +data.height,
    }
  }

  const maxCalls = 30
  let calls = 0
  let lowBlock: TimestampBlock | undefined // closest known block at or before the timestamp
  let highBlock: TimestampBlock | undefined // closest known block after the timestamp
  let bestBlock: TimestampBlock | undefined
  let blockTime: number | undefined
  let lastBracketWidth = Infinity

  try {
    let floor = getFloorBlock()
    const cachedLow = getLowBlock()
    if (cachedLow && cachedLow.number >= floor) updateBounds(cachedLow, false)
    const cachedHigh = getHighBlock()
    if (cachedHigh) updateBounds(cachedHigh, false)

    // anchor on the chain head unless the cache already has a block after the timestamp
    if (!highBlock || earliestAvailableBlockRange[chain]) {
      const head = await getLatestBlock(chain)
      if (Math.abs(head.timestamp - timestamp) < 60 * 5) // Short-circuit in case we are trying to get the current block
        return { block: head.number, number: head.number, timestamp: head.timestamp }
      floor = getFloorBlock(head)
      if (!highBlock || head.number < highBlock.number) updateBounds(head, false)
      if (lowBlock && lowBlock.number < floor) lowBlock = undefined
    }

    while (!isPreciseEnough() && calls < maxCalls) {
      floor = Math.max(floor, earliestAvailableBlock[chain] ?? 0)
      let guesses: number[]

      if (lowBlock) {
        // bracketed: interpolate between the bounds, bisect when the previous step didn't at least halve the bracket
        const width = highBlock!.number - lowBlock.number
        if (width <= 1) break
        let guess = lowBlock.number + Math.round((timestamp - lowBlock.timestamp) * width / (highBlock!.timestamp - lowBlock.timestamp))
        if (width > lastBracketWidth / 2) guess = Math.floor((lowBlock.number + highBlock!.number) / 2)
        lastBracketWidth = width
        guesses = [clamp(guess, lowBlock.number + 1, highBlock!.number - 1)]
      } else {
        // only an upper bound: extrapolate back from it using the recent block time
        if (highBlock!.number <= floor) break // requested time is before the available history
        blockTime = blockTime ?? await getRecentBlockTime(chain, highBlock!, floor, block => { calls++; updateBounds(block) })
        if (lowBlock) continue // the block time sample already bracketed the timestamp
        const guess = clamp(Math.round(highBlock!.number - (highBlock!.timestamp - timestamp) / blockTime), floor, highBlock!.number - 1)
        // probe around the guess too, so a slightly off block time still brackets the timestamp in one round trip
        const spread = Math.max(acceptableBlockImprecision, Math.round((highBlock!.number - guess) * 0.02))
        guesses = [...new Set([guess - spread, guess, guess + spread].map(b => clamp(b, floor, highBlock!.number - 1)))]
      }

      const blocks = await Promise.all(guesses.map(b => fetchAvailableBlock(b, chain)))
      calls += blocks.length
      blocks.forEach(block => updateBounds(block))
    }

    if (calls > 2 && ENV_CONSTANTS.GET_BLOCK_STATS)
      debugLog(`chain: ${chain} block: ${bestBlock!.number} #calls: ${calls} imprecision: ${Number(getImprecision(bestBlock!) / 60).toFixed(2)} (min) Time Taken: ${Number((Date.now() - time) / 1000).toFixed(2)} (in sec)`)

    if (
      getImprecision(bestBlock!) > 3600
      && chain !== "bsc" // this check is there because bsc halted the chain for few days
      && !shouldSkipBlockValidation(chain)
    ) {
      if (!lowBlock && highBlock!.number <= floor)
        throw new Error(`Requested timestamp ${timestamp} (${new Date(timestamp * 1000).toISOString()}) is before the earliest available block ${highBlock!.number} (${new Date(highBlock!.timestamp * 1000).toISOString()}) of ${chain}`)
      throw new Error(
        "Block selected is more than 1 hour away from the requested timestamp"
      );
    }

    return {
      number: bestBlock!.number,
      block: bestBlock!.number,
      timestamp: bestBlock!.timestamp
    };

  } catch (e) {
    throw formError(e)
  }

  function getFloorBlock(head?: TimestampBlock) {
    let floor = intialBlocks[chain] ?? 100
    const envLowValue = process.env[`${chain.toUpperCase()}_BLOCK_LOW`]
    if (envLowValue) floor = parseInt(envLowValue)
    floor = Math.max(floor, earliestAvailableBlock[chain] ?? 0)
    if (head && earliestAvailableBlockRange[chain]) floor = Math.max(floor, head.number - earliestAvailableBlockRange[chain]!)
    return floor
  }

  function getImprecision(block: TimestampBlock) {
    return Math.abs(block.timestamp - timestamp)
  }

  function isPreciseEnough() {
    if (bestBlock && getImprecision(bestBlock) <= allowedTimeRange) return true
    return !!lowBlock && !!highBlock && highBlock.number - lowBlock.number <= acceptableBlockImprecision
  }

  function updateBounds(block: TimestampBlock, saveToCache = true) {
    if (saveToCache) addBlockToCache(block)
    if (block.timestamp <= timestamp) {
      if (!lowBlock || block.number > lowBlock.number) lowBlock = block
    } else if (!highBlock || block.number < highBlock.number) {
      // while unbracketed, the slope between consecutive upper bounds is the most local block time we have
      if (highBlock && !lowBlock) {
        const localBlockTime = (highBlock.timestamp - block.timestamp) / (highBlock.number - block.number)
        if (localBlockTime > 0) blockTime = localBlockTime
      }
      highBlock = block
    }
    if (!bestBlock || getImprecision(block) < getImprecision(bestBlock)) bestBlock = block
  }

  function clamp(value: number, min: number, max: number) {
    return Math.min(Math.max(value, min), max)
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
