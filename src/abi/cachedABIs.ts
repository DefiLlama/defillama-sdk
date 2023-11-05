export default {
  "erc20:symbol": "string:symbol",
  "erc20:decimals": "uint8:decimals",
  "erc20:balanceOf": "function balanceOf(address account) view returns (uint256)",
  "erc20:totalSupply": "uint256:totalSupply",
} as {
  [method: string]: any | undefined;
};

export const rawBalanceOfAbi = {"inputs":[{"internalType":"address","name":"account","type":"address"}],"name":"balanceOf","outputs":[{"internalType":"uint256","name":"","type":"uint256"}],"stateMutability":"view","type":"function"}