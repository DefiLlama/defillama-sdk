import axios from 'axios'
import { JsonRpcProvider } from 'ethers'
import { LlamaProvider } from './LlamaProvider'

type Blocks = Record<string, number>

async function createProvider(blocks: Blocks) {
  process.env.SKIP_RPC_CHECK = 'false'
  jest.spyOn(axios, 'post').mockImplementation(async (url: any) => {
    const block = blocks[String(url)]
    if (block === undefined) throw new Error(`unexpected RPC ${url}`)
    return { data: { result: `0x${block.toString(16)}` } } as any
  })

  const provider = new LlamaProvider({
    providers: Object.keys(blocks).map(url => ({ url, provider: new JsonRpcProvider(url) })),
    archivalRPCs: [],
    chainId: 1,
    chainName: 'ethereum',
  }, { cacheTimeout: 5_000, quorum: 1, eventQuorum: 1 })

  await (provider as any)._isReady
  return provider
}

describe('LlamaProvider RPC sync check', () => {
  const originalSkipRpcCheck = process.env.SKIP_RPC_CHECK

  afterEach(() => {
    jest.restoreAllMocks()
    if (originalSkipRpcCheck === undefined) delete process.env.SKIP_RPC_CHECK
    else process.env.SKIP_RPC_CHECK = originalSkipRpcCheck
  })

  test('removes a lagging RPC when there are five RPCs', async () => {
    const provider = await createProvider({
      'https://a.example': 1000,
      'https://b.example': 1500,
      'https://c.example': 2500,
      'https://d.example': 2500,
      'https://e.example': 6000,
    })

    expect(provider.rpcs.map(i => i.url)).not.toContain('https://a.example')
    expect(provider.rpcs).toHaveLength(4)
  })

  test('removes a lagging RPC when there are four RPCs', async () => {
    const provider = await createProvider({
      'https://a.example': 1000,
      'https://b.example': 1500,
      'https://c.example': 3000,
      'https://d.example': 6000,
    })

    expect(provider.rpcs.map(i => i.url)).not.toContain('https://a.example')
    expect(provider.rpcs).toHaveLength(3)
  })

  test('removes a lagging RPC when there are two RPCs', async () => {
    const provider = await createProvider({
      'https://a.example': 1000,
      'https://b.example': 5000,
    })

    expect(provider.rpcs.map(i => i.url)).not.toContain('https://a.example')
    expect(provider.rpcs).toHaveLength(1)
  })
})
