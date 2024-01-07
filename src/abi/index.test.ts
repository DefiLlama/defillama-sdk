import ChainApi from "../ChainApi";
import { call, multiCall } from "./index";
const getReservesAbi = "function getReserves() view returns (uint112 _reserve0, uint112 _reserve1, uint32 _blockTimestampLast)"
const getReservesAbi2 = "function getReserves() view returns (uint112 _reserve0, uint112 _reserve1)"

const calldata = '{"abi":{"constant":true,"inputs":[{"internalType":"uint256","name":"","type":"uint256"}],"name":"allPairs","outputs":[{"internalType":"address","name":"","type":"address"}],"payable":false,"stateMutability":"view","type":"function"},"chain":"avax", "target": "0x9Ad6C38BE94206cA50bb0d90783181662f0Cfa10", "calls": []}'
test("large muticall avax", async () => {
  const options = JSON.parse(calldata)
  for (let i = 0; i < 500; i++)
    options.calls.push({ params: i })
  const res = await multiCall(options)
  expect(res.output.filter((r: any) => !r.success).length).toBe(0)
});

test("block tag", async () => {
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      abi: "erc20:balanceOf",
      block: 15997547,
    })
  ).toEqual({
    output: "3914724000000000000",
  });
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      abi: "erc20:balanceOf",
      block: "15997547",
    })
  ).toEqual({
    output: "3914724000000000000",
  });

  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      abi: "erc20:decimals",
    })
  ).toEqual({
    output: "18",
  });

  await expect(call({
    target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
    abi: "erc20:decimals",
    block: "42n",
  })).rejects.toThrowError()
});

test("call", async () => {
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      abi: "erc20:balanceOf",
      block: 15997547,
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
  ).toEqual({
    output: "18",
  });
});

test("call with typed abi", async () => {
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      abi: "uint8:decimals",
    })
  ).toEqual({
    output: "18",
  });
  expect(
    await call({
      target: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: "string:symbol",
    })
  ).toEqual({
    output: "DAI",
  });
  expect(
    await call({
      target: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: "string:name",
    })
  ).toEqual({
    output: "Dai Stablecoin",
  });
  expect(
    await call({
      block: "16239804",
      target: "0x6b3595068778dd592e39a122f4f5a5cf09c90fe2",
      abi: "uint256:totalSupply",
    })
  ).toEqual({
    output: "246440827147798933525775397",
  });
  expect(
    await call({
      target: "0xb6916bc20cae34de64af39b8534d1459d8bb4128",
      abi: "address:factory",
    })
  ).toEqual({
    output: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  });

  expect(
    (await call({
      target: "0xdc8c63dfc31325aea8cb37ecec1a760bbb5b43e7",
      abi: "address[]:getAllLeveragePool",
      chain: 'avax'
    })).output.length
  ).toBeGreaterThan(3);
});

test("call with abi string", async () => {
  expect(
    await call({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      abi: "function decimals() view returns (uint8)",
    })
  ).toEqual({
    output: "18",
  });
  expect(
    await call({
      target: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: "function symbol() view returns (string)",
    })
  ).toEqual({
    output: "DAI",
  });
  expect(
    await call({
      target: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
      abi: "function name() view returns (string)",
    })
  ).toEqual({
    output: "Dai Stablecoin",
  });
  expect(
    await call({
      block: "16239804",
      target: "0x6b3595068778dd592e39a122f4f5a5cf09c90fe2",
      abi: "function totalSupply() view returns (uint256)",
    })
  ).toEqual({
    output: "246440827147798933525775397",
  });
  expect(
    await call({
      target: "0xb6916bc20cae34de64af39b8534d1459d8bb4128",
      abi: "function factory() view returns (address)",
    })
  ).toEqual({
    output: "0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f",
  });

});

test("call doesn't include __length__", async () => {
  expect(
    await call({
      target: "0x3dfd23A6c5E8BbcFc9581d2E864a68feb6a076d3",
      abi: 'address[]:getReserves',
    })
  ).toEqual({
    output: [
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
    ],
  });
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
  ).toEqual({
    output: [
      {
        input: {
          target: "0x0000000000085d4780B73119b644AE5ecd22b376",
          params: ["0xecd5e75afb02efa118af914515d6521aabd189f1"],
        },
        success: true,
        output: "14625620499802070062319404",
      },
      {
        input: {
          target: "0x89d24A6b4CcB1B6fAA2625fE562bDD9a23260359",
          params: ["0xd9ebebfdab08c643c5f2837632de920c70a56247"],
        },
        success: true,
        output: "309111153048197706206870",
      },
    ],
  });
});

test("multiCall with abi", async () => {
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
    })
  ).toEqual({
    output: [
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
    ],
  });
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
  ).toEqual({
    output: [
      {
        input: {
          target: "0x7f1c7aa2ce3cbc533afc7934156d4ae20d313808",
          params: [],
        },
        success: true,
        output: true,
      },
    ],
  });
});

test("multiCall with revert throws error", async () => {
  await expect(async () => multiCall({
    calls: [
      {
        target: "0xbb2b8038a1640196fbe3e38816f3e67cba72d940",
        params: [],
      },
      {
        target: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // Not a pair -> reverts the tx
        params: [],
      },
      {
        target: "0xd3d2e2692501a5c9ca623199d38826e513033a17",
        params: [],
      },
    ],
    abi: getReservesAbi,
  })).rejects;
});

test("multiCall with revert throws error2", async () => {
  await expect(async () => multiCall({
    calls: [
      {
        target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
        params: ["0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9"],
      },
      {
        target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260350", // invalid target
        params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
      },
    ],
    abi: "erc20:balanceOf",
  })).rejects;
});

test("multiCall with multiple return values and reverts", async () => {
  const response = await multiCall({
    calls: [
      {
        target: "0xbb2b8038a1640196fbe3e38816f3e67cba72d940",
        params: [],
      },
      {
        target: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", // Not a pair -> reverts the tx
        params: [],
      },
      {
        target: "0xd3d2e2692501a5c9ca623199d38826e513033a17",
        params: [],
      },
    ],
    abi: getReservesAbi,
    block: 15997547,
    permitFailure: true,
  })

  response.output.forEach((r: any) => delete r.error)

  const expectedResponse = {
    output: [
      {
        input: {
          target: "0xbb2b8038a1640196fbe3e38816f3e67cba72d940",
          params: [],
        },
        success: true,
        output: [
          "22703861331",
          "3120786254041482210638",
          "1668779963",
        ]
      },
      {
        input: {
          target: "0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2",
          params: [],
        },
        success: false,
        output: null,
      },
      {
        input: {
          target: "0xd3d2e2692501a5c9ca623199d38826e513033a17",
          params: [],
        },
        success: true,
        output: [
          "1428900635496571696616098",
          "6976400025268132321919",
          "1668782291",
        ]
      },
    ],
  }

  expect(response.output[0].output._reserve0).toEqual('22703861331')
  expect(response.output[0].output._reserve1).toEqual('3120786254041482210638')
  expect(response.output[2].output._blockTimestampLast).toEqual('1668782291')
  expect(JSON.parse(JSON.stringify(response))).toEqual(JSON.parse(JSON.stringify(expectedResponse)));
});

test("multiCall with parameters and cached ABI", async () => {
  expect(
    await multiCall({
      calls: [
        {
          target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
          params: ["0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9"],
        },
        {
          target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
          params: "0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9",
        },
        {
          target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
          params: "0xd3d2e2692501a5c9ca623199d38826e513033a17",
        },
      ],
      abi: "erc20:balanceOf",
    })
  ).toEqual({
    output: [
      {
        input: {
          target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
          params: ["0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9"],
        },
        success: true,
        output: "3914724000000000000",
      },
      {
        input: {
          target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
          params: ["0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9"],
        },
        success: true,
        output: "3914724000000000000",
      },
      {
        input: {
          target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
          params: ["0xd3d2e2692501a5c9ca623199d38826e513033a17"],
        },
        success: true,
        output: "0",
      },
    ],
  });
});

jest.setTimeout(20000);
test("multiCall with 2000 calls to verify that splitting works", async () => {
  // 500 is the limit for a single multicall
  const calls = [] as any;
  for (let i = 0; i < 2000; i++) {
    calls.push({
      target: "0x89d24a6b4ccb1b6faa2625fe562bdd9a23260359",
      params: ["0x3FfBa143f5e69Aa671C9f8e3843C88742b1FA2D9"],
    });
  }
  const res = await multiCall({
    calls,
    abi: "erc20:balanceOf",
    block: 15997547,
  })
  expect(res.output.filter((r: any) => !r.success).length).toBe(0)
  expect(res.output.length).toBe(2000)
});

test("maker multicall doesn't throw", async () => {
  const res = await multiCall({
    abi: {
      constant: true,
      inputs: [],
      name: "ilk",
      outputs: [{ internalType: "bytes32", name: "", type: "bytes32" }],
      payable: false,
      stateMutability: "view",
      type: "function",
    },
    calls: JSON.parse(
      '[{"target":"0xbaa65281c2fa2baacb2cb550ba051525a480d3f4"},{"target":"0x65c79fcb50ca1594b025960e539ed7a9a6d434a3"},{"target":"0x19c0976f590d67707e62397c87829d896dc0f1f1"},{"target":"0x197e90f9fad81970ba7976f33cbd77088e5d7cf7"},{"target":"0x78f2c2af65126834c51822f56be0d7469d7a523e"},{"target":"0xab14d3ce3f733cacb76ec2abe7d2fcb00c99f3d5"},{"target":"0xbe8e3e3618f7474f8cb1d074a26affef007e98fb"},{"target":"0x2f0b23f53734252bda2277357e97e1517d6b042a"},{"target":"0x3d0b1912b66114d4096f48a8cee3a56c231772ca"},{"target":"0xad37fd42185ba63009177058208dd1be4b136e6b"},{"target":"0x4d95a049d5b0b7d32058cd3f2163015747522e99"},{"target":"0xa191e578a6736167326d05c119ce0c90849e84b7"},{"target":"0xbf72da2bd84c5170618fbe5914b0eca9638d5eb5"},{"target":"0x2600004fd1585f7270756ddc88ad9cfa10dd0428"},{"target":"0x4454af7c8bb9463203b66c816220d41ed7837f44"},{"target":"0x475f1a89c1ed844a08e8f6c50a00228b5e59e4a9"},{"target":"0xc7e8cd72bdee38865b4f5615956ef47ce1a7e5d0"},{"target":"0xa6ea3b9c04b8a38ff5e224e7c3d6937ca44c0ef9"},{"target":"0xa41b6ef151e06da0e34b009b86e828308986736d"},{"target":"0xa5679c04fc3d9d8b0aab1f0ab83555b301ca70ea"},{"target":"0x0ac6a1d74e84c2df9063bddc31699ff2a2bb22a2"},{"target":"0x7e62b7e279dfc78deb656e34d6a435cc08a44666"},{"target":"0xbea7cdfb4b49ec154ae1c0d731e4dc773a3265aa"},{"target":"0x6c186404a7a238d3d6027c0299d1822c1cf5d8f1"},{"target":"0xdfccaf8fdbd2f4805c174f856a317765b49e4a50"},{"target":"0x08638ef1a205be6762a8b935f5da9b700cf7322c"},{"target":"0x4a03aa7fb3973d8f0221b466eefb53d0ac195f55"},{"target":"0x3ff33d9162ad47660083d7dc4bc02fb231c81677"},{"target":"0xe29a14bcdea40d83675aa43b72df07f649738c8b"},{"target":"0x3bc3a58b4fc1cbe7e98bb4ab7c99535e8ba9b8f1"},{"target":"0xfd5608515a47c37afba68960c1916b79af9491d0"},{"target":"0xc7bdd1f2b16447dcf3de045c4a039a60ec2f0ba3"},{"target":"0x24e459f61ceaa7b1ce70dbaea938940a7c5ad46e"},{"target":"0x2502f65d77ca13f183850b5f9272270454094a08"},{"target":"0x0a59649758aa4d66e25f08dd01271e891fe52199"},{"target":"0x7b3799b30f268ba55f926d7f714a3001af89d359"},{"target":"0xdc26c9b7a8fe4f5df648e314ec3e6dc3694e6dd2"},{"target":"0x03ae53b33feeac1222c3f372f32d37ba95f0f099"},{"target":"0xa81598667ac561986b70ae11bbe2dd5348ed4327"},{"target":"0x4aad139a88d2dd5e7410b408593208523a3a891d"},{"target":"0xdae88bde1fb38cf39b6a02b595930a3449e593a6"},{"target":"0xf11a98339fe1cde648e8d1463310ce3ccc3d7cc1"},{"target":"0xd40798267795cbf3aeea8e9f8dcbdba9b5281fcc"},{"target":"0x42afd448df7d96291551f1efe1a590101afb1dff"},{"target":"0xaf034d882169328caf43b823a4083dabc7eee0f4"},{"target":"0x476b81c12dc71edfad1f64b9e07caa60f4b156e2"},{"target":"0x88f88bb9e66241b73b84f3a6e197fbba487b1e30"}]'
    ),
    block: 15997547,
    permitFailure: true,
  })

  res.output.forEach((r: any) => delete r.error)
  expect(res).toEqual({
    output: JSON.parse(
      '[{"input":{"target":"0xbaa65281c2fa2baacb2cb550ba051525a480d3f4","params":[]},"success":false,"output":null},{"input":{"target":"0x65c79fcb50ca1594b025960e539ed7a9a6d434a3","params":[]},"success":false,"output":null},{"input":{"target":"0x19c0976f590d67707e62397c87829d896dc0f1f1","params":[]},"success":false,"output":null},{"input":{"target":"0x197e90f9fad81970ba7976f33cbd77088e5d7cf7","params":[]},"success":false,"output":null},{"input":{"target":"0x78f2c2af65126834c51822f56be0d7469d7a523e","params":[]},"success":false,"output":null},{"input":{"target":"0xab14d3ce3f733cacb76ec2abe7d2fcb00c99f3d5","params":[]},"success":false,"output":null},{"input":{"target":"0xbe8e3e3618f7474f8cb1d074a26affef007e98fb","params":[]},"success":false,"output":null},{"input":{"target":"0x2f0b23f53734252bda2277357e97e1517d6b042a","params":[]},"success":true,"output":"0x4554482d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x3d0b1912b66114d4096f48a8cee3a56c231772ca","params":[]},"success":true,"output":"0x4241542d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xad37fd42185ba63009177058208dd1be4b136e6b","params":[]},"success":true,"output":"0x5341490000000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x4d95a049d5b0b7d32058cd3f2163015747522e99","params":[]},"success":false,"output":null},{"input":{"target":"0xa191e578a6736167326d05c119ce0c90849e84b7","params":[]},"success":true,"output":"0x555344432d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xbf72da2bd84c5170618fbe5914b0eca9638d5eb5","params":[]},"success":true,"output":"0x574254432d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x2600004fd1585f7270756ddc88ad9cfa10dd0428","params":[]},"success":true,"output":"0x555344432d420000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x4454af7c8bb9463203b66c816220d41ed7837f44","params":[]},"success":true,"output":"0x545553442d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x475f1a89c1ed844a08e8f6c50a00228b5e59e4a9","params":[]},"success":true,"output":"0x4b4e432d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xc7e8cd72bdee38865b4f5615956ef47ce1a7e5d0","params":[]},"success":true,"output":"0x5a52582d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xa6ea3b9c04b8a38ff5e224e7c3d6937ca44c0ef9","params":[]},"success":true,"output":"0x4d414e412d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xa41b6ef151e06da0e34b009b86e828308986736d","params":[]},"success":false,"output":null},{"input":{"target":"0xa5679c04fc3d9d8b0aab1f0ab83555b301ca70ea","params":[]},"success":false,"output":null},{"input":{"target":"0x0ac6a1d74e84c2df9063bddc31699ff2a2bb22a2","params":[]},"success":true,"output":"0x555344542d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x7e62b7e279dfc78deb656e34d6a435cc08a44666","params":[]},"success":true,"output":"0x5041585553442d41000000000000000000000000000000000000000000000000"},{"input":{"target":"0xbea7cdfb4b49ec154ae1c0d731e4dc773a3265aa","params":[]},"success":true,"output":"0x434f4d502d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x6c186404a7a238d3d6027c0299d1822c1cf5d8f1","params":[]},"success":true,"output":"0x4c52432d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xdfccaf8fdbd2f4805c174f856a317765b49e4a50","params":[]},"success":true,"output":"0x4c494e4b2d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x08638ef1a205be6762a8b935f5da9b700cf7322c","params":[]},"success":true,"output":"0x4554482d42000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x4a03aa7fb3973d8f0221b466eefb53d0ac195f55","params":[]},"success":true,"output":"0x42414c2d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x3ff33d9162ad47660083d7dc4bc02fb231c81677","params":[]},"success":true,"output":"0x5946492d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xe29a14bcdea40d83675aa43b72df07f649738c8b","params":[]},"success":true,"output":"0x475553442d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x3bc3a58b4fc1cbe7e98bb4ab7c99535e8ba9b8f1","params":[]},"success":true,"output":"0x554e492d41000000000000000000000000000000000000000000000000000000"},{"input":{"target":"0xfd5608515a47c37afba68960c1916b79af9491d0","params":[]},"success":true,"output":"0x52454e4254432d41000000000000000000000000000000000000000000000000"},{"input":{"target":"0xc7bdd1f2b16447dcf3de045c4a039a60ec2f0ba3","params":[]},"success":false,"output":null},{"input":{"target":"0x24e459f61ceaa7b1ce70dbaea938940a7c5ad46e","params":[]},"success":true,"output":"0x414156452d410000000000000000000000000000000000000000000000000000"},{"input":{"target":"0x2502f65d77ca13f183850b5f9272270454094a08","params":[]},"success":true,"output":"0x554e4956324441494554482d4100000000000000000000000000000000000000"},{"input":{"target":"0x0a59649758aa4d66e25f08dd01271e891fe52199","params":[]},"success":true,"output":"0x50534d2d555344432d4100000000000000000000000000000000000000000000"},{"input":{"target":"0x7b3799b30f268ba55f926d7f714a3001af89d359","params":[]},"success":true,"output":"0x50534d2d555344432d4100000000000000000000000000000000000000000000"},{"input":{"target":"0xdc26c9b7a8fe4f5df648e314ec3e6dc3694e6dd2","params":[]},"success":true,"output":"0x554e495632574254434554482d41000000000000000000000000000000000000"},{"input":{"target":"0x03ae53b33feeac1222c3f372f32d37ba95f0f099","params":[]},"success":true,"output":"0x554e495632555344434554482d41000000000000000000000000000000000000"},{"input":{"target":"0xa81598667ac561986b70ae11bbe2dd5348ed4327","params":[]},"success":true,"output":"0x554e495632444149555344432d41000000000000000000000000000000000000"},{"input":{"target":"0x4aad139a88d2dd5e7410b408593208523a3a891d","params":[]},"success":true,"output":"0x554e495632455448555344542d41000000000000000000000000000000000000"},{"input":{"target":"0xdae88bde1fb38cf39b6a02b595930a3449e593a6","params":[]},"success":true,"output":"0x554e4956324c494e4b4554482d41000000000000000000000000000000000000"},{"input":{"target":"0xf11a98339fe1cde648e8d1463310ce3ccc3d7cc1","params":[]},"success":true,"output":"0x554e495632554e494554482d4100000000000000000000000000000000000000"},{"input":{"target":"0xd40798267795cbf3aeea8e9f8dcbdba9b5281fcc","params":[]},"success":true,"output":"0x554e495632574254434441492d41000000000000000000000000000000000000"},{"input":{"target":"0x42afd448df7d96291551f1efe1a590101afb1dff","params":[]},"success":true,"output":"0x554e495632414156454554482d41000000000000000000000000000000000000"},{"input":{"target":"0xaf034d882169328caf43b823a4083dabc7eee0f4","params":[]},"success":true,"output":"0x554e495632444149555344542d41000000000000000000000000000000000000"},{"input":{"target":"0x476b81c12dc71edfad1f64b9e07caa60f4b156e2","params":[]},"success":true,"output":"0x5257413030312d41000000000000000000000000000000000000000000000000"},{"input":{"target":"0x88f88bb9e66241b73b84f3a6e197fbba487b1e30","params":[]},"success":false,"output":null}]'
    ),
  });
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
  ).toEqual({
    output: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  });
});

test("Set protocol multicall", async () => {
  const res = await multiCall({
    abi: {
      inputs: [],
      name: "getPositions",
      outputs: [
        {
          components: [
            {
              internalType: "address",
              name: "component",
              type: "address",
            },
            { internalType: "address", name: "module", type: "address" },
            { internalType: "int256", name: "unit", type: "int256" },
            {
              internalType: "uint8",
              name: "positionState",
              type: "uint8",
            },
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

test("multicall with no call.target", async () => {
  expect(
    await multiCall({
      target: "0xC1bF1B4929DA9303773eCEa5E251fDEc22cC6828",
      abi: {
        inputs: [{ internalType: "uint256", name: "index", type: "uint256" }],
        name: "getActiveOrderId",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "view",
        type: "function",
      },
      block: 12066151,
      calls: [{ params: 0 }, { params: 1 }, { params: 2 }, { params: 3 }],
    } as any)
  ).toEqual({
    output: [
      {
        input: {
          target: "0xC1bF1B4929DA9303773eCEa5E251fDEc22cC6828",
          params: [0],
        },
        success: true,
        output: "967",
      },
      {
        input: {
          target: "0xC1bF1B4929DA9303773eCEa5E251fDEc22cC6828",
          params: [1],
        },
        success: true,
        output: "2998",
      },
      {
        input: {
          target: "0xC1bF1B4929DA9303773eCEa5E251fDEc22cC6828",
          params: [2],
        },
        success: true,
        output: "2404",
      },
      {
        input: {
          target: "0xC1bF1B4929DA9303773eCEa5E251fDEc22cC6828",
          params: [3],
        },
        success: true,
        output: "1805",
      },
    ],
  });
});

test("bsc multicall", async () => {
  expect(
    // No block provided!
    (
      await multiCall({
        abi: getReservesAbi,
        calls: [
          { target: "0xaeBE45E3a03B734c68e5557AE04BFC76917B4686" },
          { target: "0x1B96B92314C44b159149f7E0303511fB2Fc4774f" },
        ],
        chain: "bsc",
      })
    ).output.every((call: any) => call.success)
  ).toBe(true);
});

import largeMulticall from './largeMulticall'
jest.setTimeout(60 * 1000)
test("order is maintained in multicall", async () => {
  const result = await multiCall(largeMulticall as any);
  for (let i = 0; i < largeMulticall.calls.length; i++) {
    expect(result.output[i].input.target).toBe(largeMulticall.calls[i].target)
  }
})