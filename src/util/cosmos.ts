
import axios from "axios";
import { getEnvRPC } from "./env";

// where to find chain info
// https://proxy.atomscan.com/chains.json
// https://cosmos-chain.directory/chains/cosmoshub
// https://cosmos-chain.directory/chains
const endPoints: {
  [chain: string]: string;
} = {
  crescent: "https://mainnet.crescent.network:1317",
  osmosis: "https://osmosis-api.polkachu.com",
  cosmos: "https://cosmoshub-lcd.stakely.io",
  kujira: "https://kuji-api.kleomedes.network",
  comdex: "https://rest.comdex.one",
  terra: "https://terra-classic-lcd.publicnode.com",
  terra2: "https://terra-lcd.publicnode.com",
  umee: "https://umee-api.polkachu.com",
  orai: "https://lcd.orai.io",
  juno: "https://juno.api.m.stavr.tech",
  // cronos: "https://rest.mainnet.crypto.org", // it is also evm like kava
  chihuahua: "https://rest.cosmos.directory/chihuahua",
  stargaze: "https://rest.stargaze-apis.com",
  quicksilver: "https://rest.cosmos.directory/quicksilver",
  persistence: "https://rest.cosmos.directory/persistence",
  secret: "https://lcd.secret.express",
  // chihuahua: "https://api.chihuahua.wtf",
  injective: "https://sentry.lcd.injective.network:443",
  migaloo: "https://migaloo-api.polkachu.com",
  fxcore: "https://fx-rest.functionx.io",
  xpla: "https://dimension-lcd.xpla.dev",
  neutron: "https://rest-kralum.neutron-1.neutron.org",
  quasar: "https://quasar-api.polkachu.com",
  gravitybridge: "https://gravitychain.io:1317",
  sei: "https://sei-api.polkachu.com",
  aura: "https://lcd.aura.network",
  archway: "https://api.mainnet.archway.io",
  sifchain: "https://sifchain-api.polkachu.com",
  nolus: "https://pirin-cl.nolus.network:1317",
  bostrom: "https://lcd.bostrom.cybernode.ai"
};

const ibcChains = ['terra', 'terra2', 'crescent', 'osmosis', 'kujira', 'stargaze', 'juno', 'injective', 'cosmos', 'comdex', 'umee', 'orai', 'persistence', 'fxcore', 'neutron', 'quasar', 'chihuahua', 'sei', 'archway', 'migaloo', 'secret', 'aura', 'xpla', 'bostrom']

export const isCosmosChain = (chain: string) => ibcChains.includes(chain) || !!endPoints[chain]

export async function getCosmosBlock(block: number | string = 'latest', chain = 'cosmos') {
  const endPoint = getEnvRPC(chain) || endPoints[chain] || 'https://rest.cosmos.directory/' + chain
  try {
    const { data } = await axios(`${endPoint}/blocks/${block}`)
    const { block: { header: { height, time } } } = await data
    return {
      number: Number(height),
      timestamp: Math.floor(Date.parse(time) / 1000),
    }
  } catch (e) {
    const message = `Error fetchin cosmos block -
       chain: ${chain}, block: ${block}, endPoint: ${endPoint}, error: ${(e as any)?.message ?? JSON.stringify(e)}`
    throw new Error(message)
  }
}

export function getCosmosProvider(chain: string) {
  return {
    getBlock: (block: number | string = 'latest') => getCosmosBlock(block, chain)
  }
}