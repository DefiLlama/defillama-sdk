import { Address } from "../types";
import { ethers } from "ethers";
import { Chain, getProvider, handleDecimals } from "../general";

const abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function getContract(address: Address, chain?: Chain) {
  return new ethers.Contract(address, abi, getProvider(chain));
}

export async function info(tokenAddress: Address, chain?: Chain) {
  const contract = getContract(tokenAddress, chain);
  const tokenSymbol = contract.symbol();
  const tokenDecimals = contract.decimals();
  return {
    output: {
      symbol: await tokenSymbol,
      decimals: Number(await tokenDecimals),
    },
  };
}
export async function symbol(tokenAddress: Address, chain?: Chain) {
  return {
    output: await getContract(tokenAddress, chain).symbol(),
  };
}
export async function decimals(tokenAddress: Address, chain?: Chain) {
  return {
    output: Number(await getContract(tokenAddress, chain).decimals()),
  };
}
export async function totalSupply(params: {
  target: Address;
  block?: number;
  decimals?: number;
  chain?: Chain;
}) {
  const contract = getContract(params.target, params.chain);
  const supply: string = await contract.totalSupply({
    blockTag: params.block,
  });
  return {
    output: handleDecimals(supply, params.decimals),
  };
}

export async function balanceOf(params: {
  target: Address;
  owner: Address;
  block?: number;
  decimals?: number;
  chain?: Chain;
}) {
  const balance: string = await getContract(
    params.target,
    params.chain
  ).balanceOf(params.owner, {
    blockTag: params.block,
  });
  return {
    output: handleDecimals(balance, params.decimals),
  };
}
