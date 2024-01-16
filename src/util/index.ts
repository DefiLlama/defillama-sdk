import { getProvider, Chain } from "../general";
import type { Address } from "../types";
import { ethers, EventLog } from "ethers";
import { formError, getProviderUrl, sumSingleBalance } from "../generalUtil";
import { debugLog } from "./debugLog";
import runInPromisePoolOrig from "./promisePool";
export { getLatestBlock, getTimestamp, lookupBlock, } from "./blocks";
export { convertToBigInt } from "../generalUtil"
import pLimit from 'p-limit';
import { getParallelGetLogsLimit } from "./env";

export const runInPromisePool = runInPromisePoolOrig

export function sliceIntoChunks(arr: any[], chunkSize = 100) {
  const res = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    const chunk = arr.slice(i, i + chunkSize);
    res.push(chunk);
  }
  return res;
}

const chainLogLimiters: any = {}

function getChainLimiter(chain: string, providerUrl: string) {
  if (!chainLogLimiters[chain]) chainLogLimiters[chain] = createLimiter(chain)
  return chainLogLimiters[chain]

  function createLimiter(chain: string) {
    return pLimit(getParallelGetLogsLimit(chain, providerUrl))
  }
}

type GetLogsOptions = {
  target: Address;
  topic: string;
  keys: string[]; // This is just used to select only part of the logs
  fromBlock: number;
  toBlock: number; // DefiPulse's implementation is buggy and doesn't take this into account
  topics?: (string | null)[]; // This is an outdated part of DefiPulse's API which is still used in some old adapters
  chain?: Chain;
  provider?: ethers.Provider;
}

export async function getLogs(options: GetLogsOptions): Promise<{ output: EventLog[] }> {
  const getLimiter = () => getChainLimiter(options.chain!, getProviderUrl(options.provider))

  // if provider is not passed, we try with archival node first (if set) and then with non-archival node
  let provider: any
  if (!options.provider) {
    options.provider = getProvider(options.chain!, true);
    provider = options.provider
    try {
      const res = await getLimiter()(() => _getLogs(options));
      return res
    } catch (e) {
      options.provider = getProvider(options.chain!, false)
      // if (provider === options.provider) throw e // the provider for archival and non-archival request is the same
      debugLog(`Error fetching logs for chain ${options.chain} ${formError(e, { chain: options.chain, target: options.target,  })}, retrying...`)
      return getLimiter()(() => _getLogs(options));
    }
  }

  return getLimiter()(() => _getLogs(options));
}

// SMALL INCOMPATIBILITY: On the old API we don't return ids but we should
async function _getLogs(params: GetLogsOptions): Promise<{ output: EventLog[] }> {
  if (params.toBlock === undefined || params.fromBlock === undefined) {
    throw new Error(
      "toBlock and fromBlock need to be defined in all calls to getLogs"
    );
  }
  const filter = {
    address: params.target,
    topics: params.topics ?? [ethers.id(params.topic)],
    fromBlock: params.fromBlock,
    toBlock: params.toBlock // We don't replicate Defipulse's bug because the results end up being the same anyway and hopefully they'll eventually fix it
  };
  let logs: EventLog[] = [];
  let blockSpread = params.toBlock - params.fromBlock;
  let currentBlock = params.fromBlock;
  const provider = params.provider ?? getProvider(params.chain, true);
  while (currentBlock < params.toBlock) {
    const nextBlock = Math.min(params.toBlock, currentBlock + blockSpread);
    let logParams = {
      ...filter,
      fromBlock: currentBlock,
      toBlock: nextBlock
    }
    try {
      const partLogs = await provider.getLogs(logParams);
      logs = logs.concat(partLogs as EventLog[]);
      currentBlock = nextBlock;
    } catch (e) {
      debugLog(`Error fetching logs for chain ${params.chain} blockSpread: ${blockSpread}. ${formError(e, { chain: params.chain, target: params.target, provider })}`)
      if (blockSpread >= 1500) {
        // We got too many results
        // We could chop it up into 1500 block spreads as that is guaranteed to always return but then we'll have to make a lot of queries (easily >1000), so instead we'll keep dividing the block spread by two until we make it
        blockSpread = Math.floor(blockSpread / 2);
      } else {
        const error = formError(e, { chain: params.chain, target: params.target, provider })
        error.message = `[chain: ${params.chain}] ${(error as any)?.message} params: ${JSON.stringify(logParams)}`
        throw e;
      }
    }
  }
  if (params.keys.length > 0) {
    if (params.keys[0] !== "topics") {
      throw new Error("Unsupported");
    }
    return {
      output: logs.map((log) => log.topics) as any
    };
  }
  // ethers v5 logs had 'logIndex' but not ethers v6, so adding field to keep it compatible
  logs.forEach((log: any) => {
    log.logIndex = log.index
    delete log.provider
  })
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
    balances[weth] = (BigInt(balances[weth] ?? 0) + BigInt(eth)).toString();
    delete balances[ethereumAddress];
  }

  return balances;
}
