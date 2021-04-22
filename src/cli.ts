#!/usr/bin/env node
import path from "path";
import computeTVL from "./computeTVL";
import { getCurrentBlocks } from "./computeTVL/blocks";
import { humanizeNumber } from "./computeTVL/humanizeNumber";

if (process.argv.length < 3) {
  console.error(`Missing argument, you need to provide the filename of the adapter to test.
    Eg: npx @defillama/sdk projects/myadapter.js`);
  process.exit(1);
}
const passedFile = path.resolve(process.cwd(), process.argv[2]);

(async () => {
  const moduleToTest = await import(passedFile);
  const { timestamp, ethereumBlock, chainBlocks } = await getCurrentBlocks();

  let tvl = await moduleToTest.tvl(timestamp, ethereumBlock, chainBlocks);
  if (typeof tvl !== "object") {
    throw new Error("TVL returned is not a balances object");
  }

  const { usdTvl } = await computeTVL(tvl, "now", true);
  console.log("Total:", humanizeNumber(usdTvl));
  process.exit(0);
})();
