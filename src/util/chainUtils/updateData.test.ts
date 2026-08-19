import fs from 'fs'
import { updateData } from './index'

// A label that only exists in the remote label map, not in the shipped data.json. This is the
// shape that matters: api.llama.fi/config names a chain, and the key it maps to is only learned
// in the same updateData run that reads the config.
const REMOTE_LABEL = 'Zzz Test Chain'
const REMOTE_KEY = 'zzztc'

function mockResponses() {
  return jest.spyOn(global as any, 'fetch').mockImplementation((url: any) => {
    if (String(url).includes('chain-name-id-map-v2'))
      return Promise.resolve({
        json: async () => ({
          chainKeyToChainLabelMap: { [REMOTE_KEY]: REMOTE_LABEL },
          chainLabelsToKeyMap: { [REMOTE_LABEL]: REMOTE_KEY },
        }),
      } as any)

    return Promise.resolve({
      json: async () => ({
        chainCoingeckoIds: { [REMOTE_LABEL]: { deadFrom: '2026-08-19' } },
      }),
    } as any)
  })
}

test('updateData records deadFrom under the key the label maps to, not a sluggified fallback', async () => {
  const fetchSpy = mockResponses()
  let written: any
  const writeSpy = jest
    .spyOn(fs, 'writeFileSync')
    .mockImplementation(((_path: any, data: any) => {
      written = JSON.parse(data)
    }) as any)

  try {
    await updateData()
  } finally {
    writeSpy.mockRestore()
    fetchSpy.mockRestore()
  }

  expect(written).toBeDefined()
  expect(written.deadChains[REMOTE_KEY]).toBe('2026-08-19')
  // the fallback getChainKeyFromLabel produces for an unknown label, which is a key no chain uses
  expect(written.deadChains['zzz_test_chain']).toBeUndefined()
})
