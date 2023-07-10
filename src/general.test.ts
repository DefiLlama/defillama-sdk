import { getBalance } from "./eth/index";
import { getProvider, setProvider } from "./general";
import { ethers, } from "ethers"

const dummyRPC = 'https://eth.llamarpc.com'

jest.setTimeout(10000);
test("RPC nodes from multiple chains support archive queries", async () => {
  for (const chain of ["ethereum", "fantom", "rsk", "avax"]) {
    try {
      const ethOwned = await getBalance({
        target: "0x0000000000000000000000000000000000000000",
        block: 100,
        chain: chain as any,
      });
      expect(ethOwned.output).toBe("0");
    } catch (e) {
      console.log(`Error on chain ${chain}`);
      throw e;
    }
  }
});

test("getProvider default behavior", async () => {
  const ethProvider = getProvider("ethereum")
  const ethProvider2 = getProvider("ethereum")

  expect(ethProvider).toEqual(ethProvider2);
});

test("getProvider - use rpc from env", async () => {
  const ethProvider = getProvider("ethereum")
  process.env.ETHEREUM_RPC = dummyRPC
  const ethProvider2 = getProvider("ethereum")
  const ethProvider3 = getProvider("ethereum")

  expect(ethProvider).not.toBe(ethProvider2)
  expect(ethProvider2).toBe(ethProvider3)
  expect((ethProvider3 as any).providerConfigs[0].provider.connection.url).toBe(dummyRPC)
});

test("getProvider - invalid chain", async () => {
  const llamaP = getProvider("llama-chain")
  expect(llamaP).toBeNull()
});

test("getProvider - chain throws error", async () => {
  process.env.SOLANA_RPC = 'https://api.mainnet-beta.solana.com'
  const solP = getProvider("solana")
  expect(solP).toBeNull()
});

test("getProvider - custom chain", async () => {
  const clvRPC = "https://api-para.clover.finance"
  const clvObject = new ethers.providers.StaticJsonRpcProvider(clvRPC, { name: "clv-llama-test", chainId: 1024, })
  setProvider("clv-llama-test",clvObject)
  const clvP = getProvider("clv-llama-test")
  const clvPMissing = getProvider("clv-llama-test-not")
  expect(clvP).not.toBeNull()
  expect(clvPMissing).toBeNull()
  expect((clvP as any).connection.url).toBe(clvRPC)
});