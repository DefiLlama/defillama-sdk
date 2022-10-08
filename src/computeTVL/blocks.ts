import { getProvider } from "../general";
import { lookupBlock } from "../util/index";
import type { Chain } from "../general";

export const chainsForBlocks = ["avax", "bsc", "polygon", "xdai", "fantom", "arbitrum"] as Chain[];
const blockRetries = 5;

export async function getChainBlocks(timestamp: number, chains: Chain[] = chainsForBlocks) {
  const chainBlocks = {} as {
    [chain: string]: number;
  };
  const setBlock = async (chain: Chain) => chainBlocks[chain] = (await getBlock(chain, timestamp)).block
  await Promise.all(chains.map(setBlock));
  return chainBlocks;
}

export async function getBlocks(timestamp: number, chains: Chain[]|undefined = undefined) {
  const [ethBlock, chainBlocks] = await Promise.all([getBlock('ethereum', timestamp), getChainBlocks(timestamp, chains)]);
  chainBlocks['ethereum'] = ethBlock.block;
  return {
    ethereumBlock: ethBlock.block,
    chainBlocks,
  };
}

export async function getCurrentBlocks(chains: Chain[]|undefined = undefined) {
  if (chains) 
    chains = chains.filter(i => i !== "ethereum")

  const block: {
    timestamp: number
    number: number
  } = await getBlock('ethereum')
  const chainBlocks = await getChainBlocks(block.timestamp, chains);
  chainBlocks['ethereum'] = block.number;
  return {
    timestamp: block.timestamp,
    ethereumBlock: block.number,
    chainBlocks,
  };
}

const blockCache = {} as {
  [key: string | number]: {
    [chain: string]: any;
  };
}

export async function getBlock(chain: Chain, timestamp: number | undefined = undefined): Promise<any> {
  if (!timestamp) {
    if (!blockCache.current) blockCache.current = {}
    if (!blockCache.current.ethereum) {
      blockCache.current.ethereum = getCurrentEthBlock()
    }
    return blockCache.current.ethereum
  }

  if (!blockCache[timestamp])
    blockCache[timestamp] = {}

  if (!blockCache[timestamp][chain])
    blockCache[timestamp][chain] = _getBlock()

  return blockCache[timestamp][chain]

  async function getCurrentEthBlock() {
    const provider = getProvider("ethereum");
    const lastBlockNumber = await provider.getBlockNumber();
    return provider.getBlock(lastBlockNumber - 5); // To allow indexers to catch up
  }

  async function _getBlock() {
    for (let i = 0; i < blockRetries; i++) {
      try {
        const { block } = await lookupBlock(timestamp as number, { chain, })
        return block;
      } catch (e) {
        if (i === blockRetries - 1) {
          throw e;
        }
      }
    }
  }
}
