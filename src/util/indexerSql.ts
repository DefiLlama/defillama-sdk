import axios from "axios";
import http from "http";
import https from "https";
import { getEnvValue } from "./env";

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });
const httpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, maxFreeSockets: 16 });

function sqlConfig() {
  return {
    endpoint: getEnvValue("LLAMA_INDEXER_SQL_ENDPOINT"),
    user: getEnvValue("LLAMA_INDEXER_SQL_USER"),
    password: getEnvValue("LLAMA_INDEXER_SQL_PASSWORD"),
    timeoutMs: +getEnvValue("LLAMA_INDEXER_SQL_TIMEOUT_MS")! || 180_000,
  };
}

export function isIndexerSqlEnabled(): boolean {
  const c = sqlConfig();
  return !!(c.endpoint && c.user && c.password);
}

export async function queryClickhouse<T = any>(
  sql: string,
  params?: Record<string, unknown>,
  settings?: Record<string, string | number>
): Promise<T[]> {
  const { endpoint, user, password, timeoutMs } = sqlConfig();
  if (!endpoint || !user || !password) {
    throw new Error("Llama indexer SQL gateway not configured (LLAMA_INDEXER_SQL_ENDPOINT/USER/PASSWORD)");
  }

  const search = new URLSearchParams();
  search.set("default_format", "JSONEachRow");
  for (const [k, v] of Object.entries(params ?? {})) {
    search.set(`param_${k}`, typeof v === "object" ? JSON.stringify(v) : String(v));
  }
  for (const [k, v] of Object.entries(settings ?? {})) {
    search.set(k, String(v));
  }

  let res;
  try {
    res = await axios.post(`${endpoint}?${search.toString()}`, sql, {
      auth: { username: user, password },
      headers: { "Content-Type": "text/plain; charset=utf-8" },
      responseType: "text",
      transformResponse: (d) => d,
      timeout: timeoutMs,
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
  if (!text) return [];
  const out: T[] = [];
  for (const line of text.split("\n")) {
    if (!line) continue;
    out.push(JSON.parse(line) as T);
  }
  return out;
}
