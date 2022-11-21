import { BigNumber } from "@ethersproject/bignumber";
import { ethers } from "ethers";

function isNumberOrBigNumber(value: any) {
  return BigNumber.isBigNumber(value) || typeof value === "number"
}

function stringifyBigNumbers(result: any) {
  let final: any = {...result}
  if (Array.isArray(result))
    final = [...result]
  Object.keys(result).forEach((key) => {
    if (isNumberOrBigNumber(result[key]))
      final[key] = result[key].toString()
    else if (typeof result[key] === "object")
      final[key] = stringifyBigNumbers(result[key])
    else
      final[key] = result[key]
  });
  return final
}

export default function (results: ethers.utils.Result) {
  let response: any
  if (typeof results === "string" || typeof results === "boolean")
    return results

  if (isNumberOrBigNumber(results))
    return results.toString();

  response = stringifyBigNumbers(results)

  if (response instanceof Array)
    if (response.length === 1)
      return response[0]

  return response;
}
