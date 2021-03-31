import { getBalance, getBalances } from "./index";

test("getBalance", async () => {
  expect(
    await getBalance({
      target: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
      block: 9424627,
    })
  ).toEqual({
    output: "2694789147548299731168",
  });
});

test("getBalance on all chains", async () => {
  const chains = [
    "ethereum",
    "bsc",
    "polygon",
    "heco",
    "fantom",
    "rsk",
    "tomochain",
  ];
  await Promise.all(
    chains.map(async (chain) => {
      const ethOwned = await getBalance({
        target: "0x0000000000000000000000000000000000000000",
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
      block: 9424627,
    })
  ).toEqual({
    output: [
      {
        target: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
        balance: "2694789147548299731168",
      },
      {
        target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
        balance: "0",
      },
    ],
  });
});
