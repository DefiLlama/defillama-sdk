import { ethers } from "ethers"
import { once, EventEmitter } from 'events'
import { DEBUG_ENABLED, debugLog } from "../util/debugLog"

const maxParallelCalls = !!process.env.LLAMA_SDK_MAX_PARALLEL ? +process.env.LLAMA_SDK_MAX_PARALLEL : 100

const COUNTERS: Record<string, Counter> = {}
const emitter = new EventEmitter()
emitter.setMaxListeners(500000)

export async function call(provider: ethers.Provider, data: ethers.JsonRpcTransactionRequest, block?: string | number, chain?: string, options = { retry: true }): Promise<any> {
  const retry = options.retry ?? true;
  (data as any).blockTag = block
  if (!chain) chain = 'noChain'
  const counter: Counter = getChainCounter(chain)
  const currentId = counter.requestCount++
  const eventId = `${chain}-${currentId}`
  let chainMaxParallelCalls = maxParallelCalls
  if (['avax', 'harmony'].includes(chain)) chainMaxParallelCalls = 20

  if (counter.activeWorkers > chainMaxParallelCalls) {
    counter.queue.push(eventId)
    await once(emitter, eventId)
  }

  counter.activeWorkers++

  if (DEBUG_ENABLED) {
    const showEveryX = counter.queue.length > 100 ? 50 : 10 // show log fewer times if lot more are queued up
    if (currentId % showEveryX === 0) debugLog(`chain: ${chain} request #: ${currentId} queue: ${counter.queue.length} active requests: ${counter.activeWorkers}`)
  }

  let response
  try {
    response = await (provider as any).call(data, block)
    onComplete()
  } catch (e) {
    onComplete()
    if (retry)
      return call(provider, data, block, chain, { ...options, retry: false })
    throw e
  }

  return response

  function onComplete() {
    counter.activeWorkers--
    if (counter.queue.length) {
      const nextRequestId = counter.pickFromTop ? counter.queue.shift() : counter.queue.pop()
      counter.pickFromTop = !counter.pickFromTop
      emitter.emit(<string>nextRequestId)
    }
  }
}

function getChainCounter(chain: string) {
  if (!COUNTERS[chain])
    COUNTERS[chain] = {
      activeWorkers: 0,
      queue: [],
      requestCount: 0,
      pickFromTop: true,
    }
  return COUNTERS[chain]
}

interface Counter {
  activeWorkers: number;
  requestCount: number;
  queue: string[];
  pickFromTop: boolean;
}