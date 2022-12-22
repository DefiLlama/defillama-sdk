import { Address } from "../types";
import { Chain } from "../general";
import * as abi1 from './index'
import { debugLog } from "../util/debugLog";

type CallParams = string | number | (string | number)[] | undefined;
type CallsParams = {
  target?: Address;
  params?: CallParams;
};

export async function call(params: {
  target: Address;
  abi: string | any;
  block?: number | string;
  params?: CallParams;
  chain?: Chain | string;
  withMetadata?: boolean;
}) {
  const response = await abi1.call(params)
  if (params.withMetadata) return response
  return response.output
}

export async function multiCall(params: {
  abi: string | any;
  calls: CallsParams[] | (string | number)[];
  block?: number | string;
  target?: Address; // Used when calls.target is not provided
  chain?: Chain | string;
  requery?: boolean;
  withMetadata?: boolean;
}) {
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


export async function fetchList(params: {
  lengthAbi: string | any;
  itemAbi: string | any;
  block?: number | string;
  startFrom?: number;
  target: Address;
  chain?: Chain | string;
  withMetadata?: boolean;
}) {
  const { startFrom = 0, lengthAbi, itemAbi, withMetadata, ...commonParams } = params
  const itemLength = await call({ ...commonParams, abi: lengthAbi, })
  debugLog('length: ', itemLength)
  const calls = []
  for (let i = startFrom; i < itemLength; i++)  calls.push(i)
  return multiCall({ ...commonParams,  abi: itemAbi, calls, withMetadata })
}
