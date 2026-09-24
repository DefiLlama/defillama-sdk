import axios from "axios";
import http, { ServerResponse } from "http";
import { gzipSync } from "zlib";
import { isIndexerSqlEnabled, queryClickhouse, queryIndexerSql } from "./indexerSql";

describe("SQL configuration and parameters", () => {
  let post: jest.SpyInstance;
  const keys = ["LLAMA_INDEXER_SQL_ENDPOINT", "LLAMA_INDEXER_SQL_USER", "LLAMA_INDEXER_SQL_PASSWORD",
    "LLAMA_INDEXER_SQL_DATABASE", "LLAMA_INDEXER_SQL_TIMEOUT_MS", "LLAMA_INDEXER_V4_ENDPOINT"];
  const saved = { ...process.env };
  beforeEach(() => {
    post = jest.spyOn(axios, "post");
    for (const key of keys) for (const prefix of ["", "SDK_", "LLAMA_SDK_"]) delete process.env[prefix + key];
    process.env.LLAMA_INDEXER_SQL_ENDPOINT = "https://gateway.example/sql?database=evm_indexer";
    process.env.LLAMA_INDEXER_SQL_USER = "reader";
    process.env.LLAMA_INDEXER_SQL_PASSWORD = "test-password";
    post.mockReset();
    post.mockResolvedValue({ data: '{"n":"18446744073709551615"}\r\n \r\n{"n":1}\n' });
  });
  afterAll(() => {
    for (const key of keys) for (const prefix of ["", "SDK_", "LLAMA_SDK_"]) {
      if (saved[prefix + key] === undefined) delete process.env[prefix + key];
      else process.env[prefix + key] = saved[prefix + key];
    }
  });

  test("queryClickhouse keeps the row array and exact UInt64 strings", async () => {
    expect(queryIndexerSql).toBe(queryClickhouse);
    expect(await queryClickhouse("SELECT 1")).toEqual([{ n: "18446744073709551615" }, { n: 1 }]);
    const [url, sql, config] = post.mock.calls[0];
    expect(new URL(url).searchParams.get("database")).toBe("evm_indexer");
    expect(new URL(url).searchParams.get("default_format")).toBe("JSONEachRow");
    expect(sql).toBe("SELECT 1");
    expect(config.auth).toEqual({ username: "reader", password: "test-password" });
    expect(config.headers["x-api-key"]).toBeUndefined();
  });

  test("serializes nullable, array, map, boolean and UInt256 parameters as ClickHouse text", async () => {
    const big = BigInt("115792089237316195423570985008687907853269984665640564039457584007913129639935");
    await queryClickhouse("SELECT {items:Array(String)}", {
      items: ["a'b", "c\\d", "a\nb"], nullable: null, flag: true,
      nested: [[big, null, false]], map: new Map([["k", big]]), date: new Date("2020-01-01T00:00:00.123Z"),
    });
    const params = new URL(post.mock.calls[0][0]).searchParams;
    expect(params.get("param_items")).toBe("['a\\'b','c\\\\d','a\\nb']");
    expect(params.get("param_nullable")).toBe("\\N");
    expect(params.get("param_flag")).toBe("1");
    expect(params.get("param_nested")).toBe(`[[${big},NULL,FALSE]]`);
    expect(params.get("param_map")).toBe(`{'k':${big}}`);
    expect(params.get("param_date")).toBe("1577836800.123");
  });

  test("derives /sql from v4 only with separate SQL credentials", async () => {
    delete process.env.LLAMA_INDEXER_SQL_ENDPOINT;
    process.env.LLAMA_INDEXER_V4_ENDPOINT = "https://gateway.example/api/";
    expect(isIndexerSqlEnabled()).toBe(true);
    await queryClickhouse("SELECT 1");
    expect(new URL(post.mock.calls[0][0]).pathname).toBe("/api/sql");
    delete process.env.LLAMA_INDEXER_SQL_PASSWORD;
    expect(isIndexerSqlEnabled()).toBe(false);
    await expect(queryClickhouse("SELECT 1")).rejects.toThrow(/not configured/);
    expect(post).toHaveBeenCalledTimes(1);
  });

  test("leaves database and execution deadlines to the gateway and supports cancellation", async () => {
    process.env.LLAMA_INDEXER_SQL_ENDPOINT = "https://gateway.example/sql";
    process.env.LLAMA_INDEXER_SQL_DATABASE = "must-not-be-used";
    process.env.LLAMA_INDEXER_SQL_TIMEOUT_MS = "1";
    const signal = new AbortController().signal;
    await queryClickhouse("SELECT 1", undefined, { max_execution_time: 12 },
      { chain: "ethereum", signal });
    const [url, , config] = post.mock.calls[0];
    expect(new URL(url).searchParams.has("database")).toBe(false);
    expect(new URL(url).searchParams.get("max_execution_time")).toBe("12");
    expect(config.timeout).toBe(0);
    expect(config.signal).toBe(signal);
  });

  test("empty results, HTTP errors and late ClickHouse errors never return partial success", async () => {
    post.mockResolvedValueOnce({ data: "" });
    expect(await queryClickhouse("SELECT 1 WHERE 0")).toEqual([]);
    post.mockRejectedValueOnce({ response: { status: 503, data: "reader unavailable" } });
    await expect(queryClickhouse("SELECT 1")).rejects.toThrow("HTTP 503");
    post.mockResolvedValueOnce({ data: '{"n":1}\nCode: 159. DB::Exception: Timeout\n' });
    await expect(queryClickhouse("SELECT 1")).rejects.toThrow();
  });

  afterEach(() => jest.restoreAllMocks());

});

describe("SQL HTTP transport", () => {
  // Exercise real Axios/HTTP handling, not an Axios mock. No external service.
  const keys = ["LLAMA_INDEXER_SQL_ENDPOINT", "LLAMA_INDEXER_SQL_USER", "LLAMA_INDEXER_SQL_PASSWORD"];
  const saved = { ...process.env };
  let server: http.Server;
  let respond: (res: ServerResponse) => void;
  let receivedBytes = 0;
  let receivedAuth = "";
  let receivedUrl = "";

  beforeAll(async () => {
    for (const key of keys) for (const prefix of ["", "SDK_", "LLAMA_SDK_"]) delete process.env[prefix + key];
    server = http.createServer(async (req, res) => {
      receivedBytes = 0;
      receivedAuth = req.headers.authorization ?? "";
      receivedUrl = req.url ?? "";
      for await (const chunk of req) receivedBytes += chunk.length;
      respond(res);
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as import("net").AddressInfo).port;
    process.env.LLAMA_INDEXER_SQL_ENDPOINT = `http://127.0.0.1:${port}/sql`;
    process.env.LLAMA_INDEXER_SQL_USER = "fixture-user";
    process.env.LLAMA_INDEXER_SQL_PASSWORD = "fixture-secret";
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const key of keys) for (const prefix of ["", "SDK_", "LLAMA_SDK_"]) {
      const full = prefix + key;
      if (saved[full] === undefined) delete process.env[full];
      else process.env[full] = saved[full];
    }
  });

  test("posts large SQL without truncation, using Basic Auth and typed parameter binding", async () => {
    respond = res => res.end('{"ok":1}\n');
    const sql = `SELECT 1 /*${"x".repeat(3_500_000)}*/`;
    expect(await queryClickhouse(sql, { chain: 1 })).toEqual([{ ok: 1 }]);
    expect(receivedBytes).toBe(Buffer.byteLength(sql));
    expect(receivedAuth).toBe(`Basic ${Buffer.from("fixture-user:fixture-secret").toString("base64")}`);
    expect(new URL(receivedUrl, "http://fixture").searchParams.get("param_chain")).toBe("1");
  });

  test.each([false, true])("chunked Unicode NDJSON preserves strings, nulls and duplicate rows (gzip=%s)", async gzip => {
    const row = { text: "é 雪", value: "115792089237316195423570985008687907853269984665640564039457584007913129639935", empty: null };
    const body = Buffer.from(`${JSON.stringify(row)}\r\n \r\n${JSON.stringify(row)}\n`);
    respond = res => {
      const bytes = gzip ? gzipSync(body) : body;
      if (gzip) res.setHeader("Content-Encoding", "gzip");
      const cut = gzip ? 13 : body.indexOf(Buffer.from("雪")) + 1;
      res.write(bytes.subarray(0, cut));
      setImmediate(() => res.end(bytes.subarray(cut)));
    };
    expect(await queryClickhouse("SELECT 1")).toEqual([row, row]);
  });

  test.each([
    ["late server error", '{"ok":1}\nCode: 159. DB::Exception: timeout\n'],
    ["truncated last row", '{"ok":1}\n{"ok":'],
  ])("%s rejects instead of returning a partial result", async (_, body) => {
    respond = res => res.end(body);
    await expect(queryClickhouse("SELECT 1")).rejects.toThrow();
  });

  test("HTTP 503 rejects with status and without disclosing credentials", async () => {
    respond = res => { res.statusCode = 503; res.end("reader unavailable"); };
    let error: any;
    try { await queryClickhouse("SELECT 1"); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain("HTTP 503");
    expect(error.message).not.toContain("fixture-secret");
  });

  test("remote socket closure rejects and the next request can succeed", async () => {
    respond = res => {
      res.write('{"ok":1}\n');
      setImmediate(() => res.destroy());
    };
    await expect(queryClickhouse("SELECT 1")).rejects.toThrow();
    respond = res => res.end('{"ok":2}\n');
    expect(await queryClickhouse("SELECT 2")).toEqual([{ ok: 2 }]);
  });

  test("caller cancellation closes the HTTP request without returning partial rows", async () => {
    let closed!: () => void;
    const disconnected = new Promise<void>(resolve => { closed = resolve; });
    const controller = new AbortController();
    respond = res => {
      res.on("close", closed);
      res.write('{"ok":1}\n');
      controller.abort();
    };
    await expect(queryClickhouse("SELECT 1", undefined, undefined, { signal: controller.signal })).rejects.toThrow();
    await disconnected;
    respond = res => res.end('{"ok":2}\n');
    expect(await queryClickhouse("SELECT 2")).toEqual([{ ok: 2 }]);
  });
});
