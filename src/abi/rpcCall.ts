import { Deferrable } from "@ethersproject/properties"
import { BaseProvider, BlockTag, TransactionRequest } from "@ethersproject/providers"

const maxParallelCalls = 100
let activeWorkers = 0

export async function call(provider: BaseProvider, data: Deferrable<TransactionRequest>, block: BlockTag) {
  while (activeWorkers > maxParallelCalls)
    await wait()
  activeWorkers++
  const response = await provider.call(data, block)
  activeWorkers--
  return response
}

async function wait(time = 500) {
  return new Promise((resolve) => setTimeout(resolve, time))
}