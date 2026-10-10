import { getMedianBlockValue } from './LlamaProvider'

describe('getMedianBlockValue', () => {
  it.each<[number[], number]>([
    [[10], 10],
    [[10, 20], 15],
    [[10, 20, 30], 20],
    [[10, 20, 30, 40], 25],
    [[10, 20, 30, 40, 50], 30],
  ])('returns the median of %j', (blocks, median) => {
    expect(getMedianBlockValue(blocks)).toBe(median)
  })
})
