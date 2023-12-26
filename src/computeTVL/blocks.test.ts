import { getCurrentBlocks } from "./blocks";

test("multiple runs of getCurrentBlocks are fine", async () => {
  const calls: Promise<any>[] = [];
  for (let i = 0; i < 50; i++) {
    calls.push(getCurrentBlocks());
  }
  await Promise.all(calls);
});

test("nahmii stopped producing new blocks", async () => {
  const calls: Promise<any>[] = [];
  for (let i = 0; i < 3; i++)
    calls.push(getCurrentBlocks(["nahmii"]));

  try {
    await Promise.all(calls)
    expect(true).toBe(false);
  } catch (e) { }
});
