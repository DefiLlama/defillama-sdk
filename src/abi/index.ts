import { Address } from "../types";
import catchedABIs from "./cachedABIs";
import { ethers, BigNumber } from "ethers";
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

export async function multiCall(params: {
  abi: string | any;
  calls: {
    target: Address;
    params?: CallParams;
  }[];
  block?: number;
  target?: Address; // Used when calls.target is not provided
  chain?: Chain;
}) {
  const abi = resolveABI(params.abi);
  const contractCalls = params.calls.map((call, index) => {
    const callParams = normalizeParams(call.params);
    return {
      params: callParams,
      contract: call.target ?? params.target,
    };
  });
  // Only a max of around 500 calls are supported by multicall, we have to split bigger batches
  let multicallCalls = [];
  let result = [] as any[];
  for (let i = 0; i < contractCalls.length; i += 500) {
    const pendingResult = makeMultiCall(
      abi,
      contractCalls.slice(i, i + 500),
      params.chain ?? "ethereum",
      params.block
    ).then((partialCalls) => {
      result = result.concat(partialCalls);
    });
    multicallCalls.push(pendingResult);
    if (i % 20000) {
      await Promise.all(multicallCalls); // It would be faster to just await on all of them, but if we do that at some point node crashes without error message, so to prevent that we have to periodically await smaller sets of calls
      multicallCalls = []; // Clear them from memory
    }
  }
  await Promise.all(multicallCalls);
  return {
    output: result,
  };
}

/*
abi: {
      call: (options) => abi('call', { ...options }),
      multiCall: (options) => abi('multiCall', { ...options, chunk: {param: 'calls', length: 5000, combine: 'array'} })
    },
*/
