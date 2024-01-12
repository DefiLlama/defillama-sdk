import { getArchivalRPCs, getBatchMaxCount, getChainId, getChainRPCs, getDefaultChunkSize, getEnvMulticallAddress, getEnvCacheFolder, getEnvRPC, getEnvValue, getMaxParallelRequests, getParallelGetLogsLimit, } from './env'

import { ChainApi } from '../ChainApi'


test("cronos calls over batch limit", async () => {
  const limit = getBatchMaxCount("cronos") + 10
  const call = '0x66e428c3f67a68878562e79a0234c1f83c208770'
  const calls = [] as any
  for (let i = 0; i < limit + 1; i++)
    calls.push(call)

  const cronosApi = new ChainApi({ chain: 'cronos' })
  await Promise.all(calls.map((call: any) => cronosApi.call({ target: call, abi: 'string:name' })))
});

test("getArchivalRPCs", async () => {
  const llamaP = getArchivalRPCs("llama-chain")
  expect(llamaP.length).toBe(0)
});


test("getChainId", async () => {
  process.env['SDK_TESTCHAIN_RPC_CHAIN_ID'] = '1234';
  const chainId = getChainId("testchain", undefined)
  expect(chainId).toBe(1234) // value from process.env
  delete process.env['SDK_TESTCHAIN_RPC_CHAIN_ID'];
});

test("getMaxParallelRequests", async () => {
  process.env['SDK_TESTCHAIN_RPC_MAX_PARALLEL'] = '20';
  const maxParallelRequests = getMaxParallelRequests("testchain")
  expect(maxParallelRequests).toBe(20) // value from process.env
  delete process.env['SDK_TESTCHAIN_RPC_MAX_PARALLEL'];
});

test("getParallelGetLogsLimit", async () => {
  process.env['SDK_TESTCHAIN_RPC_GET_LOGS_CONCURRENCY_LIMIT'] = '10';
  const parallelGetLogsLimit = getParallelGetLogsLimit("testchain")
  expect(parallelGetLogsLimit).toBe(10) // value from process.env
  delete process.env['SDK_TESTCHAIN_RPC_GET_LOGS_CONCURRENCY_LIMIT'];
});

test("getEnvRPC", async () => {
  process.env['SDK_TESTCHAIN_RPC'] = 'http://localhost:8545';
  const envRPC = getEnvRPC("testchain")
  expect(envRPC).toBe('http://localhost:8545') // value from process.env
  delete process.env['SDK_TESTCHAIN_RPC'];
});

test("getEnvMulticallAddress", async () => {
  process.env['TESTCHAIN_RPC_MULTICALL'] = '0x1234567890abcdef';
  const envMulticallAddress = getEnvMulticallAddress("testchain")
  expect(envMulticallAddress).toBe('0x1234567890abcdef') // value from process.env
  delete process.env['TESTCHAIN_RPC_MULTICALL'];
});

test("getDefaultChunkSize", async () => {
  process.env['TESTCHAIN_MULTICALL_CHUNK_SIZE'] = '200';
  const defaultChunkSize = getDefaultChunkSize("testchain")
  expect(defaultChunkSize).toBe(200) // value from process.env
  delete process.env['TESTCHAIN_MULTICALL_CHUNK_SIZE'];
});

test("getBatchMaxCount", async () => {
  process.env['TESTCHAIN_BATCH_MAX_COUNT'] = '10';
  const batchMaxCount = getBatchMaxCount("testchain")
  expect(batchMaxCount).toBe(10) // value from process.env
  delete process.env['TESTCHAIN_BATCH_MAX_COUNT'];
});

test("getArchivalRPCs", async () => {
  process.env['TESTCHAIN_ARCHIVAL_RPC'] = 'http://localhost:8545,http://localhost:8546';
  const archivalRPCs = getArchivalRPCs("testchain")
  expect(archivalRPCs).toEqual(['http://localhost:8545', 'http://localhost:8546']) // value from process.env
  delete process.env['TESTCHAIN_ARCHIVAL_RPC'];
});

test("getChainRPCs", async () => {
  process.env['TESTCHAIN_RPC'] = 'http://localhost:8545,http://localhost:8546';
  const chainRPCs = getChainRPCs("testchain")
  expect(chainRPCs).toBe('http://localhost:8545,http://localhost:8546') // value from process.env
  delete process.env['TESTCHAIN_RPC'];
});

test("getChainId", async () => {
  const chainId = getChainId("testchain", undefined)
  expect(chainId).toBeUndefined()

  process.env['TESTCHAIN_RPC_CHAIN_ID'] = '1234';
  const chainIdAfter = getChainId("testchain", undefined)
  expect(chainIdAfter).toBe(1234) // value from process.env
  delete process.env['TESTCHAIN_RPC_CHAIN_ID'];
});

test("getMaxParallelRequests", async () => {
  const maxParallelRequests = getMaxParallelRequests("testchain")
  expect(maxParallelRequests).toBe(100) // default value

  process.env['TESTCHAIN_RPC_MAX_PARALLEL'] = '20';
  const maxParallelRequestsAfter = getMaxParallelRequests("testchain")
  expect(maxParallelRequestsAfter).toBe(20) // value from process.env
  delete process.env['TESTCHAIN_RPC_MAX_PARALLEL'];
});

test("getParallelGetLogsLimit", async () => {
  const parallelGetLogsLimit = getParallelGetLogsLimit("testchain")
  expect(parallelGetLogsLimit).toBe(42) // default value

  process.env['TESTCHAIN_RPC_GET_LOGS_CONCURRENCY_LIMIT'] = '10';
  const parallelGetLogsLimitAfter = getParallelGetLogsLimit("testchain")
  expect(parallelGetLogsLimitAfter).toBe(10) // value from process.env
  delete process.env['TESTCHAIN_RPC_GET_LOGS_CONCURRENCY_LIMIT'];
});

test("getEnvRPC", async () => {
  const envRPC = getEnvRPC("testchain")
  expect(envRPC).toBeUndefined()

  process.env['SDK_TESTCHAIN_RPC'] = 'http://localhost:8545';
  const envRPCAfter = getEnvRPC("testchain")
  expect(envRPCAfter).toBe('http://localhost:8545') // value from process.env
  delete process.env['SDK_TESTCHAIN_RPC'];
});

test("getEnvMulticallAddress", async () => {
  const envMulticallAddress = getEnvMulticallAddress("testchain")
  expect(envMulticallAddress).toBeUndefined()

  process.env['SDK_TESTCHAIN_RPC_MULTICALL'] = '0x1234567890abcdef';
  const envMulticallAddressAfter = getEnvMulticallAddress("testchain")
  expect(envMulticallAddressAfter).toBe('0x1234567890abcdef') // value from process.env
  delete process.env['SDK_TESTCHAIN_RPC_MULTICALL'];
});

test("getDefaultChunkSize", async () => {
  process.env['SDK_TESTCHAIN_MULTICALL_CHUNK_SIZE'] = '200';
  const defaultChunkSizeAfter = getDefaultChunkSize("testchain")
  expect(defaultChunkSizeAfter).toBe(200) // value from process.env
  delete process.env['SDK_TESTCHAIN_MULTICALL_CHUNK_SIZE'];
});

test("getBatchMaxCount", async () => {
  const batchMaxCount = getBatchMaxCount("testchain")
  expect(batchMaxCount).toBe(99) // default value

  process.env['TESTCHAIN_BATCH_MAX_COUNT'] = '10';
  const batchMaxCountAfter = getBatchMaxCount("testchain")
  expect(batchMaxCountAfter).toBe(10) // value from process.env
  delete process.env['TESTCHAIN_BATCH_MAX_COUNT'];
});

test("getArchivalRPCs", async () => {
  const archivalRPCs = getArchivalRPCs("testchain")
  expect(archivalRPCs).toEqual([]) // default value

  process.env['SDK_TESTCHAIN_ARCHIVAL_RPC'] = 'http://localhost:8545,http://localhost:8546';
  const archivalRPCsAfter = getArchivalRPCs("testchain")
  expect(archivalRPCsAfter).toEqual(['http://localhost:8545', 'http://localhost:8546']) // value from process.env
  delete process.env['SDK_TESTCHAIN_ARCHIVAL_RPC'];
});

test("getChainRPCs", async () => {
  const chainRPCs = getChainRPCs("testchain")
  expect(chainRPCs).toBeUndefined()

  process.env['TESTCHAIN_RPC'] = 'http://localhost:8545,http://localhost:8546';
  const chainRPCsAfter = getChainRPCs("testchain")
  expect(chainRPCsAfter).toBe('http://localhost:8545,http://localhost:8546') // value from process.env
  delete process.env['TESTCHAIN_RPC'];
});