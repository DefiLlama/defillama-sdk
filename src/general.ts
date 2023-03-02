import { ethers, BigNumber } from "ethers"
import providerList from './providers.json'


function createProvider(name: string, defaultRpc: string, chainId: number) {
  if (process.env.HISTORICAL) {
    if (chainId === 1) {
      console.log("RPC providers set to historical, only the first RPC provider will be used")
    }
    return new ethers.providers.StaticJsonRpcProvider(
      (process.env[name.toUpperCase() + "_RPC"] ?? defaultRpc)?.split(',')[0],
      {
        name,
        chainId,
      }
    )
  } else {
    return new ethers.providers.FallbackProvider(
      (process.env[name.toUpperCase() + "_RPC"] ?? defaultRpc).split(',').map((url, i) => ({
        provider: new ethers.providers.StaticJsonRpcProvider(
          url,
          {
            name,
            chainId,
          }
        ),
        priority: i
      })),
      1
    )
  }
}

export const providers = {} as {
  [chain: string]: ethers.providers.BaseProvider;
};

Object.entries(providerList).forEach(([name, value]) => {
  const { rpc, chainId } = value as any
  providers[name] = createProvider(name, rpc.join(','), chainId)
})

export type Chain = string
export function getProvider(chain: Chain = "ethereum"): ethers.providers.BaseProvider {
  return providers[chain];
}

export const TEN = BigNumber.from(10);

export function handleDecimals(num: BigNumber, decimals?: number): string {
  if (decimals === undefined) {
    return num.toString();
  } else {
    return num.div(TEN.pow(decimals)).toString();
  }
}

export const ETHER_ADDRESS = "0x0000000000000000000000000000000000000000";

export function setProvider(
  chain: Chain,
  provider: ethers.providers.BaseProvider
) {
  providers[chain] = provider;
}
