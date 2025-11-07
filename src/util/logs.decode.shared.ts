import { ethers, Interface } from "ethers";

export function normalizeLog(log: any, isIndexerCall: boolean = false): boolean {
  if (isIndexerCall || log.source) {
    log.address = log.source;
    log.logIndex = log.log_index;
    log.index = log.log_index;
    log.transactionHash = log.transaction_hash;
    log.blockNumber = parseInt(log.block_number || log.blockNumber || 0);

    const topics = [log.topic0, log.topic1, log.topic2, log.topic3]
      .filter(Boolean)
      .map((t: string) => {
        if (!t) return null;
        const topic = t.startsWith("0x") ? t : `0x${t}`;
        return ethers.zeroPadValue(topic, 32);
      });

    if (!topics[0]) return false;

    log.topics = topics;

    log._originalTopics = {
      topic0: log.topic0,
      topic1: log.topic1,
      topic2: log.topic2,
      topic3: log.topic3
    };

    log._originalTransactionHash = log.transaction_hash;

    // Only delete fields that are not needed for parsing
    [
      "chain",
      "log_index",
    ].forEach((k) => delete log[k]);
  }

  if (log.blockNumber === undefined && log.block_number !== undefined)
    log.blockNumber = parseInt(log.block_number);

  // Restore topics if they were lost
  if (!log.topics && log._originalTopics) {
    log.topics = [log._originalTopics.topic0, log._originalTopics.topic1, log._originalTopics.topic2, log._originalTopics.topic3]
      .filter(Boolean)
      .map((t: string) => {
        if (!t) return null;
        const topic = t.startsWith("0x") ? t : `0x${t}`;
        return ethers.zeroPadValue(topic, 32);
      });
  }

  // Restore transaction hash if it was lost
  if (!log.transactionHash && log._originalTransactionHash) {
    log.transactionHash = log._originalTransactionHash;
  }

  return true;
}

/**
 * Normalize value type according to Solidity type to match Ethers format
 * Ethers returns small int types (int24, uint24, uint16, etc.) as strings to avoid JS precision issues
 */
const smallIntPattern = /^u?int(8|16|24)$/;
export function normalizeValueByType(value: any, type: string): any {
  if (value === null || value === undefined) return value;

  // Ethers formats small integer types as strings
  if (smallIntPattern.test(type)) {
    if (typeof value === 'number') {
      return value.toString();
    } else if (typeof value === 'bigint') {
      return value.toString();
    }
    return value;
  }

  return value;
}

export function convertTopicsToViemFormat(topics: any[]): [`0x${string}`, ...(`0x${string}`[] | [])] | [] {
  if (!topics || topics.length === 0 || topics[0] === null) {
    return [] as [];
  }

  const filteredTopics: `0x${string}`[] = [];
  for (let t = 0; t < topics.length; t++) {
    if (topics[t] !== null) {
      filteredTopics.push(topics[t] as `0x${string}`);
    }
  }

  // Create tuple type for Viem (required format)
  return filteredTopics.length > 0
    ? [filteredTopics[0], ...filteredTopics.slice(1)] as [`0x${string}`, ...(`0x${string}`[] | [])]
    : [] as [];
}

/**
 * Enrich Ethers args with named properties to match Viem output structure
 */
export function enrichEthersArgsWithNamedProperties(
  ethersArgs: any,
  event: ethers.EventFragment | null,
  iface: Interface
): any {
  if (!ethersArgs || !event || !event.inputs) {
    return ethersArgs;
  }

  // Create a new args object with named properties
  const enrichedArgs: any = Object.create(null);

  // Copy all existing properties (numeric and named if present)
  for (const key in ethersArgs) {
    if (ethersArgs.hasOwnProperty && !ethersArgs.hasOwnProperty(key)) continue;
    enrichedArgs[key] = ethersArgs[key];
  }

  // Ensure named properties are present
  const inputs = event.inputs;
  for (let i = 0; i < inputs.length; i++) {
    const input = inputs[i];
    const value = ethersArgs[i];
    if (value !== undefined && value !== null) {
      // Add named properties if they're not already present
      if (input.name && !(input.name in enrichedArgs)) {
        enrichedArgs[input.name] = value;
      }
      // Ensure numeric index is present
      enrichedArgs[i] = value;
    }
  }

  // Preserve length
  if (typeof ethersArgs.length === 'number') {
    enrichedArgs.length = ethersArgs.length;
  }

  return enrichedArgs;
}

export function buildEthersCompatibleArgs(
  decodedArgs: any,
  eventInputs: readonly ethers.ParamType[],
  normalizeFn: (value: any, type: string) => any = normalizeValueByType
): any {
  const args: any = Object.create(null);

  if (!decodedArgs) return args;

  try {
    // Convert decoded args to array format
    let values: any[] = [];
    if (Array.isArray(decodedArgs)) {
      values = decodedArgs;
    } else if (typeof decodedArgs === 'object') {
      // Convert object to array based on input order
      values = new Array(eventInputs.length);
      for (let i = 0; i < eventInputs.length; i++) {
        const input = eventInputs[i];
        values[i] = (decodedArgs as any)[input.name] ?? (decodedArgs as any)[i] ?? null;
      }
    }

    // Build ethers-compatible Result object
    args.length = eventInputs.length;
    for (let inputIdx = 0; inputIdx < eventInputs.length; inputIdx++) {
      const input = eventInputs[inputIdx];
      if (values[inputIdx] !== undefined && values[inputIdx] !== null) {
        // Normalize the value according to Solidity type to match Ethers format
        const normalizedValue = normalizeFn(values[inputIdx], input.type);
        // Support both named and indexed access (ethers Result behavior)
        args[input.name] = normalizedValue;
        args[inputIdx] = normalizedValue;
      }
    }
  } catch (e) {
    // Fallback: create simple object from decoded args
    if (Array.isArray(decodedArgs)) {
      args.length = decodedArgs.length;
      for (let i = 0; i < decodedArgs.length; i++) {
        args[i] = decodedArgs[i];
      }
    } else if (typeof decodedArgs === 'object') {
      Object.assign(args, decodedArgs);
    }
  }

  return args;
}

