import { call, multiCall, fetchList, } from "./abi2";
import {  ChainApi } from "../ChainApi";

const uniswapAbis = {
  appPairs: { "constant": true, "inputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "name": "allPairs", "outputs": [{ "internalType": "address", "name": "", "type": "address" }], "payable": false, "stateMutability": "view", "type": "function" },
  allPairsLength: { "constant": true, "inputs": [], "name": "allPairsLength", "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }], "payable": false, "stateMutability": "view", "type": "function" },
}

test("call", async () => {
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      abi: "erc20:balanceOf",
      block: 15997547,
    })
  ).toEqual("3914724000000000000");
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      abi: "erc20:balanceOf",
      block: 15997547,
      withMetadata: true,
    })
  ).toEqual({
    output: "3914724000000000000",
  });
});

test("call with a result of low numerical value", async () => {
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      abi: "erc20:decimals",
      block: 15997547,
    })
  ).toEqual("18");
});


test("call doesn't include __length__", async () => {
  expect(
    await call({
      target: "0x3dfd23A6c5E8BbcFc9581d2E864a68feb6a076d3",
      abi: {
        constant: true,
        inputs: [],
        name: "getReserves",
        outputs: [{ internalType: "address[]", name: "", type: "address[]" }],
        payable: false,
        stateMutability: "view",
        type: "function",
      },
    })
  ).toEqual([
    "0x6B175474E89094C44Da98b954EedeAC495271d0F",
    "0x0000000000085d4780B73119b644AE5ecd22b376",
    "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "0xdAC17F958D2ee523a2206206994597C13D831ec7",
    "0x57Ab1ec28D129707052df4dF418D58a2D46d5f51",
    "0x80fB784B7eD66730e8b1DBd9820aFD29931aab03",
    "0x0D8775F648430679A709E98d2b0Cb6250d2887EF",
    "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE",
    "0x514910771AF9Ca656af840dff83E8264EcF986CA",
    "0xdd974D5C2e2928deA5F71b9825b8b646686BD200",
    "0x1985365e9f78359a9B6AD760e32412f4a445E862",
    "0x9f8F72aA9304c8B593d555F12eF6589cC3A579A2",
    "0x0F5D2fB29fb7d3CFeE444a200298f468908cC942",
    "0xE41d2489571d322189246DaFA5ebDe1F4699F498",
    "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
    "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
    "0x4Fabb145d64652a948d72533023f6E7A623C7C53",
    "0xF629cBd94d3791C9250152BD8dfBDF380E2a3B9c",
    "0x408e41876cCCDC0F92210600ef50372656052a38",
    "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
    "0x7Fc66500c84A76Ad7e9c93437bFc5Ac33E2DDaE9",
    "0x1f9840a85d5aF5bf1D1762F925BDADdC4201F984",
  ]);
});

test("multiCall", async () => {
  expect(
    await multiCall({
      calls: [
        {
          target: "0x0000000000085d4780B73119b644AE5ecd22b376",
          params: "0xecd5e75afb02efa118af914515d6521aabd189f1",
        },
        {
          target: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
          params: "0xd9ebebfdab08c643c5f2837632de920c70a56247",
        },
      ],
      abi: "erc20:balanceOf",
      block: 15997547,
    })
  ).toEqual([
    "14625620499802070062319404",
    "309111153048197706206870",
  ]);
});

test("multiCall omax", async () => {
  expect(
    await multiCall({
      calls: [
        {
          target: "0xfeBaBc6a9B2Ec46d6357879B8bf39B593F11A5B9",
          params: "0xecd5e75afb02efa118af914515d6521aabd189f1",
        },
        {
          target: "0xfeBaBc6a9B2Ec46d6357879B8bf39B593F11A5B9",
          params: "0xd9ebebfdab08c643c5f2837632de920c70a56247",
        },
      ],
      abi: "erc20:balanceOf",
      chain: "omax",
    })
  ).toEqual([
    "0",
    "0",
  ]);
  expect(
    await multiCall({
      calls: [
        {
          target: "0xAA72D7f25EeA161855CDf46aeF9475EC71169A23",
        },
      ],
      abi: "address:factory",
      chain: "omax",
    })
  ).toEqual([
    "0x0e149Ff38Cd5B5c0F1004D08A14C9653485ad5fA",
  ]);
  expect(
    await multiCall({
      calls: [
        {
          target: "0x0bce9e0ebd4fd4d6562495af45c4aaa0c1f7f3d7",
        },
        {
          target: "0x0bce9e0ebd4fd4d6562495af45c4aaa0c1f7f3d7",
        },
        {
          target: "0x0bce9e0ebd4fd4d6562495af45c4aaa0c1f7f3d7",
        },
      ],
      abi: "address:factory",
      chain: "map",
    })
  ).toEqual([
    "0x29c3d087302e3fCb75F16175A09E4C39119459B2",
    "0x29c3d087302e3fCb75F16175A09E4C39119459B2",
    "0x29c3d087302e3fCb75F16175A09E4C39119459B2",
  ]);
});

test("multiCall with abi", async () => {
  expect(
    await multiCall({
      calls: [
        "0x7f1c7aa2ce3cbc533afc7934156d4ae20d313808",
      ],
      abi: {
        constant: true,
        inputs: [],
        name: "getCurrentTokens",
        outputs: [
          { internalType: "address[]", name: "tokens", type: "address[]" },
        ],
        payable: false,
        type: "function",
      },
    })
  ).toEqual([
    [
      "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
      "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
      "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
      "0x80fB784B7eD66730e8b1DBd9820aFD29931aab03",
      "0xa3BeD4E1c75D00fa6f4E5E6922DB7261B5E9AcD2",
      "0xba100000625a3754423978a60c9317c58a424e3D",
      "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
      "0x0d438F3b5175Bebc262bF23753C1E53d03432bDE",
    ],
  ]);
  expect(
    await multiCall({
      calls: [
        {
          target: "0x7f1c7aa2ce3cbc533afc7934156d4ae20d313808",
          params: [],
        },
      ],
      abi: {
        constant: true,
        inputs: [],
        name: "getCurrentTokens",
        outputs: [
          { internalType: "address[]", name: "tokens", type: "address[]" },
        ],
        payable: false,
        type: "function",
      },
      withMetadata: true,
    })
  ).toEqual([
    {
      input: {
        target: "0x7f1c7aa2ce3cbc533afc7934156d4ae20d313808",
        params: [],
      },
      success: true,
      output: [
        "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
        "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
        "0x0bc529c00C6401aEF6D220BE8C6Ea1667F6Ad93e",
        "0x80fB784B7eD66730e8b1DBd9820aFD29931aab03",
        "0xa3BeD4E1c75D00fa6f4E5E6922DB7261B5E9AcD2",
        "0xba100000625a3754423978a60c9317c58a424e3D",
        "0xC011a73ee8576Fb46F5E1c5751cA3B9Fe0af2a6F",
        "0x0d438F3b5175Bebc262bF23753C1E53d03432bDE",
      ],
    },
  ]);
});

test("multiCall with bool", async () => {
  expect(
    await multiCall({
      calls: [
        {
          target: "0x7f1c7aa2ce3cbc533afc7934156d4ae20d313808",
          params: [],
        },
      ],
      abi: {
        constant: true,
        inputs: [],
        name: "isPublicSwap",
        outputs: [{ internalType: "bool", name: "", type: "bool" }],
        payable: false,
        stateMutability: "view",
        type: "function",
      },
    })
  ).toEqual([true]);
});

test("multiCall with multiple return values and reverts", async () => {
  const response = await multiCall({
    calls: [
      "0xbb2b8038a1640196fbe3e38816f3e67cba72d940",
      "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // Not a pair -> reverts the tx
      "0xd3d2e2692501a5c9ca623199d38826e513033a17",
    ],
    abi: {
      constant: true,
      inputs: [],
      name: "getReserves",
      outputs: [
        { internalType: "uint112", name: "_reserve0", type: "uint112" },
        { internalType: "uint112", name: "_reserve1", type: "uint112" },
        {
          internalType: "uint32",
          name: "_blockTimestampLast",
          type: "uint32",
        },
      ],
      payable: false,
      stateMutability: "view",
      type: "function",
    },
    block: 15997547,
  })

  const expectedResponse = [
    [
      "22703861331",
      "3120786254041482210638",
      "1668779963",
    ],
    null,
    [
      "1428900635496571696616098",
      "6976400025268132321919",
      "1668782291",
    ],
  ]

  expect(response[0]._reserve0).toEqual('22703861331')
  expect(response[0]._reserve1).toEqual('3120786254041482210638')
  expect(response[2]._blockTimestampLast).toEqual('1668782291')
  expect(JSON.parse(JSON.stringify(response))).toEqual(JSON.parse(JSON.stringify(expectedResponse)));
});

test("maker call doesn't do weird things", async () => {
  expect(
    await call({
      block: 15997547,
      target: "0x2f0b23f53734252bda2277357e97e1517d6b042a",
      abi: {
        constant: true,
        inputs: [],
        name: "gem",
        outputs: [{ internalType: "address", name: "", type: "address" }],
        payable: false,
        stateMutability: "view",
        type: "function",
      },
    })
  ).toEqual("0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2");
});

test("bsc multicall", async () => {
  expect(
    // No block provided!
    (
      await multiCall({
        abi: {
          constant: true,
          inputs: [],
          name: "getReserves",
          outputs: [
            { internalType: "uint112", name: "_reserve0", type: "uint112" },
            { internalType: "uint112", name: "_reserve1", type: "uint112" },
            {
              internalType: "uint32",
              name: "_blockTimestampLast",
              type: "uint32",
            },
          ],
          payable: false,
          stateMutability: "view",
          type: "function",
        },
        calls: [
          "0xaeBE45E3a03B734c68e5557AE04BFC76917B4686",
          "0x1B96B92314C44b159149f7E0303511fB2Fc4774f",
        ],
        chain: "bsc",
      })
    ).every((call) => !!call)
  ).toBe(true);
});


test("fetchList", async () => {
  const res = await fetchList({
    target: "0xa556E2d77060A42516C9A8002E9156d8d3c832CE",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
  })
  expect(res).toEqual(['0x9536A78440f72f5E9612949F1848fe5E9D4934CC']);
  const res2 = await fetchList({
    withMetadata: true,
    target: "0xa556E2d77060A42516C9A8002E9156d8d3c832CE",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
  })
  expect(res2).toEqual([
    {
      "input": {
        "params": [
          0
        ],
        "target": "0xa556E2d77060A42516C9A8002E9156d8d3c832CE"
      },
      "success": true,
      "output": "0x9536A78440f72f5E9612949F1848fe5E9D4934CC"
    }
  ]
  );
});

test("fetchList - other chains", async () => {
  const moonbeamRes = await fetchList({
    chain: 'moonbeam',
    target: "0xf6c49609e8d637c3d07133e28d369283b5e80c70",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
    startFrom: 3
  })
  const bscRes = await fetchList({
    chain: 'bsc',
    target: "0xa098751d407796d773032f5cc219c3e6889fb893",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
  })
  expect(moonbeamRes).toEqual([
    '0x58E4538fd53F14466b2Fe0A732d6eF7981065d55',
    '0xECDbF021475C391564977a0A2d7BF9235bf13578'
  ]);
  expect(bscRes).toEqual([
    '0x1Da189c1BA3d718Cc431a2ed240a3753f89CD47A',
    '0xe606cEE895ddF32b0582A9DC7495176657b4909D'
  ]);
});

test("ChainApi - bsc", async () => {
  const apiBsc = new ChainApi({ chain: 'bsc' })
  const apiMoonbeam = new ChainApi({ chain: 'moonbeam' })

  const moonbeamRes = await apiMoonbeam.fetchList({
    target: "0xf6c49609e8d637c3d07133e28d369283b5e80c70",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
    startFrom: 3
  })
  const bscRes = await apiBsc.fetchList({
    target: "0xa098751d407796d773032f5cc219c3e6889fb893",
    lengthAbi: uniswapAbis.allPairsLength,
    itemAbi: uniswapAbis.appPairs,
  })
  
  expect(moonbeamRes).toEqual([
    '0x58E4538fd53F14466b2Fe0A732d6eF7981065d55',
    '0xECDbF021475C391564977a0A2d7BF9235bf13578'
  ]);
  expect(bscRes).toEqual([
    '0x1Da189c1BA3d718Cc431a2ed240a3753f89CD47A',
    '0xe606cEE895ddF32b0582A9DC7495176657b4909D'
  ]);
});