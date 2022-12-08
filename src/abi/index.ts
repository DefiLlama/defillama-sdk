import { Address } from "../types";
import catchedABIs from "./cachedABIs";
import { ethers } from "ethers";
import { getProvider, Chain } from "../general";
import makeMultiCall from "./multicall";
import convertResults from "./convertResults";
import { PromisePool } from '@supercharge/promise-pool';
import { debugLog } from "../util/debugLog";


const defaultChunkSize = !!process.env.SDK_MULTICALL_CHUNK_SIZE? +process.env.SDK_MULTICALL_CHUNK_SIZE : 250

function resolveABI(providedAbi: string | any) {
  let abi = providedAbi;
  if (typeof abi === "string") {
    abi = catchedABIs[abi];
    if (abi === undefined) {
      throw new Error("ABI method undefined");
    }
  }
  // If type is omitted DP's sdk processes it fine but we don't, so we need to add it
  return {
    type: "function",
    ...abi,
  };
}

type CallParams = string | number | (string | number)[] | undefined;

function normalizeParams(params: CallParams): (string | number)[] {
  if (params === undefined) {
    return [];
  } else if (typeof params === "object") {
    return params;
  } else {
    return [params];
  }
}

export async function call(params: {
  target: Address;
  abi: string | any;
  block?: number;
  params?: CallParams;
  chain?: Chain;
}) {
  const abi = resolveABI(params.abi);
  const callParams = normalizeParams(params.params);

  const contractInterface = new ethers.utils.Interface([abi]);
  const functionABI = ethers.utils.FunctionFragment.from(abi);
  const callData = contractInterface.encodeFunctionData(
    functionABI,
    callParams
  );

  const result = await getProvider(params.chain).call(
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

  return {
    output: convertResults(decodedResult),
  };
}

export async function multiCall(params: {
  abi: string | any;
  calls: {
    target?: Address;
    params?: CallParams;
  }[];
  block?: number;
  target?: Address; // Used when calls.target is not provided
  chain?: Chain;
  requery?: boolean;
}) {
  if (!params.calls) throw new Error('Missing calls parameter')
  if (params.target && !params.target.startsWith('0x')) throw new Error('Invalid target: '+params.target)

  if (!params.calls.length) {
    return { output: []}
  }
  
  const abi = resolveABI(params.abi);
  const contractCalls = (params.calls).map((call: any) => {
    const callParams = normalizeParams(call.params);
    return {
      params: callParams,
      contract: call.target ?? params.target,
    };
  });
  // Only a max of around 500 calls are supported by multicall, we have to split bigger batches
  let chunkSize = defaultChunkSize
  if (['dogechain'].includes(params.chain as string)) {
    chunkSize = 100
  }
  const contractChunks = []
  for (let i = 0; i < contractCalls.length; i += chunkSize)
    contractChunks.push(contractCalls.slice(i, i + chunkSize))


  const { results, errors } = await PromisePool
    .withConcurrency(20)
    .for(contractChunks)
    .process(async (calls, i) => makeMultiCall(
      abi,
      calls,
      params.chain ?? "ethereum",
      params.block
    ).then(calls=>[calls, i]))

  if (errors.length)
    throw errors[0]

  const flatResults = [].concat.apply([], results
    .sort(([c1, i1], [c2, i2])=>i1-i2).map(([c, i])=>c)
    ) as any[]

  const failedQueries = flatResults.filter(r => !r.success)
  if(failedQueries.length)
    debugLog(`[chain: ${params.chain ?? "ethereum"}] Failed multicalls:`, failedQueries.map(r=>r.input))

  if (params.requery === true && flatResults.some(r => !r.success)) {
    const failed = flatResults.map((r, i) => [r, i]).filter(r => !r[0].success)
    const newResults = await multiCall({
      abi: params.abi,
      chain: params.chain,
      calls: failed.map((f) => f[0].input),
      block: params.block,
      requery: params.requery,
    }).then(({ output }) => output);
    failed.forEach((f, i) => {
      flatResults[f[1]] = newResults[i]
    })
  }
  return {
    output: flatResults, // flatten array
  };
}
