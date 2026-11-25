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
| `CALL_STATS_MIN_CALLS` | `sdk.callStats`: runs with fewer http requests in total are not written to elasticsearch (default 1, ie. everything). |
| `RPC_CALL_CACHE_REDIS` | Redis connection url (`redis[s]://[[user][:password]@]host[:port][/db]`). Setting it enables the shared rpc call cache, without it nothing is cached. |
| `RPC_CALL_CACHE_EMPTY` | `true` to also cache empty string / null address results, for 12 hours. Off by default. |
| `RPC_CALL_CACHE_ERROR` | `true` to also cache contract level failures (revert, result that cannot be decoded), for 24 hours once seen twice. Off by default. |
| `RPC_CALL_CACHE_ADDRESS` | `true` to also cache, for 12 hours, any getter without arguments that returns an address and is not a known fixed one (`owner`, `strategy`, ...). Off by default. |

### RPC call cache

With `RPC_CALL_CACHE_REDIS` set, `call`/`multiCall` results that rarely or never change are stored in redis and shared by
every job that points at the same server. Each call is its own key with its own expiry:

| Cached for | Calls | Used at |
| --- | --- | --- |
| 30 days | `symbol()`, `name()`, `decimals()` and any other getter without arguments that returns a `string`; token/contract getters fixed at deployment (`token0`, `token1`, `asset`, `underlying`, `want`, `stakingToken`, `factory`, ... see `structuralGetters` in `src/util/rpcCallCache.ts`); `getPoolId()`/`ilk()`; append only lists read by index (`allPairs(i)`, `allPools(i)`, `coins(i)`, `underlying_coins(i)`); factory lookups (`getPair(a, b)`, `getPool(a, b, fee)`) | any block |
| 12 hours | any other getter without arguments that returns an `address` | recent calls, only with `RPC_CALL_CACHE_ADDRESS=true` |
| 12 hours | a cacheable call that returned an empty string or the null address | recent calls, only with `RPC_CALL_CACHE_EMPTY=true` |
| 24 hours | a cacheable call that failed at the contract level (revert, result that cannot be decoded) on two runs at least 10 minutes apart. The first failure only leaves a flag and the call is still sent to the rpc | recent calls, only with `RPC_CALL_CACHE_ERROR=true` |

A call is recent when it has no `block`, or when it carries the `timestamp` of its block and that is within the last
two hours (`ChainApi` passes its own timestamp). A cached failure is returned as `{ success: false, output: null }` to a
`multiCall` with `permitFailure`, and throws otherwise, without an rpc call. An rpc failure is never cached.
`skipCache: true` on a call bypasses the cache. If redis is unreachable the calls go to the rpc as usual.
`sdk.rpcCallCache.rpcCallCacheStats` has the hit/miss/write/error counters of the process.

### permitFailure

`permitFailure` covers calls the contract rejects: a revert or a result that cannot be decoded comes back as a null
output. It does not cover the rpc. If the rpc cannot execute a call or a multicall batch, `call`/`multiCall` throw with
or without `permitFailure` (a multicall3 batch is first halved and retried, in case it was only too heavy for the node).

### Call stats

`sdk.callStats.run(meta, fn)` counts every http request made while `fn` runs (any client: axios, ethers, fetch...),
attributed to the chain whose rpc served it, plus the rpc method breakdown (`getLogs`, `call`, ...), and writes it to
elasticsearch when `ELASTICSEARCH_CONFIG` is set. Chain attribution relies on the SDK resolving the rpc urls; endpoints
managed outside the SDK can be announced with `sdk.callStats.registerEndpoints(chain, urls)`.

Two indexes, both monthly (`-<year>-<month0>` suffix) and both with an ISO `@timestamp`:

- `adapter-calls-*`: one flat doc per run and chain. `application`, `name`, `runType` (and any other scalar `meta` field),
  `chain` (`_other` for requests matching no known rpc, the llama indexer included), `calls` (rpc http requests),
  `getLogs` (rpc getLogs attempts), `indexerCalls` (http requests to the llama indexer for that chain), `logs` /
  `logsRpc` / `logsIndexer` (log rows fetched over the wire, cache hits excluded), `methods.<rpc method>`, plus the run
  totals `runCalls`, `runGetLogs`, `runIndexerCalls`, `runLogs`, `runChains`, `success`, `runtime` and a `runId`
  shared by the run's docs. Sum `calls` by `chain` or `name` directly; group by `runId` for run-level views.
  A run written before it settled (`sdk.callStats.flushActive(reason)`, called by a host that is about to kill or
  give up on it) has `success: false` and `interrupted: <reason>`, with the counters up to that point.
- `adapter-call-hosts-*`: one doc per run and host (25 busiest), same run fields plus `host`, `calls` and `rpc`
  (true for a registered rpc endpoint).

## Chain RPC PR

Before putting up a PR for new chain, check if we already support it here: https://unpkg.com/@defillama/sdk@latest/build/providers.json 

Everytime we publish a new sdk version, we automically pull latest list from chainlist.org and include it.