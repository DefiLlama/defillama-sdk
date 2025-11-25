import { getLogs } from "./indexer";

jest.setTimeout(2_400_000);

const CONTRACT = "0xa0ffb9c1ce1fe56963b0321b32e7a0302114058b";
const topics = ['0x04206ad2b7c0f463bff3dd4f33c5735b0f2957a351e4f79763a4fa9e775dd237'];
const SWAP_ABI = 'event Swap(bytes32 indexed id, address indexed sender, int128 amount0, int128 amount1, uint160 sqrtPriceX96, uint128 liquidity, int24 tick, uint24 fee, uint16 protocolFee)'

const CONFIG = {
  chain: "bsc",
  collect:   true,
  fromBlock: 66214443,
  toBlock:   66329526,
  limit:     10_000,
  all:       false
};

interface StreamingMetrics {
  totalTime: number;
  ttfb: number;
  totalLogs: number;
  totalBytes: number;
  chunks: Array<{
    chunkNumber: number;
    logsInChunk: number;
    bytesInChunk: number;
    timeForChunk: number;
    mbps: number;
  }>;
  avgMbps: number;
  logsPerSecond: number;
  totalDecodeTime: number;
  decodeBatches: number;
  avgDecodeTimePerBatch: number;
  decodeTimePerLog: number;
}

interface TestConfig {
  clientStreaming: boolean;
  decoderType: "viem" | "ethers";
}

interface TestResult {
  config: TestConfig;
  metrics: StreamingMetrics;
  logs: any[];
}

function now() { return Date.now(); }
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 B";
  const k = 1024; const sizes = ["B", "KB", "MB", "GB"]; const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${(bytes / Math.pow(k, i)).toFixed(2)} ${sizes[i]}`;
}
function formatDuration(ms: number): string { return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(2)}s`; }

function extractNumericArgsValues(args: any): any[] {
  const values: any[] = [];
  if (!args) return values;
  
  let maxLength = 0;
  if (typeof args.length === 'number' && args.length > 0) {
    maxLength = args.length;
  } else {
    const numericKeys = Object.keys(args)
      .filter(k => {
        const num = Number(k);
        return !isNaN(num) && num >= 0 && String(num) === k;
      })
      .map(k => Number(k))
      .sort((a, b) => a - b);
    if (numericKeys.length > 0) {
      maxLength = numericKeys[numericKeys.length - 1] + 1;
    }
  }
  
  for (let i = 0; i < maxLength; i++) {
    if (i in args && args[i] !== undefined) {
      values.push(args[i]);
    }
  }
  
  return values;
}

function pickStableFields(x: any) {
  const argsValues = x.args ? extractNumericArgsValues(x.args) : [];
  
  return {
    transactionHash: x.transactionHash ?? x._originalTransactionHash,
    logIndex: x.logIndex ?? x.index,
    blockNumber: x.blockNumber,
    address: (x.address ?? x.source)?.toLowerCase?.(),
    topic0: x.topics?.[0] ?? x.topic0,
    topicsLen: x.topics?.length ?? [x.topic0, x.topic1, x.topic2, x.topic3].filter(Boolean).length,
    dataLen: (x.data?.length || 0),
    hasArgs: !!x.args,
    argsValuesCount: argsValues.length,
    argsValues: argsValues,
  };
}

function compareArgsStrict(argsA: any, argsB: any, path: string = 'args'): { identical: boolean; differences: string[] } {
  const differences: string[] = [];

  const stringify = (value: any): string => {
    return JSON.stringify(value, (k, v) => typeof v === 'bigint' ? v.toString() : v);
  };

  const sortedA = Object.keys(argsA || {}).sort().reduce((acc: any, key: string) => {
    acc[key] = argsA[key];
    return acc;
  }, {} as any);
  
  const sortedB = Object.keys(argsB || {}).sort().reduce((acc: any, key: string) => {
    acc[key] = argsB[key];
    return acc;
  }, {} as any);
  
  const jsonA = stringify(sortedA);
  const jsonB = stringify(sortedB);
  
  if (jsonA !== jsonB) {
    differences.push(`Difference in ${path}: structures not identical`);
    
    const keysA = new Set(Object.keys(argsA || {}));
    const keysB = new Set(Object.keys(argsB || {}));
    const allKeys = new Set([...keysA, ...keysB]);
    
    const missingInB: string[] = [];
    const missingInA: string[] = [];
    const differentValues: string[] = [];
    
    for (const key of allKeys) {
      const hasA = keysA.has(key);
      const hasB = keysB.has(key);
      
      if (!hasA) {
        missingInA.push(`${key}=${stringify(argsB[key])}`);
      } else if (!hasB) {
        missingInB.push(`${key}=${stringify(argsA[key])}`);
      } else {
        const valA = stringify(argsA[key]);
        const valB = stringify(argsB[key]);
        if (valA !== valB) {
          differentValues.push(`${key}: A=${valA.substring(0, 100)}, B=${valB.substring(0, 100)}`);
        }
      }
    }
    
    if (missingInB.length > 0) {
      differences.push(`  Keys present in A but not in B: ${missingInB.join(', ')}`);
    }
    if (missingInA.length > 0) {
      differences.push(`  Keys present in B but not in A: ${missingInA.join(', ')}`);
    }
    if (differentValues.length > 0) {
      differences.push(`  Different values: ${differentValues.join('; ')}`);
    }
    
    if (jsonA.length < 1000 && jsonB.length < 1000) {
      differences.push(`  Object A complete:\n${stringify(sortedA).split('\n').map(l => `    ${l}`).join('\n')}`);
      differences.push(`  Object B complete:\n${stringify(sortedB).split('\n').map(l => `    ${l}`).join('\n')}`);
    } else {
      differences.push(`  Object A (truncated): ${jsonA.substring(0, 500)}...`);
      differences.push(`  Object B (truncated): ${jsonB.substring(0, 500)}...`);
    }
  }
  
  return {
    identical: differences.length === 0,
    differences
  };
}


function findCommonTransaction(results: TestResult[]): { txHash: string; logIndex: number; log: any } | null {
  if (results.length === 0 || results[0].logs.length === 0) return null;
  
  // Debug: log the structure of logs from each configuration
  if (results[0].logs.length <= 5) {
    console.log('\n🔍 DEBUG: Log structure from each configuration:');
    results.forEach((result, idx) => {
      const log = result.logs[0];
      console.log(`  Config ${idx}:`, {
        hasTransactionHash: !!log.transactionHash,
        hasOriginalTransactionHash: !!log._originalTransactionHash,
        transactionHash: log.transactionHash || log._originalTransactionHash,
        hasLogIndex: log.logIndex !== undefined,
        hasIndex: log.index !== undefined,
        logIndex: log.logIndex ?? log.index,
        keys: Object.keys(log).slice(0, 20)
      });
    });
  }
  
  // Try to find a transaction that exists in ALL results
  // Start with the first log of the first result
  const firstResult = results[0];
  
  for (const candidateLog of firstResult.logs) {
    const candidateTxHash = candidateLog.transactionHash ?? candidateLog._originalTransactionHash ?? candidateLog.transaction_hash;
    const candidateLogIndex = candidateLog.logIndex ?? candidateLog.index ?? candidateLog.log_index;
    
    if (!candidateTxHash || candidateLogIndex === undefined) {
      continue; // Skip logs without proper identifiers
    }
    
    // Check if this transaction exists in ALL other results
    let foundInAll = true;
    for (let i = 1; i < results.length; i++) {
      const found = results[i].logs.find((log: any) => {
        const txHash = log.transactionHash ?? log._originalTransactionHash ?? log.transaction_hash;
        const logIndex = log.logIndex ?? log.index ?? log.log_index;
        return txHash === candidateTxHash && logIndex === candidateLogIndex;
      });
      
      if (!found) {
        foundInAll = false;
        break;
      }
    }
    
    if (foundInAll) {
      return { txHash: candidateTxHash, logIndex: candidateLogIndex, log: candidateLog };
    }
  }
  
  // If no common transaction found, return null
  return null;
}

function getConfigLabel(config: TestConfig): string {
  const parts: string[] = [];
  parts.push(config.clientStreaming ? "streaming" : "legacy");
  parts.push(config.decoderType);
  return parts.join("+");
}

async function runTestConfig(config: TestConfig): Promise<TestResult> {
  const metrics: StreamingMetrics = { 
      totalTime: 0, ttfb: 0, totalLogs: 0, totalBytes: 0, chunks: [], avgMbps: 0, logsPerSecond: 0,
      totalDecodeTime: 0, decodeBatches: 0, avgDecodeTimePerBatch: 0, decodeTimePerLog: 0
    };
  
  let startTime = now();
  let firstByteTime: number | undefined;
  let chunkStartTime = now();
  let chunkLogs = 0;
  let chunkNumber = 0;
    let wireBytes = 0;
  
  let decodeStartTime: number | undefined;
  let decodeEndTime: number | undefined;
  let decodeTimeAccumulator = 0;

    const processor = async (logs: any[]) => {
    chunkLogs += logs.length;
    if (!firstByteTime && logs.length > 0) {
      firstByteTime = now();
      metrics.ttfb = (firstByteTime - startTime);
    }
    
    if (config.clientStreaming && chunkLogs >= 100000) {
      const chunkTime = now() - chunkStartTime;
      const bytes = wireBytes - metrics.totalBytes;
        const mbps = (bytes / 1024 / 1024) / (chunkTime / 1000);
      metrics.chunks.push({ chunkNumber: ++chunkNumber, logsInChunk: chunkLogs, bytesInChunk: bytes, timeForChunk: chunkTime, mbps });
      metrics.totalBytes += bytes;
      chunkLogs = 0;
      chunkStartTime = now();
    }
    
    if (!config.clientStreaming && chunkLogs >= 500_000) {
      const chunkTime = now() - chunkStartTime;
      metrics.chunks.push({ chunkNumber: ++chunkNumber, logsInChunk: chunkLogs, bytesInChunk: 0, timeForChunk: chunkTime, mbps: 0 });
      chunkLogs = 0;
      chunkStartTime = now();
    }
  };

  const logs = await getLogs({
      target: CONTRACT,
      topics,
      eventAbi: SWAP_ABI,
      chain: CONFIG.chain,
      fromBlock: CONFIG.fromBlock,
      toBlock: CONFIG.toBlock,
    clientStreaming: config.clientStreaming,
    decoderType: config.decoderType,
      onlyIndexer: true,
      all: CONFIG.all,
      limit: CONFIG.limit,
      debugMode: true,
      processor,
      collect: true,
    onWireStats: config.clientStreaming ? ({ bytesReceived }: any) => {
        wireBytes = bytesReceived;
    } : undefined,
      onDecodeStats: ({ decodeTime, itemsDecoded }: any) => {
      metrics.decodeBatches++;
      
      if (decodeStartTime === undefined) {
        decodeStartTime = now();
      }
      decodeEndTime = now();
      
      decodeTimeAccumulator += decodeTime;
      }
    } as any);

  const endTime = now();
  metrics.totalTime = endTime - startTime;
  metrics.totalLogs = logs.length;
  
  if (decodeStartTime !== undefined && decodeEndTime !== undefined) {
    const wallClockTime = decodeEndTime - decodeStartTime;

    if (metrics.decodeBatches > 1) {
      metrics.totalDecodeTime = wallClockTime;
    } else {
      metrics.totalDecodeTime = decodeTimeAccumulator;
    }
  } else if (decodeTimeAccumulator > 0) {
    metrics.totalDecodeTime = decodeTimeAccumulator;
  }
  
  if (config.clientStreaming) {
    const lastBytes = wireBytes - metrics.totalBytes;
    if (chunkLogs > 0) {
      const chunkTime = now() - chunkStartTime;
      const mbps = (lastBytes / 1024 / 1024) / (chunkTime / 1000);
      metrics.chunks.push({ chunkNumber: ++chunkNumber, logsInChunk: chunkLogs, bytesInChunk: lastBytes, timeForChunk: chunkTime, mbps });
      metrics.totalBytes += lastBytes;
    }
    if (metrics.chunks.length > 0) {
      metrics.avgMbps = metrics.chunks.reduce((s, c) => s + c.mbps, 0) / metrics.chunks.length;
    }
  }
  
  metrics.logsPerSecond = (logs.length / (metrics.totalTime / 1000));
  if (metrics.decodeBatches > 0) {
    metrics.avgDecodeTimePerBatch = metrics.totalDecodeTime / metrics.decodeBatches;
    metrics.decodeTimePerLog = metrics.totalDecodeTime / Math.max(metrics.totalLogs, 1);
  }

  return { config, metrics, logs };
}

describe("Indexer getLogs - All Configurations Comparison", () => {
  afterAll(() => {
    return new Promise(resolve => setTimeout(resolve, 100));
  });

  test("Compare all combinations: streaming/legacy × viem/ethers", async () => {
    // Define all combinations to test
    const allConfigs: TestConfig[] = [
      // Index 0: Streaming + Viem
      { clientStreaming: true, decoderType: "viem" },
      // Index 1: Streaming + Ethers
      { clientStreaming: true, decoderType: "ethers" },
      // Index 2: Legacy + Viem
      { clientStreaming: false, decoderType: "viem" },
      // Index 3: Legacy + Ethers
      { clientStreaming: false, decoderType: "ethers" },
    ];

    // Example: TEST_CONFIG_INDICES="2,3" to test only indices 2 and 3
    const testConfigIndicesEnv = process.env.TEST_CONFIG_INDICES;
    let configsToTest: TestConfig[] = allConfigs;
    
    if (testConfigIndicesEnv) {
      const indices = testConfigIndicesEnv
        .split(',')
        .map(s => parseInt(s.trim(), 10))
        .filter(idx => !isNaN(idx) && idx >= 0 && idx < allConfigs.length);
      
      if (indices.length > 0) {
        configsToTest = indices.map(idx => allConfigs[idx]);
        console.log(`🧪 Testing only configurations at indices: ${indices.join(', ')}`);
        console.log(`   Configurations: ${indices.map(idx => getConfigLabel(allConfigs[idx])).join(', ')}`);
      } else {
        console.warn(`⚠️  Invalid TEST_CONFIG_INDICES="${testConfigIndicesEnv}", testing all configurations`);
      }
    }

    const results: TestResult[] = [];
    for (const config of configsToTest) {
      const result = await runTestConfig(config);
      results.push(result);
    }

    const reportLines: string[] = [];
    
    reportLines.push("\n" + "=".repeat(80));
    reportLines.push("📊 COMPLETE COMPARISON - ALL CONFIGURATIONS");
    reportLines.push("=".repeat(80));

    results.forEach((result) => {
      const label = getConfigLabel(result.config);
      const m = result.metrics;
      reportLines.push(`\n${result.config.clientStreaming ? "🔵" : "🟡"} ${label.toUpperCase()}`);
      reportLines.push(`  📈 Total: ${m.totalLogs.toLocaleString()} logs in ${formatDuration(m.totalTime)}`);
      reportLines.push(`  ⚡ TTFB: ${formatDuration(m.ttfb)}`);
      if (result.config.clientStreaming) {
        reportLines.push(`  📦 Total size (wire): ${formatBytes(m.totalBytes)}`);
        reportLines.push(`  🚀 Average throughput: ${m.avgMbps.toFixed(2)} MB/s`);
      }
      reportLines.push(`  ⏱️  Logs/second: ${m.logsPerSecond.toFixed(0)}`);
      reportLines.push(`  📊 Chunks: ${m.chunks.length}`);
      if (m.decodeBatches > 0) {
        reportLines.push(`  🔧 Decode time: ${formatDuration(m.totalDecodeTime)} (${m.decodeBatches} batches)`);
        reportLines.push(`  🔧 Avg decode time/batch: ${formatDuration(m.avgDecodeTimePerBatch)}`);
        reportLines.push(`  🔧 Decode time/log: ${m.decodeTimePerLog.toFixed(3)}ms`);
        const decodePercentage = (m.totalDecodeTime / m.totalTime) * 100;
        reportLines.push(`  🔧 Decode % of total time: ${decodePercentage.toFixed(2)}%`);
      }
    });

    reportLines.push("\n" + "=".repeat(80));
    reportLines.push("⚖️  PERFORMANCE COMPARISON");
    reportLines.push("=".repeat(80));

    reportLines.push("\n📊 DETAILED COMPARISON TABLE:");
    reportLines.push("Config".padEnd(35) + "Total Time".padEnd(15) + "Decode Time".padEnd(15) + "Logs/s".padEnd(12) + "Decode %");
    reportLines.push("-".repeat(92));
    results.forEach((r) => {
      const label = getConfigLabel(r.config);
      const totalTime = formatDuration(r.metrics.totalTime);
      const decodeTime = formatDuration(r.metrics.totalDecodeTime);
      const logsPerSec = r.metrics.logsPerSecond.toFixed(0);
      const decodePct = r.metrics.totalTime > 0 ? ((r.metrics.totalDecodeTime / r.metrics.totalTime) * 100).toFixed(1) + "%" : "0%";
      reportLines.push(
        label.padEnd(35) + 
        totalTime.padEnd(15) + 
        decodeTime.padEnd(15) + 
        logsPerSec.padEnd(12) + 
        decodePct
      );
    });

    reportLines.push("\n" + "=".repeat(80));
    reportLines.push("🔧 DECODER TYPE IMPACT ANALYSIS");
    reportLines.push("=".repeat(80));

    const streamingViem = results.find(r => 
      r.config.clientStreaming && r.config.decoderType === "viem"
    );
    const streamingEthers = results.find(r => 
      r.config.clientStreaming && r.config.decoderType === "ethers"
    );

    if (streamingViem && streamingEthers) {
      const timeImprovement = ((streamingEthers.metrics.totalTime - streamingViem.metrics.totalTime) / streamingEthers.metrics.totalTime) * 100;
      const decodeImprovement = ((streamingEthers.metrics.totalDecodeTime - streamingViem.metrics.totalDecodeTime) / streamingEthers.metrics.totalDecodeTime) * 100;
      reportLines.push(`\nStreaming: Viem vs Ethers`);
      reportLines.push(`  Total time improvement: ${timeImprovement > 0 ? '+' : ''}${timeImprovement.toFixed(2)}%`);
      reportLines.push(`  Decode time improvement: ${decodeImprovement > 0 ? '+' : ''}${decodeImprovement.toFixed(2)}%`);
    }

    const legacyViem = results.find(r => 
      !r.config.clientStreaming && r.config.decoderType === "viem"
    );
    const legacyEthers = results.find(r => 
      !r.config.clientStreaming && r.config.decoderType === "ethers"
    );

    if (legacyViem && legacyEthers) {
      const timeImprovement = ((legacyEthers.metrics.totalTime - legacyViem.metrics.totalTime) / legacyEthers.metrics.totalTime) * 100;
      const decodeImprovement = ((legacyEthers.metrics.totalDecodeTime - legacyViem.metrics.totalDecodeTime) / legacyEthers.metrics.totalDecodeTime) * 100;
      reportLines.push(`\nLegacy: Viem vs Ethers`);
      reportLines.push(`  Total time improvement: ${timeImprovement > 0 ? '+' : ''}${timeImprovement.toFixed(2)}%`);
      reportLines.push(`  Decode time improvement: ${decodeImprovement > 0 ? '+' : ''}${decodeImprovement.toFixed(2)}%`);
    }

    reportLines.push("\n" + "=".repeat(80));
    
    const firstResult = results[0];
    expect(firstResult.logs.length).toBeGreaterThan(0);

    for (let i = 1; i < results.length; i++) {
      const current = results[i];
      expect(current.logs.length).toBe(firstResult.logs.length);
    }
    
    reportLines.push("\n" + "=".repeat(80));
    reportLines.push("🔍 STRICT ARGS VALIDATION - Same Transaction Across All Configs");
    reportLines.push("=".repeat(80));
    
    const commonTx = findCommonTransaction(results);
    let allArgsIdentical = true;
    const allDifferences: string[] = [];
    
    if (commonTx) {
      reportLines.push(`\n📍 Reference transaction:`);
      reportLines.push(`   TX Hash: ${commonTx.txHash}`);
      reportLines.push(`   Log Index: ${commonTx.logIndex}`);
      
      const txLogs: { config: TestConfig; log: any }[] = [];
      for (const result of results) {
        const log = result.logs.find((l: any) => {
          const txHash = l.transactionHash ?? l._originalTransactionHash;
          const logIndex = l.logIndex ?? l.index;
          return txHash === commonTx.txHash && logIndex === commonTx.logIndex;
        });
        
        if (log) {
          txLogs.push({ config: result.config, log });
        }
      }
      
      if (txLogs.length === results.length) {
        reportLines.push(`\n✅ Transaction found in all ${txLogs.length} configurations`);
        
        const refLog = txLogs[0].log;
        const refConfig = getConfigLabel(txLogs[0].config);
        
        if (refLog.args) {
          const viemExample = txLogs.find(tx => tx.config.decoderType === "viem");
          const ethersExample = txLogs.find(tx => tx.config.decoderType === "ethers");
          
          if (viemExample && viemExample.log.args) {
            reportLines.push(`\n📋 EXAMPLE ARGS - VIEM (${getConfigLabel(viemExample.config)}):`);
            const viemArgsDisplay = JSON.stringify(viemExample.log.args, (key, value) => {
              if (typeof value === 'bigint') {
                return value.toString();
              }
              return value;
            }, 2);
            if (viemArgsDisplay.length > 2000) {
              reportLines.push(viemArgsDisplay.substring(0, 2000) + "\n  ... (truncated)");
            } else {
              reportLines.push(viemArgsDisplay.split('\n').map(l => `  ${l}`).join('\n'));
            }
          }
          
          if (ethersExample && ethersExample.log.args) {
            reportLines.push(`\n📋 EXAMPLE ARGS - ETHERS (${getConfigLabel(ethersExample.config)}):`);
            const ethersArgsDisplay = JSON.stringify(ethersExample.log.args, (key, value) => {
              if (typeof value === 'bigint') {
                return value.toString();
              }
              return value;
            }, 2);
            if (ethersArgsDisplay.length > 2000) {
              reportLines.push(ethersArgsDisplay.substring(0, 2000) + "\n  ... (truncated)");
            } else {
              reportLines.push(ethersArgsDisplay.split('\n').map(l => `  ${l}`).join('\n'));
            }
          }
          
          reportLines.push(`\n🔬 Strict args comparison:`);
          reportLines.push(`   Reference: ${refConfig}`);
          
          for (let i = 1; i < txLogs.length; i++) {
            const current = txLogs[i];
            const currentConfig = getConfigLabel(current.config);
            
            const comparison = compareArgsStrict(refLog.args, current.log.args, `${refConfig} vs ${currentConfig}`);
            
            if (!comparison.identical) {
              allArgsIdentical = false;
              reportLines.push(`\n   ❌ Difference detected: ${currentConfig}`);
              comparison.differences.forEach(diff => {
                reportLines.push(`      ${diff}`);
                allDifferences.push(`${currentConfig}: ${diff}`);
              });
            } else {
              reportLines.push(`   ✅ ${currentConfig}: identical`);
            }
          }
          
          if (allArgsIdentical) {
            reportLines.push(`\n✅ All args are strictly identical across all configurations!`);
          } else {
            reportLines.push(`\n❌ ERROR: Differences detected in decoded args!`);
          }
        } else {
          reportLines.push(`\n⚠️  No args in reference transaction`);
        }
      } else {
        reportLines.push(`\n⚠️  Transaction not found in all configurations (${txLogs.length}/${results.length})`);
      }
    } else {
      reportLines.push(`\n⚠️  Unable to find a common transaction across all configurations`);
    }
    
    console.log(reportLines.join("\n"));
    
    if (!allArgsIdentical && allDifferences.length > 0) {
      throw new Error(`Args decoding mismatch:\n${allDifferences.join('\n')}`);
    }
    
    // Compare logs by transactionHash + logIndex instead of by index
    // (logs may be in different order between configurations)
    for (let i = 1; i < results.length; i++) {
      const current = results[i];
      
      if (current.logs.length > 0 && firstResult.logs.length > 0) {
        // Create a map of logs by transactionHash+logIndex for current config
        const currentLogsMap = new Map<string, any>();
        for (const log of current.logs) {
          const txHash = log.transactionHash ?? log._originalTransactionHash;
          const logIndex = log.logIndex ?? log.index;
          if (txHash && logIndex !== undefined) {
            const key = `${txHash}-${logIndex}`;
            currentLogsMap.set(key, log);
          }
        }
        
        // Sample a few logs from firstResult and find them in current config
        const sampleIndices = [0, Math.floor(firstResult.logs.length / 2), firstResult.logs.length - 1].filter(idx => idx < firstResult.logs.length);
        for (const idx of sampleIndices) {
          const logA = firstResult.logs[idx];
          const fieldsA = pickStableFields(logA);
          const txHashA = logA.transactionHash ?? logA._originalTransactionHash;
          const logIndexA = logA.logIndex ?? logA.index;
          
          if (!txHashA || logIndexA === undefined) {
            continue; // Skip if missing identifiers
          }
          
          const key = `${txHashA}-${logIndexA}`;
          const logB = currentLogsMap.get(key);
          
          if (!logB) {
            // Log not found in current config - this is acceptable if configs have different results
            continue;
          }
          
          const fieldsB = pickStableFields(logB);
          
          expect(fieldsB.transactionHash).toBe(fieldsA.transactionHash);
          expect(fieldsB.blockNumber).toBe(fieldsA.blockNumber);
          expect(fieldsB.logIndex).toBe(fieldsA.logIndex);
          expect(fieldsB.address).toBe(fieldsA.address);
          expect(fieldsB.topic0).toBe(fieldsA.topic0);
          expect(fieldsB.hasArgs).toBe(fieldsA.hasArgs);
          
          if (fieldsA.hasArgs && fieldsB.hasArgs) {
            const valuesA = fieldsA.argsValues;
            const valuesB = fieldsB.argsValues;
            
            expect(valuesB.length).toBe(valuesA.length);
            
            for (let j = 0; j < Math.min(valuesA.length, valuesB.length); j++) {
              const valA = valuesA[j];
              const valB = valuesB[j];
              
              if (typeof valA === 'bigint' && typeof valB === 'bigint') {
                expect(valB).toBe(valA);
              } else if (typeof valA === 'bigint' || typeof valB === 'bigint') {
                expect(String(valB)).toBe(String(valA));
              } else if (typeof valA === 'object' && typeof valB === 'object' && valA !== null && valB !== null) {
                expect(JSON.stringify(valB)).toBe(JSON.stringify(valA));
              } else {
                expect(valB).toBe(valA);
              }
            }
          }
        }
      }
    }
  });
});
