
import providerList from '../providers.json'
import fs from 'fs'
import fetch from "node-fetch";

function fetchJson(url: string) {
  return fetch(url).then((res) => res.json());
}

async function main() {
  let chainData = await fetchJson('https://chainid.network/chains.json')
  const existingChainIds = new Set(Object.values(providerList).map(i => i.chainId))
  const existingChainNames = new Set(Object.keys(providerList))
  chainData = chainData
    .filter((i: any) => i.rpc.length)
    .filter((i: any) => !i.status || i.status === 'active')
    .filter((i: any) => i.shortName)
    .filter((i: any) => !existingChainIds.has(i.chainId))
    .filter((i: any) => !existingChainNames.has(i.shortName))
  const newList = {...providerList} as any
  chainData.forEach((i: any) => {
    newList[i.shortName.toLowerCase()] = {
      rpc: i.rpc,
      chainId: i.chainId
    }
  })
  fs.writeFileSync(__dirname+'/../providers.json', JSON.stringify(newList))
}

main()