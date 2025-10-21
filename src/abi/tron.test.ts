import { ChainApi } from "../ChainApi";
import { getBalance, getBalances } from "../eth/index";
import { ETHER_ADDRESS } from "../general";
import { getLatestBlock, lookupBlock } from "../util/blocks";
import getLogs from "../util/logs";


const intercroneFactory = 'TPvaMEL5oY2gWsJv7MDjNQh2dohwvwwVwx'
const tronPair = 'TW1gkyFAHstM33MJVk6tmKdcaPKkD2G4MG'
const tUSDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t'
const tronApi = new ChainApi({ chain: 'tron' })
const reservesAbi = "function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)"
test("call tron address 0x", async () => {
  expect(
    await tronApi.call({
      target: "0xa614f803b6fd780986a42c78ec9c7f77e6ded13c",
      abi: "erc20:decimals",
    })
  ).toEqual("6");
});

test("call tron address TR...", async () => {
  expect(
    await tronApi.call({
      target: tUSDT,
      abi: "erc20:decimals",
    })
  ).toEqual("6");
});

test("tron call: get token balance", async () => {
  expect(
    await tronApi.call({
      target: tUSDT,
      params: intercroneFactory,
      abi: "erc20:balanceOf",
    })
  ).toEqual("0");
});
test("tron multicall: get token balance", async () => {
  const res = await tronApi.multiCall({
    calls: [
      { target: tUSDT, params: intercroneFactory, },
      { target: tUSDT, params: intercroneFactory, },
    ],
    abi: "erc20:balanceOf",
  })
  expect(res.map(i => +i)).toEqual([0, 0]);
  expect(res).toEqual(['0', '0']);
});

test("tron call: uniswap methods", async () => {
  expect(
    +await tronApi.call({
      target: intercroneFactory,
      abi: "uint256:allPairsLength",
    })
  ).toBeGreaterThan(50);
  expect(
    await tronApi.call({
      target: intercroneFactory,
      abi: "function allPairs(uint256) view returns (address)",
      params: [1]
    })
  ).toEqual(tronPair);
});

test("multicall: tron", async () => {
  expect(
    await tronApi.multiCall({
      target: intercroneFactory,
      abi: "function allPairs(uint256) view returns (address)",
      calls: [0, 1, 2, 3, 4]
    })
  ).toEqual(["TGnK2w6vWX9dTL7ZsbXAarvc1CVujv9os8", tronPair, "TPT5yEpBxtS18cEGpRkkrBAANB4pD79ERT", "TF7ALfmpZeMhQhzJK8JXfhghrH7Exk2gkx", "TXemHTu125mZqubnibGPXrbgqKe89nV2Dv"]);
});

test("multicall no target passed: tron", async () => {
  expect(
    await tronApi.multiCall({
      abi: "address:token0",
      calls: ['TS2xnL5XW4JqMgSVizrhGLKNBekn5ubrLr', 'TLw6HAYJxZG2SEsmn2fx8myaqeFkGRa9KH', 'TAUtMLMQUcabAr48pJgxNUmX2zfDMSPptb', 'TEYbSjBNBN1kphjvbjKsBbtPLa5QdgArdx', 'TXPbj1xgKKWFuM6R4qG9iQx1Ao1aiBShML', 'TVGdFgp1oKksGXcozoYdM614by7pdJnzty',]
    })
  ).toEqual(["TLa2f6VPqDgRE67v1736s7bJ8Ray5wYjU7", "TCFLL5dx5ZJdKnWuesXxi1VPwjLVmWZZy9", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", "TNUC9Qb1rRpS5CbWLmNMxXBjyFoydXjWFR", "TKqvrVG7a2zJvQ3VysLoiz9ijuMNDehwy7",]);
});

test("call: output params with labels are honoured", async () => {
  const res = await tronApi.call({
    abi: reservesAbi,
    target: 'TS2xnL5XW4JqMgSVizrhGLKNBekn5ubrLr'
  })
  expect(res._reserve0).toBeDefined()
  expect(res._reserve1).toBeDefined()
});
test("multicall: output params with labels are honoured", async () => {
  const res = await tronApi.multiCall({
    abi: reservesAbi,
    calls: ['TS2xnL5XW4JqMgSVizrhGLKNBekn5ubrLr', 'TLw6HAYJxZG2SEsmn2fx8myaqeFkGRa9KH', 'TAUtMLMQUcabAr48pJgxNUmX2zfDMSPptb', 'TEYbSjBNBN1kphjvbjKsBbtPLa5QdgArdx', 'TXPbj1xgKKWFuM6R4qG9iQx1Ao1aiBShML', 'TVGdFgp1oKksGXcozoYdM614by7pdJnzty',]
  })
  res.forEach((i: any) => {
    expect(i._reserve0).toBeDefined()
    expect(i._reserve1).toBeDefined()
  })
});

test("tron: getBalance", async () => {
  expect(
    await getBalance({
      chain: 'tron',
      target: intercroneFactory,
    })
  ).toEqual({ "output": "0" });
});

test("tron: getBalances", async () => {
  const res = await getBalances({
    chain: 'tron',
    targets: [intercroneFactory, tronPair],
  })
  expect(res).toEqual({
    "output": [
      { "target": intercroneFactory, "balance": "0" },
      { "target": tronPair, "balance": "498" },
    ]
  })
});

test("tron: getBalances", async () => {
  const res = await getBalances({
    chain: 'tron',
    targets: ['TKgD8Qnx9Zw3DNvG6o83PkufnMbtEXis4T'],
  })
  expect(+res.output[0].balance).toBeGreaterThan(1e6)
});

test('tron: getLatestBlock', async () => {
  const res = await getLatestBlock('tron')
  expect(res.block).toBeDefined()
})


function getDiff(a: number, b: number): number {
  return (a > b) ? a - b : b - a;
}

test("tron: lookupBlock", async () => {
  const block = await lookupBlock(1668158653, { chain: 'tron' });
  expect(getDiff(block.block, 45858868)).toBeLessThanOrEqual(500); // 200 blocks appromiates to 10 minute difference
  expect(getDiff(block.timestamp, 1668158653)).toBeLessThanOrEqual(15 * 60); // difference should be under 15 minutes
});

test("tron: getLogs", async () => {
  const { block: latestBlock } = await getLatestBlock('tron')
  expect(latestBlock).toBeDefined()
  const fromBlock = latestBlock - 500
  const toBlock = latestBlock
  const logs = await getLogs({
    chain: 'tron',
    target: 'TEkxiTehnzSmSe2XqrBj4w32RUN966rdz8',
    fromBlock,
    toBlock,
    cacheInCloud: false,
    skipCache: true,
    eventAbi: 'event Transfer(address indexed from, address indexed to,uint256 value)',
  })
  expect(logs.length).toBeGreaterThan(0)
});

test("tron: chainApi.getBalances", async () => {

  // most of the trx here is staked, so good test to check staked balance is included
  const binanceColdWallet = 'TNPdqto8HiuMzoG7Vv9wyyYhWzCojLeHAF'

  const res = await tronApi.getGasTokenBalance(binanceColdWallet)
  const multiRes = await tronApi.getGasTokenBalances({ owners: [binanceColdWallet] })
  const tokenBalancesRes = await tronApi.getTokenBalances({ owners: [binanceColdWallet, binanceColdWallet, binanceColdWallet], tokens: [ETHER_ADDRESS], skipDuplicates: true, })
  const tokenBalancesDupsRes = await tronApi.getTokenBalances({ owners: [binanceColdWallet, binanceColdWallet, binanceColdWallet], tokens: [ETHER_ADDRESS] })

  expect(+res).toBeGreaterThan(1e13)
  expect(multiRes.length).toEqual(1)
  expect(tokenBalancesRes.length).toEqual(1)
  expect(multiRes).toEqual(tokenBalancesRes)
  expect(tokenBalancesDupsRes.length).toEqual(3)
  expect(tokenBalancesDupsRes[2]).toEqual(res)
})