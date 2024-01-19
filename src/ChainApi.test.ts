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
  expect(api.getBalances()).toEqual({ 'ethereum:eth': 10, 'bitcoin': 10 });
})

test("ChainApi - addToken", async () => {
  const api = new ChainApi({})
  api.addToken('eth', 5)
  api.add('eth', 5)
  api.addToken('bitcoin', 10, { skipChain: true })
  expect(api.getBalances()).toEqual({ 'ethereum:eth': 10, 'bitcoin': 10 });
})

test("ChainApi - addTokens", async () => {
  const api = new ChainApi({})
  api.add('eth', 5)
  api.add('eth', 5)
  api.add('bitcoin', 10, { skipChain: true })
  api.addTokens(['bsc', 'eth'], [15, 5])
  api.addTokens(['bitcoin', 'rsk'], [15, 5], { skipChain: true })
  expect(api.getBalances()).toEqual({ 'ethereum:eth': 15, 'ethereum:bsc': 15, 'bitcoin': 25, 'rsk': 5 });
})


test("ChainApi - cosmos ", async () => {
  const api = new ChainApi({ chain: 'injective' })
  api.add('peggy0x1Da189c1BA3d718Cc431a2ed240a3753f89CD47A', 5)
  api.add('ibc/kijura/isk123', 1)
  api.add('ibc/kijura/Factory/123', 5)
  api.add('injectiveNative', 1)
  expect(api.getBalances()).toEqual({ 'ethereum:0x1Da189c1BA3d718Cc431a2ed240a3753f89CD47A': 5, 'injective:injectiveNative': 1, 'ibc:kijura:isk123': 1, 'ibc:kijura:Factory:123': 5 });
})
test("ChainApi - log", async () => {
  const api = new ChainApi({})
  api.add('eth', 5)
  api.add('eth', 5)
  api.add('bitcoin', 10, { skipChain: true })
  api.addTokens(['bsc', 'eth'], [15, 5])
  api.addTokens(['bitcoin', 'rsk'], [15, 5], { skipChain: true })
  api.log(api.getBalances())
})

test("ChainApi - logTable", async () => {
  const api = new ChainApi({})
  api.add('eth', 5)
  api.add('eth', 5)
  api.add('bitcoin', 10, { skipChain: true })
  api.addTokens(['bsc', 'eth'], [15, 5])
  api.addTokens(['bitcoin', 'rsk'], [15, 5], { skipChain: true })
  api.logTable(api.getBalances())
})

test("ChainApi - addBalances", async () => {
  const api = new ChainApi({})
  api.add('eth', 5)
  api.add('eth', 5)
  api.add('bitcoin', 10, { skipChain: true })
  api.addBalances({ 'ethereum:eth': 10, 'bitcoin': 10, bsc: '50' })
  expect(api.getBalances()).toEqual({ 'ethereum:eth': 20, 'bitcoin': 20, bsc: '50' });
  api.addBalances(api.getBalances())
  api.addBalances(api.getBalances())
  api.addBalances(api.getBalances())
  expect(api.getBalances()).toEqual({ 'ethereum:eth': 20, 'bitcoin': 20, bsc: '50' });
})

test("ChainApi - getChainId", async () => {
  expect((new ChainApi({})).getChainId()).toEqual(1);
  expect((new ChainApi({ chain: 'arbitrum' })).getChainId()).toEqual(42161);
  expect((new ChainApi({ chain: 'optimism' })).getChainId()).toEqual(10);
  const fakeRPC = new ChainApi({ chain: 'solana' })
  // ensure that it doesnt throw any errors
  fakeRPC.provider
  fakeRPC.getChainId()
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

test("bad parameters throw error", async () => {
  const nullAddress = '0x0000000000000000000000000000000000000000'
  const testAbi = uniswapAbis.allPairsLength
  const apiBsc = new ChainApi({ chain: 'bsc' })
  const apiEth = new ChainApi({})
  await apiBsc.multiCall({ abi: testAbi, calls: ['0xa098751d407796d773032f5cc219c3e6889fb893'] })

  await expect(apiBsc.multiCall({ abi: testAbi, calls: ['0xa098751d407796d773032f5cc219c3e6889fb893', ''] })).rejects.toThrowError()
  await expect(apiEth.multiCall({ abi: testAbi, calls: [{}] })).rejects.toThrowError()
  await expect(apiEth.multiCall({ abi: testAbi, calls: [nullAddress] })).rejects.toThrowError()
});

const nullAddress = '0x0000000000000000000000000000000000000000'
test("bad parameters does not throw error with permitFailure Flag", async () => {
  const testAbi = uniswapAbis.allPairsLength
  const apiBsc = new ChainApi({ chain: 'bsc' })
  const apiEth = new ChainApi({})
  const testRes = await apiEth.multiCall({ abi: testAbi, permitFailure: true, calls: [nullAddress, 'ethTest'] })
  const testRes2 = await apiBsc.multiCall({ abi: testAbi, permitFailure: true, calls: [nullAddress, 'tester', undefined as any, {}, '0xa098751d407796d773032f5cc219c3e6889fb893'] })
  expect(testRes).toEqual([null, null])
  expect(testRes2).toEqual([null, null, null, null, "2"])
});

test("ChainApi - sumTokens - use tokens", async () => {
  const api = new ChainApi({})
  const res = await api.sumTokens({
    tokens: ['0xdac17f958d2ee523a2206206994597c13d831ec7',],
    owners: ['0xdac17f958d2ee523a2206206994597c13d831ec7'],
  })
  expect(+res['ethereum:0xdac17f958d2ee523a2206206994597c13d831ec7']).toBeGreaterThan(0)
})

test("ChainApi - sumTokens - use tokensAndOwners", async () => {
  const api = new ChainApi({})
  const res = await api.sumTokens({
    tokensAndOwners: [
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      [nullAddress, '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      [nullAddress, '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      [nullAddress, '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      [nullAddress, '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
    ]
  })

  const singleApi = new ChainApi({})
  const resSingle = await singleApi.sumTokens({
    tokensAndOwners: [
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      [nullAddress, '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
    ]
  })
  const key1 = 'ethereum:0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97'.toLowerCase()
  const key2 = 'ethereum:' + nullAddress
  expect(res[key1]).toEqual(resSingle[key1])
  expect(res[key2]).toEqual(resSingle[key2])
})
test("ChainApi - sumTokens - use ownerTokens", async () => {
  const api = new ChainApi({})
  const res = await api.sumTokens({
    ownerTokens: [
      [['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', nullAddress], '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A',],
    ]
  })
  
  const singleApi = new ChainApi({})
  const resSingle = await singleApi.sumTokens({
    tokensAndOwners: [
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      [nullAddress, '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
    ]
  })
  const key1 = 'ethereum:0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97'.toLowerCase()
  const key2 = 'ethereum:' + nullAddress
  expect(res[key1]).toEqual(resSingle[key1])
  expect(res[key2]).toEqual(resSingle[key2])
})

test("ChainApi - sumTokens - use tokensAndOwners2", async () => {
  const api = new ChainApi({})
  const res = await api.sumTokens({
    tokensAndOwners2: [
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', nullAddress, nullAddress, nullAddress],
      ['0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A',],
    ]
  })
  
  const singleApi = new ChainApi({})
  const resSingle = await singleApi.sumTokens({
    tokensAndOwners: [
      ['0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97', '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
      [nullAddress, '0x9a849A108764a5cE2Ab4CD3208071B304a9Ac99A'],
    ]
  })
  const key1 = 'ethereum:0x419B8ED155180A8c9C64145e76DaD49c0A4Efb97'.toLowerCase()
  const key2 = 'ethereum:' + nullAddress
  expect(res[key1]).toEqual(resSingle[key1])
  expect(res[key2]).toEqual(resSingle[key2])
})


test("ChainApi - sumTokens: tron", async () => {
  const api = new ChainApi({ chain: 'tron' })
  const res = await api.sumTokens({
    tokensAndOwners2: [
      ["TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", "TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", "TKqvrVG7a2zJvQ3VysLoiz9ijuMNDehwy7",],
      ['TS2xnL5XW4JqMgSVizrhGLKNBekn5ubrLr', 'TLw6HAYJxZG2SEsmn2fx8myaqeFkGRa9KH', 'TAUtMLMQUcabAr48pJgxNUmX2zfDMSPptb', 'TEYbSjBNBN1kphjvbjKsBbtPLa5QdgArdx', 'TXPbj1xgKKWFuM6R4qG9iQx1Ao1aiBShML', 'TVGdFgp1oKksGXcozoYdM614by7pdJnzty',],
    ]
  })
  expect(+res['tron:TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9']).toBeGreaterThan(0)
});


test("ChainApi - sumTokens - duplicated entries", async () => {
  const api = new ChainApi({})
  const polkaMultisig = '0x3BfC20f0B9aFcAcE800D73D2191166FF16540258'
  const token1 = '0xfb243bc5e98286e8560f17c3f6b48203afe43139'
  const blacklistedToken = '0xfe633a37c77241b825f1cf39afff44cb56242b77'
  const token2 = '0x537edd52ebcb9f48ff2f8a28c51fcdb9d6a6e0d4'
  const blacklistedToken2Owner = '0xc5Fba8936315A57217222593f0A6Bb0Bdcc2985B'
  const res = await api.sumTokens({
    tokensAndOwners2: [
      [nullAddress, nullAddress],
      [polkaMultisig, polkaMultisig, polkaMultisig, polkaMultisig],
    ],
    tokensAndOwners: [
      [token1, polkaMultisig],
      [nullAddress, polkaMultisig],
    ],
    blacklistedTokens: [blacklistedToken],
    blacklistedOwners: [blacklistedToken2Owner],
    tokens: [token2, nullAddress],
    owners: [polkaMultisig, blacklistedToken2Owner],
  })
  expect(+res['ethereum:0x0000000000000000000000000000000000000000']).toBeLessThan(3 * 1e23 * 1.1)
  expect(+res['ethereum:0x0000000000000000000000000000000000000000']).toBeGreaterThan(3 * 1e23)
})

test("ChainApi - sumTokens - era", async () => {
  const api = new ChainApi({ chain: 'era' })
  const polkaMultisig = '0x3BfC20f0B9aFcAcE800D73D2191166FF16540258'
  const token1 = '0xfb243bc5e98286e8560f17c3f6b48203afe43139'
  const blacklistedToken = '0xfe633a37c77241b825f1cf39afff44cb56242b77'
  const token2 = '0x537edd52ebcb9f48ff2f8a28c51fcdb9d6a6e0d4'
  const blacklistedToken2Owner = '0xc5Fba8936315A57217222593f0A6Bb0Bdcc2985B'
  const res = await api.sumTokens({
    tokensAndOwners2: [
      [nullAddress, nullAddress],
      [polkaMultisig, polkaMultisig, polkaMultisig],
    ],
    tokensAndOwners: [
      [nullAddress, polkaMultisig],
      [nullAddress, polkaMultisig],
    ],
    blacklistedTokens: [blacklistedToken],
    blacklistedOwners: [blacklistedToken2Owner],
    tokens: [nullAddress],
    owners: [polkaMultisig, blacklistedToken2Owner],
  })
  expect(+res["era:0x0000000000000000000000000000000000000000"]).toBeGreaterThan(0)
})

test("ChainApi - sumTokens - base", async () => {
  const api = new ChainApi({ chain: 'base' })
  const emptyAddr = '0x3BfC20f0B9aFcAcE800D73D2191166FF16540257'
  const blacklistedToken = '0xfe633a37c77241b825f1cf39afff44cb56242b77'
  const blacklistedToken2Owner = '0xc5Fba8936315A57217222593f0A6Bb0Bdcc2985B'
  const res = await api.sumTokens({
    tokensAndOwners2: [
      [nullAddress, nullAddress],
      [emptyAddr, emptyAddr, emptyAddr],
    ],
    tokensAndOwners: [
      [nullAddress, emptyAddr],
      [nullAddress, emptyAddr],
    ],
    blacklistedTokens: [blacklistedToken],
    blacklistedOwners: [blacklistedToken2Owner],
    tokens: [nullAddress],
    owners: [emptyAddr, blacklistedToken2Owner],
  })
  expect(res).toEqual({})
})


test("ChainApi - sumTokens - blacklisted entires", async () => {
  const api = new ChainApi({})
  const polkaMultisig = '0x3BfC20f0B9aFcAcE800D73D2191166FF16540258'
  const token1 = '0xfb243bc5e98286e8560f17c3f6b48203afe43139'
  const blacklistedToken2Owner = '0xc5Fba8936315A57217222593f0A6Bb0Bdcc2985B'
  const res = await api.sumTokens({
    tokensAndOwners2: [
      [nullAddress, nullAddress],
      [polkaMultisig, polkaMultisig, polkaMultisig],
    ],
    tokensAndOwners: [
      [token1, polkaMultisig],
      [token1, blacklistedToken2Owner],
      [nullAddress, polkaMultisig],
    ],
    blacklistedTokens: [token1],
    blacklistedOwners: [polkaMultisig],
    tokens: [token1],
    owners: [polkaMultisig, blacklistedToken2Owner],
  })
  expect(res).toEqual({})
})

const balancerPools = [
  '0x26fa40f1f29e3b495ec3c4c46b24df7EcDE796d9',
  '0x0708b37dD778E459bEAB114FDF1C431068888379',
  '0x9Bd09687Da5Ec6b50e8242E7cE3cc5C065FF07c9',
  '0x53149F25aF0D7D19c0c2D7389e1eC73A3e479c72',
]

test("ChainApi - erc4626Sum - 1", async () => {
  const api = new ChainApi({ chain: 'avax'})
  await api.erc4626Sum({ calls: balancerPools, tokenAbi: 'address:stakingToken', balanceAbi: 'uint256:totalDeposits' })
  expect(Object.keys(api.getBalances()).length).toBeGreaterThan(0)
})

test("ChainApi - erc4626Sum - 2", async () => {
  const api = new ChainApi({ chain: 'avax'})
  await api.erc4626Sum({ calls: balancerPools, tokenAbi: 'stakingToken', balanceAbi: 'totalDeposits' })
  expect(Object.keys(api.getBalances()).length).toBeGreaterThan(0)
})

test("ChainApi - erc4626Sum - 3", async () => {
  const api = new ChainApi({ chain: 'mantle'})
  await api.erc4626Sum({ calls: ['0x0DB2BA00bCcf4F5e20b950bF954CAdF768D158Aa'], isOG4626: true })
})
