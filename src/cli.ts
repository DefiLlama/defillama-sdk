#!/usr/bin/env node
import path from "path";
import computeTVL from "./computeTVL";
import { provider } from "./general";
import { humanizeNumber } from "./computeTVL/humanizeNumber";

if (process.argv.length < 3) {
  console.error(`Missing argument, you need to provide the filename of the adapter to test.
    Eg: npx @defillama/sdk projects/myadapter.js`);
  process.exit(1);
}
const passedFile = path.resolve(process.cwd(), process.argv[2]);

(async () => {
  const moduleToTest = await import(passedFile);
  const block = await provider.getBlock("latest");
  let tvl = await moduleToTest.tvl(block.timestamp, block.number);
  if (typeof tvl !== "object") {
    throw new Error("TVL returned is not a balances object");
  }

  console.log("Total:", humanizeNumber(await computeTVL(tvl, "now")));
  process.exit(0);
})();
