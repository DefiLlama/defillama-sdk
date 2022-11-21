import { sumMultiBalanceOf, sumSingleBalance } from "./generalUtil";
import { BigNumber } from "ethers"

test("sumMultiBalanceOf", () => {
  const balances = {
    "0x0000000000000000000000000000000000000000": "1380309269697565432250",
  };
  sumMultiBalanceOf(balances, {
    ethCallCount: 1,
    output: [
      {
        input: {
          target: "0x514910771af9ca656af840dff83e8264ecf986ca",
          params: ["0xa04197e5f7971e7aef78cf5ad2bc65aac1a967aa"],
        },
        success: true,
        output: "121787335350553116046",
      },
      {
        input: {
          target: "0xc00e94cb662c3520282e6f5717214004a7f26888",
          params: ["0xfa203e643d1fddc5d8b91253ea23b3bd826cae9e"],
        },
        success: true,
        output: "196377513373723266",
      },
      {
        input: {
          target: "0x80fb784b7ed66730e8b1dbd9820afd29931aab03",
          params: ["0xd48c88a18bfa81486862c6d1d172a39f1365e8ac"],
        },
        success: true,
        output: "240068223687113307904",
      },
      {
        input: {
          target: "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f",
          params: ["0x4cc89906db523af7c3bb240a959be21cb812b434"],
        },
        success: true,
        output: "32125191633871661847",
      },
    ],
  });
  expect(balances).toEqual({
    "0x0000000000000000000000000000000000000000": "1380309269697565432250",
    "0x514910771af9ca656af840dff83e8264ecf986ca": "121787335350553116046",
    "0xc00e94cb662c3520282e6f5717214004a7f26888": "196377513373723266",
    "0x80fb784b7ed66730e8b1dbd9820afd29931aab03": "240068223687113307904",
    "0xc011a73ee8576fb46f5e1c5751ca3b9fe0af2a6f": "32125191633871661847",
  });
});

test("sumSingleBalance", () => {
  let balances = {};
  sumSingleBalance(balances, "ethereum", "2")
  expect(balances).toMatchObject({ ethereum: '2'})
  sumSingleBalance(balances, "ethereum", "5")
  expect(balances).toMatchObject({ ethereum: '7'})

  balances = { ethereum: '5000' }
  sumSingleBalance(balances, "ethereum", 2000)
  expect(balances).toMatchObject({ ethereum: 7000})
  
  balances = { 'bsc:0x000': 5000 }
  sumSingleBalance(balances, "0x000", '2000', 'bsc')
  sumSingleBalance(balances, "0x000", '3000', 'bsc')
  expect(balances).toMatchObject({ 'bsc:0x000': '10000' })
  
  balances = { 'polygon:0x000': 5000 }
  sumSingleBalance(balances, "0x000", BigNumber.from(2000), 'polygon')
  expect(balances).toMatchObject({ 'polygon:0x000': '7000' })
  
  balances = { 'avax:0x000': 6999 }
  sumSingleBalance(balances, "0x000", 1, 'avax')
  expect(balances).toMatchObject({ 'avax:0x000': 7000 })
  
  balances = { 'ethereum:0x000': '5000' }
  sumSingleBalance(balances, "0x000", '2000', 'ethereum')
  sumSingleBalance(balances, "0x000", 0, 'ethereum')
  sumSingleBalance(balances, "0x000", '0', 'ethereum')
  expect(balances).toMatchObject({ 'ethereum:0x000': '7000' })
});

test("sumSingleBalance throw error on invalid input", () => {
  expect(() => sumSingleBalance({ ethereum: 1},'dummy', {bad: 1} as any)).toThrowError()
  expect(() => sumSingleBalance({ ethereum: 1},'dummy', null as any, 'bsc')).toThrowError()
  expect(() => sumSingleBalance({ ethereum: '1'},'ethereum', undefined as any)).toThrowError()
  expect(() => sumSingleBalance({ ethereum: 1},'dummy', 'a111' as any, 'ethereum')).toThrowError()
  expect(() => sumSingleBalance({ ethereum: '1'},'dummy', '111a' as any, 'ethereum')).toThrowError()
});
