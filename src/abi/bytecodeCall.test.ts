import { bytecodeCall } from "./abi2";

const solidityData = {
  code: `// SPDX-License-Identifier: MIT
  pragma solidity ^0.8.0;
  
  interface IUniswapV2Factory {
      function allPairsLength() external view returns (uint);
  
      function allPairs(uint) external view returns (address);
  }
  
  contract TestUniQuery {
      constructor(address factory) {
          IUniswapV2Factory uniswapFactory = IUniswapV2Factory(factory);
          uint pairCount = uniswapFactory.allPairsLength();
  
          // encode the return data
          bytes memory _data = abi.encode(pairCount);
          // force constructor to return data via assembly
          assembly {
              // abi.encode adds an additional offset (32 bytes) that we need to skip
              let _dataStart := add(_data, 32)
              // msize() gets the size of active memory in bytes.
              // if we subtract msize() from _dataStart, the output will be
              // the amount of bytes from _dataStart to the end of memory
              // which due to how the data has been laid out in memory, will coincide with
              // where our desired data ends.
              let _dataEnd := sub(msize(), _dataStart)
              // starting from _dataStart, get all the data in memory.
              return(_dataStart, _dataEnd)
          }
      }
  }`,
  bytecode: '608060405234801561000f575f80fd5b506040516101e33803806101e383398181016040528101906100319190610131565b5f8190505f8173ffffffffffffffffffffffffffffffffffffffff1663574f2ba36040518163ffffffff1660e01b8152600401602060405180830381865afa15801561007f573d5f803e3d5ffd5b505050506040513d601f19601f820116820180604052508101906100a3919061018f565b90505f816040516020016100b791906101c9565b6040516020818303038152906040529050602081018059038082f35b5f80fd5b5f73ffffffffffffffffffffffffffffffffffffffff82169050919050565b5f610100826100d7565b9050919050565b610110816100f6565b811461011a575f80fd5b50565b5f8151905061012b81610107565b92915050565b5f60208284031215610146576101456100d3565b5b5f6101538482850161011d565b91505092915050565b5f819050919050565b61016e8161015c565b8114610178575f80fd5b50565b5f8151905061018981610165565b92915050565b5f602082840312156101a4576101a36100d3565b5b5f6101b18482850161017b565b91505092915050565b6101c38161015c565b82525050565b5f6020820190506101dc5f8301846101ba565b9291505056fe',
  inputTypes: ['address'],
  outputTypes: ['uint256'],
}

test("bytecodeCall", async () => {
  const result = await bytecodeCall({
    bytecode: solidityData.bytecode,
    inputTypes: solidityData.inputTypes,
    outputTypes: solidityData.outputTypes,
    inputs: ["0x460b2005b3318982feADA99f7ebF13e1D6f6eFfE"],
  })
  expect(+result).toBeGreaterThanOrEqual(22)
});
