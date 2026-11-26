import { ethers } from "ethers";
import { ChainApi } from "./ChainApi";
import { setProvider } from "./general";

const chain = 'ethereum'
const target = '0x1111111111111111111111111111111111111111'
const feeIface = new ethers.Interface(['function launchFee() view returns (uint256)'])
const aggIface = new ethers.Interface(['function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'])
const seen: any[] = []

const answerAt = (blockTag: any) => feeIface.encodeFunctionResult('launchFee', [BigInt(blockTag ?? 0)])

beforeAll(() => {
  setProvider(chain, {
    async call(tx: any) {
      seen.push(tx.blockTag)
      if (tx.data.startsWith(aggIface.getFunction('tryAggregate')!.selector)) {
        const [, calls] = aggIface.decodeFunctionData('tryAggregate', tx.data)
        return aggIface.encodeFunctionResult('tryAggregate', [calls.map(() => [true, answerAt(tx.blockTag)])])
      }
      return answerAt(tx.blockTag)
    },
    async getNetwork() { return { chainId: BigInt(1) } },
  } as any)
})

beforeEach(() => { seen.length = 0 })

test("ChainApi.call reads at the block the caller passes", async () => {
  const api = new ChainApi({ chain, block: 20_000_200 })
  expect(await api.call({ target, abi: 'uint256:launchFee', block: 20_000_100 })).toBe('20000100')
  expect(await api.call({ target, abi: 'uint256:launchFee' })).toBe('20000200')
})

test("ChainApi.multiCall reads at the block the caller passes", async () => {
  const api = new ChainApi({ chain, block: 20_000_200 })
  expect(await api.multiCall({ abi: 'uint256:launchFee', calls: [target], block: 20_000_100 })).toEqual(['20000100'])
  expect(await api.multiCall({ abi: 'uint256:launchFee', calls: [target] })).toEqual(['20000200'])
})

test("ChainApi without a block still honours a block passed to call", async () => {
  const api = new ChainApi({ chain })
  expect(await api.call({ target, abi: 'uint256:launchFee', block: 20_000_100 })).toBe('20000100')
  expect(seen).toEqual([20_000_100])
})
