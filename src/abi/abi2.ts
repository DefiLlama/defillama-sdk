import { CallsParams, CallOptions, MulticallOptions, FetchListOptions, } from "../types";
import * as abi1 from './index'
import { debugLog } from "../util/debugLog";

export async function call(params: CallOptions) {
  const response = await abi1.call(params)
  if (params.withMetadata) return response
  return response.output
}

export async function multiCall(params: MulticallOptions) {
  params.calls = params.calls.map(i => {
    if (typeof i === 'object') return i
    if (typeof i === 'string') {
      if (params.target) return { params: i } as CallsParams
      return { target: i } as CallsParams
    }
    return { params: i }
  })

  if (!params.target) {
    if (params.calls.some(i => !i.target)) throw new Error('Missing target parameter')
  }

  const { output } = await abi1.multiCall(params as any)

  if (params.withMetadata) return output
  return output.map(i => i.output)
}

export async function fetchList(params: FetchListOptions) {
  const { startFrom = 0, lengthAbi, itemAbi, withMetadata, ...commonParams } = params
  const itemLength = await call({ ...commonParams, abi: lengthAbi, })
  debugLog('length: ', itemLength)
  const calls = []
  for (let i = startFrom; i < itemLength; i++)  calls.push(i)
  return multiCall({ ...commonParams,  abi: itemAbi, calls, withMetadata })
}
