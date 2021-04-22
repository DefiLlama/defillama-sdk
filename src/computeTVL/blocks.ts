import { getProvider } from "../general";
import { lookupBlock } from "../util/index";
import type { Chain } from "../general";

const chainsForBlocks = ["avax", "bsc", "polygon", "xdai"] as Chain[];
const blockRetries = 5;

async function getChainBlocks(timestamp: number) {
  const chainBlocks = {} as {
    [chain: string]: number;
  };
  await Promise.all(
    chainsForBlocks.map(async (chain) => {
      for (let i = 0; i < blockRetries; i++) {
        try {
          chainBlocks[chain] = await lookupBlock(timestamp, {
            chain,
          }).then((block) => block.block);
          break;
        } catch (e) {
          if (i === blockRetries - 1) {
            throw e;
          }
        }
      }
    })
  );
  return chainBlocks;
}

export async function getBlocks(timestamp: number) {
  const ethBlock = lookupBlock(timestamp);
  const chainBlocks = await getChainBlocks(timestamp);
  return {
    ethereumBlock: (await ethBlock).block,
    chainBlocks,
  };
}

export async function getCurrentBlocks() {
  const provider = getProvider("ethereum");
  const lastBlockNumber = await provider.getBlockNumber();
  const block = await provider.getBlock(lastBlockNumber - 5); // To allow indexers to catch up
  const chainBlocks = await getChainBlocks(block.timestamp);
  return {
    timestamp: block.timestamp,
    ethereumBlock: block.number,
    chainBlocks,
  };
}
