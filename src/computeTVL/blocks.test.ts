import { getCurrentBlocks } from "./blocks";

jest.setTimeout(30000);
test("multiple runs of getCurrentBlocks are fine", async () => {
  const calls = [];
  for (let i = 0; i < 3; i++) {
    calls.push(getCurrentBlocks());
  }
  await Promise.all(calls);
});
