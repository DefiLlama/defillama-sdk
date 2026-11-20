// permitFailure covers calls the contract rejects, never the rpc: an rpc that cannot execute a call must throw.
// No network: every chain here uses a fake provider.
import { ethers } from 'ethers'
import { multiCall } from './index'
import * as abi2 from './abi2'
import { setProvider } from '../general'
import { isContractRevert } from './rpcCall'

const tokenA = '0x00000000000000000000000000000000000000aa'
const tokenB = '0x00000000000000000000000000000000000000bb'
const tokenC = '0x00000000000000000000000000000000000000cc'
const calls = [{ target: tokenA }, { target: tokenB }, { target: tokenC }]

const coder = ethers.AbiCoder.defaultAbiCoder()
const tryAggregate = new ethers.Interface(['function tryAggregate(bool requireSuccess, tuple(address target, bytes callData)[] calls) payable returns (tuple(bool success, bytes returnData)[] returnData)'])
const encodedSymbol = (symbol: string) => coder.encode(['string'], [symbol])

const revert = () => ({ llamaRPCError: true, method: 'call', errors: [{ host: 'a', error: 'execution reverted', jsonRpcError: true }] })
const rpcDown = () => ({ llamaRPCError: true, method: 'call', errors: [{ host: 'a', error: 'timeout of 30000ms exceeded', jsonRpcError: false }] })

// answers a multicall3 tryAggregate: `answer(target)` returns the symbol, or null for a call that reverts
function multicall3Provider(answer: (target: string) => string | null, options: { maxBatch?: number } = {}) {
  const batchSizes: number[] = []
  const provider: any = {
    call: jest.fn(async ({ data }: any) => {
      const [, batch] = tryAggregate.decodeFunctionData('tryAggregate', data)
      batchSizes.push(batch.length)
      if (options.maxBatch && batch.length > options.maxBatch) throw rpcDown()
      const results = batch.map((item: any) => {
        const symbol = answer(item.target.toLowerCase())
        return symbol === null ? [false, '0x'] : [true, encodedSymbol(symbol)]
      })
      return tryAggregate.encodeFunctionResult('tryAggregate', [results])
    }),
  }
  return { provider, batchSizes }
}

const symbols: { [target: string]: string | null } = { [tokenA]: 'AAA', [tokenB]: null, [tokenC]: 'CCC' }

describe('multicall3 path', () => {
  const chain = 'ethereum'

  test('a reverting call is null with permitFailure, and fails the multicall without it', async () => {
    setProvider(chain, multicall3Provider(target => symbols[target]).provider)
    const res = await multiCall({ chain, abi: 'erc20:symbol', calls, permitFailure: true })
    expect(res.output.map((i: any) => [i.success, i.output])).toEqual([[true, 'AAA'], [false, null], [true, 'CCC']])
    await expect(multiCall({ chain, abi: 'erc20:symbol', calls })).rejects.toThrow('Multicall failed!')
  })

  test('an rpc failure throws with and without permitFailure', async () => {
    setProvider(chain, { call: jest.fn(async () => { throw rpcDown() }) } as any)
    await expect(multiCall({ chain, abi: 'erc20:symbol', calls, permitFailure: true })).rejects.toThrow('Promise pool failed!')
    await expect(multiCall({ chain, abi: 'erc20:symbol', calls })).rejects.toThrow('Promise pool failed!')
  })

  test('a batch the rpc cannot execute is halved until it can, results keep their order', async () => {
    const { provider, batchSizes } = multicall3Provider(target => symbols[target], { maxBatch: 1 })
    setProvider(chain, provider)
    const res = await multiCall({ chain, abi: 'erc20:symbol', calls, permitFailure: true })
    expect(res.output.map((i: any) => i.output)).toEqual(['AAA', null, 'CCC'])
    expect(res.output.map((i: any) => i.input.target)).toEqual([tokenA, tokenB, tokenC])
    expect(Math.max(...batchSizes)).toBe(3)
    expect(batchSizes.filter(i => i === 1).length).toBe(3)
  })
})

describe('legacy path (chain without multicall)', () => {
  const chain = 'rpc_failure_test_chain_without_multicall'
  const symbolSelector = new ethers.Interface(['function symbol() view returns (string)']).encodeFunctionData('symbol')

  function singleCallProvider(answer: (target: string) => Promise<string>) {
    return {
      getNetwork: async () => ({ chainId: 999999001 }),
      call: jest.fn(async ({ to, data }: any) => {
        expect(data).toBe(symbolSelector)
        return answer(to.toLowerCase())
      }),
    } as any
  }

  test('a reverting call is null with permitFailure', async () => {
    setProvider(chain, singleCallProvider(async target => {
      if (symbols[target] === null) throw revert()
      return encodedSymbol(symbols[target] as string)
    }))
    const res = await multiCall({ chain, abi: 'erc20:symbol', calls, permitFailure: true })
    expect(res.output.map((i: any) => [i.success, i.output])).toEqual([[true, 'AAA'], [false, null], [true, 'CCC']])
  })

  test('an rpc failure throws with and without permitFailure', async () => {
    setProvider(chain, singleCallProvider(async target => {
      if (symbols[target] === null) throw rpcDown()
      return encodedSymbol(symbols[target] as string)
    }))
    await expect(multiCall({ chain, abi: 'erc20:symbol', calls, permitFailure: true })).rejects.toThrow('Promise pool failed!')
    await expect(multiCall({ chain, abi: 'erc20:symbol', calls })).rejects.toThrow('Promise pool failed!')
  })
})

describe('single call with permitFailure (api.call)', () => {
  const chain = 'rpc_failure_test_chain_single_call'

  test('a revert and an undecodable result are null, an rpc failure throws', async () => {
    const call = jest.fn()
    setProvider(chain, { call } as any)

    call.mockRejectedValue(revert())
    await expect(abi2.call({ chain, target: tokenA, abi: 'erc20:symbol', permitFailure: true })).resolves.toBeNull()
    call.mockResolvedValue('0x')
    await expect(abi2.call({ chain, target: tokenA, abi: 'erc20:symbol', permitFailure: true })).resolves.toBeNull()
    call.mockRejectedValue(rpcDown())
    await expect(abi2.call({ chain, target: tokenA, abi: 'erc20:symbol', permitFailure: true })).rejects.toMatchObject({ isRpcFailure: true })
  })

  test('an invalid target is still null with permitFailure', async () => {
    await expect(abi2.call({ chain, target: 'not an address', abi: 'erc20:symbol', permitFailure: true })).resolves.toBeNull()
  })
})

test('isContractRevert: only an EVM rejection reported by a node counts', () => {
  expect(isContractRevert(revert())).toBe(true)
  expect(isContractRevert({ llamaRPCError: true, errors: [{ host: 'a', error: 'timeout', jsonRpcError: false }, { host: 'b', error: 'execution reverted: 0x', jsonRpcError: true }] })).toBe(true)
  expect(isContractRevert(rpcDown())).toBe(false)
  expect(isContractRevert({ llamaRPCError: true, errors: [{ host: 'a', error: 'rate limit exceeded', jsonRpcError: true }] })).toBe(false)
  // a transport error whose text happens to mention a revert is not a node answer
  expect(isContractRevert({ llamaRPCError: true, errors: [{ host: 'a', error: 'execution reverted', jsonRpcError: false }] })).toBe(false)
  expect(isContractRevert({ code: 'CALL_EXCEPTION' })).toBe(true)
  expect(isContractRevert(new Error('rpc is down'))).toBe(false)
  expect(isContractRevert(undefined)).toBe(false)
})
