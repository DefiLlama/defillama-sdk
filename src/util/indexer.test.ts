import { ChainApi } from "../ChainApi";
import { getLogs, getTokenTransfers, getTransactions } from "./indexer";

const contract = '0xf33c13da4425629c3f10635e4f935d8020f97D1F'
const eventAbi = 'event MarketCreated(uint256 indexed mIndex, address hedge, address risk, address token, string name, int256 strikePrice)'

test("Indexer - getLogs", async () => {

  const res = await getLogs({
    target: contract,
    eventAbi,
    fromBlock: 16310967,
    toBlock: 16610967,
    chain: 'ethereum',
    entireLog: true,
  })
  expect(res.length).toBe(2)
  expect(res[0].source).toBe(contract.toLowerCase())
});


test("Indexer - getLogs - flatten false", async () => {

  const res = await getLogs({
    targets: [contract, '0x0000000000000000000000000000000000055555'],
    eventAbi,
    fromBlock: 16310967,
    toBlock: 16610967,
    chain: 'ethereum',
    flatten: false,
    onlyArgs: true,
  })
  expect(res[0].length).toBe(2)
  expect(res[0][0].mIndex).toBe(BigInt(1))
});



test("Indexer - getLogs - block not synced", async () => {
  const res = getLogs({
    target: contract,
    eventAbi,
    fromBlock: 508211790,
    toBlock: 508211791,
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

test("Indexer - getLogs - noTarget with large block range should throw", async () => {
  const res = getLogs({
    fromBlock: 10000000,
    toBlock: 60000000, // 50M blocks range
    chain: 'ethereum',
    topic: 'event Swap (address indexed sender, uint256 amount0In, uint256 amount1In, uint256 amount0Out, uint256 amount1Out, address indexed to)',
    noTarget: true,
  })
  await expect(res).rejects.toThrow('When noTarget is true, block range must be less than 500k blocks')
});

test("Indexer - getLogs - noTarget with > 10k block range", async () => {
  const res = await getLogs({
    fromBlock: 345461578,
    toBlock: 345803768, // ~~ 300k blocks
    chain: 'arbitrum',
    topics: ['0x40b88e5c41c5a97ffb7b6ef88a0a2d505aa0c634cf8a0275cb236ea7dd87ed4d'],
    noTarget: true,
  })
  expect(Array.isArray(res)).toBe(true)
});

test("Indexer - getLogs with processor", async () => {
  const api = new ChainApi({ chain: 'arbitrum' })
  const processor = async (logs: any[]) => {
    logs.forEach(({ args }) => {
      api.add(args.token, args.amount)
    })
  }

  await getLogs({
    fromBlock: 345461578,
    toBlock: 345803768, // ~~ 300k blocks
    chain: 'arbitrum',
    eventAbi: 'event WithdrawFromLockupStream (uint256 indexed streamId, address indexed to, address indexed token, uint128 amount)',
    noTarget: true,
    processor
  })

  const balances = api.getBalances()
  expect(Object.keys(balances).length).toBeGreaterThan(0)

  expect(balances['arbitrum:0x999FAF0AF2fF109938eeFE6A7BF91CA56f0D07e1']).toBe('225237781369731800000')
  expect(balances['arbitrum:0x577Fd586c9E6BA7f2E85E025D5824DBE19896656']).toBe('1.2409671794946094e+22')
  expect(balances['arbitrum:0x4e6b45BB1C7D11402faf72c2d59cAbC4085E36f2']).toBe('2.0821579300721433e+27')
  expect(balances['arbitrum:0xe47ba52f326806559c1deC7ddd997F6957d0317D']).toBe('574795991880981700000')
  expect(balances['arbitrum:0x83e5Ecd192eAc043B0674A16EEDf96176726A159']).toBe('9.92413672876591e+22')
  expect(balances['arbitrum:0xA533f744B179F2431f5395978e391107DC76e103']).toBe('272211934709000000000')
  expect(balances['arbitrum:0x4F604735c1cF31399C6E711D5962b2B3E0225AD3']).toBe('1e+21')
  expect(balances['arbitrum:0xC760F9782F8ceA5B06D862574464729537159966']).toBe('2.9174585867738748e+22')
  expect(balances['arbitrum:0x66E535e8D2ebf13F49F3D49e5c50395a97C137b1']).toBe('3768845891207509000')
  expect(balances['arbitrum:0x3269a3C00AB86c753856fD135d97b87FACB0d848']).toBe('1.2449725048906123e+22')
  expect(balances['arbitrum:0xC3323b6e71925b25943fB7369EE6769837e9C676']).toBe('8.9999999e+21')
  expect(balances['arbitrum:0x0721b3C9f19cfeF1d622C918DcD431960f35E060']).toBe('2.2350494277261517e+22')
})

test("Indexer - getTransactions", async () => {
  const txHash = '0x1d1a14b882adf9d9c078a9868b682eba7833ebfd59ee0a93aa477c990056aa79'
  const res = await getTransactions({
    chain: 'ethereum',
    addresses: ['0x00a7227f026012459c218f0d9eaabd992bd48c56'],
    transaction_hashes: [txHash],
    from_block: 19000067,
    to_block: 19001067,
  })
  if (!res || !res.length) throw new Error('Transaction not found')
  const tx = res[0]

  expect(tx.hash).toBe(txHash)
  expect(tx.blockNumber).toBe(19000067)
  expect(tx.from).toBe('0x00a7227f026012459c218f0d9eaabd992bd48c56')
  expect(tx.to).toBe('0x28c6c06298d514db089934071355e5743bf21d60')
  expect(tx.value).toBe(540432699734939000)
  expect(tx.gas).toBe(207128)
  expect(tx.gasPrice).toBe(17883340967)
  expect(tx.nonce).toBe(68)
  expect(tx.input).toBe('0x')
  expect(tx.data).toBe('0x')
  expect(tx.type).toBe(2)
  expect(tx.maxFeePerGas).toBe(24000000000)
  expect(tx.maxPriorityFeePerGas).toBe(2000000000)
  expect(tx.baseFeePerGas).toBe(15883340967)
  expect(tx.effectiveGasPrice).toBe(17883340967)
  expect(tx.gasUsed).toBe(21000)
  expect(tx.cumulativeGasUsed).toBe(6678791)
  expect(tx.status).toBe(1)
  expect(tx.contractCreated).toBeUndefined()
  expect(tx.timestamp).toBe('2024-01-13 19:30:47')
});

test("Indexer - getTransactions - missing from_block", async () => {
  await expect(getTransactions({
    chain: 'ethereum',
    transaction_hashes: ['0x1d1a14b882adf9d9c078a9868b682eba7833ebfd59ee0a93aa477c990056aa79'],
    to_block: 19000067,
  })).rejects.toThrow("'from_block' and 'to_block' are required to search for transactions");
});

test("Indexer - getTransactions - missing addresses and transaction_hashes", async () => {
  await expect(getTransactions({
    chain: 'ethereum',
    from_block: 19000067,
    to_block: 19001067,
  })).rejects.toThrow("You must provide at least 'addresses' or 'transaction_hashes'");
});

test("Indexer - getTransactions - to_block not synced", async () => {
  await expect(getTransactions({
    chain: 'ethereum',
    addresses: ['0x00a7227f026012459c218f0d9eaabd992bd48c56'],
    from_block: 19000067,
    to_block: 999999999,
  })).rejects.toThrow();
});

test("Indexer - getTransactions - unknown chain", async () => {
  await expect(getTransactions({
    chain: 'unknownchain',
    addresses: ['0x00a7227f026012459c218f0d9eaabd992bd48c56'],
    from_block: 19000067,
    to_block: 19001067,
  })).rejects.toThrow();
});

test("Indexer - getLogs - Viem vs Ethers comparison", async () => {
  const testConfig = {
    target: contract,
    eventAbi,
    fromBlock: 16310967,
    toBlock: 16610967,
    chain: 'ethereum',
    entireLog: true,
  };

  // Convert BigInt to string immediately to avoid Jest serialization issues
  function convertBigIntToString(obj: any): any {
    if (obj === null || obj === undefined) return obj;
    if (typeof obj === 'bigint') return obj.toString();
    if (Array.isArray(obj)) return obj.map(convertBigIntToString);
    if (typeof obj === 'object') {
      const converted: any = {};
      for (const key in obj) {
        converted[key] = convertBigIntToString(obj[key]);
      }
      return converted;
    }
    return obj;
  }

  const viemLogsRaw = await getLogs({
    ...testConfig,
    decoderType: "viem",
  });
  const viemLogs = convertBigIntToString(viemLogsRaw);

  const ethersLogsRaw = await getLogs({
    ...testConfig,
    decoderType: "ethers",
  });
  const ethersLogs = convertBigIntToString(ethersLogsRaw);

  expect(viemLogs.length).toBe(ethersLogs.length);
  expect(viemLogs.length).toBeGreaterThan(0);

  function normalizeArgsForComparison(args: any): any {
    if (!args) return args;
    
    const sorted = Object.keys(args).sort().reduce((acc: any, key: string) => {
      acc[key] = args[key];
      return acc;
    }, {} as any);
    
    return sorted;
  }

  for (let i = 0; i < viemLogs.length; i++) {
    const viemLog = viemLogs[i];
    const ethersLog = ethersLogs[i];

    // Compare basic fields
    expect(viemLog.transactionHash).toBe(ethersLog.transactionHash);
    expect(viemLog.logIndex ?? viemLog.index).toBe(ethersLog.logIndex ?? ethersLog.index);
    expect(viemLog.blockNumber).toBe(ethersLog.blockNumber);
    expect((viemLog.address ?? viemLog.source)?.toLowerCase()).toBe(
      (ethersLog.address ?? ethersLog.source)?.toLowerCase()
    );

    // Compare args if present
    if (viemLog.args || ethersLog.args) {
      const viemArgs = normalizeArgsForComparison(viemLog.args);
      const ethersArgs = normalizeArgsForComparison(ethersLog.args);

      expect(viemArgs).toEqual(ethersArgs);
    }
  }
});