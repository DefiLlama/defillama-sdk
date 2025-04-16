import { getLogs, getTokens, getTokenTransfers, } from "./indexer";
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

test("Indexer - getTokenTransfers", async () => {
  const addresses = ['0x1B5e59759577fa0079e2a35bc89143bc0603d546', '0xD5aC6419635Aa6352EbaDe0Ab42d25FbFa570D21']

  const res = await getTokenTransfers({
    targets: addresses,
    tokens: ['0xff970a61a04b1ca14834a43f5de4533ebddb5cc8', '0x09faeb69e29845f3326e4f004f45a31ceb0eedb9'],
    fromBlock: 119877801,
    toBlock: 119943935,
    chain: 'arbitrum',
  })
  const addressesSet = new Set(addresses.map((t: any) => t.toLowerCase()))
  expect(res.length).toBe(2)
  expect(res.some((i: any) => !addressesSet.has(i.to_address))).toBeFalsy()
});


test("Indexer - getLogs - multiple targets", async () => {
  const addresses = ['0xDFC14d2Af169B0D36C4EFF567Ada9b2E0CAE044f', '0xBb2b8038a1640196FbE3e38816F3e67Cba72D940'].map(i => i.toLowerCase())

  const res = await getLogs({
    targets: addresses,
    fromBlock: 22018452,
    toBlock: 22019085,
    chain: 'ethereum',
    topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
  })
  expect(res.length).toBe(37)
  expect(res.filter((i: any) => i.source === addresses[0]).length).toBe(4)
  expect(res.filter((i: any) => i.source === addresses[1]).length).toBe(33)
});


test("Indexer - getLogs - no targets - throw error", async () => {

  const res = getLogs({
    fromBlock: 22280140,
    toBlock: 22280145,
    chain: 'ethereum',
    topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)'
  })
  await expect(res).rejects.toThrowError()
});




test("Indexer - getLogs - no targets", async () => {

  const res = await getLogs({
    fromBlock: 22280140,
    toBlock: 22280145,
    chain: 'ethereum',
    topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
    noTarget: true,
  })
  expect(res.length).toBe(94)
});