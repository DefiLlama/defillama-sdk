import * as http from "http"
import { getProvider } from "./LlamaProvider"

const RESULT = "0x" + "0".repeat(63) + "7"

// an rpc host that answers 200 with a web page instead of a json-rpc body (eg. mainnet.telos.net/evm redirecting to a marketing site)
function startServer(handler: (method: string) => { status: number; body: string }): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let raw = ""
      req.on("data", (c) => (raw += c))
      req.on("end", () => {
        const { status, body } = handler(JSON.parse(raw).method)
        res.writeHead(status, { "content-type": body.startsWith("{") ? "application/json" : "text/html" })
        res.end(body)
      })
    })
    server.listen(0, "127.0.0.1", () => resolve({
      url: `http://127.0.0.1:${(server.address() as any).port}`,
      close: () => server.close(),
    }))
  })
}

const htmlPage = () => ({ status: 200, body: "<!DOCTYPE html><html><body>not an rpc</body></html>" })
const workingRPC = (method: string) => ({
  status: 200,
  body: JSON.stringify({ jsonrpc: "2.0", id: 1, result: method === "eth_blockNumber" ? "0x64" : RESULT }),
})

test("call fails over when an rpc returns a non json-rpc body", async () => {
  const bad = await startServer(htmlPage)
  const good = await startServer(workingRPC)
  process.env.SKIP_RPC_CHECK = "true" // keep the bad rpc in the pool
  process.env.RPC_NO_PLAYING_AROUND = "true" // so the bad rpc is tried first
  process.env.FAILOVERCHAIN_RPC = `${bad.url},${good.url}`
  try {
    const provider: any = getProvider("failoverchain")
    expect(await provider.call({ to: "0x" + "1".repeat(40), data: "0x01" })).toBe(RESULT)
  } finally {
    bad.close()
    good.close()
    delete process.env.SKIP_RPC_CHECK
    delete process.env.RPC_NO_PLAYING_AROUND
  }
})

test("health check drops an rpc whose eth_blockNumber is not a json-rpc body", async () => {
  const bad = await startServer(htmlPage)
  const good = await startServer(workingRPC)
  process.env.HEALTHCHECKCHAIN_RPC = `${bad.url},${good.url}`
  try {
    const provider: any = getProvider("healthcheckchain")
    await provider.call({ to: "0x" + "1".repeat(40), data: "0x01" })
    expect(provider.rpcs.map((i: any) => i.url)).toEqual([good.url])
  } finally {
    bad.close()
    good.close()
  }
})
