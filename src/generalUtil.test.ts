import { sumMultiBalanceOf, sumSingleBalance, mergeBalances, removeTokenBalance, sumChainTvls, convertToBigInt, } from "./generalUtil";
import ChainApi from "./ChainApi";
import { getHash, sleep, sleepRandom, sliceIntoChunks, normalizeAddress } from "./generalUtil";

test("sumMultiBalanceOf", () => {
  const balances = {
    "0x0000000000000000000000000000000000000000": "1380309269697565432250",
  };
  sumMultiBalanceOf(balances, {
    ethCallCount: 1,
    output: [
      {
        input: {
          target: "0x514910771af9ca656af840dff83e8264ecf986ca",
          params: ["0xa04197e5f7971e7aef78cf5ad2bc65aac1a967aa"],
        },
        success: true,
        output: "121787335350553116046",
      },
      {
        input: {
          target: "0xc00e94cb662c3520282e6f5717214004a7f26888",
          params: ["0xfa203e643d1fddc5d8b91253ea23b3bd826cae9e"],
        },
        success: true,
        output: "196377513373723266",
      },
      {
        input: {
          target: "0x80fb784b7ed66730e8b1dbd9820afd29931aab03",
          params: ["0xd48c88a18bfa81486862c6d1d172a39f1365e8ac"],
        },
        success: true,
        output: "240068223687113307904",
      },
      {
        input: {
          target: "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f",
          params: ["0x4cc89906db523af7c3bb240a959be21cb812b434"],
        },
        success: true,
        output: "32125191633871661847",
      },
    ],
  });
  expect(balances).toEqual({
    "0x0000000000000000000000000000000000000000": "1380309269697565432250",
    "0x514910771af9ca656af840dff83e8264ecf986ca": "121787335350553116046",
    "0xc00e94cb662c3520282e6f5717214004a7f26888": "196377513373723266",
    "0x80fb784b7ed66730e8b1dbd9820afd29931aab03": "240068223687113307904",
    "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f": "32125191633871661847",
  });
});

test("sumSingleBalance", () => {
  let balances = {};
  sumSingleBalance(balances, "ethereum", "2")
  expect(balances).toMatchObject({ ethereum: '2' })
  sumSingleBalance(balances, "ethereum", "5")
  expect(balances).toMatchObject({ ethereum: '7' })

  balances = { ethereum: '5000' }
  sumSingleBalance(balances, "ethereum", 2000)
  expect(balances).toMatchObject({ ethereum: 7000 })

  balances = { 'bsc:0x000': 5000 }
  sumSingleBalance(balances, "0x000", '2000', 'bsc')
  sumSingleBalance(balances, "0x000", '3000', 'bsc')
  expect(balances).toMatchObject({ 'bsc:0x000': 10000 })

  balances = { 'polygon:0x000': 5000 }
  sumSingleBalance(balances, "0x000", BigInt(2000), 'polygon')
  expect(balances).toMatchObject({ 'polygon:0x000': 7000 })

  balances = { 'avax:0x000': 6999 }
  sumSingleBalance(balances, "0x000", 1, 'avax')
  expect(balances).toMatchObject({ 'avax:0x000': 7000 })

  balances = { 'ethereum:0x000': '5000' }
  sumSingleBalance(balances, "0x000", '2000', 'ethereum')
  sumSingleBalance(balances, "0x000", 0, 'ethereum')
  sumSingleBalance(balances, "0x000", '0', 'ethereum')
  expect(balances).toMatchObject({ 'ethereum:0x000': '7000' })

  balances = { 'covalent:0x000': '5000' }
  sumSingleBalance(balances, "0x001", 0, 'ethereum')
  sumSingleBalance(balances, "0x002", '0', 'ethereum')
  expect(balances).toMatchObject({ 'covalent:0x000': '5000' })

  balances = { 'polygon:0x000': '5000' }
  sumSingleBalance(balances, "0x001", 100, 'bsc')
  sumSingleBalance(balances, "0x002", '0', 'ethereum')
  expect(balances).toMatchObject({ 'polygon:0x000': '5000', 'bsc:0x001': 100 })
});

test("sumSingleBalance throw error on invalid input", () => {
  expect(() => sumSingleBalance({ ethereum: 1 }, 'dummy', { bad: 1 } as any)).toThrowError()
  expect(() => sumSingleBalance({ ethereum: 1 }, 'dummy', null as any, 'bsc')).toThrowError()
  expect(() => sumSingleBalance({ ethereum: '1' }, 'ethereum', undefined as any)).toThrowError()
  expect(() => sumSingleBalance({ ethereum: 1 }, 'dummy', 'a111' as any, 'ethereum')).toThrowError()
  expect(() => sumSingleBalance({ ethereum: '1' }, 'dummy', '111a' as any, 'ethereum')).toThrowError()
});


test("sumSingleBalance with numbers", () => {
  const balances: any = {}
  const veryBigNumber = 1.731174581703269e+21
  sumSingleBalance(balances, 'dummy', '5')
  sumSingleBalance(balances, 'dummy', '1731174581703269000000')
  sumSingleBalance(balances, 'dummy2', '1.7e-12')
  sumSingleBalance(balances, 'dummy', BigInt(170))
  sumSingleBalance(balances, 'dummy', veryBigNumber)
  expect(balances['dummy']/veryBigNumber).toBeCloseTo(2)
});

test("sumChainTvls", async () => {
  const api = new ChainApi({})
  api.addTokens(['a', 'b', 'c'], [1, 2, 3], { skipChain: true })
  const balances = await (sumChainTvls([
    () => ({ d: 5 }),
    () => ({ d: 5 }),
    (_, _1, _2, { api }) => api.getBalances(),
    (_, _1, _2, { api }) => api.getBalances(),
  ]))(0, 0, {}, { api })
  expect(balances).toMatchObject({ 'a': 1, 'b': 2, 'c': 3, 'd': 10, })
});

test("removeTokenBalance", () => {
  let balances: any = { ethereum: '7', 'polygon:0x000': '5000' };
  let balances2 = removeTokenBalance(balances, "ethereum")
  expect(balances).toMatchObject({ 'polygon:0x000': '5000' })
  expect(balances2).toMatchObject({ 'polygon:0x000': '5000' })

  balances = { ethereum: '7', 'polygon:0x000': '5000', 'bsc:0x001': 100 }
  removeTokenBalance(balances, "0x000")
  removeTokenBalance(balances, "ETHEREUM")
  removeTokenBalance(balances, "BSC", true)
  expect(balances).toMatchObject({ 'bsc:0x001': 100 })

  balances = { 'coingecko:ethereum': '7', 'polygon:0x000': '5000', 'bsc:0x001': 100, 'coingecko:test': 500, }
  removeTokenBalance(balances, "polygon")
  removeTokenBalance(balances, "missing")
  removeTokenBalance(balances, "ETHEREUM")
  removeTokenBalance(balances, "0x001", true)
  expect(balances).toMatchObject({ 'coingecko:test': 500, })
});


test("mergeBalances", () => {
  let balances = {};
  mergeBalances(balances, { "ethereum": "2" })
  expect(balances).toMatchObject({ ethereum: '2' })
  mergeBalances(balances, { "ethereum": "5" })
  expect(balances).toMatchObject({ ethereum: '7' })

  balances = { ethereum: '5000' }
  mergeBalances(balances, { "ethereum": 2000 })
  expect(balances).toMatchObject({ ethereum: 7000 })

  balances = { 'bsc:0x000': 5000 }
  mergeBalances(balances, { "bsc:0x000": '2000', "0x000": '3000' })
  expect(balances).toMatchObject({ 'bsc:0x000': 7000, "0x000": '3000' })

  balances = { 'polygon:0x000': 5000 }
  mergeBalances(balances, { "0x000": BigInt(2000) } as any)
  expect(balances).toMatchObject({ 'polygon:0x000': 5000, "0x000": '2000' })

  balances = { 'avax:0x000': 6999 }
  mergeBalances(balances, { "avax:0x000": 1, })
  expect(balances).toMatchObject({ 'avax:0x000': 7000 })

  balances = { 'ethereum:0x000': '5000', fantom: 5, avax: 10, }
  mergeBalances(balances, { "ethereum:0x000": 1, })
  mergeBalances(balances, { "ethereum:0x000": '0' })
  expect(balances).toMatchObject({ 'ethereum:0x000': 5001, fantom: 5, avax: 10, })

  balances = {}
  const moreBalances = { 'ethereum:0x000': '5000', fantom: 5, avax: 10, }
  mergeBalances(balances, moreBalances)
  mergeBalances(balances, balances)
  mergeBalances(balances, balances)
  mergeBalances(balances, { "ethereum:0x000": '0' })
  expect(balances).toMatchObject({ 'ethereum:0x000': '5000', fantom: 5, avax: 10, })
});

test('convertToBigInt', () => {
  expect(convertToBigInt('1')).toBe(BigInt(1))
  expect(convertToBigInt(2.031945223e+22)).toBe(BigInt('20319452230000000000000'))
  expect(convertToBigInt('2.031e+22')).toBe(BigInt('20310000000000000000000'))
  expect(convertToBigInt('0x0000000000000000000139C5FfeE6153a7b8678f')).toBe(BigInt('1481753159505255786375055'))
})

test("getHash", () => {
  // Test basic functionality
  const hash1 = getHash("test string");
  expect(hash1).toBeDefined();
  expect(typeof hash1).toBe("string")
  
  // Test determinism (same input gives same output)
  const hash2 = getHash("test string");
  expect(hash1).toEqual(hash2);
  
  // Test different inputs give different outputs
  const hash3 = getHash("different string");
  expect(hash1).not.toEqual(hash3);
  
  // Test with empty string
  const emptyHash = getHash("");
  expect(emptyHash).toBeDefined();

  const longString = "a".repeat(1000);
  const longString2 = longString + "b"
  const longHash = getHash(longString);
  expect(longHash).toBeDefined();

  const longHash2 = getHash(longString2);
  expect(longHash).not.toEqual(longHash2);
});

test("sleep", async () => {
  const start = Date.now();
  await sleep(50); // Sleep for 50ms
  const duration = Date.now() - start;
  
  // Check that at least the sleep time has passed, with some tolerance
  expect(duration).toBeGreaterThanOrEqual(45);
});

test("sleepRandom", async () => {
  const start = Date.now();
  await sleepRandom(50, 100); // Sleep for between 50-100ms
  const duration = Date.now() - start;
  
  // Check that at least min sleep time has passed
  expect(duration).toBeGreaterThanOrEqual(45);
  
  // It's difficult to test the upper bound due to timing variations,
  // but we can check that it's reasonably close to our expected range
  expect(duration).toBeLessThan(150);
});

test("sliceIntoChunks", () => {
  const array = [1, 2, 3, 4, 5, 6, 7, 8];
  
  const chunks = sliceIntoChunks(array, 3);
  expect(chunks).toEqual([[1, 2, 3], [4, 5, 6], [7, 8]]);
  
  const singleChunk = sliceIntoChunks(array, 10);
  expect(singleChunk).toEqual([array]);
  
  const manyChunks = sliceIntoChunks(array, 1);
  expect(manyChunks).toEqual([[1], [2], [3], [4], [5], [6], [7], [8]]);
  
  // Test empty array
  expect(sliceIntoChunks([], 3)).toEqual([]);
});

test("normalizeAddress", () => {
  const upperAddress = "0xABCDEF1234567890ABCDEF1234567890ABCDEF12";
  const lowerAddress = "0xabcdef1234567890abcdef1234567890abcdef12";
  
  expect(normalizeAddress(upperAddress)).toBe(lowerAddress);
  expect(normalizeAddress(lowerAddress)).toBe(lowerAddress);
});
