import { CallsParams, CallOptions, MulticallOptions, FetchListOptions, ByteCodeCallOptions, } from "../types";
import * as abi1 from './index'
import { debugLog } from "../util/debugLog";

export async function call(params: CallOptions): Promise<any> {
  try {
    const response = await abi1.call(params)
    if (params.field) response.output = response.output[params.field]
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
  if (params.field) output.forEach((i: any) => i.output = i.output[params.field!])
  if (params.withMetadata) return output
  return output.map((i: any) => i.output)
}

export async function fetchList(params: FetchListOptions) {
  // itemAbi2 is used when we need to make a second call to get the final result
  let { startFrom = 0, lengthAbi, itemAbi, withMetadata, startFromOne = false, itemCount, target, targets, calls: _targets, chain, block, permitFailure, groupedByInput, excludeFailed, itemAbi2, field, field2, } = params

  if (!targets) targets = _targets
  const _groupedByInputOrignal = groupedByInput
  if (targets && itemAbi2) groupedByInput = true
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
    // debugLog('length: ', itemLength)
    if (startFromOne) {
      itemLength++
      if (startFrom === 0) startFrom = 1
    }
    for (let i = startFrom; i < itemLength; i++) calls.push({ target, params: [i] })

    const response = await multiCall({ chain, block, permitFailure, abi: itemAbi, calls, withMetadata, excludeFailed, field, })
    if (!itemAbi2) return response
    return multiCall({ chain, block, target, permitFailure, abi: itemAbi2, calls: response, withMetadata, excludeFailed, field: field2, })

  }

  if (itemCount) itemLengths = targets!.map(() => itemCount)
  else itemLengths = await multiCall({ chain, block, calls: targets!, abi: lengthAbi, })

  // debugLog('itemLengths: ', itemLengths)
  let groupedByRes: any = itemLengths.map(() => [])
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

  const res = await multiCall({ chain, block, permitFailure, abi: itemAbi, calls, withMetadata, excludeFailed, field, })
  if (!groupedByInput) return res
  res.forEach((i: any, idx: number) => groupedByRes[indexToTargetMapping[idx]].push(i))
  if (!itemAbi2) return groupedByRes


  const calls2 = []
  for (let i = 0; i < targets!.length; i++) {
    for (let j = 0; j < groupedByRes[i].length; j++) {
      calls2.push({ target: targets![i], params: groupedByRes[i][j] })
    }
  }

  const res2 = await multiCall({ chain, block, permitFailure, abi: itemAbi2, calls: calls2, withMetadata, excludeFailed, field: field2, })
  if (!_groupedByInputOrignal) return res2

  groupedByRes = itemLengths.map(() => [])
  res2.forEach((i: any, idx: number) => groupedByRes[indexToTargetMapping[idx]].push(i))
  return groupedByRes
}


export async function bytecodeCall(params: ByteCodeCallOptions) {
  const response = await abi1.bytecodeCall(params)
  if (params.withMetadata) return response
  return response.output
}
