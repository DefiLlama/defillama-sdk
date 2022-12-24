import { Block, CallOptions, MulticallOptions, FetchListOptions, } from "./types";
import { Chain, getProvider,  } from "./general";
import{ call, multiCall, fetchList } from './abi/abi2'
import{ getBlock } from './computeTVL/blocks'
import { ethers, } from "ethers";

import { debugLog } from "./util/debugLog";

export class ChainApi {
  block?: Block;
  chain?: Chain | string;
  timestamp?: number;
  provider: ethers.providers.BaseProvider;
 
  constructor(params: {
    block?: Block;
    chain?: Chain | string;
    timestamp?: number;
  }) {
    this.block = params.block
    this.chain = params.chain ?? 'ethereum'
    this.timestamp = params.timestamp
    this.provider = getProvider(this.chain as Chain)
  }

  call(params: CallOptions) {
    return call({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  multiCall(params: MulticallOptions) {
    return multiCall({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  fetchList(params: FetchListOptions) {
    return fetchList({
      ...params,
      block: this.block,
      chain: this.chain,
    })
  }

  async getBlock(): Promise<number> {
    if (!this.block) this.block = (await getBlock(this.chain as Chain, this.timestamp)).block
    return this.block as number
  }
}

export default ChainApi