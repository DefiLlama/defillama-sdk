import {humanizeNumber} from './humanizeNumber'

describe('humanizeNumber', () => {
  it('should humanize numbers correctly', () => {
    expect(humanizeNumber(1500)).toBe('1.50 k')
    expect(humanizeNumber(2500000)).toBe('2.50 M')
    expect(humanizeNumber(4300000000)).toBe('4.30 B')
    expect(humanizeNumber(720)).toBe('720.00')
    expect(humanizeNumber(-1500)).toBe('-1.50 k')
    expect(humanizeNumber(-2500000)).toBe('-2.50 M')
    expect(humanizeNumber(-4300000000)).toBe('-4.30 B')
    expect(humanizeNumber(-720)).toBe('-720.00')
    expect(humanizeNumber(1500000000000)).toBe('1.50 T')
    expect(humanizeNumber(-1500000000000)).toBe('-1.50 T')
    expect(humanizeNumber(-0)).toBe('0.00')
    expect(humanizeNumber(0)).toBe('0.00')
    expect(humanizeNumber(0.1234)).toBe('0.12')
    expect(humanizeNumber(-0.1234)).toBe('-0.12')
    expect(humanizeNumber(1)).toBe('1.00')
    expect(humanizeNumber(1.00034)).toBe('1.00')
    expect(humanizeNumber(141.00034)).toBe('141.00')
    expect(humanizeNumber(-1)).toBe('-1.00')
  })
})