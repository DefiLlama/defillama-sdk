import { ethers } from "ethers";
import { evmToTronAddress } from "../util/common";

function isNumberOrBigNumber(value: any) {
  return typeof value === 'bigint' || typeof value === "number"
}

function stringifyBigNumbers(result: any) {
  let final: any = { ...result }
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

export default function (results: ethers.Result, { functionABI, chain }: { functionABI?: ethers.FunctionFragment, chain?: string } = {}) {
  let response: any
  if (typeof results === "string" || typeof results === "boolean")
    return results

  if (isNumberOrBigNumber(results))
    return results.toString();

  response = stringifyBigNumbers(results)

  if (functionABI && functionABI.outputs) {
    functionABI.outputs.map((componentDefinition, i) => {
      setComponentDetails(response[i], componentDefinition, chain)
      setNameAndTranformAddress({ response, componentDefinition, chain, index: i })
    })
  }

  if (response instanceof Array)
    if (response.length === 1)
      return response[0]

  return response;
}

function setComponentDetails(component: any, componentDefinition: any, chain?: string) {
  if (componentDefinition.type === "tuple[]")
    return component.map((item: any) => setDetails(item, chain));

  if (componentDefinition.type === "tuple")
    return setDetails(component, chain)

  function setDetails(value: any, chain?: string) {
    const definitions = componentDefinition.components || componentDefinition.arrayChildren.components
    definitions.map((def: any, i: number) => {
      setComponentDetails(value[i], def, chain)
      setNameAndTranformAddress({ response: value, componentDefinition: def, chain, index: i })
    })
  }
}

function setNameAndTranformAddress({ response, componentDefinition, chain, index }: { response: any, componentDefinition: any, chain?: string, index: number, }) {

  if (chain === 'tron' && componentDefinition.type === 'address') {
    response[index] = evmToTronAddress(response[index])
  }

  if (componentDefinition?.name)
    response[componentDefinition.name] = response[index]

  return response
}