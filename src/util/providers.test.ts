import providerSeed from "../providers.json"
import { getEVMProvidersConfigMap, isEvmChain } from "../generalUtil"

const seed = providerSeed as { [chain: string]: { rpc: string[]; chainId: number } }
const providerMap = getEVMProvidersConfigMap()
// aliases like hydradx -> hdx are added while generating the list, they are not in the curated seed
const testGeneratedList = Object.keys(providerMap).length > 1000 ? test : test.skip

test("curated rpcs exclude keyless aggregators", () => {
  Object.entries(seed).forEach(([chain, { rpc }]) =>
    rpc.forEach((url) => expect(`${chain}: ${url}`).not.toMatch(/lb\.routeme\.sh/)),
  )
})

test("curated floor for chains chainlist reduced to a single keyless rpc", () => {
  expect(seed.btr.chainId).toBe(200901)
  expect(seed.bob.chainId).toBe(60808)
  expect(seed.hdx.chainId).toBe(222222)
  ;["btr", "bob", "hdx"].forEach((chain) => expect(seed[chain].rpc.length).toBeGreaterThan(0))
})

testGeneratedList("hydradx resolves through the hdx alias", () => {
  expect(seed.hydradx).toBeUndefined()
  expect(providerMap.hydradx?.chainId).toBe(seed.hdx.chainId)
  expect(providerMap.hydradx?.rpc?.length).toBeGreaterThan(0)
  expect(isEvmChain("hydradx")).toBe(true)
})
