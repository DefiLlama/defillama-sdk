import { getPrunedChainFirstBlock, prunedChainBlockRetention } from "./blocks"

// nibiru and evmos prune, so the block search starts a fixed distance behind the head. The
// distance has to stay inside what the RPC still serves or the very first lookup fails.

test('pruned chains start the search inside their retained window', () => {
  // measured against evm-rpc.nibiru.fi at head 44,683,543: head - 400k is served,
  // head - 600k returns "block not found: tendermint client failed to get block"
  expect(getPrunedChainFirstBlock('nibiru', 44_683_543)).toBe(44_283_543)
  expect(getPrunedChainFirstBlock('nibiru', 44_683_543)).not.toBe(44_083_543)

  expect(getPrunedChainFirstBlock('evmos', 1_000_000)).toBe(800_000)
})

test('each pruned chain gets its own retention and only its own', () => {
  expect(prunedChainBlockRetention.nibiru).toBe(400_000)
  expect(prunedChainBlockRetention.evmos).toBe(200_000)
})

test('chains that do not prune have no offset', () => {
  expect(getPrunedChainFirstBlock('ethereum', 20_000_000)).toBeUndefined()
  expect(getPrunedChainFirstBlock('bsc', 40_000_000)).toBeUndefined()
})
