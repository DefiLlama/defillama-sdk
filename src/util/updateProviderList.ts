
import _providerList from '../providers.json'
import fs from 'fs'
import { debugLog } from './debugLog';
import PromisePool from '@supercharge/promise-pool';
import { fetchJson, postJson } from '../generalUtil';

const concurrentCheckChains = +(process.env.SDK_BUILD_CONCURRENT_CHAINS || 7)
const chainRemovalThreshold = +(process.env.SDK_BUILD_CHAIN_REMOVAL_THRESHOLD || 20)


const providerList = _providerList as {
  [key: string]: {
    rpc: string[]
    chainId: number
    explorer?: string
  }
}

async function getChainData() {
  try {
    const chainData = await fetchJson('https://chainlist.org/rpcs.json')
    // fix for zksync era name clash
    const eteriaListing = chainData.find((i: any) => i.chainId === 140)
    if (eteriaListing) eteriaListing.shortName = 'eteria'

    return chainData
  } catch (e) {
    console.log('Failed to fetch chainlist.org, falling back to local copy')
    // https://unpkg.com/@defillama/sdk@latest/build/providers.json
    return require(__dirname + '/chainlistOrgCache.json')
  }
}

async function main() {
  const oldProviders = await fetchJson(`https://unpkg.com/@defillama/sdk@latest/build/providers.json`)
  const currentChains = await fetchJson(`https://raw.githubusercontent.com/DefiLlama/DefiLlama-Adapters/refs/heads/main/projects/helper/chains.json`)
  const currentChainsSet = new Set(currentChains)
  let chainData = await getChainData()
  const providerIDMap = {} as {
    [key: string]: string[]
  }
  Object.values(providerList).forEach((i: any) => providerIDMap[i.chainId] = i.rpc)
  chainData = chainData
    .filter((i: any) => i.rpc.length)
    // .filter((i: any) => !i.status || (i.status === 'active' || i.status === 'incubating'))
    .filter((i: any) => i.shortName)
    .filter((i: any) => {
      if (currentChainsSet.has(i.shortName)) return true

      const bannedKeys = ['sepolia', 'test', 'goerli', 'devnet', 'holesky',]
      const bannedRPCKeys = ['sepolia', 'goerli', 'devnet', 'holesky']
      const isTestnetKey = bannedKeys.some((j: string) => i.shortName.includes(j))
      const hasTestnetRPC = i.rpc.some((rpc: any) => bannedRPCKeys.some((k: string) => rpc?.url.includes(k)))
      if (isTestnetKey || hasTestnetRPC)
        console.log(`Excluding testnet chain ${i.name} (${i.shortName})`)
      return !isTestnetKey && !hasTestnetRPC
    })

  // trim/remove mainnet|-mainnet|_mainnet from short names, preliminary rpc filtering
  const rpcFilterRegex = /(wss\:|ws\:|terminet\.io|huobichain\.com|getblock\.io|bitstack\.com|nodereal.io\/v1|pokt\.network|histori\.xyz|chainstacklabs\.com|owlracle\.info|blastapi\.io)/
  chainData.forEach((i: any) => {

    if (currentChainsSet.has(i.shortName)) {
      // keep the short name as is
    } if (i.shortName.endsWith('-mainnet'))
      i.shortName = i.shortName.slice(0, -8)
    else if (i.shortName.endsWith('_mainnet'))
      i.shortName = i.shortName.slice(0, -8)
    else if (i.shortName.endsWith('mainnet'))
      i.shortName = i.shortName.slice(0, -7)


    i.rpc = i.rpc.filter((j: any) => {
      if (!j.url) return false;
      if (rpcFilterRegex.test(j.url)) {
        console.log(`Removing blacklisted rpc ${j.url} from ${i.name}`)
        return false // remove anything with blacklisted words
      }
      return true
    })
  })

  // shuffle the array
  chainData.sort(() => Math.random() - 0.5)


  await PromisePool
    .withConcurrency(concurrentCheckChains)
    .for(chainData)
    .process(async (i: any) => {
      i.rpc = await filterForWorkingRPCs(i.rpc.map((j: any) => j.url), i.name, i.chainId)
      if (!i.rpc.length) return;
      if (providerIDMap[i.chainId]) {
        const isBEVM = i.chainId + '' === '11501'  // bevm chain id clashes with 
        if (!isBEVM)
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
    i.rpc.forEach((j: string) => {
      if (filterRPCs([j]).length === 0) {
        debugLog(`Removing rpc ${j} from ${key}`)
      }
    })
    i.rpc = Array.from(new Set(filterRPCs(i.rpc)));
  });
  Object.keys(providerList).forEach((i: any) => {
    if (!providerList[i].rpc.length) delete providerList[i]
  })
  for (const [key, shorName] of Object.entries(chainShortNameMapping)) {
    if (providerList[key]) continue
    providerList[key] = providerList[shorName]
  }

  const droppedChains = Object.keys(oldProviders).filter(oldChain => providerList[oldChain] === undefined)
  if (droppedChains.length > chainRemovalThreshold) {
    throw new Error(`Following chains used to be included but is not anymore, can the devs fix please?\n${droppedChains.join(', ')}`)
  }

  delete providerList.bitcoin // what were they smoking?


  const rpcCount = Object.values(providerList).reduce((acc, i) => acc + (i?.rpc.length ?? 0), 0)
  console.log('Final provider list:')
  console.log('Chain count:', Object.keys(providerList).length)
  console.log('Dropped chain count:', droppedChains.length)
  console.log('RPC count:', rpcCount)
  console.log('Dropped chains:', droppedChains.join(', '))

  fs.writeFileSync(__dirname + '/../providers.json', JSON.stringify(providerList));
}

const blacklist: string[] = [
  'https://eth.api.onfinality.io/public'
]

// this is stricter filtering used only when chain has more than 10 rpcs
function filterRPCs(rpc: string[]): string[] {
  return rpc.filter((i: string) => {
    if (blacklist.includes(i)) return false // remove rpcs returning bad block heights etc
    if (i.endsWith('/demo')) return false // remove demo rpc
    if (!i.startsWith('http')) return false // remove demo rpc
    if (i.includes('$')) return false // remove anything where api key is injected
    // reject websocket, http, testnet, devnet, and anything with '='
    if (/(wss\:|ws\:|http\:|test|devnet|terminet\.io|huobichain\.com|getblock\.io|bitstack\.com|nodereal.io\/v1|pokt\.network|ankr\.com|histori\.xyz|chainstacklabs\.com|owlracle\.info|blastapi\.io|\=)/.test(i)) return false // remove anything with blacklisted words
    return true
  }).map((i: string) => {
    if (i.endsWith('/')) return i.slice(0, -1)
    return i
  })
}

const chainShortNameMapping = {
  real: 're-al',
  karura: 'karura_evm',
  taiko: 'tko-mainnet',
  bsquared: 'b2-mainnet',
  ox_chain: 'ox-chain',
  ailayer: 'ailayer-mainnet',
  ontology: 'OntologyMainnet',
  occ: 'edu_chain',
  hyperliquid: 'hyper_evm',
  hydradx: 'hdx',
  nibiru: 'cataclysm_1',
  fraxtal: 'frax',
  elsm: 'ely',
  tac: 'tacchain',
  xone: 'xoc',
  hydragon: 'hydra',
  camp: 'campmainnet',
  mantra: 'mantrachain',
  saga: 'sagaevm',
}

async function filterForWorkingRPCs(rpc: string[], chain: string, chainId: number): Promise<string[]> {
  if (rpc.length < 10) return rpc
  rpc = filterRPCs(rpc)

  const promises = await Promise.all(rpc.map(async (i: string) => {
    try {
      const data = await postJson(i, {
        jsonrpc: '2.0',
        method: 'eth_blockNumber',
        params: [],
        id: 1
      }, {
        timeout: 30000
      })
      if (data.result) return true
    } catch (e) {
      console.log('ignoring bad rpc', chain, (e as any)?.message)
    }
    return false
  }))

  return rpc.filter((_i: string, index: number) => promises[index])
}

main()
