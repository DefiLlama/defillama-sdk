import { getLogs, getTokens, getTokenTransfers, getTransaction } from "./indexer";
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

test("Indexer - getTransaction", async () => {
  const txHash = '0x1d1a14b882adf9d9c078a9868b682eba7833ebfd59ee0a93aa477c990056aa79'
  const res = await getTransaction(txHash, 'ethereum')
  if (!res) throw new Error('Transaction not found')

  expect(res.hash).toBe(txHash)
  expect(res.blockNumber).toBe(19000067)
  expect(res.from).toBe('0x00a7227f026012459c218f0d9eaabd992bd48c56')
  expect(res.to).toBe('0x28c6c06298d514db089934071355e5743bf21d60')
  expect(res.value).toBe('540432699734939000')
  expect(res.gas).toBe(207128)
  expect(res.gasPrice).toBe('17883340967')
  expect(res.nonce).toBe(68)
  expect(res.input).toBe('0x')
  expect(res.data).toBe('0x')
  expect(res.type).toBe(2)
  expect(res.maxFeePerGas).toBe('24000000000')
  expect(res.maxPriorityFeePerGas).toBe('2000000000')
  expect(res.baseFeePerGas).toBe(0)
  expect(res.effectiveGasPrice).toBe('17883340967')
  expect(res.gasUsed).toBe(21000)
  expect(res.cumulativeGasUsed).toBe(6678791)
  expect(res.status).toBe(1)
  expect(res.contractCreated).toBeUndefined()
  expect(res.timestamp).toBe('2024-01-13 19:30:47')
});