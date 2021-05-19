import { ethers } from "ethers";
import { ParamType } from "ethers/lib/utils";
import { getProvider, Chain } from "../general";
import convertResults from "./convertResults";

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
export const AGGREGATE_SELECTOR = "0x252dba42";

export default async function makeMultiCall(
  functionABI: any,
  calls: {
    contract: string;
    params: any[];
  }[],
  chain: Chain,
  block?: number
) {
  const contractInterface = new ethers.utils.Interface([functionABI]);
  let fd = Object.values(contractInterface.functions)[0];

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
    try {
      output = convertResults(
        contractInterface.decodeFunctionResult(fd, values)
      );
    } catch (e) {
      output = null;
    }
    return {
      input: {
        params: calls[index].params,
        target: calls[index].contract,
      },
      success: output !== null,
      output,
    };
  });
}

async function executeCalls(
  contractCalls: {
    to: string;
    data: string;
  }[],
  chain: Chain,
  block?: number
) {
  if (await networkSupportsMulticall(chain)) {
    try {
      const multicallData = ethers.utils.defaultAbiCoder.encode(
        [
          ParamType.fromObject({
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

      const returnData = await getProvider(chain).call(tx, block ?? "latest");

      const [blockNumber, returnValues] = ethers.utils.defaultAbiCoder.decode(
        ["uint256", "bytes[]"],
        returnData
      );
      return returnValues;
    } catch (e) {
      if (!process.env.DEFILLAMA_SDK_MUTED) {
        console.log("Multicall failed, defaulting to single transactions...");
      }
    }
  }
  const values = await Promise.all(
    contractCalls.map(async (call) => {
      try {
        return await getProvider(chain).call(
          { to: call.to, data: call.data },
          block ?? "latest"
        );
      } catch (e) {
        return null;
      }
    })
  );
  return values;
}

async function multicallAddressOrThrow(chain: Chain) {
  const network = await getProvider(chain).getNetwork();
  const address = multicallAddress(network.chainId);
  if (address === null) {
    const msg = `multicall is not available on the network ${network.chainId}`;
    console.error(msg);
    throw new Error(msg);
  }
  return address;
}

async function networkSupportsMulticall(chain: Chain) {
  const network = await getProvider(chain).getNetwork();
  const address = multicallAddress(network.chainId);
  return address !== null;
}

function multicallAddress(chainId: number) {
  switch (chainId) {
    case 1:
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
    default:
      return null;
  }
}
