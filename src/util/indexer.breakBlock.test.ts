import { getIndexerBreakBlock } from "./indexer"

// the partial-sync path splits a request into an indexer leg [fromBlock, breakBlock] and an RPC leg
// [breakBlock + 1, toBlock]. breakBlock sits a fixed buffer behind the indexer head, so it has to be
// checked against fromBlock or the RPC leg starts before the range the caller asked for.

test('breakBlock sits a buffer behind the indexer head when the range is wide enough', () => {
  expect(getIndexerBreakBlock(1000, 5000)).toBe(4950)
  expect(getIndexerBreakBlock(1000, 5000, 10)).toBe(4990)
})

test('breakBlock is usable right down to the first block of the range', () => {
  // the indexer leg becomes the single block [1000, 1000], which is still a valid range
  expect(getIndexerBreakBlock(1000, 1050)).toBe(1000)
  // one block further behind and there is nothing left for the indexer to answer
  expect(getIndexerBreakBlock(1000, 1049)).toBeUndefined()
})

test('a short range with the indexer lagging inside it does not produce a break block', () => {
  // fromBlock 1000, toBlock 1080, lastIndexedBlock 1045
  // percentageMissing = (1080 - 1045) / (1080 - 1000) * 100 = 43.75, so this passes the >50 guard
  // and reaches the split. 1045 - 50 = 995, which is behind fromBlock.
  const percentageMissing = ((1080 - 1045) / (1080 - 1000)) * 100
  expect(percentageMissing).toBeLessThanOrEqual(50)
  expect(getIndexerBreakBlock(1000, 1045)).toBeUndefined()
})

test('whenever a break block is returned, the RPC leg never starts before fromBlock', () => {
  const fromBlock = 1000
  for (let lastIndexedBlock = 900; lastIndexedBlock <= 1200; lastIndexedBlock++) {
    const breakBlock = getIndexerBreakBlock(fromBlock, lastIndexedBlock)
    if (breakBlock === undefined) continue
    expect(breakBlock).toBeGreaterThanOrEqual(fromBlock)
    expect(breakBlock + 1).toBeGreaterThan(fromBlock)
  }
})
