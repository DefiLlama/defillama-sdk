/**
 * Non-EVM chain clients. One module per chain family, all resolving endpoints
 * through `rpc.getEndpoints` so `<CHAIN>_RPC` env vars override built-in defaults.
 *
 * Usage: `sdk.chains.svm.getAccounts({ chain: 'solana', accounts })`
 */
export * as rpc from "./rpc";
export * as svm from "./svm";
export * as cosmos from "./cosmos";
export * as starknet from "./starknet";
export * as aptos from "./aptos";
export * as sui from "./sui";
export * as near from "./near";
export * as ton from "./ton";
export * as algorand from "./algorand";
export * as stellar from "./stellar";
export * as xrpl from "./xrpl";
export * as cardano from "./cardano";
export * as tezos from "./tezos";
export * as icp from "./icp";
export * as substrate from "./substrate";
export * as utxo from "./utxo";
export * as tron from "./tron";
