import { getBufferedToBlock } from "./logs"

// getLogs widens the fetched range by 10 blocks in each direction. Forward, that has to stop at the
// chain head: base RPCs answer a range ending past their latest block with
// "block range extends beyond current head block" and "block N is beyond the latest block M of this
// node", and when every RPC in the pool does that the whole call throws.

test('the full buffer is used when the head is far enough ahead', () => {
  expect(getBufferedToBlock(1000, 5000)).toBe(1010)
  expect(getBufferedToBlock(1000, 1010)).toBe(1010)
})

test('the buffer stops at the head', () => {
  expect(getBufferedToBlock(1000, 1003)).toBe(1003)
  expect(getBufferedToBlock(1000, 1000)).toBe(1000)
})

test('a stale head never shrinks the range below what was requested', () => {
  // getBlockNumber caches the current block for a minute, so the head can read behind toBlock
  expect(getBufferedToBlock(1000, 990)).toBe(1000)
  expect(getBufferedToBlock(1000, 0)).toBe(1000)
})

test('an unreadable head keeps the previous behaviour', () => {
  expect(getBufferedToBlock(1000, undefined)).toBe(1010)
})

test('the buffer size is configurable and still clamped', () => {
  expect(getBufferedToBlock(1000, 5000, 50)).toBe(1050)
  expect(getBufferedToBlock(1000, 1020, 50)).toBe(1020)
})
