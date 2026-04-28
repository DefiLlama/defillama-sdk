import { call, multiCall } from "./index";
import { getBalance, getBalances } from "../eth/index";
import { LogArray } from "../types";

const expectedResults: { [test: string]: LogArray } = {
  call: [
    {
      chain: "ethereum",
      token: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      holder: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      amount: "3914724000000000000",
    },
  ],
  multiCall: [
    {
      chain: "ethereum",
      holder: "0xecd5e75afb02efa118af914515d6521aabd189f1",
      token: "0x0000000000085d4780B73119b644AE5ecd22b376",
      amount: "14625620499802070062319404",
    },
    {
      chain: "ethereum",
      holder: "0xd9ebebfdab08c643c5f2837632de920c70a56247",
      token: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
      amount: "309111153048197706206870",
    },
  ],
  getBalance: [
    {
      chain: "ethereum",
      holder: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
      token: "0x0000000000000000000000000000000000000000",
      amount: "779645000329959489157",
    },
  ],
  getBalances: [
    {
      chain: "ethereum",
      holder: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
      token: "0x0000000000000000000000000000000000000000",
      amount: "779645000329959489157",
    },
    {
      chain: "ethereum",
      holder: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      token: "0x0000000000000000000000000000000000000000",
      amount: "0",
    },
  ],
};

const objectArraysEqual = (oa1: any[], oa2: any[]) =>
  !oa1
    .map(
      (o1: any, i: number) =>
        Object.keys(o1).length === Object.keys(oa2[i]).length &&
        Object.keys(o1).every((p) => o1[p] === oa2[i][p]),
    )
    .includes(false);

test("log array call", async () => {
  const logArray: LogArray = [];
  await call({
    target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
    params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
    abi: "erc20:balanceOf",
    block: 15997547,
    logArray,
  });
  expect(objectArraysEqual(logArray, expectedResults.call)).toBe(true);
});
test("log array multiCall", async () => {
  const logArray: LogArray = [];
  await multiCall({
    calls: [
      {
        target: "0x0000000000085d4780B73119b644AE5ecd22b376",
        params: "0xecd5e75afb02efa118af914515d6521aabd189f1",
      },
      {
        target: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
        params: "0xd9ebebfdab08c643c5f2837632de920c70a56247",
      },
    ],
    abi: "erc20:balanceOf",
    block: 15997547,
    logArray,
  });
  expect(objectArraysEqual(logArray, expectedResults.multiCall)).toBe(true);
});
test("log array getBalance", async () => {
  const logArray: LogArray = [];
  await getBalance({
    target: "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
    block: 16018720,
    logArray,
  });
  expect(objectArraysEqual(logArray, expectedResults.getBalance)).toBe(true);
});
test("log array getBalancess", async () => {
  const logArray: LogArray = [];
  await getBalances({
    targets: [
      "0xd5524179cB7AE012f5B642C1D6D700Bbaa76B96b",
      "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
    ],
    block: 16018720,
    logArray,
  });
  expect(objectArraysEqual(logArray, expectedResults.getBalances)).toBe(true);
});
