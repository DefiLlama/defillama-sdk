
import fetch from "node-fetch";
import { BytesLike, ParamType } from "ethers/lib/utils";
import { ethers } from "ethers";
import { fromHex, toHex } from 'tron-format-address'
import { Address } from "../types";
import convertResults from "./convertResults";
import { debugLog } from "../util/debugLog"
import { runInPromisePool, sliceIntoChunks, } from "../util"

const ownerAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const endpoint = 'https://rpc.ankr.com/http/tron/wallet/triggerconstantcontract'

type CallParams = any;

type CallOptions = {
  target: Address;
  abi: string | any;
  params?: CallParams;
  isMulticall?: boolean;
}

async function post(body = {}) {
  const response = await fetch(endpoint, {
    method: 'post',
    body: JSON.stringify(body),
    headers: { 'Content-Type': 'application/json' }
  });
  return response.json()
}

function unhexifyTarget(address: string) {
  if (address.startsWith('0x')) return fromHex(address)
  return address
}
function hexifyTarget(address: string) {
  if (!address.startsWith('0x')) return toHex(address)
  return address
}

export async function call(options: CallOptions) {
  let { target, abi, params, isMulticall, } = options
  target = unhexifyTarget(target)
  const contractInterface = new ethers.utils.Interface([abi]);
  const functionABI = ethers.utils.FunctionFragment.from(abi);
  let inputTypes: any = (abi.inputs ?? []).map((i: any) => i.type)
  if (isMulticall)
    inputTypes = [ParamType.fromObject({
      components: [
        { name: "target", type: "address" },
        { name: "callData", type: "bytes" },
      ],
      name: "data",
      type: "tuple[]",
    })]
  const outputTypes = (abi.outputs ?? []).map((i: any) => i.type)
  params.forEach((v: any, i: number) => {
    if (inputTypes[i] === 'address' && !v.startsWith('0x')) params[i] = toHex(v)
  })
  const callData = contractInterface._encodeParams(inputTypes, params)
  const body = {
    owner_address: ownerAddress,
    contract_address: target,
    function_selector: Object.keys(contractInterface.functions).pop(),
    parameter: callData.slice(2),
    visible: true,
  }

  const { constant_result: [data] } = await post(body)

  let decodedResult: any = contractInterface.decodeFunctionResult(
    functionABI,
    '0x' + data
  );
  decodedResult = [...decodedResult]
  decodedResult.forEach((v: any, i: number) => {
    if (outputTypes[i] === 'address' && v.startsWith('0x')) {
      const newValue = fromHex(v)
      decodedResult[i] = newValue
      let outputName = abi.outputs[i].name
      if (outputName && outputName.length) decodedResult[outputName] = newValue
    }
  })
  return {
    output: convertResults(decodedResult),
  };
}

const MULTICALL_ADDRESS = 'TGXuuKAb4bnrn137u39EKbYzKNXvdCes98'

export async function multiCall(
  functionABI: any,
  calls: {
    contract: string;
    params: any[];
  }[]
) {
  const returnValues = await executeCalls(functionABI, calls);

  return returnValues.map((output: any, index: number) => {
    return {
      input: {
        params: calls[index].params,
        target: calls[index].contract,
      },
      success: output !== null,
      output,
    };
  });
}

async function executeCalls(
  functionABI: any,
  calls: {
    contract: string;
    params: any[];
  }[]
) {
  const contractInterface = new ethers.utils.Interface([functionABI]);
  let fd = Object.values(contractInterface.functions)[0];

  const contractCalls = calls.map((call) => {
    const data = contractInterface.encodeFunctionData(fd, call.params);
    return {
      to: call.contract,
      data: data,
    };
  });

  try {
    const { output: [_, returnData] } = await call({ target: MULTICALL_ADDRESS, params: [contractCalls.map((call) => ({ target: hexifyTarget(call.to), callData: call.data, isMulticall: true }))], abi: MULTICALL_ABI, isMulticall: true })
    return returnData.map((v: any) => {

      let decodedResult: any = contractInterface.decodeFunctionResult(functionABI, v);
      const outputTypes = (functionABI.outputs ?? []).map((i: any) => i.type)
      let output = [...decodedResult]
      output.forEach((v: any, i: number) => {
        if (outputTypes[i] === 'address' && v.startsWith('0x')) {
          const newValue = fromHex(v)
          output[i] = newValue
          let outputName = functionABI.outputs[i].name
          if (outputName && outputName.length) output[outputName] = newValue
        }
      })
      if (output.length === 1) output = output[0]
      return output
    })
  } catch (e) {
    console.error(e)
    if (calls.length > 10) {
      const chunkSize = Math.ceil(calls.length / 5)
      const chunks = sliceIntoChunks(calls, chunkSize)
      debugLog(`Multicall failed, call size: ${contractCalls.length}, splitting into smaller chunks and trying again, new call size: ${chunks[0].length}`)
      const response = await runInPromisePool({
        items: chunks,
        concurrency: 2,
        processor: (calls: any) => executeCalls(functionABI, calls)
      })
      return response.flat()
    }
    debugLog("Multicall failed, defaulting to single transactions...")
  }

  return runInPromisePool({
    items: calls,
    concurrency: 3,
    processor: async ({ contract, params }: any) => {
      let result = null
      try {
        result = (await call({ target: contract, params, abi: functionABI })).output
      } catch (e) {
        debugLog(e)
      }
      return result
    }
  })
}

// this is needed else correct function identifier wont be picked up while calling
const MULTICALL_ABI = {
  "inputs": [
    {
      "components": [
        {
          "internalType": "address",
          "name": "target",
          "type": "address"
        },
        {
          "internalType": "bytes",
          "name": "callData",
          "type": "bytes"
        }
      ],
      "internalType": "struct TronMulticall.Call[]",
      "name": "calls",
      "type": "tuple[]"
    }
  ],
  "name": "aggregate",
  "outputs": [
    {
      "internalType": "uint256",
      "name": "blockNumber",
      "type": "uint256"
    },
    {
      "internalType": "bytes[]",
      "name": "returnData",
      "type": "bytes[]"
    }
  ],
  "stateMutability": "view",
  "type": "function"
}