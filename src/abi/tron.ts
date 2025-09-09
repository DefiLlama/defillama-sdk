
import axios from "axios";
import { ethers } from "ethers";
import { fromHex, toHex } from 'tron-format-address'
import { Address } from "../types";
import convertResults from "./convertResults";
import { debugLog } from "../util/debugLog"
import { runInPromisePool, sliceIntoChunks, } from "../util"
import { handleDecimals } from "../general";
import pLimit from 'p-limit';
import { getEnvRPC, getEnvValue } from "../util/env";

const limitRPCCalls = pLimit(+getEnvValue('TRON_RPC_CONCURRENCY_LIMIT', '5')!);

const ownerAddress = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const MULTICALL_ADDRESS = 'TGXuuKAb4bnrn137u39EKbYzKNXvdCes98'

const getEndpoint = () => getEnvRPC('tron') 

type CallParams = any;

type CallOptions = {
  target: Address;
  abi: string | any;
  params?: CallParams;
  isMulticall?: boolean;
}

export async function call(options: CallOptions) {
  let { target, abi, params, isMulticall, } = options
  target = unhexifyTarget(target)
  const contractInterface = new ethers.Interface([abi]);
  const functionABI = ethers.FunctionFragment.from(abi);
  let inputTypes: any = (abi.inputs ?? []).map((i: any) => i.type)
  if (isMulticall)
    inputTypes = [ethers.ParamType.from({
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
    function_selector: (contractInterface.fragments[0] as ethers.FunctionFragment).format(),
    parameter: callData.slice(2),
    visible: true,
  }

  const { constant_result: [data] } = await limitRPCCalls(() => post(body))

  let decodedResult: any = contractInterface.decodeFunctionResult(
    functionABI,
    '0x' + data
  );
  decodedResult = [...decodedResult]
  decodedResult.forEach((v: any, i: number) => {
    if (outputTypes[i] === 'address' && v.startsWith('0x')) {
      v = fromHex(v)
      decodedResult[i] = v
    }
    let outputName = abi.outputs[i].name
    if (outputName && outputName.length) decodedResult[outputName] = v
  })
  return {
    output: convertResults(decodedResult, functionABI),
  };
}

export async function multiCall(
  functionABI: any,
  calls: {
    contract: string;
    params: any[];
  }[]
) {
  if (functionABI.inputs?.length) {
    const inputs = functionABI.inputs
    calls.forEach((call: any) => {
      call.params?.forEach((v: any, i: number) => {
        if (inputs[i].type === 'address') call.params[i] = hexifyTarget(v)
      })
    })
  }
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


export async function getBalance(params: {
  target: Address;
  decimals?: number;
}) {
  const data = await limitRPCCalls(() => post({ address: params.target, visible: true, }, '/wallet/getaccount'))
  const frozenBalance = data.frozen?.reduce((t: any, { frozen_balance }: any) => t + frozen_balance, 0) ?? 0
  const frozenBalanceV2 = data.frozenV2?.reduce((t: any, { amount = 0 }: any) => t + amount, 0) ?? 0
  const freeBalance = data.balance ?? 0
  const balance = (freeBalance + frozenBalance + frozenBalanceV2).toString()

  return {
    output: handleDecimals(balance, params.decimals),
  };
}

export async function getBalances(params: {
  targets: Address[];
  block?: number;
  decimals?: number;
}) {
  const { targets, decimals } = params
  const res = await Promise.all(targets.map(i => getBalance({ target: i, decimals })))
  return {
    output: res.map((v: any, i: number) => ({ target: targets[i], balance: v.output })),
  };
}

async function executeCalls(
  functionABI: any,
  calls: {
    contract: string;
    params: any[];
  }[]
) {
  const contractInterface = new ethers.Interface([functionABI]);
  let fd = contractInterface.fragments[0] as ethers.FunctionFragment

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
          v = fromHex(v)
          output[i] = v
        }
        let outputName = functionABI.outputs[i].name
        if (outputName && outputName.length) output[outputName] = v
      })
      return convertResults(output as ethers.Result, fd)
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

export function unhexifyTarget(address: string) {
  if (address.startsWith('0x')) return fromHex(address)
  return address
}
export function hexifyTarget(address: string) {
  if (!address.startsWith('0x')) return toHex(address)
  return address
}

async function post(body = {}, endpoint = '/wallet/triggerconstantcontract') {
  const host = getEndpoint()
  const headers: any = { 'Content-Type': 'application/json' }
  const apiKey = getEnvValue('TRON_PRO_API_KEY')
  if (apiKey) headers['TRON-PRO-API-KEY'] = apiKey
  const { data } = await axios.post(host + endpoint, body, {
    headers,
  });
  return data
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

