import { Address } from "../types";
import catchedABIs from "./cachedABIs";
import { ethers } from "ethers";
import { getProvider, Chain } from "../general";
import makeMultiCall from "./multicall";
import convertResults from "./convertResults";
import { debugLog } from "../util/debugLog";
import { runInPromisePool, sliceIntoChunks, } from "../util";

// https://docs.soliditylang.org/en/latest/abi-spec.html
const knownTypes = [
  'string', 'address', 'bool',
  'int', 'int8', 'int16', 'int32', 'int64', 'int128', 'int256',
  'uint', 'uint8', 'uint16', 'uint32', 'uint64', 'uint128', 'uint256',
]

const defaultChunkSize = !!process.env.SDK_MULTICALL_CHUNK_SIZE ? +process.env.SDK_MULTICALL_CHUNK_SIZE : 500

function resolveABI(providedAbi: string | any) {
  let abi = providedAbi;
  if (typeof abi === "string") {
    abi = catchedABIs[abi];
    if (abi === undefined) {
      const [outputType, name] = providedAbi.split(':')
      if (!knownTypes.includes(outputType) || !name)
        throw new Error("ABI method undefined");

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

function fixBlockTag(params: any) {
  let { block } = params
  if (typeof block !== 'string' || block === 'latest') return;
  block = +block
  if (isNaN(block)) throw new Error('Invalid block: ' + params.block)
  params.block = block
}

export async function call(params: {
  target: Address;
  abi: string | any;
  block?: number | string;
  params?: CallParams;
  chain?: Chain | string;
}) {
  fixBlockTag(params)
  const abi = resolveABI(params.abi);
  const callParams = normalizeParams(params.params);

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
  block?: number | string;
  target?: Address; // Used when calls.target is not provided
  chain?: Chain | string;
  chunkSize?: number;
}) {
  fixBlockTag(params)
  const chain = params.chain ?? 'ethereum'
  if (!params.calls) throw new Error('Missing calls parameter')
  if (params.target && !params.target.startsWith('0x')) throw new Error('Invalid target: ' + params.target)

  if (!params.calls.length) {
    return { output: [] }
  }

  let chunkSize: number = params.chunkSize as number
  if (!params.chunkSize) {
    // Only a max of around 500 calls are supported by multicall, we have to split bigger batches
    chunkSize = defaultChunkSize
  }

  const abi = resolveABI(params.abi);
  const contractCalls = (params.calls).map((call: any) => {
    const callParams = normalizeParams(call.params);
    return {
      params: callParams,
      contract: call.target ?? params.target,
    };
  });
  const results = await runInPromisePool({
    items: sliceIntoChunks(contractCalls, chunkSize),
    concurrency: 20,
    processor: (calls: any) => makeMultiCall(abi, calls, chain as Chain, params.block)
  })

  const flatResults = [].concat.apply([], results) as any[]

  const failedQueries = flatResults.filter(r => !r.success)
  if (failedQueries.length)
    debugLog(`[chain: ${params.chain ?? "ethereum"}] Failed multicalls:`, failedQueries.map(r => r.input))

  return {
    output: flatResults, // flatten array
  };
}
