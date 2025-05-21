import { debugLog } from "./debugLog";
import { getTransaction as getIndexerTransaction, isIndexerEnabled } from "./indexer";

export async function getTransaction(tx: string, chain: string) {
  if (isIndexerEnabled(chain)) {
    try {
      const response = await getIndexerTransaction(tx, chain)
      if (response) return response
    } catch (e) {
      let message = (e as any)?.message
      debugLog('Error in indexer getTransaction', message)
    }
  }
  return null
} 