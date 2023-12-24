import { CallsParams, CallOptions, MulticallOptions, FetchListOptions, ByteCodeCallOptions, } from "../types";
import * as abi1 from './index'
import { debugLog } from "../util/debugLog";

export async function call(params: CallOptions): Promise<any> {
  const response = await abi1.call(params)
  if (params.withMetadata) return response
  return response.output
}

export async function multiCall(params: MulticallOptions): Promise<any[]> {
  params.calls = params.calls.map(i => {
    if (typeof i === 'object') return i
    if (typeof i === 'string') {
      if (params.target) return { params: i } as CallsParams
      return { target: i } as CallsParams
    }
    return { params: i }
  })

  const { output } = await abi1.multiCall(params as any)

  if (params.withMetadata) return output
  return output.map((i: any) => i.output)
}

export async function fetchList(params: FetchListOptions) {
  let { startFrom = 0, lengthAbi, itemAbi, withMetadata, startFromOne = false, itemCount, ...commonParams } = params

  if (typeof lengthAbi === 'string' && (!lengthAbi.includes(':') && !lengthAbi.includes('('))) lengthAbi = `uint256:${lengthAbi}`
  if (typeof itemAbi === 'string' && (!itemAbi.includes(':') && !itemAbi.includes('('))) itemAbi = `function ${itemAbi}(uint256) view returns (address)`
  let itemLength
  if (itemCount) itemLength = itemCount
  else itemLength = await call({ ...commonParams, abi: lengthAbi, })
  debugLog('length: ', itemLength)
  if (startFromOne) {
    itemLength++
    if (startFrom === 0) startFrom = 1
  }
  const calls = []
  for (let i = startFrom; i < itemLength; i++)  calls.push(i)
  return multiCall({ ...commonParams, abi: itemAbi, calls, withMetadata })
}


export async function bytecodeCall(params: ByteCodeCallOptions) {
  const response = await abi1.bytecodeCall(params)
  if (params.withMetadata) return response
  return response.output
}
