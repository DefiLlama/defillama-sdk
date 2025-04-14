
import _providerList from '../providers.json'
import fs from 'fs'
import axios from "axios";


const providerList = _providerList as {
  [key: string]: {
    rpc: string[]
    chainId: number
    explorer?: string
  }
}

async function getChainData() {
  try {
    const { data: chainData } = await axios('https://chainlist.org/rpcs.json')
    return chainData
  } catch (e) {
    console.log('Failed to fetch chainlist.org, falling back to local copy')
    // https://unpkg.com/@defillama/sdk@latest/build/providers.json
    return require(__dirname + '/chainlistOrgCache.json')
  }
}

async function main() {
  let chainData = await getChainData()
  const providerIDMap = {} as any
  Object.values(chainData).forEach((i: any) => providerIDMap[i.chainId] = {
    ...i,
    rpc: new Set(i.rpc.map((j: any) => j.url))
  })
  Object.entries(providerList).forEach(([key, data]: any) => {
    const chainListdata = providerIDMap[data.chainId]
    if (!chainListdata) return;
    data.rpc = data.rpc.filter((i: string) => {
      if (i.endsWith('/')) i = i.slice(0, -1)
      if (chainListdata.rpc.has(i)) {
        console.log(`Removing rpc ${i} from ${key} as it is already in chainlist`)
        return false
      }
      return true
    })
    if (!data.rpc.length && chainListdata.shortName === key) {
      delete providerList[key]
      console.log(`Removing ${key} as it has no rpcs left`)
      return
    }
  })
  fs.writeFileSync(__dirname + '/../providers.json', JSON.stringify(_providerList, null, 2));
}

main()
