import { CallsParams, CallOptions, MulticallOptions, FetchListOptions, ByteCodeCallOptions, } from "../types";
import * as abi1 from './index'
import { debugLog } from "../util/debugLog";

export async function call(params: CallOptions): Promise<any> {
  try {
    const response = await abi1.call(params)
    if (params.withMetadata) return response
    return response.output
  } catch (e) {
    if (!params.permitFailure) throw e
    if (params.withMetadata) return { success: false, error: e }
    return null
  }
}

export async function multiCall(params: MulticallOptions): Promise<any[]> {
  if (params.excludeFailed) params.permitFailure = true
  params.calls = params.calls.map(i => {
    if (typeof i === 'object') return i
    if (typeof i === 'string') {
      if (params.target) return { params: i } as CallsParams
      return { target: i } as CallsParams
    }
    return { params: i }
  })

  let { output } = await abi1.multiCall(params as any)

  if (params.excludeFailed) output = output.filter((i: any) => i.success)
  if (params.withMetadata) return output
  return output.map((i: any) => i.output)
}

export async function fetchList(params: FetchListOptions) {
  let { startFrom = 0, lengthAbi, itemAbi, withMetadata, startFromOne = false, itemCount, target, targets, calls: _targets, chain, block, permitFailure, groupedByInput, excludeFailed, } = params
  if (!targets) targets = _targets
  permitFailure = permitFailure || excludeFailed

  if (excludeFailed && groupedByInput) throw new Error('excludeFailed and groupedByInput cannot be used together!')
  if (withMetadata && groupedByInput) throw new Error('withMetadata and groupedByInput cannot be used together!')

  if (typeof lengthAbi === 'string' && (!lengthAbi.includes(':') && !lengthAbi.includes('('))) lengthAbi = `uint256:${lengthAbi}`
  if (typeof itemAbi === 'string' && (!itemAbi.includes(':') && !itemAbi.includes('('))) itemAbi = `function ${itemAbi}(uint256) view returns (address)`
  let itemLength, itemLengths
  const calls = []

  if (!target && !targets) throw new Error('Need to provide either target or targets parameter!')

  if (target) {

    if (itemCount) itemLength = itemCount
    else itemLength = await call({ chain, block, target, abi: lengthAbi, })
    debugLog('length: ', itemLength)
    if (startFromOne) {
      itemLength++
      if (startFrom === 0) startFrom = 1
    }
    for (let i = startFrom; i < itemLength; i++) calls.push({ target, params: [i] })

    return multiCall({ chain, block, permitFailure, abi: itemAbi, calls, withMetadata, excludeFailed, })
  }

  if (itemCount) itemLengths = targets!.map(() => itemCount)
  else itemLengths = await multiCall({ chain, block, calls: targets!, abi: lengthAbi, })

  debugLog('itemLengths: ', itemLengths)
  const groupedByRes: any = itemLengths.map(() => [])
  const indexToTargetMapping: { [idx: number]: number } = {}
  let k = 0
  for (let i = 0; i < itemLengths.length; i++) {
    let itemLength = itemLengths[i]
    if (startFromOne) {
      itemLength++
      if (startFrom === 0) startFrom = 1
    }
    for (let j = startFrom; j < itemLength; j++) {
      calls.push({ target: targets![i], params: [j] })
      indexToTargetMapping[k] = i
      k++
    }
  }

  const res = await multiCall({ chain, block, permitFailure, abi: itemAbi, calls, withMetadata, excludeFailed, })
  if (!groupedByInput) return res
  res.forEach((i: any, idx: number) => groupedByRes[indexToTargetMapping[idx]].push(i))
  return groupedByRes
}


export async function bytecodeCall(params: ByteCodeCallOptions) {
  const response = await abi1.bytecodeCall(params)
  if (params.withMetadata) return response
  return response.output
}
