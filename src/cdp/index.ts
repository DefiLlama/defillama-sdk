import { Address } from "../types";
import {gql, request} from 'graphql-request'
import {ETHER_ADDRESS, e18} from '../general'
import {BigNumber} from 'ethers'

async function compound(params: {
  targets: Address[];
  block?: number;
}) {
  // This is not an exact copy of the SDK function since we are coalescing everything into ETH, but the total TVL should be the same
  let totalCollateralValueInEth = 0
  const queries = []
  for(let i = 0; i<params.targets.length; i+=1000){
    const addresses = params.targets.slice(i, i+1000)
    const query = gql`
    {
      accounts(where:{
        id_in:[${addresses.map(addr=>`"${addr.toLowerCase()}"`).join(',')}]
      }) {
        id
        totalCollateralValueInEth
        tokens{
          symbol
          supplyBalanceUnderlying
        }
      }
    }
    `
    const req = await request('https://api.thegraph.com/subgraphs/name/graphprotocol/compound-v2', query).then((data) => data.accounts.forEach(
      (account:any)=>{
        totalCollateralValueInEth += Number(account.totalCollateralValueInEth)
      }
    ))
    queries.push(req)
  }
  await Promise.all(queries);
  return {
    [ETHER_ADDRESS]: BigNumber.from(totalCollateralValueInEth).mul(e18)
  }
}


export async function getAllAssetsLocked(params: {
  targets: Address[];
  block?: number;
}) {

}

export async function maker(params: {
  targets: Address[];
  block?: number;
}) {

}

export async function aave(params: {
  targets: Address[];
  block?: number;
}) {

}

export default {
  getAssetsLocked:getAllAssetsLocked,
  compound:{
    getAssetsLocked:compound
  },
  aave:{
    getAssetsLocked:aave
  },
  maker:{
    getAssetsLocked:maker
  },
}

/*
cdp: {
      getAssetsLocked: (options) => cdp('getAssetsLocked', { ...options, chunk: {param: 'targets', length: 1000, combine: 'balances'} }),
      maker: {
        tokens: (options) => maker('tokens', { ...options }),
        getAssetsLocked: (options) => maker('getAssetsLocked', { ...options, chunk: {param: 'targets', length: 3000, combine: 'balances'} })
      },
      compound: {
        tokens: (options) => compound('tokens', { ...options }),
        getAssetsLocked: (options) => compound('getAssetsLocked', { ...options, chunk: {param: 'targets', length: 1000, combine: 'balances'} })
      }
    },
    */
