import { multicallAddressOrThrow, networkSupportsMulticall } from "./multicall";
import makeMultiCall from "./multicall3";

const decimalsAbi = "function decimals() view returns (uint8)"

test("multicall basic", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] }], 'ethereum')
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
});

test("multicall bsc", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', params: [] }], 'bsc')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});

test("multicall pulse", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] }], 'pulse')
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
});
test("multicall nos", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0x111808AbE352c8003e0eFfcc04998EaB26Cebe3c', params: [] }], 'nos')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});

test("multicall onus", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0x4c761E48d1E735af551cc38ABCBDCe1d7FaaC6E4', params: [] }], 'onus')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});
test("multicall rollux", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0x4200000000000000000000000000000000000006', params: [] }], 'rollux')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});

test("multicall kardia", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xAF984E23EAA3E7967F3C5E007fbe397D8566D23d', params: [] }], 'kardia')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});

test("multicall3: pre multicall3 deploy", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] }], 'ethereum', 14353001)
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
  const output1 = await makeMultiCall(decimalsAbi, [{ contract: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', params: [] }], 'bsc', 15921052)
  expect(output1[0].output).toEqual('18');
  expect(output1[0].success).toEqual(true);
});

test("multicall3: post multicall3 deploy", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] }], 'ethereum', 'latest')
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
  const output1 = await makeMultiCall(decimalsAbi, [{ contract: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', params: [] }], 'bsc', 'latest')
  expect(output1[0].output).toEqual('18');
  expect(output1[0].success).toEqual(true);
});

test("multicall invalid call", async () => {
  const output = await makeMultiCall(decimalsAbi, [
    { contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] },
    { contract: '0xaac17f958d2ee523a2206206994597c13d831ec7', params: [] }, // invalid one
  ], 'ethereum')
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
  expect(output[1].output).toEqual(null);
  expect(output[1].success).toEqual(false);
});

test("set multicall via env", async () => {
  const testChain = 'env_multicall_chain'
  const fakeRPC = 'https://env_multicall_chain.org/'
  process.env[testChain.toUpperCase() + "_RPC_MULTICALL"] = fakeRPC
  const envMulti = await networkSupportsMulticall(testChain)
  expect(envMulti).toEqual(true);
});

test("check zkfair multicall", async () => {
  const testChain = 'zkfair'
  const envMulti = await networkSupportsMulticall(testChain)
  expect(envMulti).toEqual(true);
  expect(await multicallAddressOrThrow(testChain)).toEqual('0x9eF6667974Fb12D07774221AAB1E90b2ec48896E');
});