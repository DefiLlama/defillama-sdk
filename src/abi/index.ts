import { Address, ByteCodeCallOptions, LogArray, } from "../types";
import catchedABIs from "./cachedABIs";
import { ethers } from "ethers";
import { getProvider, Chain } from "../general";
import makeMultiCall, { isMulticallV3Supported } from "./multicall3";
import { isContractRevert } from "./rpcCall";
import convertResults from "./convertResults";
import { debugLog } from "../util/debugLog";
import { getRpcCallCacheRule, isRpcCallCacheEnabled, isRpcCallCacheRuleActive, readRpcCallCache, writeRpcCallCache, RpcCallCacheRule, } from "../util/rpcCallCache";
import { runInPromisePool, sliceIntoChunks, } from "../util";
import { fixTronCallParams, formError } from "../util/common";
import { getDefaultChunkSize } from "../util/env";
import { recordReads } from "../util/callStats";

const nullAddress = '0x0000000000000000000000000000000000000000'

// https://docs.soliditylang.org/en/latest/abi-spec.html
const knownTypes = [
  'string', 'address', 'bool', 'bytes32',
  'int', 'int8', 'int16', 'int24', 'int32', 'int64', 'int96', 'int128', 'int256',
  'uint', 'uint8', 'uint16', 'uint24', 'uint32', 'uint64', 'uint96', 'uint128', 'uint256',
];

([...knownTypes]).forEach(i => knownTypes.push(i + '[]')) // support array type for all known types


function resolveABI(providedAbi: string | any) {
  if (!providedAbi) throw new Error('Missing ABI parameter!')
  let abi = providedAbi;
  if (typeof abi === "string") {
    const [outputType, name] = providedAbi.split(':')
    if (!knownTypes.includes(outputType) || !name) {
      const contractInterface = new ethers.Interface([providedAbi])
      const jsonAbi = contractInterface.formatJson()
      return JSON.parse(jsonAbi as string)[0]
    }

    abi = {
      constant: true,
      inputs: [],
      name,
      outputs: [
        {
          internalType: outputType,
          name: "",
          type: outputType,
        },
      ],
      payable: false,
      stateMutability: "view",
      type: "function",
    }
  }
  // If type is omitted DP's sdk processes it fine but we don't, so we need to add it
  return {
    type: "function",
    ...abi,
  };
}

type CallParams = any;

type CallOptions = {
  target: Address;
  abi: string | any;
  block?: number | string;
  timestamp?: number; // unix timestamp of `block`, only used to tell whether the call reads the current state (rpc call cache)
  params?: CallParams;
  chain?: Chain | string;
  skipCache?: boolean;
  logArray?: LogArray;
}

type MulticallOptions = {
  abi: string | any;
  calls: {
    target?: Address;
    params?: CallParams;
  }[];
  block?: number | string;
  timestamp?: number; // unix timestamp of `block`, only used to tell whether the call reads the current state (rpc call cache)
  target?: Address; // Used when calls.target is not provided
  chain?: Chain | string;
  chunkSize?: number;
  skipCache?: boolean;
  contractCalls?: any;
  permitFailure?: boolean;
  logArray?: LogArray;
}

function normalizeParams(params: CallParams): (any)[] {
  if (params === undefined) {
    return [];
  } else if (typeof params === "object") {
    return params;
  } else {
    return [params];
  }
}

function fixBlockTag(params: any) {
  let { block } = params
  if (typeof block !== 'string' || block === 'latest') return;
  block = +block
  if (isNaN(block)) throw new Error('Invalid block: ' + params.block)
  params.block = block
}

function isValidTarget(target: string, chain?: string) {
  if (typeof target !== 'string') return false
  return target.startsWith('0x') && target !== nullAddress
}

export async function call(params: CallOptions): Promise<any> {
  if (!params.abi) throw new Error('Missing ABI parameter ("abis" is supported only in abi2/ChainApi)!')

  if (params.chain === 'tron')
    fixTronCallParams(params)

  if (!isValidTarget(params.target, params.chain)) throw new Error('Invalid target: ' + params.target)
  fixBlockTag(params)
  const chain = params.chain ?? "ethereum";
  if (catchedABIs[params.abi]) params.abi = catchedABIs[params.abi]
  recordReads(chain, params.abi, [{ target: params.target, params: params.params }])
  let errorParams: any = { ...params }
  let rpcCalled = false
  try {

    if (!params.skipCache) return cachedCall(params)
    const abi = resolveABI(params.abi);
    const callParams = normalizeParams(params.params);
    // if (chain === 'tron') return Tron.call({ ...params, abi, params: callParams })

    const contractInterface = new ethers.Interface([abi]);
    const functionABI = ethers.FunctionFragment.from(abi);
    const callData = contractInterface.encodeFunctionData(
      functionABI,
      callParams
    );

    const provider = getProvider(chain as Chain);
    errorParams.provider = provider
    rpcCalled = true
    const result = await provider.call({
      to: params.target,
      data: callData,
      blockTag: params.block,
    });
    errorParams.result = result
    const decodedResult = contractInterface.decodeFunctionResult(abi, result);

    const output = convertResults(decodedResult, { functionABI, chain });


    if (params.logArray && abi.name == 'balanceOf' && abi.outputs[0].type == 'uint256')
      params.logArray.push({
        chain,
        token: params.target,
        holder: Array.isArray(params.params) ? params.params[0] : params.params,
        amount: output
      });

    return {
      output,
    };
  } catch (e: any) {
    errorParams.isCallError = true
    const error: any = formError(e, errorParams)
    // isContractFailure: the node answered and the contract rejected the call (revert, or a result that cannot be
    // decoded). isRpcFailure: the rpc could not be reached or did not execute the call. Set once, where the rpc was called
    if (error && typeof error === 'object' && error.isContractFailure === undefined) {
      error.isContractFailure = !!e?.isContractFailure || errorParams.result !== undefined || isContractRevert(e)
      error.isRpcFailure = rpcCalled && !error.isContractFailure
    }
    throw error
  }
}

export async function bytecodeCall(params: ByteCodeCallOptions): Promise<any> {
  fixBlockTag(params)
  const { block, bytecode, inputTypes, inputs, outputTypes, chain } = params
  if (!bytecode) throw new Error('Missing bytecode parameter!')
  if (chain === 'tron') throw new Error('Bytecode call is not supported on Tron')

  const inputData = ethers.AbiCoder.defaultAbiCoder().encode(inputTypes, inputs);
  const callData = '0x' + bytecode.concat(inputData.slice(2))

  const result = await getProvider(chain as Chain).call({ data: callData, blockTag: block });
  const decodedResult = ethers.AbiCoder.defaultAbiCoder().decode(outputTypes, result)

  return {
    output: convertResults(decodedResult, { chain }),
  };
}

export async function multiCall(params: MulticallOptions): Promise<any> {

  if (!params.abi) throw new Error('Missing ABI parameter ("abis" is supported only in abi2/ChainApi)!')


  fixBlockTag(params)

  if (params.chain === 'tron')
    fixTronCallParams(params)

  if (catchedABIs[params.abi]) params.abi = catchedABIs[params.abi]
  const chain = params.chain ?? 'ethereum'
  if (!params.calls) throw new Error('Missing calls parameter')
  if (params.target && !isValidTarget(params.target, chain)) throw new Error('Invalid target: ' + params.target)

  if (!params.calls.length) {
    return { output: [] }
  }

  let chunkSize: number = params.chunkSize as number
  if (!params.chunkSize) {
    // Only a max of around 500 calls are supported by multicall, we have to split bigger batches
    chunkSize = getDefaultChunkSize(chain)
  }

  if (!params.target && !params.permitFailure) {
    // check if target adddress is missing for one of the calls
    if (params.calls.some((i: any) => {
      if (typeof i === 'string' && i.startsWith('0x')) return !isValidTarget(i, params.chain)
      if (typeof i === 'object') return !isValidTarget(i.target, params.chain)
      return true
    })) {
      // debugLog('Multicall is missing target', JSON.stringify(params, null, 2))
      throw new Error('Multicall is missing a target')
    }
  }

  let contractCalls = params.contractCalls;
  if (!contractCalls) {

    contractCalls = (params.calls).map((call: any) => {
      const callParams = normalizeParams(call.params);
      return {
        params: callParams,
        contract: call.target ?? params.target,
      };
    })
    params.contractCalls = contractCalls
  }
  recordReads(chain, params.abi, contractCalls)
  if (!params.skipCache) return cachedMultiCall(params)

  const abi = resolveABI(params.abi);
  const chunkedCalls = sliceIntoChunks(contractCalls, chunkSize)
  // permitFailure covers calls the contract rejects (revert, undecodable result), those come back as
  // { success: false, output: null }. It never covers the rpc: if a batch cannot be executed the promise pool
  // throws, with or without permitFailure, instead of reporting every call of the batch as failed.
  const results = await runInPromisePool({
    items: chunkedCalls,
    concurrency: 10,
    processor: (calls: any) => makeMultiCallBatch(abi, calls, chain as Chain, params.block, !!params.permitFailure),
  })

  const flatResults = [].concat.apply([], results) as any[]

  const failedQueries = flatResults.filter(r => !r.success)
  if (failedQueries.length) {
    // debugLog(`[chain: ${params.chain ?? "ethereum"}] [abi: ${params.abi}] Failed multicalls:`, failedQueries.map(r => r.input))
    if (!params.permitFailure) {
      (params as any).failedQueries = failedQueries;
      (params as any).isMultiCallError = true
      throw formError(null, params)
    }
  }

  if (params.logArray && abi.name == 'balanceOf' && abi.outputs[0].type == 'uint256')
    params.logArray.push(
      ...contractCalls.map((c: any, i: number) => ({
        chain,
        holder: c.params.length ? c.params[0] : c.params,
        token: c.contract,
        amount: flatResults[i].output
      })),
    );

  return {
    output: flatResults, // flatten array
  };
}

// One multicall batch. Calls with an unusable target are failed up front under permitFailure (they are a caller
// problem and never reach the rpc). If the rpc cannot execute a multicall3 batch, its first call is sent alone:
// if that fails too the rpc is down (or the call cannot be executed) and the error is thrown right away, otherwise
// the batch was too heavy for the node (gas cap, cpu limit, timeout) and the rest is halved and retried, halves one
// after the other. The legacy path splits a failed batch on its own, see multicall.ts
async function makeMultiCallBatch(abi: any, calls: any[], chain: Chain, block: number | string | undefined, permitFailure: boolean): Promise<any[]> {
  if (permitFailure && calls.some((call: any) => !isValidTarget(call.contract, chain))) {
    const validCalls = calls.filter((call: any) => isValidTarget(call.contract, chain))
    const validResults = validCalls.length ? await makeMultiCallBatch(abi, validCalls, chain, block, false) : []
    let validIndex = 0
    return calls.map((call: any) => isValidTarget(call.contract, chain)
      ? validResults[validIndex++]
      : { input: { params: call.params, target: call.contract }, success: false, output: null })
  }

  try {
    return await makeMultiCall(abi, calls, chain, block)
  } catch (e) {
    if (calls.length <= 1 || !isMulticallV3Supported(chain, block)) throw e
    debugLog(`[chain: ${chain}] multicall batch of ${calls.length} failed, retrying it in smaller batches`)
    const first = await makeMultiCall(abi, calls.slice(0, 1), chain, block)
    const rest = calls.slice(1)
    const mid = Math.ceil(rest.length / 2)
    const firstHalf = await makeMultiCallBatch(abi, rest.slice(0, mid), chain, block, false)
    const secondHalf = mid < rest.length ? await makeMultiCallBatch(abi, rest.slice(mid), chain, block, false) : []
    return [...first, ...firstHalf, ...secondHalf]
  }
}

const cacheRulesByAbiString = new Map<string, RpcCallCacheRule | undefined>()
const RECENT_CALL_WINDOW = 2 * 60 * 60 // same window ChainApi uses to decide whether a timestamp needs a block

// A call is recent when it reads the current state of the chain: it has no block, or it carries the timestamp of
// its block (ChainApi passes its own) and that is within the last two hours. A block alone says nothing about its age.
function isRecentCall(params: { block?: number | string, timestamp?: number }): boolean {
  if (params.block === undefined || params.block === null || params.block === 'latest') return true
  return typeof params.timestamp === 'number' && params.timestamp > Date.now() / 1000 - RECENT_CALL_WINDOW
}

// undefined if the call must not go through the cache: cache disabled, abi not cacheable, or a value that can change
// over time (cached only for recent calls, and only with RPC_CALL_CACHE_ADDRESS)
function getCacheRule(params: { abi: any, block?: number | string, timestamp?: number }): RpcCallCacheRule | undefined {
  if (!isRpcCallCacheEnabled()) return undefined

  const isStringAbi = typeof params.abi === 'string'
  let rule: RpcCallCacheRule | undefined
  if (isStringAbi && cacheRulesByAbiString.has(params.abi)) rule = cacheRulesByAbiString.get(params.abi)
  else {
    try {
      rule = getRpcCallCacheRule(resolveABI(params.abi))
    } catch (e) { } // a bad abi is reported by the call itself
    if (isStringAbi) cacheRulesByAbiString.set(params.abi, rule)
  }

  if (rule && !isRpcCallCacheRuleActive(rule, { isRecent: isRecentCall(params) })) return undefined
  return rule
}

const CACHED_FAILURE_MESSAGE = 'call failed on previous runs, the failure is cached (skipCache: true to retry it)'

async function cachedCall(params: CallOptions) {
  params.skipCache = true
  const rule = getCacheRule(params)
  if (!rule) return call(params)

  const chain = params.chain ?? 'ethereum'
  const options = { isRecent: isRecentCall(params) }
  const cacheCall = { target: params.target, params: normalizeParams(params.params) }
  const [entry] = await readRpcCallCache(chain, rule, [cacheCall], options)

  if (entry && 'output' in entry) return { output: entry.output }
  if (entry && 'failure' in entry) {
    const error: any = new Error(CACHED_FAILURE_MESSAGE)
    error.isContractFailure = true
    throw error
  }

  let value: any
  try {
    value = await call(params)
  } catch (e: any) {
    // an rpc failure says nothing about the contract, only a contract level failure is remembered
    if (e?.isContractFailure)
      await writeRpcCallCache(chain, rule, [{ ...cacheCall, failed: true, failedOnceAt: entry?.failedOnceAt }], options)
    throw e
  }
  await writeRpcCallCache(chain, rule, [{ ...cacheCall, output: value.output }], options)
  return value
}


async function cachedMultiCall(params: MulticallOptions) {
  params.skipCache = true
  const chain = params.chain ?? 'ethereum'
  const rule = getCacheRule(params)

  const response: any = []
  const validCalls: any[] = []
  const validIndices: number[] = []

  params.contractCalls.forEach((value: any, i: number) => {
    if (!isValidTarget(value.contract, params.chain)) {
      response[i] = {
        input: { target: value.contract, params: value.params, },
        output: null,
        success: false,
      }
      debugLog(params.abi, 'Bad target passed:', value.contract, 'skipping call and returning null output for this')
      return;
    }

    validCalls.push(value)
    validIndices.push(i)
  })

  if (!rule) {
    if (!validCalls.length) return { output: response }
    params.contractCalls = validCalls
    const { output } = await multiCall(params)
    output.forEach((value: any, i: number) => {
      response[validIndices[i]] = value
    })
    return { output: response }
  }

  const options = { isRecent: isRecentCall(params) }
  const entries = await readRpcCallCache(chain, rule, validCalls.map((value: any) => ({ target: value.contract, params: value.params })), options)

  const missing: any = []
  const missingIndices: number[] = []
  const missingFailedOnceAt: (number | undefined)[] = []

  validCalls.forEach((value: any, i: number) => {
    const entry = entries[i]
    const input = { target: value.contract, params: value.params, }
    if (entry && 'output' in entry) {
      response[validIndices[i]] = { input, output: entry.output, success: true, }
      return;
    }
    if (entry && 'failure' in entry) {
      response[validIndices[i]] = { input, output: null, success: false, error: new Error(CACHED_FAILURE_MESSAGE), }
      return;
    }

    missing.push(value)
    missingIndices.push(validIndices[i])
    missingFailedOnceAt.push(entry?.failedOnceAt)
  })

  if (missing.length) {
    // Failures are permitted for the rpc round trip so that the results of the calls that did succeed (and the
    // failures of the ones that did not) reach the cache. An rpc failure still throws from multiCall, and the
    // caller's own permitFailure is applied to the full response below.
    const permitFailure = params.permitFailure
    params.contractCalls = missing
    params.permitFailure = true
    let fetched: any[]
    try {
      fetched = (await multiCall(params)).output
    } finally {
      params.permitFailure = permitFailure
    }

    fetched.forEach((value: any, i: number) => {
      response[missingIndices[i]] = value
    })

    await writeRpcCallCache(chain, rule, fetched.map((value: any, i: number) => {
      const cacheCall = { target: value.input.target, params: value.input.params }
      if (value.success) return { ...cacheCall, output: value.output }
      return { ...cacheCall, failed: true as const, failedOnceAt: missingFailedOnceAt[i] }
    }), options)
  }

  const failedQueries = response.filter((value: any) => !value.success)
  if (failedQueries.length && !params.permitFailure) {
    (params as any).failedQueries = failedQueries;
    (params as any).isMultiCallError = true
    throw formError(null, params)
  }

  return { output: response }
}