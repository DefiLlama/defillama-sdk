import axios from 'axios'
import { JsonRpcProvider } from 'ethers'
import { LlamaProvider } from './LlamaProvider'

describe('LlamaProvider getLogs runner selection', () => {
  const originalSkipRpcCheck = process.env.SKIP_RPC_CHECK

  beforeAll(() => {
    process.env.SKIP_RPC_CHECK = 'true'
  })

  afterEach(() => {
    jest.restoreAllMocks()
  })

  afterAll(() => {
    if (originalSkipRpcCheck === undefined) delete process.env.SKIP_RPC_CHECK
    else process.env.SKIP_RPC_CHECK = originalSkipRpcCheck
  })

  test('tries each RPC once and does not re-add llamarpc for getLogs', async () => {
    const urls = [
      'https://llamarpc.com',
      ...Array.from({ length: 8 }, (_, i) => `https://rpc${i}.example`),
    ]
    const provider = new LlamaProvider({
      providers: urls.map(url => ({ url, provider: new JsonRpcProvider(url) })),
      archivalRPCs: [],
      chainId: 1,
      chainName: 'ethereum',
    }, { cacheTimeout: 5_000, quorum: 1, eventQuorum: 1 })
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('rpc down'))

    await expect(provider._performAction('getLogs', [{
      fromBlock: 1,
      toBlock: 2,
      address: '0x0000000000000000000000000000000000000000',
      topics: [],
    }], 100)).rejects.toMatchObject({ llamaRPCError: true })

    const called = post.mock.calls.map(([url]) => url)
    expect(called).toHaveLength(8)
    expect(new Set(called).size).toBe(called.length)
    expect(called).not.toContain('https://llamarpc.com')
  })

  test('tries the first archival RPC before other getLogs runners', async () => {
    const archivalURL = 'https://archive.example'
    const provider = new LlamaProvider({
      providers: ['https://rpc1.example', 'https://rpc2.example'].map(url => ({
        url,
        provider: new JsonRpcProvider(url),
      })),
      archivalRPCs: [{ url: archivalURL, provider: new JsonRpcProvider(archivalURL) }],
      chainId: 1,
      chainName: 'ethereum',
    }, { cacheTimeout: 5_000, quorum: 1, eventQuorum: 1 })
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('rpc down'))

    await expect(provider._performAction('getLogs', [{
      fromBlock: 1,
      toBlock: 2,
      address: '0x0000000000000000000000000000000000000000',
      topics: [],
    }], 1)).rejects.toMatchObject({ llamaRPCError: true })

    expect(post).toHaveBeenCalledTimes(1)
    expect(post.mock.calls[0][0]).toBe(archivalURL)
  })

  test('calls each distinct URL once when the regular RPC list repeats an entry', async () => {
    const provider = new LlamaProvider({
      providers: ['https://rpc1.example', 'https://rpc1.example', 'https://rpc2.example'].map(url => ({
        url,
        provider: new JsonRpcProvider(url),
      })),
      archivalRPCs: [],
      chainId: 1,
      chainName: 'ethereum',
    }, { cacheTimeout: 5_000, quorum: 1, eventQuorum: 1 })
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('rpc down'))

    await expect(provider._performAction('getLogs', [{
      fromBlock: 1,
      toBlock: 2,
      address: '0x0000000000000000000000000000000000000000',
      topics: [],
    }], 100)).rejects.toMatchObject({ llamaRPCError: true })

    expect(post.mock.calls.map(([url]) => url)).toEqual(['https://rpc1.example', 'https://rpc2.example'])
  })

  test('calls a URL once when it is both an archival and a regular RPC', async () => {
    const shared = 'https://shared.example'
    const provider = new LlamaProvider({
      providers: [shared, 'https://rpc2.example'].map(url => ({
        url,
        provider: new JsonRpcProvider(url),
      })),
      archivalRPCs: [{ url: shared, provider: new JsonRpcProvider(shared) }],
      chainId: 1,
      chainName: 'ethereum',
    }, { cacheTimeout: 5_000, quorum: 1, eventQuorum: 1 })
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('rpc down'))

    await expect(provider._performAction('getLogs', [{
      fromBlock: 1,
      toBlock: 2,
      address: '0x0000000000000000000000000000000000000000',
      topics: [],
    }], 100)).rejects.toMatchObject({ llamaRPCError: true })

    const called = post.mock.calls.map(([url]) => url)
    expect(called).toEqual([shared, 'https://rpc2.example'])
  })

  test('stops at the production seven attempts', async () => {
    const urls = Array.from({ length: 10 }, (_, i) => `https://rpc${i}.example`)
    const provider = new LlamaProvider({
      providers: urls.map(url => ({ url, provider: new JsonRpcProvider(url) })),
      archivalRPCs: [],
      chainId: 1,
      chainName: 'ethereum',
    }, { cacheTimeout: 5_000, quorum: 1, eventQuorum: 1 })
    const post = jest.spyOn(axios, 'post').mockRejectedValue(new Error('rpc down'))

    await expect(provider.getLogs({
      fromBlock: 1,
      toBlock: 2,
      address: '0x0000000000000000000000000000000000000000',
      topics: [],
    })).rejects.toMatchObject({ llamaRPCError: true })

    const called = post.mock.calls.map(([url]) => url)
    expect(called).toHaveLength(7)
    expect(new Set(called).size).toBe(7)
  })
})
