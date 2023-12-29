import { call, multiCall } from "./index";
import ChainApi from "../ChainApi";

const getPortfoliosABI = "function getPortfolios() view returns (tuple(string[] name, address[] contractAddress, address[] baseTokenAddress, address[] lpTokenAddress, uint256[] lpTokenPrice, uint256[] totalValue, uint256[] tokenCount, uint256[] baseTokenPriceCoefficient, tuple(address[] tokenAddress, uint256[] amount, uint256[] price, uint256[] depositLimit, uint256[] withdrawLimit, uint256[] depositEMAPrice, uint256[] withdrawEMAPrice, uint256[] portfolioShare, uint256[] targetWeight)[] tokens))"


test("Set protocol multicall", async () => {
  const res = await multiCall({
    abi: {
      inputs: [],
      name: "getPositions",
      outputs: [
        {
          components: [
            { internalType: "address", name: "component", type: "address", },
            { internalType: "address", name: "module", type: "address" },
            { internalType: "int256", name: "unit", type: "int256" },
            { internalType: "uint8", name: "positionState", type: "uint8", },
            { internalType: "bytes", name: "data", type: "bytes" },
          ],
          internalType: "struct ISetToken.Position[]",
          name: "",
          type: "tuple[]",
        },
      ],
      stateMutability: "view",
      type: "function",
    },
    block: 12065584,
    calls: [
      { target: "0x1494CA1F11D487c2bBe4543E90080AeBa4BA3C2b" },
      { target: "0x90d8C1eE7fE895a780405d1B62839fa1c7796A70" },
      { target: "0x23687D9d40F9Ecc86E7666DDdB820e700F954526" },
      { target: "0x532777F415735dAD24eC97FeEAC62EB1F15cf128" },
      { target: "0x7F8E3f03D84e0aA7488375C85Ed470b4451f0899" },
    ],
  })
  let expectedResponse: any = '{"output":[{"input":{"target":"0x1494CA1F11D487c2bBe4543E90080AeBa4BA3C2b","params":[]},"success":true,"output":[["0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e","0x0000000000000000000000000000000000000000","566681395927559","0","0x"],["0xc00e94Cb662C3520282E6f5717214004A7f26888","0x0000000000000000000000000000000000000000","70318775153048506","0","0x"],["0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F","0x0000000000000000000000000000000000000000","2384736988477651228","0","0x"],["0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2","0x0000000000000000000000000000000000000000","14668017874179484","0","0x"],["0x408e41876cCCDC0F92210600ef50372656052a38","0x0000000000000000000000000000000000000000","14329297278561211120","0","0x"],["0xdd974D5C2e2928deA5F71b9825b8b646686BD200","0x0000000000000000000000000000000000000000","3322796981570831895","0","0x"],["0xBBbbCA6A901c926F240b89EacB641d8Aec7AEafD","0x0000000000000000000000000000000000000000","20270507030878218910","0","0x"],["0xba100000625a3754423978a60c9317c58a424e3D","0x0000000000000000000000000000000000000000","175627130233863107","0","0x"],["0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984","0x0000000000000000000000000000000000000000","4871122751163785374","0","0x"],["0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9","0x0000000000000000000000000000000000000000","201801624666571816","0","0x"],["0xa3BeD4E1c75D00fa6f4E5E6922DB7261B5E9AcD2","0x0000000000000000000000000000000000000000","295166852626052623","0","0x"],["0x6B3595068778DD592e39A122f4f5a5cF09C90fE2","0x0000000000000000000000000000000000000000","1969722723891450605","0","0x"]]},{"input":{"target":"0x90d8C1eE7fE895a780405d1B62839fa1c7796A70","params":[]},"success":true,"output":[["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","0x0000000000000000000000000000000000000000","147000000000000000","0","0x"],["0x6B175474E89094C44Da98b954EedeAC495271d0F","0x0000000000000000000000000000000000000000","50000000000000000000","0","0x"]]},{"input":{"target":"0x23687D9d40F9Ecc86E7666DDdB820e700F954526","params":[]},"success":true,"output":[["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","0x0000000000000000000000000000000000000000","130867502281176757","0","0x"],["0x6B175474E89094C44Da98b954EedeAC495271d0F","0x0000000000000000000000000000000000000000","63797945472382022874","0","0x"]]},{"input":{"target":"0x532777F415735dAD24eC97FeEAC62EB1F15cf128","params":[]},"success":true,"output":[["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","0x0000000000000000000000000000000000000000","147000000000000000","0","0x"],["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599","0x0000000000000000000000000000000000000000","480000","0","0x"]]},{"input":{"target":"0x7F8E3f03D84e0aA7488375C85Ed470b4451f0899","params":[]},"success":true,"output":[["0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2","0x0000000000000000000000000000000000000000","147000000000000000","0","0x"],["0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599","0x0000000000000000000000000000000000000000","480000","0","0x"]]}]}'
  expectedResponse = JSON.parse(expectedResponse)
  // We serialize and unserialize to avoid the test failing because some functions were copied with lodash.deepClone differently
  expect(JSON.parse(JSON.stringify(res))).toEqual(expectedResponse)
  expect(res.output[0].output[0].component).toEqual(expectedResponse.output[0].output[0][0])
  expect(res.output[1].output[0].module).toEqual(expectedResponse.output[1].output[0][1])
  expect(res.output[2].output[0].unit).toEqual(expectedResponse.output[2].output[0][2])
  expect(res.output[3].output[0].positionState).toEqual(expectedResponse.output[3].output[0][3])
  expect(res.output[4].output[0].data).toEqual(expectedResponse.output[4].output[0][4])
});

test("tuples within tuples", async () => {
  const api = new ChainApi({ chain: "polygon" })
  const kavaApi = new ChainApi({ chain: "kava" })
  await api.call({ abi: getPortfoliosABI, target: '0x2080A319A4B11D097050722b6b65d09F754EdC83', })
  await kavaApi.call({ abi: getPortfoliosABI, target: '0x49399653f651A25924b3D8718276b5b4372577b1', })
});