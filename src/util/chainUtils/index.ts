import { chainKeyToChainLabelMap, chainLabelsToKeyMap, } from './data.json'
import fs from 'fs'
import path from 'path'

interface ChainInfo {
  [key: string]: any
}

export { chainKeyToChainLabelMap, chainLabelsToKeyMap, }

export async function updateData(): Promise<void> {
  try {
    // mapping pulled from https://github.com/DefiLlama/defillama-server/blob/master/defi/src/utils/normalizeChain.ts
    const response = await fetch('https://api.llama.fi/overview/_internal/chain-name-id-map-v2')
    const remoteData: ChainInfo = await response.json()

    for (const [key, value] of Object.entries(remoteData.chainKeyToChainLabelMap)) {
      (chainKeyToChainLabelMap as any)[key] = value
    }

    for (const [key, value] of Object.entries(remoteData.chainLabelsToKeyMap)) {
      (chainLabelsToKeyMap as any)[key] = value
    }

    // Save to data.json file
    const dataFilePath = path.join(__dirname, 'data.json')
    fs.writeFileSync(dataFilePath, JSON.stringify({
      chainKeyToChainLabelMap: sortJSONData(chainKeyToChainLabelMap),
      chainLabelsToKeyMap: sortJSONData(chainLabelsToKeyMap),
    }, null, 2))
  } catch (error) {
    console.error('Error updating chain data:', error)
  }
}

export const sluggifyString = (name: string) => name.toLowerCase().split(" ").join("-").split("'").join("");

function sortJSONData(jsonData: ChainInfo): ChainInfo {
  const sortedKeys = Object.keys(jsonData).sort()
  const sortedData: ChainInfo = {}
  for (const key of sortedKeys) {
    sortedData[key] = jsonData[key]
  }
  return sortedData
}

const _chainLabelToChainIdCache = {} as { [label: string]: string }

Object.entries(chainLabelsToKeyMap as any).forEach(([label, id]: any) => {
  _chainLabelToChainIdCache[label] = id
  _chainLabelToChainIdCache[sluggifyString(label)] = id
})


// to be used if we are unsure if a label exists in our system, if it is known, use chainLabelsToKeyMap instead
export function getChainKeyFromLabel(label: string): string {
  let value = _chainLabelToChainIdCache[label]

  if (!value) {
    let sluggifiedLabel = sluggifyString(label)
    value = _chainLabelToChainIdCache[sluggifiedLabel]
    if (!value) {
      value = sluggifiedLabel.replace(/\-/g, '_') // try replacing - with _
      _chainLabelToChainIdCache[sluggifiedLabel] = value
    }
    _chainLabelToChainIdCache[label] = value
  }

  return value as string
}


// to be used if we are unsure if a label exists in our system, if it is known, use chainKeyToChainLabelMap instead
export function getChainLabelFromKey(id: string): string { // prefers new name
  let value = (chainKeyToChainLabelMap as ChainInfo)[id]
  if (value) return value

  value = id.slice(0, 1).toUpperCase() + id.slice(1);  // Capitalize first letter

  (chainKeyToChainLabelMap as ChainInfo)[id] = value
  return value
}