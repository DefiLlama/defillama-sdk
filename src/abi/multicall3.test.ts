import { multicallAddressOrThrow, networkSupportsMulticall } from "./multicall";
import makeMultiCall, { getMulticallAddress, isMulticallV3Supported } from "./multicall3";

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

test.skip("multicall pulse", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] }], 'pulse')
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
});
test.skip("multicall nos", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0x111808AbE352c8003e0eFfcc04998EaB26Cebe3c', params: [] }], 'nos')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});

test.skip("multicall onus", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0x4c761E48d1E735af551cc38ABCBDCe1d7FaaC6E4', params: [] }], 'onus')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});
test("multicall rollux", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0x4200000000000000000000000000000000000006', params: [] }], 'rollux')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});

test.skip("multicall kardia", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xAF984E23EAA3E7967F3C5E007fbe397D8566D23d', params: [] }], 'kardia')
  expect(output[0].output).toEqual('18');
  expect(output[0].success).toEqual(true);
});

test("multicall3: pre multicall3 deploy", async () => {
  const output = await makeMultiCall(decimalsAbi, [{ contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] }], 'ethereum', 14353001)
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
  // const output1 = await makeMultiCall(decimalsAbi, [{ contract: '0x2170ed0880ac9a755fd29b2688956bd959f933f8', params: [] }], 'bsc', 15921052)
  // expect(output1[0].output).toEqual('18');
  // expect(output1[0].success).toEqual(true);
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

test("multicall bad EIP-55 checksum target", async () => {
  // single `call` accepts mixed-case targets without validating the checksum, multiCall should behave the same
  const output = await makeMultiCall(decimalsAbi, [
    { contract: '0xdAC17F958D2ee523a2206206994597C13D831Ec7', params: [] }, // invalid checksum (Ec7 instead of ec7)
  ], 'ethereum')
  expect(output[0].output).toEqual('6');
  expect(output[0].success).toEqual(true);
});

test("multicall malformed target fails encoding", async () => {
  const output = await makeMultiCall(decimalsAbi, [
    { contract: '0xdac17f958d2ee523a2206206994597c13d831ec7', params: [] },
    { contract: '0x1234', params: [] }, // not an address
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
  delete process.env[testChain.toUpperCase() + "_RPC_MULTICALL"]
  expect(envMulti).toEqual(true);
});

test("check zkfair multicall", async () => {
  const testChain = 'zkfair'
  const envMulti = await networkSupportsMulticall(testChain)
  expect(envMulti).toEqual(true);
  expect(await multicallAddressOrThrow(testChain)).toEqual('0x9eF6667974Fb12D07774221AAB1E90b2ec48896E');
});

describe("multicall v3 contract via env override", () => {
  const envAddress = '0x1111111111111111111111111111111111111111'

  // NOTE: getMulticallV3ContractFromEnv memoizes per chain for the process
  // lifetime, so each test uses a distinct, otherwise-unknown chain name to
  // avoid cache bleed across cases (and to avoid touching real chains).

  test("an unknown chain with no override is unsupported", () => {
    // distinct chain name from the enable test below: the env lookup is
    // memoized per chain, so a chain probed while unset would stay unset.
    const chain = 'env_mc3_baseline' as any
    expect(isMulticallV3Supported(chain)).toBe(false)
    expect(getMulticallAddress(chain)).toBe(null)
  })

  test("override enables an otherwise-unsupported chain and supplies its address", () => {
    const chain = 'env_mc3_enable' as any
    process.env['ENV_MC3_ENABLE_RPC_MULTICALL_V3'] = envAddress
    try {
      expect(isMulticallV3Supported(chain)).toBe(true)
      expect(getMulticallAddress(chain)).toBe(envAddress)
    } finally {
      delete process.env['ENV_MC3_ENABLE_RPC_MULTICALL_V3']
    }
  })

  test("override wins for historical blocks (ignores deployment-block gating)", () => {
    const chain = 'env_mc3_block' as any
    process.env['ENV_MC3_BLOCK_RPC_MULTICALL_V3'] = envAddress
    try {
      expect(isMulticallV3Supported(chain, 100)).toBe(true)
      expect(getMulticallAddress(chain, 100)).toBe(envAddress)
    } finally {
      delete process.env['ENV_MC3_BLOCK_RPC_MULTICALL_V3']
    }
  })

  test("honors the SDK_ env prefix", () => {
    const chain = 'env_mc3_sdk' as any
    process.env['SDK_ENV_MC3_SDK_RPC_MULTICALL_V3'] = envAddress
    try {
      expect(isMulticallV3Supported(chain)).toBe(true)
      expect(getMulticallAddress(chain)).toBe(envAddress)
    } finally {
      delete process.env['SDK_ENV_MC3_SDK_RPC_MULTICALL_V3']
    }
  })

  test("honors the LLAMA_SDK_ env prefix", () => {
    const chain = 'env_mc3_llama' as any
    process.env['LLAMA_SDK_ENV_MC3_LLAMA_RPC_MULTICALL_V3'] = envAddress
    try {
      expect(isMulticallV3Supported(chain)).toBe(true)
      expect(getMulticallAddress(chain)).toBe(envAddress)
    } finally {
      delete process.env['LLAMA_SDK_ENV_MC3_LLAMA_RPC_MULTICALL_V3']
    }
  })

  test("chains already in the v3 registry are unaffected by the override being absent", () => {
    // sanity: a real supported chain still resolves to the canonical address
    expect(isMulticallV3Supported('ethereum')).toBe(true)
    expect(getMulticallAddress('ethereum')).toBe('0xca11bde05977b3631167028862be2a173976ca11')
  })
})