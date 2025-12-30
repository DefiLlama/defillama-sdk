
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
  abi?: string | any;
  abis?: string[];
  block?: Block;
  params?: CallParams;
  chain?: Chain | string;
  withMetadata?: boolean;
  skipCache?: boolean;
  logArray?: LogArray;
  permitFailure?: boolean;
  field?: string;
}
export type Chain = string

export type MulticallOptions = {
  abi?: string | any;
  abis?: string[];
  calls: CallsParams[] | (string | number)[];
  block?: Block;
  target?: Address; // Used when calls.target is not provided
  chain?: Chain | string;
  requery?: boolean;
  withMetadata?: boolean;
  skipCache?: boolean;
  permitFailure?: boolean;
  excludeFailed?: boolean;
  logArray?: LogArray;
  field?: string;
}

export type FetchListOptions = {
  lengthAbi?: string | any;
  itemAbi: string | any;
  itemAbi2?: string | any;
  block?: Block;
  startFrom?: number;
  target?: Address;
  calls?: Address[];
  targets?: Address[];
  chain?: Chain | string;
  withMetadata?: boolean;
  startFromOne?: boolean;
  itemCount?: number;
  permitFailure?: boolean;
  logArray?: LogArray;
  groupedByInput?: boolean;
  excludeFailed?: boolean;
  field?: string;
  field2?: string;
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

export type LogArray = {
  token: Address;
  holder: Address;
  chain: Chain;
  amount: any
}[]
