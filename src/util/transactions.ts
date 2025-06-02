import { debugLog } from "./debugLog";
import { getTransactions as getIndexerTransaction, isIndexer2Enabled } from "./indexer";

export interface GetTransactionOptions {
  addresses?: string[];
  from_block?: number;
  to_block?: number;
  transaction_hashes?: string[];
  limit?: number | 'all';
  offset?: number;
  chain: string;
  all?: boolean;
  debugMode?: boolean;
  transactionType?: 'from' | 'to' | 'all';
}

export async function getTransactions(params: GetTransactionOptions) {
  const { chain } = params;
  if (!isIndexer2Enabled(chain)) {
    throw new Error(`Indexer v2 not available for chain ${chain}`);
  }
  try {
    const response = await getIndexerTransaction(params);
    if (response) return response;
  } catch (e) {
    let message = (e as any)?.message;
    debugLog('Error in indexer getTransactions', message);
    throw e;
  }
  return null;
} 