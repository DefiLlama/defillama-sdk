# sdk

```
npm i
npm run build
npm t
npm run format
```

### Publish
```
bash patchAndPublish.sh
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

## Chain RPC PR

Before putting up a PR for new chain, check if we already support it here: https://unpkg.com/@defillama/sdk@latest/build/providers.json 

Everytime we publish a new sdk version, we automically pull latest list from chainlist.org and include it.