import { ethers, Interface } from "ethers";
import { decodeAbiParameters, parseAbiItem } from "viem";

export function padTopic32(t: string): `0x${string}` {
  if (!t) return '0x' as `0x${string}`;
  // Early return if already 32 bytes (0x + 64 hex chars)
  if (t.startsWith('0x') && t.length === 66) return t as `0x${string}`;
  const hex = t.startsWith('0x') ? t.slice(2) : t;
  return ('0x' + hex.padStart(64, '0')) as `0x${string}`;
}

export function normalizeLog(log: any, isIndexerCall: boolean = false): boolean {
  if (isIndexerCall || log.source) {
    log.address = log.source;
    log.logIndex = log.log_index;
    log.index = log.log_index;
    log.transactionHash = log.transaction_hash;
    log.blockNumber = parseInt(log.block_number || log.blockNumber || 0);

    const topics = [log.topic0, log.topic1, log.topic2, log.topic3]
      .filter(Boolean)
      .map(padTopic32);

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
      .map(padTopic32);
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

// Enrich Ethers args with named properties to match Viem output structure
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
      if (input.name && !(input.name in enrichedArgs)) {
        enrichedArgs[input.name] = value;
      }
      enrichedArgs[i] = value;
    }
  }

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
  if (!decodedArgs) {
    const args: any = Object.create(null);
    args.length = eventInputs.length;
    return args;
  }

  const args: any = Object.create(null);
  args.length = eventInputs.length;

  try {
    if (Array.isArray(decodedArgs)) {
      const len = Math.min(decodedArgs.length, eventInputs.length);
      for (let i = 0; i < len; i++) {
        const input = eventInputs[i];
        const value = decodedArgs[i];
        if (value !== undefined && value !== null) {
          const normalizedValue = normalizeFn(value, input.type);
          if (input.name) args[input.name] = normalizedValue;
          args[i] = normalizedValue;
        }
      }
      return args;
    }

    if (typeof decodedArgs === 'object') {
      const inputCount = eventInputs.length;
      for (let i = 0; i < inputCount; i++) {
        const input = eventInputs[i];
        const value = (decodedArgs as any)[input.name] ?? (decodedArgs as any)[i] ?? null;
        if (value !== undefined && value !== null) {
          const normalizedValue = normalizeFn(value, input.type);
          if (input.name) args[input.name] = normalizedValue;
          args[i] = normalizedValue;
        }
      }
      return args;
    }
  } catch (e) {
    // Fallback: minimal object creation
    if (Array.isArray(decodedArgs)) {
      const len = decodedArgs.length;
      for (let i = 0; i < len; i++) {
        args[i] = decodedArgs[i];
      }
      args.length = len;
    } else if (typeof decodedArgs === 'object') {
      Object.assign(args, decodedArgs);
    }
  }

  return args;
}

export function createViemFastPathBatchDecoder(eventAbi: string | any): ((logs: any[]) => Promise<any[]>) | null {
  try {
    // Parse ABI once
    const ev = parseAbiItem(eventAbi);
    if (!ev || ev.type !== 'event') return null;

    const inputs = ev.inputs || [];
    const indexed: typeof inputs = [] as typeof inputs;
    const nonIndexed: typeof inputs = [] as typeof inputs;

    for (const inp of inputs) {
      if (inp.indexed) {
        (indexed as any[]).push(inp);
      } else {
        (nonIndexed as any[]).push(inp);
      }
    }

    const nonIndexedTypes = nonIndexed.map(i => ({ type: i.type as any }));

    return async function decodeBatchViemFast(logs: any[]): Promise<any[]> {
      const out = new Array(logs.length);

      for (let i = 0; i < logs.length; i++) {
        const l = logs[i];

        try {
          const logData = l.data || l.data_field || '0x';
          
          const decodedNon = nonIndexed.length && logData && logData !== '0x'
            ? decodeAbiParameters(nonIndexedTypes as any, logData as `0x${string}`)
            : [];

          const args: any = Object.create(null);
          args.length = inputs.length;

          let topicIdx = 1; // topics[0] = event signature
          let nonIndexedIdx = 0;

          for (let j = 0; j < inputs.length; j++) {
            const inp = inputs[j];
            let value: any;

            if (inp.indexed) {
              if (topicIdx < (l.topics?.length || 0)) {
                value = l.topics[topicIdx];
                topicIdx++;
              } else {
                value = null;
              }
            } else {
              value = decodedNon[nonIndexedIdx] ?? null;
              nonIndexedIdx++;
            }

            let normalizedValue: any = null;
            
            if (value !== null && value !== undefined) {
              // For indexed addresses, Ethers extracts the address from the padded topic
              // Topics are 32 bytes padded, but Ethers returns addresses as normal 20-byte addresses
              // Ethers uses getAddress() which converts to checksum format
              if (inp.type === 'address' && inp.indexed && typeof value === 'string') {
                let addressStr: string;
                if (value.startsWith('0x') && value.length === 66) {
                  // Topic is 32 bytes padded, extract the address (last 20 bytes = 40 hex chars)
                  addressStr = '0x' + value.slice(-40);
                } else if (value.startsWith('0x') && value.length === 42) {
                  addressStr = value;
                } else {
                  // Fallback: try to extract address from topic
                  const hex = value.startsWith('0x') ? value.slice(2) : value;
                  if (hex.length >= 40) {
                    addressStr = '0x' + hex.slice(-40);
                  } else {
                    addressStr = value;
                  }
                }
                // Use ethers.getAddress to convert to checksum format (like Ethers does)
                try {
                  normalizedValue = ethers.getAddress(addressStr) as `0x${string}`;
                } catch {
                  // Fallback if getAddress fails
                  normalizedValue = addressStr.toLowerCase() as `0x${string}`;
                }
              } else {
                // For other types, use normal normalization
                normalizedValue = normalizeValueByType(value, inp.type);
              }
            }
            
            // Always assign both numeric index and named property (even if value is null/undefined)
            // This matches Ethers behavior where all args are present in the args object
            args[j] = normalizedValue;
            if (inp.name) {
              args[inp.name] = normalizedValue;
            }
          }

          out[i] = args;
        } catch (e) {
          // Fallback: return empty args on decode error
          const args: any = Object.create(null);
          args.length = inputs.length;
          out[i] = args;
        }
      }

      return out;
    };
  } catch (e) {
    return null;
  }
}

