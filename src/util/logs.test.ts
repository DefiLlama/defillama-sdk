import ChainApi from "../ChainApi";
import { getLogs, toFilterTopic, } from "./logs";

const baseApi = new ChainApi({ chain: 'base' })

test("logs - base - aerodrome", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'
  const logs = await baseApi.getLogs({
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003822,
    toBlock: 9004022,
    skipCache: true,
    entireLog: true,
  });
  expect(logs.length).toBe(1)
  expect(logs[0].blockNumber).toBe(9003822)
});

test("logs - malformed request", async () => {
  await expect(getLogs({
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    fromBlock: 9003822,
    toBlock: 9004022,
  })).rejects.toThrowError()

  await expect(getLogs({
    chain: 'base',
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    toBlock: 9004022,
  })).rejects.toThrowError()
});

test("logs - base - aerodrome2", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'
  const logs = await getLogs({
    chain: 'base',
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
    onlyArgs: true,
  });
  expect(logs.length).toBe(1)
  expect(logs[0].sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43")
});

test("logs - base - aerodrome 3", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'
  const logs = await baseApi.getLogs({
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
    onlyArgs: true,
  });
  expect(logs.length).toBe(1)
  expect(logs[0].sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43")
});

test.skip("logs - rate limit eth_getLogs", async () => {
  const api = new ChainApi({ chain: 'fantom' })
  const lpTokens = await api.fetchList({ lengthAbi: 'allPairsLength', itemAbi: 'allPairs', target: '0x472f3C3c9608fe0aE8d702f3f8A2d12c410C881A' })
  const toTimestamp = Math.floor(Date.now() / 1000 - 60 * 60 * 0.1)
  const fromTimestamp = Math.floor(Date.now() / 1000 - 60 * 60 * 2)
  await getLogs({
    chain: 'fantom', fromTimestamp, toTimestamp,
    targets: lpTokens,
    topic: '0xf5b850648f086f3f988a2c06dd4214f39db9fa92ee563e6246c398361d1963ad',
  });
});

test('toFilterTopic', () => {
  const topicExpectedPairs = [
    ["event Transfer (address indexed from, address indexed to, uint256 value)", '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
    ["event CreateMarket(address indexed pool, address lender0, address lender1)", '0x3f53d2c2743b2b162c0aa5d678be4058d3ae2043700424be52c04105df3e2411'],
    ['event NewBunni (address indexed  token, bytes32 indexed  bunniKeyHash, address indexed  pool, int24 tickLower, int24 tickUpper)', '0xa633a76553e9d8d77256f9284d85ae2eb5e5ef445d9e5686e3e6270e2e8fd4a8'],
    ['event CreatePool(address indexed poolAddress, string name, string symbol, uint256 purchaseTokenCap, address indexed purchaseToken, uint256 duration, uint256 sponsorFee, address indexed sponsor, uint256 purchaseDuration, bool hasAllowList)', '0x2f9902ccfa1b25adff84fa12ff5b7cbcffcb5578f08631567f5173b39c3004fe'],
    ['event TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)', '0xf5847d3f2197b16cdcd2098ec95d0905cd1abdaf415f07bb7cef2bba8ac5dec4'],
    ['event CreatedLPDA(address indexed vault, address indexed token, uint256 _id, tuple(uint32 startTime, uint32 endTime, uint64 dropPerSecond, uint128 startPrice, uint128 endPrice, uint128 minBid, uint16 supply, uint16 numSold, uint128 curatorClaimed, address curator) _lpdaInfo)', '0x4a08e09eb1f4b221a4d4faff944c52d3bb85486dd0f7e647977d35b406e16e43'],
  ]
  topicExpectedPairs.forEach(([event, expected]: any) => {
    expect(toFilterTopic(event)).toBe(expected)
  })
})

test("logs - maxBlockRange and processor", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'

  const processor = async (logs: any[]) => {
    logs.forEach(log => {
      log.processed = true;
      log.sender = log.args[0];
      log.to = log.args[1];
      log.amount0In = log.args[2];
      log.amount1In = log.args[3];
      log.amount0Out = log.args[4];
      log.amount1Out = log.args[5];
    });
  }

  const logs = await getLogs({
    chain: 'base',
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
    maxBlockRange: 100,
    processor
  });

  expect(logs.length).toBe(1);
  expect(logs[0].processed).toBe(true);
  expect(logs[0].sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43");
  expect(logs[0].to).toBe("0x1111111254EEB25477B68fb85Ed929f73A960582");
  expect(logs[0].amount0In).toBe(BigInt(0));
  expect(logs[0].amount1In).toBe(BigInt(1000));
  expect(logs[0].amount0Out).toBe(BigInt(21463255605));
  expect(logs[0].amount1Out).toBe(BigInt(0));
});

test("logs - base - aerodrome", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'
  const logs = await baseApi.getLogs({
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003822,
    toBlock: 9004022,
    entireLog: true,
    skipCache: true,
    skipIndexer: true,
  });
  expect(logs.length).toBe(1)
  expect(logs[0].blockNumber).toBe(9003822)
});

test("logs - malformed request", async () => {
  await expect(getLogs({
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    fromBlock: 9003822,
    toBlock: 9004022,
    skipCache: true,
    skipIndexer: true,
  })).rejects.toThrowError()

  await expect(getLogs({
    chain: 'base',
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    toBlock: 9004022,
    skipCache: true,
    skipIndexer: true,
  })).rejects.toThrowError()
});

test("logs - base - aerodrome2", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'
  const logs = await getLogs({
    chain: 'base',
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
    onlyArgs: true,
    skipCache: true,
    skipIndexer: true,
  });
  expect(logs.length).toBe(1)
  expect(logs[0].sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43")
});


test("logs - base - aerodrome 3", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'
  const logs = await baseApi.getLogs({
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
    onlyArgs: true,
    skipCache: true,
    skipIndexer: true,
  });
  expect(logs.length).toBe(1)
  expect(logs[0].sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43")
});


test.skip("logs - rate limit eth_getLogs", async () => {
  const api = new ChainApi({ chain: 'fantom' })
  const lpTokens = await api.fetchList({ lengthAbi: 'allPairsLength', itemAbi: 'allPairs', target: '0x472f3C3c9608fe0aE8d702f3f8A2d12c410C881A' })
  const toTimestamp = Math.floor(Date.now() / 1000 - 60 * 60 * 0.1)
  const fromTimestamp = Math.floor(Date.now() / 1000 - 60 * 60 * 2)
  await getLogs({
    chain: 'fantom', fromTimestamp, toTimestamp,
    targets: lpTokens,
    skipCache: true,
    skipIndexer: true,
    topic: '0xf5b850648f086f3f988a2c06dd4214f39db9fa92ee563e6246c398361d1963ad',
  });
});

test('toFilterTopic', () => {
  const topicExpectedPairs = [
    ["event Transfer (address indexed from, address indexed to, uint256 value)", '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef'],
    ["event CreateMarket(address indexed pool, address lender0, address lender1)", '0x3f53d2c2743b2b162c0aa5d678be4058d3ae2043700424be52c04105df3e2411'],
    ['event NewBunni (address indexed  token, bytes32 indexed  bunniKeyHash, address indexed  pool, int24 tickLower, int24 tickUpper)', '0xa633a76553e9d8d77256f9284d85ae2eb5e5ef445d9e5686e3e6270e2e8fd4a8'],
    ['event CreatePool(address indexed poolAddress, string name, string symbol, uint256 purchaseTokenCap, address indexed purchaseToken, uint256 duration, uint256 sponsorFee, address indexed sponsor, uint256 purchaseDuration, bool hasAllowList)', '0x2f9902ccfa1b25adff84fa12ff5b7cbcffcb5578f08631567f5173b39c3004fe'],
    ['event TokensRegistered(bytes32 indexed poolId, address[] tokens, address[] assetManagers)', '0xf5847d3f2197b16cdcd2098ec95d0905cd1abdaf415f07bb7cef2bba8ac5dec4'],
    ['event CreatedLPDA(address indexed vault, address indexed token, uint256 _id, tuple(uint32 startTime, uint32 endTime, uint64 dropPerSecond, uint128 startPrice, uint128 endPrice, uint128 minBid, uint16 supply, uint16 numSold, uint128 curatorClaimed, address curator) _lpdaInfo)', '0x4a08e09eb1f4b221a4d4faff944c52d3bb85486dd0f7e647977d35b406e16e43'],
  ]
  topicExpectedPairs.forEach(([event, expected]: any) => {
    expect(toFilterTopic(event)).toBe(expected)
  })
})

test("logs - maxBlockRange and processor", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'

  const processor = async (logs: any[]) => {
    logs.forEach(log => {
      log.processed = true;
      log.sender = log.args[0];
      log.to = log.args[1];
      log.amount0In = log.args[2];
      log.amount1In = log.args[3];
      log.amount0Out = log.args[4];
      log.amount1Out = log.args[5];
    });
  }

  const logs = await getLogs({
    chain: 'base',
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
    maxBlockRange: 100,
    skipCache: true,
    skipIndexer: true,
    processor
  });

  expect(logs.length).toBe(1);
  expect(logs[0].processed).toBe(true);
  expect(logs[0].sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43");
  expect(logs[0].to).toBe("0x1111111254EEB25477B68fb85Ed929f73A960582");
  expect(logs[0].amount0In).toBe(BigInt(0));
  expect(logs[0].amount1In).toBe(BigInt(1000));
  expect(logs[0].amount0Out).toBe(BigInt(21463255605));
  expect(logs[0].amount1Out).toBe(BigInt(0));
});

test("entireLog keeps the raw log (topics) and does NOT reduce to args", async () => {
  const eventSwap = "event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)";

  const logs = await getLogs({
    chain: "base",
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: eventSwap,
    fromBlock: 9003822,
    toBlock: 9004022,
    parseLog: false,
    entireLog: true,
    skipCache: true,
    skipIndexer: true,
  });

  expect(logs.length).toBe(1);
  const l = logs[0];

  expect(l.topics).toBeDefined();
  expect(l.args).toBeUndefined();
  expect(l.blockNumber).toBe(9003822);
});

test("onlyArgs=true returns ONLY the decoded arguments", async () => {
  const eventSwap = "event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)";

  const logs = await getLogs({
    chain: "base",
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: eventSwap,
    fromBlock: 9003822,
    toBlock: 9004022,
    onlyArgs: true,
    skipCache: true,
    skipIndexer: true, // force the RPC path
  });

  expect(logs.length).toBe(1);

  expect(typeof logs[0]).toBe("object");
  expect(Object.keys(logs[0]).length > 0 || logs[0].length > 0).toBe(true);

  expect((logs[0] as any).transactionHash).toBeUndefined();
  expect((logs[0] as any).blockNumber).toBeUndefined();
});

test("logs - onlyArgs are iterable arrays with named fields", async () => {
  const event_swap = "event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)";

  const logs = await baseApi.getLogs({
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
    onlyArgs: true,
    skipCache: true,
    skipIndexer: true
  });

  expect(logs.length).toBe(1);

  const args: any = logs[0];

  expect(Array.isArray(args)).toBe(true);

  expect(args.sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43");

  const [sender, to, amount0In, amount1In, amount0Out, amount1Out] = args;

  expect(sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43");
  expect(to).toBe("0x1111111254EEB25477B68fb85Ed929f73A960582");
  expect(amount0In).toBe(BigInt(0));
  expect(amount1In).toBe(BigInt(1000));
  expect(amount0Out).toBe(BigInt(21463255605));
  expect(amount1Out).toBe(BigInt(0));

  const totalAmount1In = logs.reduce(
    (acc: any, [, , , amt]: any) => acc + BigInt(amt || 0),
    BigInt(0),
  );

  expect(totalAmount1In).toBe(BigInt(1000));
});