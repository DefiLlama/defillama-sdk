import { Deferrable } from "@ethersproject/properties"
import { BaseProvider, BlockTag, TransactionRequest } from "@ethersproject/providers"

const DEBUG_MODE_ENABLED = !!process.env.LLAMA_DEBUG_MODE
const maxParallelCalls = !!process.env.LLAMA_SDK_MAX_PARALLEL ? +process.env.LLAMA_SDK_MAX_PARALLEL : 100
const waitTime = !!process.env.LLAMA_SDK_CALL_WAIT_TIME ? +process.env.LLAMA_SDK_CALL_WAIT_TIME : 50

const COUNTERS: Record<string, Record<string, number>> = {}

export async function call(provider: BaseProvider, data: Deferrable<TransactionRequest>, block: BlockTag, chain?: string ) {
  if (!chain) chain = 'noChain'
  const counter: Record<string, number> = getChainCounter(chain)
  const currentId = counter.requestCount++
  let addedToQueue = false

  while (counter.activeWorkers > maxParallelCalls) {
    if (DEBUG_MODE_ENABLED && !addedToQueue) {
      addedToQueue = true
      counter.queueCount++
    }
    await wait()
  }

  counter.activeWorkers++

  if (DEBUG_MODE_ENABLED) {
    if (addedToQueue) counter.queueCount--
    if (counter.queueCount && currentId % 50 === 0) console.log(`#: ${currentId} queue: ${counter.queueCount} active requests: ${counter.activeWorkers} chain: ${chain}`)
  }

  const response = await provider.call(data, block)
  counter.activeWorkers--
  return response
}

async function wait(time = waitTime) {
  return new Promise((resolve) => setTimeout(resolve, time))
}

function getChainCounter(chain: string) {
  if (!COUNTERS[chain])
    COUNTERS[chain] = {
      activeWorkers: 0,
      queueCount: 0,
      requestCount: 0,
    }
  return COUNTERS[chain]
}