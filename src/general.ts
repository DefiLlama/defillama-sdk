export { providers, setProvider, getProvider, } from './util/LlamaProvider'
export { Chain } from './types'

export const TEN = BigInt(10);

export function handleDecimals(num: any, decimals?: number): string {
  if (typeof num !== 'number') num = num.toString()
  if (decimals === undefined) {
    return num.toString();
  } else {
    return Number(num / (10 ** decimals)).toString();
  }
}
export const ETHER_ADDRESS = "0x0000000000000000000000000000000000000000";
