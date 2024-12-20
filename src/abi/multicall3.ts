import { ethers } from "ethers";
import { Chain } from "../general";
import convertResults from "./convertResults";
import makeMultiCallV2 from './multicall'
import * as Tron from './tron'
import { call } from './index'
// https://github.com/mds1/multicall
// https://www.multicall3.com/deployments
const MULTICALL_V3_ADDRESS = '0xca11bde05977b3631167028862be2a173976ca11'

const DEPLOYMENT_BLOCK = {
  ethereum: 14353601,
  ethf: 14353601,
  arbitrum: 7654707,
  arbitrum_nova: 1746963,
  optimism: 4286263,
  polygon: 25770160,
  polygon_zkevm: 57746,
  fantom: 33001987,
  bsc: 15921452,
  moonriver: 609002,
  moonbeam: 609002,
  avax: 11907934,
  harmony: 24185753,
  cronos: 1963112,
  klaytn: 96002415,
  godwoken_v1: 15034,
  celo: 13112599,
  oasis: 1481392,
  rsk: 4249540,
  metis: 2338552,
  heco: 14413501,
  okexchain: 10364792,
  astar: 761794,
  aurora: 62907816,
  boba: 446859,
  songbird: 13382504,
  fuse: 16146628,
  flare: 3002461,
  milkomeda: 4377424,
  velas: 55883577,
  // telos: 246530709,
  step: 5734583,
  canto: 2905789,
  iotex: 22163670,
  bitgert: 2118034,
  kava: 3661165,
  dfk: 14790551,
  pulse: 14353601,
  onus: 805931,
  rollux: 119222,
  xdai: 21022491,
  evmos: 188483,
  thundercore: 100671921,
  kcc: 11760430,
  linea: 42,
  zora: 5882,
  eos_evm: 7943933,
  // dogechain: 14151696, // for some reason this is not working
  tron: 51067989,
  era: 3908235,
  mantle: 304717,
  base: 5022,
  darwinia: 251739,
  op_bnb: 412254,
  shimmer_evm: 1290,
  manta: 332890,
  neon_evm: 206545524,
  beam: 3,
  pgn: 3380209,
  meter: 41238476,
  meer: 744781,
  lukso: 468183,
  nos: 1578065,
  scroll: 14,
  q: 8357148,
  edg: 18117872,
  chz: 8007643,
  azktn: 31317,
  lightlink_phoenix: 51289975,
  eon: 646592,
  jfin: 13857465,
  ethereumclassic: 18288646,
  core: 6988931,
  callisto: 13811517,
  bittorrent: 31078552,
  zeta: 1632781,
  area: 353286,
  zkfair: 6090959,
  mode: 2465882,
  xai: 222549,
  dos: 161908,
  // xdc: 71542788, // not working for some reason
  fraxtal: 100,
  lyra: 1935198,
  blast: 88189,
  omax: 4750251,
  astrzk: 183817,
  shibarium: 3485946,
  imx: 3680945,
  sapphire: 734531,
  jbc: 2919675,
  rss3_vsl: 14193,
  islm: 10515193,
  're-al': 695,
  real: 695,
  svm: 400460,
  degen: 414273,
  karak: 4475345,
  iotaevm: 25022,
  planq: 8470015,
  bob: 946071,
  bitr: 1045566,
  btr: 3225645,
  dreyerx: 163720,
  cyeth: 1,
  taiko: 11269  ,
  sei: 79351444,
  aura: 6731307,
  conflux: 97705330,
  etlk: 1,
  alg: 2344547,
  lisk: 4664276,
  gravity: 52682,
  flow: 968659,
  rupx: 35231,
  fluence: 207583,
  ontology: 17984796,
  wc: 4353799,
  unit0: 9727,
  spn: 39,
  starchain: 23898035,
  apechain: 20889,
  zircuit: 5815253,
  qom: 10050,
  matchain: 2598669,
  shape: 3443414,
  morph: 169985,
  sonic: 1,
  ace: 1,
  ink: 1,
  sophon: 1,
  vana: 818176,
  swellchain: 878173,
} as {
  [key: string | Chain]: number
}

export default async function makeMultiCall(
  functionABI: any,
  calls: {
    contract: string;
    params: any[];
  }[],
  chain: Chain,
  block?: string | number,
): Promise<any> {
  if (chain === 'tron') return Tron.multiCall(functionABI, calls)
  if (!functionABI) throw new Error('Missing ABI parameter')
  if (calls.some(i => !i.contract)) throw new Error('Missing target, abi:' + functionABI)
  if (!isMulticallV3Supported(chain, block))
    return makeMultiCallV2(functionABI, calls, chain, block)
  const contractInterface = new ethers.Interface([functionABI])
  let fd = contractInterface.fragments[0] as ethers.FunctionFragment

  const contractCalls = calls.map((call) => {
    const data = contractInterface.encodeFunctionData(fd, call.params);
    return {
      to: call.contract,
      data,
    };
  });

  let returnValues: any
  try {
    await _call()
  } catch (e) {
    // debugLog(chain, 'Multicall failed, retrying call...')
    await _call()
  }

  return returnValues.map(([success, values]: any, index: number) => {
    let output = null
    let error = null
    try {
      output = convertResults(contractInterface.decodeFunctionResult(fd, values), fd);
    } catch (e) {
      error = e
      success = false
    }
    const res: any = {
      input: {
        params: calls[index].params,
        target: calls[index].contract,
      },
      success, output,
    }
    if (error) res.error = error
    return res;
  });

  async function _call() {
    const multicallAddress = getMulticallAddress(chain, block) as string
    const { output: returnData } = await call({ chain, block, target: multicallAddress, abi: 'function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)', params: [false, contractCalls.map((call) => [call.to, call.data])] })
    returnValues = returnData;
  }
}

export function isMulticallV3Supported(chain: Chain, block?: string | number) {
  const startBlock = DEPLOYMENT_BLOCK[chain]
  if (!startBlock) return false
  if (!block) return true
  if (typeof block === 'string') return block === 'latest'
  return block > startBlock
}

export function getMulticallAddress(chain: Chain, block?: string | number) {
  if (!isMulticallV3Supported(chain, block)) return null
  let multicallAddress = MULTICALL_V3_ADDRESS
  switch (chain) {
    case 'onus': multicallAddress = '0x748c384f759cc596f0d9fa96dcabe8a11e443b30'; break;
    case 'era': multicallAddress = '0xF9cda624FBC7e059355ce98a31693d299FACd963'; break;
    case 'tron': multicallAddress = 'TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED'; break;
    case 'op_bnb': multicallAddress = '0x5eF9501fE659b97C45f3A7efD298c14405b454D1'; break;
    case 'beam': multicallAddress = '0x4956f15efdc3dc16645e90cc356eafa65ffc65ec'; break;
    case 'nos': multicallAddress = '0x337F5fBB75007e59cC4A6132017Bd96748b09F7F'; break;
    case 'chz': multicallAddress = '0x0E6a1Df694c4be9BFFC4D76f2B936bB1A1df7fAC'; break;
    case 'lightlink_phoenix': multicallAddress = '0xb9a543d7B7dF05C8845AeA6627dE4a6622Ac863C'; break;
    case 'eon': multicallAddress = '0x4ea6779581bDAcd376724A52070bE89FfB74eC39'; break;
    case 'svm': multicallAddress = '0x40a3a97ac5d9acadF9F96cB8283a912dDFd05dc8'; break;
    case 'degen': multicallAddress = '0xFBF562a98aB8584178efDcFd09755FF9A1e7E3a2'; break;
    case 'karak': multicallAddress = '0x73331e33f1552E706D56aa453ce19BCE314B4F59'; break;
    case 'taiko': multicallAddress = '0xcb2436774C3e191c85056d248EF4260ce5f27A9D'; break;
    case 'qom' : multicallAddress = '0x7A52370716ea730585884F5BDB0f6E60C39b8C64'; break;
    case 'matchain' : multicallAddress = '0xDa91510Bd8c50bfa54FC2BE2dD6dAbE03eA8496c'; break;
    case 'morph' : multicallAddress = '0x33A213b1049D5AD2eeE6e61dAe040955e60383D4'; break;
    case 'ace' : multicallAddress = '0x025A2B4fCE1E0bD736D5cebe6C8a52229795376B'; break;
    case 'sophon' : multicallAddress = '0x5f4867441d2416cA88B1b3fd38f21811680CD2C8'; break;
    case 'vana' : multicallAddress = '0xFe92b91F3326e58557478c28EeAe1936E0c7148a'; break;
  }
  return multicallAddress
}
