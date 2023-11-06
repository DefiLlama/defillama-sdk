import { Address, ByteCodeCallOptions, LogArray, } from "../types";
import catchedABIs from "./cachedABIs";
import { ethers } from "ethers";
import { getProvider, Chain } from "../general";
import makeMultiCall from "./multicall3";
import convertResults from "./convertResults";
import { debugLog } from "../util/debugLog";
import { getCache, setCache, CacheOptions, } from "../util/internal-cache";
import { runInPromisePool, sliceIntoChunks, } from "../util";
import * as Tron from './tron'

const nullAddress = '0x0000000000000000000000000000000000000000'

// https://docs.soliditylang.org/en/latest/abi-spec.html
const knownTypes = [
  'string', 'address', 'bool',
  'int', 'int8', 'int16', 'int32', 'int64', 'int128', 'int256',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uint128', 'uint256',
];

([...knownTypes]).forEach(i => knownTypes.push(i + '[]')) // support array type for all known types

const defaultChunkSize = !!process.env.SDK_MULTICALL_CHUNK_SIZE ? +process.env.SDK_MULTICALL_CHUNK_SIZE : 300

function resolveABI(providedAbi: string | any) {
  if (!providedAbi) throw new Error('Missing ABI parameter!')
  let abi = providedAbi;
  if (typeof abi === "string") {
    const [outputType, name] = providedAbi.split(':')
    if (!knownTypes.includes(outputType) || !name) {
      const contractInterface = new ethers.utils.Interface([providedAbi])
      const jsonAbi = contractInterface.format(ethers.utils.FormatTypes.json)
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
  if (chain === 'tron') return true;
  return target.startsWith('0x') && target !== nullAddress
}

export async function call(params: CallOptions): Promise<any> {
  if (!isValidTarget(params.target, params.chain)) throw new Error('Invalid target: ' + params.target)
  fixBlockTag(params)
  const chain = params.chain ?? "ethereum";
  if (catchedABIs[params.abi]) params.abi = catchedABIs[params.abi]
  if (!params.skipCache) return cachedCall(params)
  const abi = resolveABI(params.abi);
  const callParams = normalizeParams(params.params);
  if (chain === 'tron') return Tron.call({ ...params, abi, params: callParams })

  const contractInterface = new ethers.utils.Interface([abi]);
  const functionABI = ethers.utils.FunctionFragment.from(abi);
  const callData = contractInterface.encodeFunctionData(
    functionABI,
    callParams
  );

  const result = await getProvider(params.chain as Chain).call(
    {
      to: params.target,
      data: callData,
    },
    params.block ?? "latest"
  );
  const decodedResult = contractInterface.decodeFunctionResult(
    functionABI,
    result
  );

  const output = convertResults(decodedResult)

  if (params.logArray && abi.name == 'balanceOf' && abi.outputs[0].type == 'uint256')
    params.logArray.push({
      chain,
      token: params.target,
      holder: params.params.length ? params.params[0] : params.params,
      amount: output
    });

  return {
    output,
  };
}

export async function bytecodeCall(params: ByteCodeCallOptions): Promise<any> {
  fixBlockTag(params)
  const { block, bytecode, inputTypes, inputs, outputTypes, chain } = params
  if (!bytecode) throw new Error('Missing bytecode parameter!')
  if (chain === 'tron') throw new Error('Bytecode call is not supported on Tron')

  const inputData = ethers.utils.defaultAbiCoder.encode(inputTypes, inputs);
  const callData = '0x' + bytecode.concat(inputData.slice(2))

  const result = await getProvider(chain as Chain).call({ data: callData, }, block ?? "latest");
  const decodedResult = ethers.utils.defaultAbiCoder.decode(outputTypes, result)

  return {
    output: convertResults(decodedResult),
  };
}

export async function multiCall(params: MulticallOptions): Promise<any> {
  fixBlockTag(params)
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
    chunkSize = defaultChunkSize
  }

  if (!params.target && !params.permitFailure) {
    // check if target adddress is missing for one of the calls
    if (params.calls.some((i: any) => {
      if (typeof i === 'string' && i.startsWith('0x')) return !isValidTarget(i, params.chain)
      if (typeof i === 'object') return !isValidTarget(i.target, params.chain)
      return true
    })) {
      debugLog('Multicall is missing target', JSON.stringify(params, null, 2))
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
  if (!params.skipCache) return cachedMultiCall(params)

  const abi = resolveABI(params.abi);
  const results = await runInPromisePool({
    items: sliceIntoChunks(contractCalls, chunkSize),
    concurrency: 10,
    processor: (calls: any) => makeMultiCall(abi, calls, chain as Chain, params.block)
  })

  const flatResults = [].concat.apply([], results) as any[]

  const failedQueries = flatResults.filter(r => !r.success)
  if (failedQueries.length) {
    debugLog(`[chain: ${params.chain ?? "ethereum"}] [abi: ${params.abi}] Failed multicalls:`, failedQueries.map(r => r.input))
    if (!params.permitFailure) throw new Error('Multicall failed!')
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

async function cachedCall(params: CallOptions) {
  params.skipCache = true
  if (!isCachableAbi(params.abi)) return call(params)
  const cacheObject: CacheOptions = {
    abi: params.abi,
    chain: params.chain,
    address: params.target,
  }
  const cachedValue = getCache(cacheObject)

  if (cachedValue)
    return {
      output: cachedValue
    }

  const value = await call(params)

  if (value) {
    cacheObject.value = value.output
    setCache(cacheObject)
  }

  return value
}


async function cachedMultiCall(params: MulticallOptions) {
  params.skipCache = true
  const isCacheable = isCachableAbi(params.abi)

  const response: any = []
  const missing: any = []
  const missingIndices: number[] = []

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

    if (isCacheable) {
      const cacheObject: CacheOptions = {
        abi: params.abi,
        chain: params.chain,
        address: value.contract,
      }
      const cachedValue = getCache(cacheObject)
      if (cachedValue) {
        response[i] = {
          input: { target: value.contract, params: value.params, },
          output: cachedValue,
          success: true,
        }
        return;
      }
    }

    missing.push(value)
    missingIndices.push(i)
  })

  if (!missing.length) return { output: response }

  params.contractCalls = missing
  const response_ = await multiCall(params)

  response_.output.forEach((value: any, i: number) => {
    if (isCacheable) {
      const cacheObject: CacheOptions = {
        abi: params.abi,
        chain: params.chain,
        address: value.input.target,
        value: value.output
      }

      setCache(cacheObject)
    }

    response[missingIndices[i]] = value
  })

  return { output: response }
}


const cachableAbiSet = new Set([
  'uint8:decimals',
])

function isCachableAbi(abi: string): boolean {
  if (typeof abi !== 'string') return false
  return abi.startsWith('address:') || abi.startsWith('string:') || cachableAbiSet.has(abi)
}