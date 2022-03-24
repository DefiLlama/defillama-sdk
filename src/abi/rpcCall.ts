import { Deferrable } from "@ethersproject/properties"
import { BaseProvider, BlockTag, TransactionRequest } from "@ethersproject/providers"

const DEBUG_MODE_ENABLED = !!process.env.LLAMA_DEBUG_MODE
const maxParallelCalls = !!process.env.LLAMA_SDK_MAX_PARALLEL ? +process.env.LLAMA_SDK_MAX_PARALLEL : 100
const waitTime = !!process.env.LLAMA_SDK_CALL_WAIT_TIME ? +process.env.LLAMA_SDK_CALL_WAIT_TIME : 50

let activeWorkers = 0
let queueCount = 0
let requestCount = 0

export async function call(provider: BaseProvider, data: Deferrable<TransactionRequest>, block: BlockTag) {
  const currentId = requestCount++
  let addedToQueue = false

  while (activeWorkers > maxParallelCalls) {
    if (DEBUG_MODE_ENABLED && !addedToQueue) {
      addedToQueue = true
      queueCount++
    }
    await wait()
  }

  activeWorkers++

  if (DEBUG_MODE_ENABLED) {
    if (addedToQueue) queueCount--
    if (queueCount && currentId % 50 === 0) console.log(`#: ${currentId} queue: ${queueCount} active requests: ${activeWorkers}`)
  }

  const response = await provider.call(data, block)
  activeWorkers--
  return response
}

async function wait(time = waitTime) {
  return new Promise((resolve) => setTimeout(resolve, time))
}