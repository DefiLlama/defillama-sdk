import { symbol, info, balanceOf, totalSupply, decimals } from "./index";

test("symbol", async () => {
  expect(await symbol("0x6B175474E89094C44Da98b954EedeAC495271d0F")).toEqual({
    output: "DAI",
  });
});

test("decimals", async () => {
  expect(await decimals("0x6B175474E89094C44Da98b954EedeAC495271d0F")).toEqual({
    output: 18,
  });
});

test("info", async () => {
  expect(await info("0x6B175474E89094C44Da98b954EedeAC495271d0F")).toEqual({
    output: {
      symbol: "DAI",
      decimals: 18,
    },
  });
});

test("totalSupply", async () => {
  expect(
    await totalSupply({
      target: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      block: 9424366,
    })
  ).toEqual({
    output: "62681748267",
  });
});

test("balanceOf", async () => {
  expect(
    await balanceOf({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      owner: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      block: 9424627,
    })
  ).toEqual({
    output: "3914724000000000000",
  });
});
