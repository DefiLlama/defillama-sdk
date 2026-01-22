import {
  chainKeyToChainLabelMap,
  chainLabelsToKeyMap,
  sluggifyString,
  getChainKeyFromLabel,
  getChainLabelFromKey,
  updateData,
} from './index'

// Mock fs and fetch for updateData tests
jest.mock('fs')

describe('chainUtils', () => {
  describe('chainKeyToChainLabelMap', () => {
    test('is an object with chain mappings', () => {
      expect(typeof chainKeyToChainLabelMap).toBe('object')
      expect(chainKeyToChainLabelMap).not.toBeNull()
    })

    test('contains expected chain mappings', () => {
      expect((chainKeyToChainLabelMap as any)['ethereum']).toBe('Ethereum')
      expect((chainKeyToChainLabelMap as any)['bsc']).toBe('BSC')
      expect((chainKeyToChainLabelMap as any)['arbitrum']).toBe('Arbitrum')
      expect((chainKeyToChainLabelMap as any)['avax']).toBe('Avalanche')
    })
  })

  describe('chainLabelsToKeyMap', () => {
    test('is an object with chain mappings', () => {
      expect(typeof chainLabelsToKeyMap).toBe('object')
      expect(chainLabelsToKeyMap).not.toBeNull()
    })

    test('contains expected label to key mappings', () => {
      expect((chainLabelsToKeyMap as any)['Ethereum']).toBe('ethereum')
      expect((chainLabelsToKeyMap as any)['BSC']).toBe('bsc')
      expect((chainLabelsToKeyMap as any)['Arbitrum']).toBe('arbitrum')
      expect((chainLabelsToKeyMap as any)['Avalanche']).toBe('avax')
    })
  })

  describe('sluggifyString', () => {
    test('converts string to lowercase', () => {
      expect(sluggifyString('HELLO')).toBe('hello')
      expect(sluggifyString('HeLLo WoRLD')).toBe('hello-world')
    })

    test('replaces spaces with hyphens', () => {
      expect(sluggifyString('hello world')).toBe('hello-world')
      expect(sluggifyString('one two three')).toBe('one-two-three')
    })

    test('removes apostrophes', () => {
      expect(sluggifyString("it's")).toBe('its')
      expect(sluggifyString("don't stop")).toBe('dont-stop')
    })

    test('handles combined transformations', () => {
      expect(sluggifyString("Hello World's Test")).toBe('hello-worlds-test')
      expect(sluggifyString("It's A Beautiful Day")).toBe('its-a-beautiful-day')
    })

    test('handles empty string', () => {
      expect(sluggifyString('')).toBe('')
    })

    test('handles string with only spaces', () => {
      // 3 spaces split into 4 empty strings, joined with hyphens = 3 hyphens
      expect(sluggifyString('   ')).toBe('---')
    })

    test('handles already sluggified strings', () => {
      expect(sluggifyString('already-sluggified')).toBe('already-sluggified')
    })
  })

  describe('getChainKeyFromLabel', () => {
    test('returns key for known labels', () => {
      expect(getChainKeyFromLabel('Ethereum')).toBe('ethereum')
      expect(getChainKeyFromLabel('BSC')).toBe('bsc')
      expect(getChainKeyFromLabel('Arbitrum')).toBe('arbitrum')
    })

    test('returns key for sluggified labels', () => {
      // Labels that match when sluggified
      expect(getChainKeyFromLabel('ethereum')).toBe('ethereum')
    })

    test('handles labels with spaces', () => {
      // "Arbitrum Nova" should map to "arbitrum_nova"
      expect(getChainKeyFromLabel('Arbitrum Nova')).toBe('arbitrum_nova')
    })

    test('converts unknown labels to sluggified form with underscores', () => {
      // Unknown labels get sluggified and - replaced with _
      const result = getChainKeyFromLabel('Unknown Chain Name')
      expect(result).toBe('unknown_chain_name')
    })

    test('caches results for repeated lookups', () => {
      const label = 'TestCacheLabel' + Date.now()
      const firstResult = getChainKeyFromLabel(label)
      const secondResult = getChainKeyFromLabel(label)
      expect(firstResult).toBe(secondResult)
    })

    test('handles different case variations of the same label', () => {
      // All should resolve to the same key for known chains
      expect(getChainKeyFromLabel('ETHEREUM')).toBe('ethereum')
      expect(getChainKeyFromLabel('Ethereum')).toBe('ethereum')
      expect(getChainKeyFromLabel('ethereum')).toBe('ethereum')
    })

    test('handles labels with apostrophes', () => {
      const result = getChainKeyFromLabel("Chain's Name")
      expect(result).toBe('chains_name')
    })

    test('handles labels with multiple consecutive spaces', () => {
      const result = getChainKeyFromLabel('Chain  Name')
      expect(result).toBe('chain__name')
    })

    test('handles labels with hyphens', () => {
      const result = getChainKeyFromLabel('Chain-Name')
      expect(result).toBe('chain_name')
    })

    test('handles mixed special characters', () => {
      const result = getChainKeyFromLabel("It's A Test-Chain")
      expect(result).toBe('its_a_test_chain')
    })

    test('handles labels with leading/trailing spaces', () => {
      const result = getChainKeyFromLabel(' Chain Name ')
      expect(result).toBe('_chain_name_')
    })

    test('returns same key for label and its sluggified version', () => {
      const timestamp = Date.now()
      const label = `Test Chain ${timestamp}`
      const sluggified = `test-chain-${timestamp}`

      const resultFromLabel = getChainKeyFromLabel(label)
      const resultFromSluggified = getChainKeyFromLabel(sluggified)

      expect(resultFromLabel).toBe(resultFromSluggified)
    })

    test('handles numeric labels', () => {
      const result = getChainKeyFromLabel('Chain 123')
      expect(result).toBe('chain_123')
    })

    test('handles label that is already a valid key format', () => {
      const result = getChainKeyFromLabel('already_valid_key')
      expect(result).toBe('already_valid_key')
    })

    test('handles real chain labels with spaces', () => {
      expect(getChainKeyFromLabel('Polygon zkEVM')).toBe('polygon_zkevm')
      expect(getChainKeyFromLabel('Arbitrum Nova')).toBe('arbitrum_nova')
      expect(getChainKeyFromLabel('Astar zkEVM')).toBe('astrzk')
    })

    test('handles empty string', () => {
      const result = getChainKeyFromLabel('')
      expect(result).toBe('')
    })
  })

  describe('getChainLabelFromKey', () => {
    test('returns label for known keys', () => {
      expect(getChainLabelFromKey('ethereum')).toBe('Ethereum')
      expect(getChainLabelFromKey('bsc')).toBe('BSC')
      expect(getChainLabelFromKey('avax')).toBe('Avalanche')
    })

    test('capitalizes first letter for unknown keys', () => {
      const unknownKey = 'unknownchain' + Date.now()
      const result = getChainLabelFromKey(unknownKey)
      expect(result.charAt(0)).toBe(unknownKey.charAt(0).toUpperCase())
      expect(result.slice(1)).toBe(unknownKey.slice(1))
    })

    test('caches results for repeated lookups', () => {
      const key = 'testcachekey' + Date.now()
      const firstResult = getChainLabelFromKey(key)
      const secondResult = getChainLabelFromKey(key)
      expect(firstResult).toBe(secondResult)
    })

    test('handles single character key', () => {
      const result = getChainLabelFromKey('x')
      expect(result).toBe('X')
    })

    test('handles empty string', () => {
      const result = getChainLabelFromKey('')
      expect(result).toBe('')
    })

    test('handles keys with underscores', () => {
      // For unknown keys, underscores are preserved, only first letter capitalized
      const timestamp = Date.now()
      const result = getChainLabelFromKey(`test_chain_${timestamp}`)
      expect(result).toBe(`Test_chain_${timestamp}`)
    })

    test('handles keys that start with uppercase', () => {
      const timestamp = Date.now()
      const result = getChainLabelFromKey(`Alreadycaps${timestamp}`)
      expect(result).toBe(`Alreadycaps${timestamp}`)
    })

    test('handles keys with numbers', () => {
      const result = getChainLabelFromKey('chain123')
      expect(result).toBe('Chain123')
    })

    test('handles keys starting with numbers', () => {
      const result = getChainLabelFromKey('123chain')
      expect(result).toBe('123chain')
    })

    test('handles keys with mixed case', () => {
      const timestamp = Date.now()
      const result = getChainLabelFromKey(`testMixedCase${timestamp}`)
      expect(result).toBe(`TestMixedCase${timestamp}`)
    })

    test('handles real chain keys with underscores', () => {
      expect(getChainLabelFromKey('arbitrum_nova')).toBe('Arbitrum Nova')
      expect(getChainLabelFromKey('polygon_zkevm')).toBe('Polygon zkEVM')
    })

    test('caches unknown keys in chainKeyToChainLabelMap', () => {
      const timestamp = Date.now()
      const key = `cachedkey${timestamp}`

      // First call should create the cache entry
      const result = getChainLabelFromKey(key)
      expect(result).toBe(`Cachedkey${timestamp}`)

      // Verify it's cached by checking if subsequent call returns same value
      const cachedResult = getChainLabelFromKey(key)
      expect(cachedResult).toBe(result)
    })

    test('handles keys with hyphens', () => {
      const timestamp = Date.now()
      const result = getChainLabelFromKey(`test-chain-${timestamp}`)
      expect(result).toBe(`Test-chain-${timestamp}`)
    })

    test('handles keys with special characters', () => {
      const timestamp = Date.now()
      const result = getChainLabelFromKey(`test.chain.${timestamp}`)
      expect(result).toBe(`Test.chain.${timestamp}`)
    })

    test('returns consistent results for all known chains', () => {
      // Test a variety of known chains
      const knownChains = ['ethereum', 'bsc', 'polygon', 'arbitrum', 'optimism', 'avax', 'fantom', 'base']
      for (const chain of knownChains) {
        const label = getChainLabelFromKey(chain)
        expect(typeof label).toBe('string')
        expect(label.length).toBeGreaterThan(0)
      }
    })

    test('handles two-character keys', () => {
      const result = getChainLabelFromKey('ab')
      expect(result).toBe('Ab')
    })

    test('unknown key label starts with uppercase version of first char', () => {
      const timestamp = Date.now()
      const testCases = [
        { key: `achain${timestamp}`, expectedStart: 'A' },
        { key: `zchain${timestamp}`, expectedStart: 'Z' },
        { key: `mchain${timestamp}`, expectedStart: 'M' },
      ]

      for (const { key, expectedStart } of testCases) {
        const result = getChainLabelFromKey(key)
        expect(result.charAt(0)).toBe(expectedStart)
      }
    })
  })

  describe('updateData', () => {
    const originalFetch = global.fetch
    const fs = require('fs')

    beforeEach(() => {
      jest.clearAllMocks()
    })

    afterEach(() => {
      global.fetch = originalFetch
    })

    test('fetches and updates chain data', async () => {
      const mockData = {
        chainKeyToChainLabelMap: {
          'newchain': 'New Chain'
        },
        chainLabelsToKeyMap: {
          'New Chain': 'newchain'
        }
      }

      global.fetch = jest.fn().mockResolvedValue({
        json: jest.fn().mockResolvedValue(mockData)
      })

      fs.writeFileSync = jest.fn()

      await updateData()

      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.llama.fi/overview/_internal/chain-name-id-map-v2'
      )
      expect(fs.writeFileSync).toHaveBeenCalled()
    })

    test('handles fetch errors gracefully', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      global.fetch = jest.fn().mockRejectedValue(new Error('Network error'))

      await updateData()

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error updating chain data:',
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })

    test('handles json parsing errors gracefully', async () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation()

      global.fetch = jest.fn().mockResolvedValue({
        json: jest.fn().mockRejectedValue(new Error('Invalid JSON'))
      })

      await updateData()

      expect(consoleErrorSpy).toHaveBeenCalledWith(
        'Error updating chain data:',
        expect.any(Error)
      )

      consoleErrorSpy.mockRestore()
    })
  })
})
