import { Address } from "../types";
import { ethers, BigNumber } from "ethers";
import { provider, handleDecimals } from "../general";

const abi = [
  "function balanceOf(address owner) view returns (uint256)",
  "function totalSupply() view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
];

function getContract(address: Address) {
  return new ethers.Contract(address, abi, provider);
}

export async function info(tokenAddress: Address) {
  const contract = getContract(tokenAddress);
  const tokenSymbol = contract.symbol();
  const tokenDecimals = contract.decimals();
  return {
    output: {
      symbol: await tokenSymbol,
      decimals: await tokenDecimals,
    },
  };
}
export async function symbol(tokenAddress: Address) {
  return {
    output: await getContract(tokenAddress).symbol(),
  };
}
export async function decimals(tokenAddress: Address) {
  return {
    output: await getContract(tokenAddress).decimals(),
  };
}
export async function totalSupply(params: {
  target: Address;
  block?: number;
  decimals?: number;
}) {
  const contract = getContract(params.target);
  const supply: BigNumber = await contract.totalSupply({
    blockTag: params.block ?? "latest",
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
}) {
  const balance: BigNumber = await getContract(params.target).balanceOf(
    params.owner,
    {
      blockTag: params.block ?? "latest",
    }
  );
  return {
    output: handleDecimals(balance, params.decimals),
  };
}

/*
 erc20: {
      info: (target) => erc20('info', { target }),
      symbol: (target) => erc20('symbol', { target }),
      decimals: (target) => erc20('decimals', { target }),
      totalSupply: (options) => erc20('totalSupply', { ...options }),
      balanceOf: (options) => erc20('balanceOf', { ...options }),
    }
*/
