import { getBalance } from "./eth/index";

jest.setTimeout(10000);
test("RPC nodes from multiple chains support archive queries", async () => {
  for (const chain of ["ethereum", "fantom", "rootstock", "avax"]) {
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
