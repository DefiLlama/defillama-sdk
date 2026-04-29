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

### Per-chain RPC environment variables

For each EVM chain `<CHAIN>` (lowercase chain key as listed in
`providers.json`), the following env vars are recognised. Names are case-
insensitive and may also be prefixed with `LLAMA_SDK_` or `SDK_`.

| Variable | Purpose | Default |
|----------|---------|---------|
| `<CHAIN>_RPC` | Comma-separated list of RPC URLs for the chain. **Replaces** the bundled defaults from `providers.json`. | (defaults from `providers.json`) |
| `<CHAIN>_RPC_APPEND` | If `true`, `<CHAIN>_RPC` is appended to the bundled defaults instead of replacing them (legacy behaviour). | `false` |
| `<CHAIN>_WHITELISTED_RPC` | Comma-separated list. When set, only these RPCs are used (ignores `<CHAIN>_RPC` and defaults). | unset |
| `<CHAIN>_ARCHIVAL_RPC` | Comma-separated list of archival RPCs used for `getLogs` and historical calls. | unset |
| `<CHAIN>_RPC_CHAIN_ID` | Override the chain id reported by the SDK (rarely needed). | from `providers.json` |
| `<CHAIN>_RPC_MULTICALL` | Override the multicall contract address. | bundled per-chain default |
| `<CHAIN>_RPC_MAX_PARALLEL` | Max concurrent RPC requests for the chain. | `MAX_PARALLEL` (`100`) |
| `<CHAIN>_RPC_GET_LOGS_CONCURRENCY_LIMIT` | Max concurrent `getLogs` calls. | `GET_LOGS_CONCURRENCY_LIMIT` (`25`) |
| `<CHAIN>_RPC_GET_BLOCKS_CONCURRENCY_LIMIT` | Max concurrent `getBlock` calls. | `GET_BLOCKS_CONCURRENCY_LIMIT` (`5`) |
| `<CHAIN>_BATCH_MAX_COUNT` | Max JSON-RPC batch size. | `BATCH_MAX_COUNT` (`5`) |
| `<CHAIN>_MULTICALL_CHUNK_SIZE` | Calls per multicall chunk. | `MULTICALL_CHUNK_SIZE` (`300`) |

Global RPC tuning:

| Variable | Purpose | Default |
|----------|---------|---------|
| `LLAMA_SDK_RPC_QUARANTINE_THRESHOLD` | Consecutive failures before an RPC URL is quarantined. | `5` |
| `LLAMA_SDK_RPC_QUARANTINE_MS` | How long (ms) a quarantined RPC is skipped. | `600000` (10 min) |
| `SKIP_BLOCK_VALIDATION_CHAINS` | Comma-separated chain keys for which to skip the startup block-height validation. | unset |
| `RPC_NO_PLAYING_AROUND` | If `true`, always try the primary RPC first (no shuffling). | `false` |

## Chain RPC PR

Before putting up a PR for new chain, check if we already support it here: https://unpkg.com/@defillama/sdk@latest/build/providers.json 

Everytime we publish a new sdk version, we automically pull latest list from chainlist.org and include it.