import { Deferrable } from "@ethersproject/properties";
import {
  BaseProvider,
  BlockTag,
  TransactionRequest,
} from "@ethersproject/providers";
import { once, EventEmitter } from "events";

const DEBUG_MODE_ENABLED = !!process.env.LLAMA_DEBUG_MODE;
const maxParallelCalls = !!process.env.LLAMA_SDK_MAX_PARALLEL
  ? +process.env.LLAMA_SDK_MAX_PARALLEL
  : 100;

const COUNTERS: Record<string, Counter> = {};
const emitter = new EventEmitter();
emitter.setMaxListeners(500000);

export async function call(
  provider: BaseProvider,
  data: Deferrable<TransactionRequest>,
  block: BlockTag,
  chain?: string
) {
  if (!chain) chain = "noChain";
  const counter: Counter = getChainCounter(chain);
  const currentId = counter.requestCount++;
  const eventId = `${chain}-${currentId}`;

  if (counter.activeWorkers > maxParallelCalls) {
    counter.queue.push(eventId);
    await once(emitter, eventId);
  }

  counter.activeWorkers++;

  if (DEBUG_MODE_ENABLED) {
    const showEveryX = counter.queue.length > 100 ? 50 : 10; // show log fewer times if lot more are queued up
    if (currentId % showEveryX === 0)
      console.log(
        `chain: ${chain} request #: ${currentId} queue: ${counter.queue.length} active requests: ${counter.activeWorkers}`
      );
  }

  let response;
  try {
    response = await provider.call(data, block);
    onComplete();
  } catch (e) {
    onComplete();
    throw e;
  }

  return response;

  function onComplete() {
    counter.activeWorkers--;
    if (counter.queue.length) {
      const nextRequestId = counter.pickFromTop
        ? counter.queue.shift()
        : counter.queue.pop();
      counter.pickFromTop = !counter.pickFromTop;
      emitter.emit(<string>nextRequestId);
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
    };
  return COUNTERS[chain];
}

interface Counter {
  activeWorkers: number;
  requestCount: number;
  queue: string[];
  pickFromTop: boolean;
}
