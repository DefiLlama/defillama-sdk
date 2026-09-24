import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { parser } from "stream-json";
import Assembler from "stream-json/Assembler";

type RowKind = "logs" | "transfers" | "transactions";
const numericFields: Record<RowKind, string[]> = {
  logs: ["chain", "block_number", "log_index"],
  transfers: ["chain", "block_number", "log_index", "value", "id"],
  transactions: ["chain", "block_number", "transaction_index", "value", "gas", "gas_price",
    "gas_used", "effective_gas_price", "max_fee_per_gas", "max_priority_fee_per_gas",
    "base_fee_per_gas", "nonce", "transaction_type", "cumulative_gas_used"],
};
const addressFields: Record<RowKind, string[]> = {
  logs: ["source", "address"],
  transfers: ["from_address", "to_address", "token", "operator"],
  transactions: ["from_address", "to_address", "contract_created"],
};
const hashFields: Record<RowKind, string[]> = {
  logs: ["transaction_hash", "topic0", "topic1", "topic2", "topic3"],
  transfers: ["transaction_hash"],
  transactions: ["hash", "block_hash"],
};

function fixedHex(value: any, bytes: number) {
  // Empty/absent values are not the zero address or the zero topic.
  if (typeof value !== "string" || !/^0x[0-9a-f]+$/i.test(value)) return value;
  const hex = value.slice(2);
  return hex.length <= bytes * 2 ? `0x${hex.toLowerCase().padStart(bytes * 2, "0")}` : value;
}

/** Preserve v2 REST field types and padding; never applied to SQL results. */
export function normalizeV4Row(row: any, kind: RowKind) {
  for (const key of numericFields[kind]) {
    // The exact transfer id is captured for the cursor before restoring the public Number.
    if (typeof row[key] === "string" && /^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(row[key]))
      row[key] = Number(row[key]);
  }
  for (const key of addressFields[kind]) if (key in row) row[key] = fixedHex(row[key], 20);
  for (const key of hashFields[kind]) if (key in row) row[key] = fixedHex(row[key], 32);
  if (kind === "logs" && row.source === undefined && row.address !== undefined) row.source = row.address;
  return row;
}

/** Capture an unquoted UInt256 id before JSON.parse can round it. */
export async function parseTransferResponse(text: string) {
  const assembler = new Assembler();
  // Assembler only needs packed values, not intermediate string/number chunks.
  await pipeline(Readable.from([text]), parser({ streamValues: false }), async tokens => {
    for await (const token of tokens) {
      assembler.consume(token.name === "numberValue" && assembler.key === "id"
        ? { name: "stringValue", value: token.value } : token);
    }
  });
  return assembler.current;
}
