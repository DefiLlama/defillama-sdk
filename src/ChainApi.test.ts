import { ChainApi } from "./ChainApi";

const uniswapAbis = {
  appPairs: { "constant": true, "inputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "name": "allPairs", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "payable": false, "stateMutability": "view", "type": "function" },
  allPairsLength: { "constant": true, "inputs": [], "name": "allPairsLength", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" },
}

test("ChainApi - fetchList", async () => {
  const apiBsc = new ChainApi({ chain: 'bsc' })
  const apiMoonbeam = new ChainApi({ chain: 'moonbeam' })

  const moonbeamRes = await apiMoonbeam.fetchList({
    target: "0xf6c49609e8d637c3d07133e28d369283b5e80c70",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
    startFrom: 3
  })
  const bscRes = await apiBsc.fetchList({
    target: "0xa098751d407796d773032f5cc219c3e6889fb893",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
  })

  expect(moonbeamRes).toEqual([
    '0x58E4538fd53F14466b2Fe0A732d6eF7981065d55',
    '0xECDbF021475C391564977a0A2d7BF9235bf13578'
  ]);
  expect(bscRes).toEqual([
    '0x1Da189c1BA3d718Cc431a2ed240a3753f89CD47A',
    '0xe606cEE895ddF32b0582A9DC7495176657b4909D'
  ]);
})

test("ChainApi - log", async () => {
  const api = new ChainApi({})
  api.log('test log')
  api.log('test log', 55555555555, {})
  api.log('test log', [55555555555], { abc: 'def' })
  expect(api.chain).toEqual('ethereum');
})

test("ChainApi - add", async () => {
  const api = new ChainApi({})
  api.add('eth', 5)
  api.add('eth', 5)
  api.add('bitcoin', 10, { skipChain: true })
  expect(api.balances).toEqual({ 'ethereum:eth': 10, 'bitcoin': 10 });
})

test("ChainApi - addTokens", async () => {
  const api = new ChainApi({})
  api.add('eth', 5)
  api.add('eth', 5)
  api.add('bitcoin', 10, { skipChain: true })
  api.addTokens(['bsc', 'eth'], [15, 5])
  api.addTokens(['bitcoin', 'rsk'], [15, 5], { skipChain: true })
  expect(api.balances).toEqual({ 'ethereum:eth': 15, 'ethereum:bsc': 15, 'bitcoin': 25, 'rsk': 5 });
})


test("ChainApi - addBalances", async () => {
  const api = new ChainApi({})
  api.add('eth', 5)
  api.add('eth', 5)
  api.add('bitcoin', 10, { skipChain: true })
  api.addBalances({'ethereum:eth': 10, 'bitcoin': 10, bsc: '50' })
  expect(api.balances).toEqual({ 'ethereum:eth': 20, 'bitcoin': 20, bsc: '50' });
})

test("ChainApi - call", async () => {
  const apiBsc = new ChainApi({ chain: 'bsc' })
  const bscRes = await apiBsc.call({
    target: "0xa098751d407796d773032f5cc219c3e6889fb893",
    params: [0],
    abi: uniswapAbis.appPairs,
  })

  expect(bscRes).toEqual('0x1Da189c1BA3d718Cc431a2ed240a3753f89CD47A');
})


test("ChainApi - multiCall", async () => {
  const apiMoonbeam = new ChainApi({ chain: 'moonbeam' })

  const moonbeamRes = await apiMoonbeam.multiCall({
    target: "0xf6c49609e8d637c3d07133e28d369283b5e80c70",
    abi: uniswapAbis.appPairs,
    calls: [3, 4],
  })

  expect(moonbeamRes).toEqual([
    '0x58E4538fd53F14466b2Fe0A732d6eF7981065d55',
    '0xECDbF021475C391564977a0A2d7BF9235bf13578'
  ]);
})