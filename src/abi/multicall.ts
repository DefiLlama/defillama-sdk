import { ethers } from "ethers";
import { getProvider, Chain } from "../general";
import convertResults from "./convertResults";
import { call } from "./rpcCall";
import { debugLog } from "../util/debugLog"
import { runInPromisePool, sliceIntoChunks, } from "../util"
import { getEnvMulticallAddress } from "../util/env";

export const MULTICALL_ADDRESS_MAINNET =
  "0xeefba1e63905ef1d7acba5a8513c70307c1ce441";
export const MULTICALL_ADDRESS_KOVAN =
  "0x2cc8688c5f75e365aaeeb4ea8d6a480405a48d2a";
export const MULTICALL_ADDRESS_RINKEBY =
  "0x42ad527de7d4e9d9d011ac45b31d8551f8fe9821";
export const MULTICALL_ADDRESS_GOERLI =
  "0x77dca2c955b15e9de4dbbcf1246b4b85b651e50e";
export const MULTICALL_ADDRESS_POLYGON =
  "0x95028E5B8a734bb7E2071F96De89BABe75be9C8E";
export const MULTICALL_ADDRESS_BSC =
  "0x1Ee38d535d541c55C9dae27B12edf090C608E6Fb";
export const MULTICALL_ADDRESS_FANTOM =
  "0xb828C456600857abd4ed6C32FAcc607bD0464F4F";
export const MULTICALL_ADDRESS_XDAI =
  "0xb5b692a88BDFc81ca69dcB1d924f59f0413A602a";
export const MULTICALL_ADDRESS_HECO =
  "0xc9a9F768ebD123A00B52e7A0E590df2e9E998707";
export const MULTICALL_ADDRESS_HARMONY =
  "0xFE4980f62D708c2A84D3929859Ea226340759320";
export const MULTICALL_ADDRESS_ARBITRUM =
  "0x842eC2c7D803033Edf55E478F461FC547Bc54EB2";
export const MULTICALL_ADDRESS_AVAX =
  "0xdf2122931FEb939FB8Cf4e67Ea752D1125e18858";
export const MULTICALL_ADDRESS_MOONRIVER =
  "0xe05349d6fE12602F6084550995B247a5C80C0E2C";
export const MULTICALL_ADDRESS_AURORA =
  "0xe0e3887b158F7F9c80c835a61ED809389BC08d1b";
export const MULTICALL_ADDRESS_OPTIMISM =
  "0xD0E99f15B24F265074747B2A1444eB02b9E30422";

export const AGGREGATE_SELECTOR = "0x252dba42";

export default async function makeMultiCall(
  functionABI: any,
  calls: {
    contract: string;
    params: any[];
  }[],
  chain: Chain,
  block?: string | number,
) {
  const contractInterface = new ethers.Interface([functionABI]);
  let fd = contractInterface.fragments[0] as ethers.FunctionFragment

  const contractCalls = calls.map((call) => {
    const data = contractInterface.encodeFunctionData(fd, call.params);
    return {
      to: call.contract,
      data,
    };
  });

  const returnValues = await executeCalls(contractCalls, chain, block);

  return returnValues.map((values: any, index: number) => {
    let output: any;
    let error = undefined
    try {
      output = convertResults(contractInterface.decodeFunctionResult(fd, values), { functionABI: fd, chain });
    } catch (e) {
      output = null;
      error = e
    }
    const res: any = {
      input: {
        params: calls[index].params,
        target: calls[index].contract,
      },
      success: output !== null,
      output,
    }
    if (error) res.error = error
    return res;
  });
}

async function executeCalls(
  contractCalls: {
    to: string;
    data: string;
  }[],
  chain: Chain,
  block?: string | number
) {
  if (await networkSupportsMulticall(chain)) {
    try {
      const multicallData = ethers.AbiCoder.defaultAbiCoder().encode(
        [
          ethers.ParamType.from({
            components: [
              { name: "target", type: "address" },
              { name: "callData", type: "bytes" },
            ],
            name: "data",
            type: "tuple[]",
          }),
        ],
        [contractCalls.map((call) => [call.to, call.data])]
      );
      const address = await multicallAddressOrThrow(chain);

      const callData = AGGREGATE_SELECTOR + multicallData.substr(2);

      const tx = {
        to: address,
        data: callData,
      };

      const returnData = await call(getProvider(chain), tx, block, chain)

      const [blockNumber, returnValues] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint256", "bytes[]"],
        returnData
      );
      return returnValues;
    } catch (e) {
      if (contractCalls.length > 10) {
        const chunkSize = Math.ceil(contractCalls.length / 5)
        const chunks = sliceIntoChunks(contractCalls, chunkSize)
        debugLog(`Multicall failed, call size: ${contractCalls.length}, splitting into smaller chunks and trying again, new call size: ${chunks[0].length}`)
        const response = await runInPromisePool({
          items: chunks,
          concurrency: 2,
          processor: (calls: any) => executeCalls(calls, chain, block)
        })
        return response.flat()
      }
      debugLog("Multicall failed, defaulting to single transactions...")
    }
  }

  return runInPromisePool({
    items: contractCalls,
    concurrency: await networkSupportsMulticall(chain) ? 2 : 10,
    processor: async ({ to, data }: any) => {
      let result = null
      try {
        result = await call(getProvider(chain), { to, data }, block, chain,);
      } catch (e) {
        debugLog(e)
      }
      return result
    }
  })
}

export async function multicallAddressOrThrow(chain: Chain) {
  const multicallEnv = getEnvMulticallAddress(chain)
  if (multicallEnv) return multicallEnv
  const network = await getProvider(chain).getNetwork();
  const address = multicallAddress(network?.chainId);
  if (address === null) {
    const msg = `multicall is not available on the network ${network.chainId}`;
    console.error(msg);
    throw new Error(msg);
  }
  return address;
}

const networkMulticallCache = {} as { [chain: string]: boolean };

export async function networkSupportsMulticall(chain: Chain) {
  const multicallEnv = getEnvMulticallAddress(chain)
  if (multicallEnv) networkMulticallCache[chain] = true
  if (!networkMulticallCache.hasOwnProperty(chain)) {
    const network = await getProvider(chain)?.getNetwork();
    const address = multicallAddress(network?.chainId);
    networkMulticallCache[chain] = address !== null;
  }
  return networkMulticallCache[chain];
}

function multicallAddress(chainId: number | BigInt) {
  if (typeof chainId === "bigint") chainId = Number(chainId);
  switch (chainId) {
    case 1:
    case 10001:
      return MULTICALL_ADDRESS_MAINNET;
    case 42:
      return MULTICALL_ADDRESS_KOVAN;
    case 4:
      return MULTICALL_ADDRESS_RINKEBY;
    case 5:
      return MULTICALL_ADDRESS_GOERLI;
    case 137:
      return MULTICALL_ADDRESS_POLYGON;
    case 56:
      return MULTICALL_ADDRESS_BSC;
    case 250:
      return MULTICALL_ADDRESS_FANTOM;
    case 100:
      return MULTICALL_ADDRESS_XDAI;
    case 128:
      return MULTICALL_ADDRESS_HECO;
    case 1666600000:
      return MULTICALL_ADDRESS_HARMONY;
    case 42161:
      return MULTICALL_ADDRESS_ARBITRUM;
    case 43114:
      return MULTICALL_ADDRESS_AVAX;
    case 1285:
      return MULTICALL_ADDRESS_MOONRIVER;
    case 1313161554:
      return MULTICALL_ADDRESS_AURORA;
    case 10:
      return MULTICALL_ADDRESS_OPTIMISM;
    case 25:
      return "0x5e954f5972EC6BFc7dECd75779F10d848230345F"; // cronos
    case 288:
      return "0x80Ae459D058436ecB4e043ac48cfd209B578CBF0"; // boba
    case 43288:
      return "0x92C5b5B66988E6B8931a8CD3faa418b42003DF2F"; // boba
    case 56288:
      return "0x31cCe73DA4365342bd081F6a748AAdb7c7a49b7E"; // boba
    case 4689:
      return "0x5a6787fc349665c5b0c4b93126a0b62f14935731"; // iotex
    case 82:
      return "0x59177c9e5d0488e21355816094a047bdf8f14ebe"; // meter
    case 11297108109:
      return "0xfFE2FF36c5b8D948f788a34f867784828aa7415D"; // palm
    case 416:
      return "0x834a005DDCF990Ba1a79f259e840e58F2D14F49a"; // sx
    case 20201022:
      return "0xA363151e5CC8c0dBcC3eD2287A08f261bE08A33C"; // pg
    case 255:
      return "0xE3c886498ac54433F2B0E6842FAE421006067751"; // kroma
    case 246: // energy web chain
    case 336: // shiden
    case 592: // astar
    case 269: // High performance blockchain
    case 321: // KCC
    case 20: // elastos
    case 8217: // Klaytn - multicall doesnt work for some reason
    // case 88: // tomochain - multicall doesnt work for some reason
    case 122: // Fuse
    case 42220: // Celo
    case 42262: // ROSE
    case 39797: // energi
    case 1284: // moonbeam
    case 30: // rsk
    case 1088: // metis
    case 10000: // smartbch
    case 2001: // Milkomeda C1
    case 9001: // evmos
    case 106: // velas
    case 888: // wanchain
    case 24: // kardia
    case 108: // thundercore
    case 361: // Theta
    case 57: // Syscoin
    case 61: // etc
    case 70: // hoo
    case 60: // go
    case 66: // okxchain
    case 19: // songbird
    case 1030: // conflux
    case 333999: // polis
    case 7700: // canto
    case 62621: // multivac
    case 900000: // posi
    case 1231: // ultron
    case 2152: // findora
    case 50: // xdc
    case 52: // csc
    case 311: // omax
    case 1111: // omax
    case 32659: // fusion
    case 3797: // alvey
      return "0x18fA376d92511Dd04090566AB6144847c03557d8";
    case 75: // decimalchain
      return "0x949d1A0757803C51F2EfFFEb5472C861A898B8E8";
    case 40: // telos
      return "0x74D01B798F0aEdc39548D3EA5fC922B291293b95";
    case 2222:
      return "0x30A62aA52Fa099C4B227869EB6aeaDEda054d121" // kava
    case 47805:
      return "0x9eE9904815B80C39C1a27294E69a8626EAa7952d" // rei network
    case 87:
      return "0x7A5a7579eb8DdEd352848cFDD0a5530C4e56FF7f" // nova
    case 32520:
      return "0x5AE90c229d7A8AFc12bFa263AC672548aEb1D765" // bitgert/brise
    case 820: // callisto
    case 199: // bittorrent
      return "0xB2fB6dA40DF36CcFFDc3B0F99df4871C7b86FCe7"
    case 2000:  // dogechain
      return "0x8856C24Ba82F737CFb99Ec4785CEe4d48A842F33"
    // case 71394: // Godwoken v0 chain
    // return "0x285aF41aC18BA105407555f49c59c58574b8e284"
    case 71402: // Godwoken v1 chain
    // case 8217: // Klaytn - multicall doesnt work for some reason
    //   // https://github.com/mds1/multicall
    //   return "0xcA11bde05977b3631167028862bE2a173976CA11"
    case 96: // bitkub chain
      return "0xcc515Aa7eE9Be4491c98DE68ee2147F0A063759D"
    case 42170: // arbitrum nova chain
      return "0x2fe78f55c39dc437c4c025f8a1ffc54edb4a34c3"
    case 55555: // reichain
      return "0x5CCBA81867AE1F9d470a9514fb9B175E84D47979";
    case 530: // functionx
      return "0xC43a7181654639556e4caca1bf9219C14a106401";
    case 1818: // cube
      return "0x28d2ebdb36369db1c51355cdc0898754d1a1c3c5";
    case 1234:
      return "0x176CcFFbAB792Aaa0da7C430FE20a7106d969f66"
    case 53935: // dfk
      return "0x5b24224dC16508DAD755756639E420817DD4c99E"
    case 3000: // echelon
      return "0xe6d0cEE385992029Cb64C94A2dF6d0331937B2C8"
    case 55: // zyx
      return "0xd0dd5446f58D6f4F4A669f289E4268c1b12AEc31"
    case 420420: // kekchain
      return "0x781bB181833986C78238228F9AF0891829AF922B"
    case 2002: // milkomeda_a1
      return "0x61EEE5a6c13c358101487f3b7c7Dd9863590C350"
    case 20402: // muuchain
      return "0xF8D7509aD8570b16dAd163A3841684f660fD9242"
    case 14: // flare network
      return "0x336897CAe2791048DA77EEa2A43BFB96342b9CE1"
    case 383414847825: // zeniq
      return "0x23c65A0E1aF27EFd46B60c43998682e1e322C6f6"
    case 4099: // bitindi
      return "0xDF15De1fB392Ab10551afF1dDDDfAFFd228D7FE0"
    case 22776: // map
      return "0x6f13ad2bae66B5560c6157883a42B70085F9ca20"
    case 888888: // vision
      return "0x7a677A43eb6eEe4AB6c13872Abc04e1bA5CF88eD";
    case 1116: // core
      return "0xE5552e0318531F9Ec585c83bDc8956C08Bf74b71";
    case 2046399126: // europa
      return "0x918D8F3670c67f14Ff3fEB025D46B9C165d12a23";
    case 2025: // rpg
      return "0x692D7f4B08E4490d546Cb9242F082064acd8c6cd";
    case 324: // zksync era
      return "0xb1F9b5FCD56122CdfD7086e017ec63E50dC075e7";
    case 9117: // bone
      return "0x538b8b1e982604f4949b13B495ED1684278D7845";
    case 15551: // loop
      return "0x474a0768AeE3D378356524F331235b3e5fD21416";
    case 1101: // polygon zkevm
      return "0x554f16d513e1eB2fDf3b8CaAAb50405415Fa405A";
    case 17777: // EOS EVM
      return "0xf6ded65bf69FeC06b8cc95B4B06c33a66ab58A0F";
    case 770077: // grove
      return "0x118fa9297F4E2cBB310133A8aAa695f0e14D04c3";
    case 109: // shibarium
      return "0x80ad06DF035d28d6BE1167c3b06E638B561cf90E";
    case 192837465: // gth
      return "0x372d0695E75563D9180F8CE31c9924D7e8aaac47";
    case 534352: // scroll
      return "0xC2c8eDe80BB5aeB883077eCe496B0C374549D092";
    case 1890: // lightlink - phoenix
      return "0xC6a4B6667c44Fd56dC6E15C45108c4e8fC22F517";
    case 1012: // newton
      return "0x5c1537fd2B4e75D54f17535Cfd350b998068B04B";
    case 1339:  // eon
      return '0x952e846E505d4e4ddf579541A0d739f1681F2282';
    case 34443: // mode
      return '0xA1da7a7eB5A858da410dE8FBC5092c2079B58413';
    case 42766: // zkfair
      return '0x9eF6667974Fb12D07774221AAB1E90b2ec48896E';
    // case 4200: // merlin
    //   return '0x4398C643e4FA26420B49AcA0d3EeCD96a7C20e5e';
    case 7171: // bitrock
      return '0x40DD0342A46Ab0893251211F6626E82c09A75345';
    case 201022: // fsc
      return '0x18fA376d92511Dd04090566AB6144847c03557d8';
    case 196: // xlayer okb
      return '0x398F92e15519B4F6F2D5cc42C17FC9ED15De53d8';
    case 200901: // btr
      return '0xc8818aaeaBF0dF9f3f3ffF54Ab185705177A6234';
    case 1130:  // defichain evm
      return '0x7fEf77CDe3B41221Cff54B84Ea89D2EBc6b53352';
    case 6001:  // bouncebit
      return '0x493d616f5F9a64e5B3D527120E406439bdF29272';
    case 810180:  // zklink
      return '0xa8738F57538E3Bb73872d1133F2358c7Fe56FD35';
    case 5112:  // ham
      return '0xB7c3Ea932649fBD594C881aDCb3F19415e2EA2d5';
    case 1996:  // sanko
      return '0xB32d192e07727A0F6f48e721791aa4e02cd292e1';
    case 185:  // mint
      return '0xf8ac4BEB2F75d2cFFb588c63251347fdD629B92c';
    case 42420:  // assetchain
      return '0xf8ac4BEB2F75d2cFFb588c63251347fdD629B92c';
    case 388:  // cronos_zkevm
      return '0x9b122BF7a96F24EFB7A2b5765c635909dB3458F7';
    case 47763:  // neox
      return '0xD6010D102015fEa9cB3a9AbFBB51994c0Fd6E672';
    case 207:  // vinu
      return '0x63CE2062281fb85fE5BC407799A455C21f35F355';
    case 32770:  // zilliqa
      return '0x38899efb93d5106d3adb86662c557f237f6ecf57';
    case 181: // water
      return '0x63cee78B11774535132fd773C5dDe3c4b41CD07f';
    case 11820: return '0x6d761c3fe633c67b1d3a55678b04eb4ad11c4642'; // artela
    case 2355: return '0x566da61a4D0841a67bA8F2c7e5975885fa0Af4DA'; // silicon_zk
    case 728126428: return 'TEazPvZwDjDtFeJupyo7QunvnrnUjPH8ED'; // silicon_zk
    default:
      return null;
  }
}
