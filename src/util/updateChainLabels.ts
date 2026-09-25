import { updateData, chainKeyToChainLabelMap, chainLabelsToKeyMap } from './chainUtils';

// pulls latest chain key <-> label mappings and dead chain list from the llama api and writes them to chainUtils/data.json
export async function updateChainLabels() {
  const chainKeyLabelMapCountBefore = Object.keys(chainKeyToChainLabelMap).length
  const chainLabelsKeyMapCountBefore = Object.keys(chainLabelsToKeyMap).length
  await updateData()

  const chainKeyLabelMapCountAfter = Object.keys(chainKeyToChainLabelMap).length
  const chainLabelsKeyMapCountAfter = Object.keys(chainLabelsToKeyMap).length

  if (chainKeyLabelMapCountAfter > chainKeyLabelMapCountBefore) {
    console.log(`Updated chainKeyToChainLabelMap: ${chainKeyLabelMapCountBefore} -> ${chainKeyLabelMapCountAfter}`)
  }
  if (chainLabelsKeyMapCountAfter > chainLabelsKeyMapCountBefore) {
    console.log(`Updated chainLabelsToKeyMap: ${chainLabelsKeyMapCountBefore} -> ${chainLabelsKeyMapCountAfter}`)
  }

  if (chainKeyLabelMapCountAfter < chainKeyLabelMapCountBefore)
    throw new Error('chainKeyToChainLabelMap count decreased, please investigate')
  if (chainLabelsKeyMapCountAfter < chainLabelsKeyMapCountBefore)
    throw new Error('chainLabelsToKeyMap count decreased, please investigate')
}

if (require.main === module) {
  updateChainLabels().then(() => process.exit(0)).catch((e) => {
    console.error(e)
    process.exit(1)
  })
}
