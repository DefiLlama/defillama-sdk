import * as common from "../util/common"
import { getBalance } from "./tron"

// unique per test so the module level balanceCache in tron.ts is not shared between cases
const ADDRESS = 'TCacheProbe1111111111111111111111111'

test('tron: a failed getBalance is not cached, the next call retries', async () => {
  jest.spyOn(common, 'sleepRandom').mockResolvedValue(undefined as any)

  let healthy = false
  const postJson = jest.spyOn(common, 'postJson').mockImplementation(async () => {
    if (!healthy) throw new Error('rpc down')
    return { balance: 12_345_678 } as any
  })

  await expect(getBalance({ target: ADDRESS })).rejects.toThrow('All TRON RPCs are not working')
  const callsAfterFailure = postJson.mock.calls.length
  expect(callsAfterFailure).toBeGreaterThan(0)

  // the RPC recovers
  healthy = true
  const res = await getBalance({ target: ADDRESS, decimals: 6 })

  expect(res.output).toBe("12.345678")
  // the retry actually went out to the network rather than being served the cached rejection
  expect(postJson.mock.calls.length).toBeGreaterThan(callsAfterFailure)

  // a successful response is still cached, so a repeat call does not hit the network again
  const callsAfterSuccess = postJson.mock.calls.length
  await getBalance({ target: ADDRESS, decimals: 6 })
  expect(postJson.mock.calls.length).toBe(callsAfterSuccess)

  postJson.mockRestore()
})
