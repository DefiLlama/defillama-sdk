import { Address } from "../types";
import catchedABIs from "./cachedABIs";
import { ethers } from "ethers";
import { getProvider, Chain } from "../general";
import makeMultiCall from "./multicall";
import convertResults from "./convertResults";

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

import { once, EventEmitter } from 'events'
const maxParallelCalls = !!process.env.LLAMA_SDK_MAX_PARALLEL ? +process.env.LLAMA_SDK_MAX_PARALLEL : 100

interface Counter {
  activeWorkers: number;
  requestCount: number;
  queue: (() => void)[];
  pickFromTop: boolean;
}
const COUNTERS: Record<string, Counter> = {}
const emitter = new EventEmitter()
emitter.setMaxListeners(500000)

function getChainCounter(chain: string) {
  if (!COUNTERS[chain])
    COUNTERS[chain] = {
      activeWorkers: 0,
      queue: [],
      requestCount: 0,
      pickFromTop: true,
    }
  return COUNTERS[chain]
}


export async function multiCall(params: {
  abi: string | any;
  calls: {
    target: Address;
    params?: CallParams;
  }[];
  block?: number;
  target?: Address; // Used when calls.target is not provided
  chain?: Chain;
  requery?:boolean;
}) {
  const chain = params.chain ?? "ethereum";
  const abi = resolveABI(params.abi);
  const contractCalls = params.calls.map((call, index) => {
    const callParams = normalizeParams(call.params);
    return {
      params: callParams,
      contract: call.target ?? params.target,
    };
  });
  let resolveAllCallsCompleted: Function;
  const allCallsCompleted = new Promise((resolve)=>resolveAllCallsCompleted=resolve)
  let callsCompleted = 0;
  // Only a max of around 500 calls are supported by multicall, we have to split bigger batches
  let result = [] as any[];
  const chunkSize = 500
  for (let i = 0; i < contractCalls.length; i += chunkSize) {
    const counter: Counter = getChainCounter(chain)
    if (counter.activeWorkers > maxParallelCalls) {
      let queueResolve: (value: unknown) => void;
      const queuePromise = new Promise((resolve)=>queueResolve=resolve)
      counter.queue.push(queueResolve! as any)
      await queuePromise
    }
    counter.activeWorkers++;
    const pendingResult = makeMultiCall(
      abi,
      contractCalls.slice(i, i + chunkSize),
      chain,
      params.block
    ).then((partialCalls) => {
      result[i/chunkSize] = partialCalls;
      counter.activeWorkers--;
      const bottomResolve = counter.queue.shift()
      if(bottomResolve !== undefined){
        bottomResolve()
      }
      callsCompleted++;
      if(callsCompleted === contractCalls.length){
        resolveAllCallsCompleted()
      }
    });
  }
  await allCallsCompleted;
  const flatResults = [].concat.apply([], result) as any[]

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
