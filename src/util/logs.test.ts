import { getLogs, } from "./logs";
import ChainApi from "../ChainApi";

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

jest.setTimeout(30000)
test("logs - rate limit eth_getLogs", async () => {
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