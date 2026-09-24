import axios from "axios";
import http from "http";
import https from "https";
import { getEnvValue } from "./env";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });

function getSqlConfig() {
  const v4Endpoint = getEnvValue("LLAMA_INDEXER_V4_ENDPOINT");
  return {
    endpoint: getEnvValue("LLAMA_INDEXER_SQL_ENDPOINT") || (v4Endpoint ? `${v4Endpoint.replace(/\/+$/, "")}/sql` : undefined),
    user: getEnvValue("LLAMA_INDEXER_SQL_USER"),
    password: getEnvValue("LLAMA_INDEXER_SQL_PASSWORD"),
  };
}

export type IndexerSqlOptions = {
  /** Accepted for compatibility with dimension-adapters; all chains use the same gateway. */
  chain?: string;
  signal?: AbortSignal;
};

// ClickHouse HTTP query parameters use escaped text, not JSON. Nested strings
// must be quoted, and UInt64/UInt256 values must never pass through Number().
function serializeQueryParameter(value: unknown, nested = false): string {
  if (value === null || value === undefined) return nested ? "NULL" : "\\N";
  if (typeof value === "string") {
    const escaped = value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")
      .replace(/\t/g, "\\t").replace(/\n/g, "\\n").replace(/\r/g, "\\r");
    return nested ? `'${escaped}'` : escaped;
  }
  if (typeof value === "boolean") return nested ? (value ? "TRUE" : "FALSE") : (value ? "1" : "0");
  if (typeof value === "number") {
    if (Number.isNaN(value)) return "nan";
    if (!Number.isFinite(value)) return value > 0 ? "+inf" : "-inf";
    return String(value);
  }
  if (typeof value === "bigint") return String(value);
  if (Array.isArray(value)) return `[${value.map((v) => serializeQueryParameter(v, true)).join(",")}]`;
  if (value instanceof Date) {
    const seconds = String(Math.floor(value.getTime() / 1000)).padStart(10, "0");
    return value.getUTCMilliseconds() ? `${seconds}.${String(value.getUTCMilliseconds()).padStart(3, "0")}` : seconds;
  }
  if (typeof value === "object") {
    const entries = value instanceof Map ? [...value.entries()] : Object.entries(value);
    return `{${entries.map(([k, v]) => `${serializeQueryParameter(k, true)}:${serializeQueryParameter(v, true)}`).join(",")}}`;
  }
  throw new Error("Unsupported SQL query parameter type");
}

export function isIndexerSqlEnabled(): boolean {
  const c = getSqlConfig();
  return !!(c.endpoint && c.user && c.password);
}

export async function queryClickhouse<T = any>(
  sql: string,
  params?: Record<string, unknown>,
  settings?: Record<string, string | number>,
  options: IndexerSqlOptions = {},
): Promise<T[]> {
  const { endpoint, user, password } = getSqlConfig();
  if (!endpoint || !user || !password) {
    throw new Error("Llama indexer SQL gateway not configured (LLAMA_INDEXER_SQL_ENDPOINT/USER/PASSWORD)");
  }

  const url = new URL(endpoint);
  const search = url.searchParams;
  search.set("default_format", "JSONEachRow");
  for (const [name, value] of Object.entries(params ?? {})) {
    search.set(`param_${name}`, serializeQueryParameter(value));
  }
  for (const [name, value] of Object.entries(settings ?? {})) {
    search.set(name, String(value));
  }

  let res;
  try {
    res = await axios.post(url.toString(), sql, {
      auth: { username: user, password },
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      responseType: "text",
      transformResponse: (d) => d,
      // The gateway owns execution deadlines. Callers can still cancel a request.
      timeout: 0,
      signal: options.signal,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      httpAgent,
      httpsAgent,
    });
  } catch (e: any) {
    const status = e?.response?.status;
    const body = typeof e?.response?.data === "string" ? e.response.data.slice(0, 500) : "";
    throw new Error(`indexer /sql query failed${status ? ` (HTTP ${status})` : ""}: ${body || e?.message || e}`);
  }

  return parseJsonEachRow<T>(res.data as string);
}

function parseJsonEachRow<T>(text: string): T[] {
  return text.split("\n").filter(line => line.trim()).map(line => JSON.parse(line) as T);
}

/** Gateway-oriented name; queryClickhouse remains available for existing consumers. */
export const queryIndexerSql = queryClickhouse;
