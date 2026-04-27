# sdk

```
bun i
bun run build
bun test
bun run format
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

## Chain RPC PR

Before putting up a PR for new chain, check if we already support it here: https://unpkg.com/@defillama/sdk@latest/build/providers.json 

Everytime we publish a new sdk version, we automically pull latest list from chainlist.org and include it.