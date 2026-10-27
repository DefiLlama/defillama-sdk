# sdk

```
npm i
npm run build
npm t
npm run format
```

### Publish
```
npm run pack-and-publish
```

### Keys

```
POLYGON_RPC="https://..."
ETHEREUM_RPC="https://..."
BSC_RPC="https://..."
```

### Environment variables

Most settings can be overridden per chain via environment variables. The chain
name is uppercased and used as a prefix, e.g. `ETHEREUM_RPC`, `BSC_RPC_MULTICALL_V3`.
Every key is also resolved with an `SDK_` or `LLAMA_SDK_` prefix (checked in the
order `LLAMA_SDK_<KEY>` → `SDK_<KEY>` → `<KEY>`), so `SDK_ETHEREUM_RPC` works too.

| Variable | Description |
| --- | --- |
| `<CHAIN>_RPC` | RPC URL(s) for the chain (comma-separated for multiple). |
| `<CHAIN>_RPC_MULTICALL_V3` | Address of a Multicall3 contract for the chain. Setting it enables the Multicall3 code path for that chain (even if the chain is not in the built-in registry) and uses this address. Takes precedence over the built-in registry and the deployment-block gating. |
| `<CHAIN>_RPC_MULTICALL` | Address of a legacy (v2) multicall contract, used only when Multicall3 is not available for the chain. |
| `<CHAIN>_MULTICALL_CHUNK_SIZE` | Max number of calls per multicall batch for the chain. |
| `CALL_STATS_MIN_CALLS` | `sdk.callStats`: chain/host buckets with fewer http requests are dropped and runs below it are not written to elasticsearch (default 50). |
| `CALL_STATS_MIN_GET_LOGS` | `sdk.callStats`: a chain (or run) with at least this many getLogs requests is kept even when below `CALL_STATS_MIN_CALLS` (default 10). |

### Call stats

`sdk.callStats.run(meta, fn)` counts every http request made while `fn` runs (any client: axios, ethers, fetch...),
attributed to the chain whose rpc served it, plus the rpc method breakdown (`getLogs`, `call`, ...), and writes the
summary to the `adapter-call-stats` elasticsearch index when `ELASTICSEARCH_CONFIG` is set. Chain attribution relies
on the SDK resolving the rpc urls; endpoints managed outside the SDK can be announced with
`sdk.callStats.registerEndpoints(chain, urls)`.

## Chain RPC PR

Before putting up a PR for new chain, check if we already support it here: https://unpkg.com/@defillama/sdk@latest/build/providers.json 

Everytime we publish a new sdk version, we automically pull latest list from chainlist.org and include it.