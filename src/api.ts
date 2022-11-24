export * as util from "./util";
export * as eth from "./eth";
export * as erc20 from "./erc20";
export * as abi from "./abi";
import { setProvider, getProvider, } from "./general";
const config = {
  setProvider, getProvider,
};
export { config };
