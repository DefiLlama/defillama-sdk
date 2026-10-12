import { getProvider, Chain } from "../general";
import type { Address } from "../types";
import { ethers, EventLog } from "ethers";
import { formError, getProviderUrl, sumSingleBalance } from "./common";
import { debugLog } from "./debugLog";
import runInPromisePoolOrig from "./promisePool";
export { getLatestBlock, getTimestamp, lookupBlock, } from "./blocks";
export { convertToBigInt } from "./common"
import pLimit from 'p-limit';
import { getParallelGetLogsLimit, ENV_CONSTANTS } from "./env";
import { getHintedBlockSpan, isRangeTooWideError } from "./logs.range";

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
  target?: Address;
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

      if (ENV_CONSTANTS.GET_LOGS_DEBUG)
        debugLog(`Error fetching logs for chain ${options.chain} ${formError(e, { chain: options.chain, target: options.target, })}, retrying...`)

      return getLimiter()(() => _getLogs(options));
    }
  }

  return getLimiter()(() => _getLogs(options));
}

// a node that caps by result count or by a tiny block range can need a lot of sub-queries, but not
// an unbounded number, past this it is cheaper to fail than to walk the range a few blocks at a time
const MAX_SUB_QUERIES = 2000;

// the node either states the span it will serve or just complains about the size, in which case
// halve. returns undefined when the error is not about the range at all, so retrying cannot help.
function narrowBlockSpan(attemptedSpan: number, e: any): number | undefined {
  if (!isRangeTooWideError(e)) return undefined;
  const hinted = getHintedBlockSpan(e);
  let next = hinted !== undefined && hinted < attemptedSpan ? hinted : Math.floor(attemptedSpan / 2);
  // most nodes that cap by block range cap at one of these, landing on it saves a round trip
  if (next > 510 && next < 2000) next = 1000;
  if (next > 5100 && next < 10000) next = 10000;
  if (next >= attemptedSpan) next = Math.floor(attemptedSpan / 2);
  return next >= 1 ? next : undefined;
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
  const totalBlocks = params.toBlock - params.fromBlock + 1;
  const minBlockSpan = Math.max(1, Math.ceil(totalBlocks / MAX_SUB_QUERIES));
  let logs: EventLog[] = [];
  let blockSpan = totalBlocks;
  let currentBlock = params.fromBlock;
  const provider = params.provider ?? getProvider(params.chain, true);
  while (currentBlock <= params.toBlock) {
    const nextBlock = Math.min(params.toBlock, currentBlock + blockSpan - 1);
    let logParams = {
      ...filter,
      fromBlock: currentBlock,
      toBlock: nextBlock
    }
    try {
      const partLogs = await provider.getLogs(logParams);
      logs = logs.concat(partLogs as EventLog[]);
      currentBlock = nextBlock + 1;
    } catch (e) {

      if (ENV_CONSTANTS.GET_LOGS_DEBUG)
        debugLog(`Error fetching logs for chain ${params.chain} blockSpan: ${blockSpan}. ${formError(e, { chain: params.chain, target: params.target, provider })}`)

      const nextSpan = narrowBlockSpan(nextBlock - currentBlock + 1, e);
      if (nextSpan === undefined || nextSpan < minBlockSpan) {
        const error = formError(e, { chain: params.chain, target: params.target, provider })
        error.message = `[chain: ${params.chain}] ${(error as any)?.message} params: ${JSON.stringify(logParams)}`
        throw e;
      }
      blockSpan = nextSpan;
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

export function tableToString(data: any, columns?: any, { title, columns: _columns }: { title?: string, columns?: string[] } = {}) {
  // If only two arguments are passed and the second is not an array, treat it as options
  if (arguments.length === 2 && !Array.isArray(columns) && typeof columns === 'object') {
    ({ title, columns: _columns } = columns ?? {});
    columns = undefined;
  }

  if (_columns && Array.isArray(_columns))
    columns = _columns;

  let tableString = '';
  if (!Array.isArray(data) && typeof data === 'object') {
    data = Object.entries(data).map(([key, value]: any) => {
      const row: any = { key };
      if (typeof value === 'object' && !Array.isArray(value)) {
        Object.entries(value).forEach(([subKey, subValue]) => {
          row[subKey] = subValue;
        });
      } else {
        row.value = value;
      }
      return row;
    });

  }
  if (!data || !Array.isArray(data) || data.length === 0) {
    return '';
  }
  data = [...data]; // Ensure we don't modify the original data
  if (!columns || !Array.isArray(columns) || columns.length === 0) {
    const columnsSet = new Set();
    data.forEach((row: any) => {
      Object.keys(row).forEach((col: any) => {
        columnsSet.add(col);
      });
    });
    columns = Array.from(columnsSet);
  }

  if (title)
    tableString += `# ${title}\n\n`;

  // Add the header row
  const headerObject: any = {}
  const headerObject1: any = {}
  columns.forEach((col: any) => {
    headerObject[col] = col
    headerObject1[col] = '---'
  })
  data.unshift(headerObject1)
  data.unshift(headerObject)
  // Calculate the maximum width for each column
  const columnWidths = columns.map((col: any) =>
    Math.max(col.length, ...data.map((row: any) => (row[col] !== undefined ? String(row[col]).length : 0)))
  );

  // Add the data rows
  data.forEach((row: any) => {

    // Format the row with padded values
    const tableRow = columns.map((col: any, index: number) => {
      const cell = row[col] !== undefined ? String(row[col]) : '';
      return cell.padEnd(columnWidths[index], ' ');
    }).join(' | ');
    tableString += tableRow + '\n';
  });

  return tableString;
}