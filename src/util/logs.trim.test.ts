import { trimCachesForStorage } from './logs'

const log = (blockNumber: number, index: number) => ({ blockNumber, transactionHash: '0x' + blockNumber.toString(16), index } as any)

function cache(logs: any[], fromBlock: number, toBlock: number) {
  return [{ logs, metadata: { fromBlock, toBlock } }] as any
}

test('a cut inside a block drops that block rather than claiming to cover it', () => {
  // block 1000 emits five logs, 1001 and 1002 one each
  const logs = [...Array(5)].map((_, i) => log(1000, i)).concat([log(1001, 0), log(1002, 0)])
  const [out] = trimCachesForStorage(cache(logs, 900, 1002), 4)

  expect(out.metadata).toEqual({ fromBlock: 1001, toBlock: 1002 })
  expect(out.logs.map((l: any) => l.blockNumber).sort()).toEqual([1001, 1002])
})

test('a cut that lands on a block boundary keeps the whole budget', () => {
  // 1002 emits two, 1001 and 1000 one each; a budget of three ends exactly on the 1001 boundary
  const logs = [log(1000, 0), log(1001, 0), log(1002, 0), log(1002, 1)]
  const [out] = trimCachesForStorage(cache(logs, 900, 1002), 3)

  expect(out.metadata).toEqual({ fromBlock: 1001, toBlock: 1002 })
  expect(out.logs).toHaveLength(3)
})

test('a budget that cannot hold one block keeps that block whole', () => {
  const logs = [...Array(10)].map((_, i) => log(1002, i)).concat([log(1001, 0)])
  const [out] = trimCachesForStorage(cache(logs, 900, 1002), 4)

  expect(out.metadata).toEqual({ fromBlock: 1002, toBlock: 1002 })
  expect(out.logs).toHaveLength(10)
})

test('every block the trimmed metadata claims is held in full', () => {
  const logs: any[] = []
  for (let b = 1000; b <= 1100; b++) for (let i = 0; i < (b % 7) + 1; i++) logs.push(log(b, i))

  for (const budget of [1, 5, 17, 60, 123, 400]) {
    const [out] = trimCachesForStorage(cache(logs, 900, 1100), budget)
    const { fromBlock, toBlock } = out.metadata
    const heldPerBlock = new Map<number, number>()
    for (const l of out.logs as any[]) heldPerBlock.set(l.blockNumber, (heldPerBlock.get(l.blockNumber) ?? 0) + 1)
    for (let b = fromBlock; b <= toBlock; b++) {
      const actual = logs.filter((l) => l.blockNumber === b).length
      expect(heldPerBlock.get(b) ?? 0).toBe(actual)
    }
  }
})

test('a cache under the budget is left alone', () => {
  const logs = [log(1000, 0), log(1001, 0)]
  const [out] = trimCachesForStorage(cache(logs, 900, 1002), 10)
  expect(out.metadata).toEqual({ fromBlock: 900, toBlock: 1002 })
  expect(out.logs).toHaveLength(2)
})
