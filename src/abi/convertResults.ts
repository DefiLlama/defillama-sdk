import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "ethers";

function stringifyBigNumbers(result: any, final: any) {
  Object.keys(result).forEach((key) => {
    try {
      if (
        BigNumber.isBigNumber(result[key]) ||
        typeof result[key] === "number"
      ) {
        final[key] = result[key].toString();
      } else if (typeof final[key] === "object") {
        stringifyBigNumbers(result[key], final[key]);
      } else {
        final[key] = result[key]
      }
    } catch (e) {
      console.log(e);
    }
  });
}

function containsNamedResults(obj: ethers.utils.Result) {
  return Object.keys(obj).some((key) => isNaN(Number(key))); // Are there any non-numeric keys?
}

export default function (results: ethers.utils.Result) {
  if (typeof results === "string" || typeof results === "boolean") {
    return results;
  }
  let convertedResults = {} as any;
  if (results instanceof Array && !containsNamedResults(results)) {
    // Match every idiosynchrasy of the SDK
    convertedResults = [];
  }
  if (BigNumber.isBigNumber(results) || typeof results === "number") {
    convertedResults = results.toString();
  } else {
    stringifyBigNumbers(results, convertedResults);
  }
  if (results instanceof Array) {
    if (results.length === 1) {
      return convertedResults[0];
    } else {
      // Some calls return the extra __length__ parameter (I think when some results are named)
      if (containsNamedResults(convertedResults)) {
        convertedResults["__length__"] = results.length;
      }
    }
  }
  return convertedResults;
}
