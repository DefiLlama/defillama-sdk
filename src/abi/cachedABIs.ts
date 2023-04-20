export default {
  "erc20:symbol": "string:symbol",
  "erc20:decimals": "uint8:decimals",
  "erc20:balanceOf": "function balanceOf(address account) view returns (uint256)",
  "erc20:totalSupply": "uint256:totalSupply",
} as {
  [method: string]: any | undefined;
};
