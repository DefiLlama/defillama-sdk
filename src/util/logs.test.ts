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


test("logs - base - aerodrome2", async () => {
  const event_swap = 'event Swap(address indexed sender,address indexed to,uint256 amount0In,uint256 amount1In,uint256 amount0Out,uint256 amount1Out)'
  const logs = await getLogs({
    chain: 'base',
    target: "0x723aef6543aece026a15662be4d3fb3424d502a9",
    eventAbi: event_swap,
    fromBlock: 9003820,
    toBlock: 9004822,
  });
  expect(logs.length).toBe(1)
  expect(logs[0].args.sender).toBe("0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43")
});