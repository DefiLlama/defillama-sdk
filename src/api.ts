export * as util from "./util";
export * as eth from "./eth";
export * as erc20 from "./erc20";
export * as cdp from "./cdp";
export * as abi from "./abi";
export * as rpc from "./rpc";
import { setProvider } from "./general";
const config = {
  setProvider,
};
export { config };
