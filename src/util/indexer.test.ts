import { getLogs, getTokens, } from "./indexer";
const contract = '0xf33c13da4425629c3f10635e4f935d8020f97D1F'
const eventAbi = 'event MarketCreated(uint256 indexed mIndex, address hedge, address risk, address token, string name, int256 strikePrice)'

test("Indexer - getTokens 1", async () => {
  const arbitrumBridge = '0xa3A7B6F88361F48403514059F1F16C8E78d60EeC'
  const res = await getTokens(arbitrumBridge, { skipCache: true })
  const ethTokenSet = new Set(res['ethereum'].map((t: any) => t.toLowerCase()))
  expect(ethTokenSet.has('0x0868da39ba4e8a083d6fede0536a11eed1337707')).toBe(true)
  expect(ethTokenSet.has('0x0000000000000000000000000000000000000000')).toBe(true)
});

test("Indexer - getLogs", async () => {

  const res = await getLogs({  
    target: contract,
    eventAbi,
    fromBlock: 16310967,
    toBlock: 20021179,
    chain: 'ethereum',
    entireLog: true,
  })
  expect(res.length).toBe(2)
  expect(res[0].source).toBe(contract.toLowerCase())
});


test("Indexer - getLogs - block not synced", async () => {
  const res = getLogs({  
    target: contract,
    eventAbi,
    fromBlock: 16310967,
    toBlock: 208211790,
    chain: 'ethereum',
  })
  await expect(res).rejects.toThrowError()
});