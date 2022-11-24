import { getBalance, getBalances } from "./index";

test("getBalance", async () => {
  expect(
    await getBalance({
      target: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
      block: 16018720,
    })
  ).toEqual({
    output: "779645000329959489157",
  });
});

test("getBalance on all chains", async () => {
  const chains = [
    "ethereum",
    "bsc",
    "polygon",
    "fantom",
  ];
  await Promise.all(
    chains.map(async (chain) => {
      const ethOwned = await getBalance({
        target: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
        chain: chain as any,
      });
      expect(ethOwned.output).toBeDefined();
    })
  );
});

test("getBalances", async () => {
  expect(
    await getBalances({
      targets: [
        "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
        "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      ],
      block: 16018720,
    })
  ).toEqual({
    output: [
      {
        target: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
        balance: "779645000329959489157",
      },
      {
        target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
        balance: "0",
      },
    ],
  });
});
