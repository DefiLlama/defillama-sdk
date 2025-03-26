
import _providerList from '../providers.json'
import fs from 'fs'
import axios from "axios";
import { debugLog } from './debugLog';
import PromisePool from '@supercharge/promise-pool';


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
    return require(__dirname+'/chainlistOrgCache.json')
  }
}

async function main() {
  const { data: oldProviders } = await axios(`https://unpkg.com/@defillama/sdk@latest/build/providers.json`)
  let chainData = await getChainData() 
  const providerIDMap = {} as {
    [key: string]: string[]
  }
  Object.values(providerList).forEach((i: any) => providerIDMap[i.chainId] = i.rpc)
  chainData = chainData
    .filter((i: any) => i.rpc.length)
    // .filter((i: any) => !i.status || (i.status === 'active' || i.status === 'incubating'))
    .filter((i: any) => i.shortName)

  // shuffle the array
  chainData.sort(() => Math.random() - 0.5)


  await PromisePool
    .withConcurrency(7)
    .for(chainData)
    .process(async (i: any) => {
      i.rpc = await filterForWorkingRPCs(i.rpc.map((j: any) => j.url), i.name, i.chainId)
      if (!i.rpc.length) return;
      if (providerIDMap[i.chainId]) {
        providerIDMap[i.chainId].push(...i.rpc)
      } else if (providerList[i.shortName.toLowerCase()]) {
        debugLog(`Duplicate short name ${i.chainId} for ${i.shortName}, doing nothing`)
      } else {
        const label = i.shortName.toLowerCase().replace(/-/g, '_')
        providerList[label] = {
          rpc: i.rpc,
          chainId: i.chainId
        }
        let explorer = i.explorers?.[0]?.url
        if (explorer) providerList[label].explorer = explorer
      }
    })

  Object.entries(providerList).forEach(([key, i]: any) => {
    if (key.includes('testnet')) {
      delete providerList[key]
      return;
    }
    i.rpc = Array.from(new Set(filterRPCs(i.rpc)));
    if (key.endsWith('-mainnet') || key.endsWith('_mainnet')) {
      const shortName = key.slice(0, -8)
      if (!providerList[shortName])
        providerList[shortName] = i
    }
  });
  Object.keys(providerList).forEach((i: any) => {
    if (!providerList[i].rpc.length) delete providerList[i]
  })
  for (const [key, shorName] of Object.entries(chainShortNameMapping)) {
    if (providerList[key]) continue
    providerList[key] = providerList[shorName]
  }

  if (providerList.hyperliquid) {
    providerList.hyperliquid.rpc.push('https://hyperliquid.cloud.blockscout.com/api/eth-rpc')
  }

  const droppedChains = Object.keys(oldProviders).filter(oldChain=>providerList[oldChain] === undefined)
  if(droppedChains.length > 20){
    throw new Error(`Following chains used to be included but is not anymore, can the devs fix please?\n${droppedChains.join('\n')}`)
  }

  fs.writeFileSync(__dirname + '/../providers.json', JSON.stringify(providerList));
}

const blacklist: string[] = [
  'https://eth.api.onfinality.io/public'
]

function filterRPCs(rpc: string[]): string[] {
  return rpc.filter((i: string) => {
    if (blacklist.includes(i)) return false // remove rpcs returning bad block heights etc
    if (i.endsWith('/demo')) return false // remove demo rpc
    if (i.includes('$')) return false // remove anything where api key is injected
    // reject websocket, http, testnet, devnet, and anything with '='
    if (/(wss\:|ws\:|http\:|test|devnet|terminet\.io|huobichain\.com|getblock\.io|bitstack\.com|nodereal.io\/v1|pokt\.network|ankr\.com|\=)/.test(i)) return false // remove anything with blacklisted words
    return true
  }).map((i: string) => {
    if (i.endsWith('/')) return i.slice(0, -1)
    return i
  })
}

const chainShortNameMapping = {
  real: 're-al',
  taiko: 'tko-mainnet',
  bsquared: 'b2-mainnet',
  ox_chain: 'ox-chain',
  ailayer: 'ailayer-mainnet',
  ontology: 'OntologyMainnet',
  occ: 'edu_chain',
  hyperliquid: 'hyper_evm',
  elsm: 'ely',
}

async function filterForWorkingRPCs(rpc: string[], chain: string, chainId: number): Promise<string[]> {
  if (rpc.length < 10) return rpc
  rpc = filterRPCs(rpc)

  const promises = await Promise.all(rpc.map(async (i: string) => {
    try {
      const { data } = await axios.post(i, {
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1
      }, {
        timeout: 30000
      })
      if (data.result) return i
    } catch (e) {
      console.log((e as any)?.message, i, chain)
    }
  }))

  return rpc.filter((_i: string, index: number) => promises[index])
}

main()
