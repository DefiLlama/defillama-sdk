
import { Chain } from "./general";

export type Address = string;
export type StringNumber = string;
export type Block = number | string;
export type Balances = {
  [address: string]: StringNumber | number;
};


type CallParams = string | number | (string | number)[] | undefined;
export type CallsParams = {
  target?: Address;
  params?: CallParams;
};


export type CallOptions = {
  target: Address;
  abi: string | any;
  block?: Block;
  params?: CallParams;
  chain?: Chain | string;
  withMetadata?: boolean;
  skipCache?: boolean;
  logArray?: {
    target: Address;
    params?: CallParams;
  }[];
}

export type MulticallOptions = {
  abi: string | any;
  calls: CallsParams[] | (string | number)[];
  block?: Block;
  target?: Address; // Used when calls.target is not provided
  chain?: Chain | string;
  requery?: boolean;
  withMetadata?: boolean;
  skipCache?: boolean;
  permitFailure?: boolean;
  logArray?: {
    target: Address;
    params?: CallParams;
  }[];
}

export type FetchListOptions = {
  lengthAbi?: string | any;
  itemAbi: string | any;
  block?: Block;
  startFrom?: number;
  target: Address;
  chain?: Chain | string;
  withMetadata?: boolean;
  startFromOne?: boolean;
  itemCount?: number;
  permitFailure?: boolean;
  logArray?: {
    target: Address;
    params?: CallParams;
  }[];
}

export type ByteCodeCallOptions = {
  bytecode: string;
  inputTypes: string[];
  inputs: any[];
  block?: number | string;
  chain?: Chain | string;
  outputTypes: string[];
  withMetadata?: boolean;
}
