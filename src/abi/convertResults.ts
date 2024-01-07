import { ethers } from "ethers";

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

export default function (results: ethers.Result, functionABI?: ethers.FunctionFragment) {
  let response: any
  if (typeof results === "string" || typeof results === "boolean")
    return results

  if (isNumberOrBigNumber(results))
    return results.toString();

  response = stringifyBigNumbers(results)

  if (functionABI && functionABI.outputs) {
    const outputNames = functionABI.outputs.map((i) => i.name)
    outputNames.map((name, i) => {
      setComponentDetails(response[i], functionABI.outputs[i])
      if (name)
        response[name] = response[i]
    })
  }

  if (response instanceof Array)
    if (response.length === 1)
      return response[0]

  return response;
}

function setComponentDetails(component: any, componentDefinition: any) {
  if (componentDefinition.type === "tuple[]")
    return component.map(setDetails)

  if (componentDefinition.type === "tuple")
    return setDetails(component)

  function setDetails(value: any) {
    const definitions = componentDefinition.components || componentDefinition.arrayChildren.components
    definitions.map((def: any, i: number) => {
      setComponentDetails(value[i], def)
      const name = def.name
      if (name)
        value[name] = value[i]
    })
  }
}