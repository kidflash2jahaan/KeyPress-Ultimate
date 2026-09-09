import { describe, expect, it } from 'vitest'
import { compare, isNewer } from './semver'

describe('semver compare', () => {
  it('orders 1.0.0 below 1.0.1', () => {
    expect(compare('1.0.0', '1.0.1')).toBe(-1)
    expect(compare('1.0.1', '1.0.0')).toBe(1)
  })

  it('compares numerically, so 1.9.0 is below 1.10.0', () => {
    expect(compare('1.9.0', '1.10.0')).toBe(-1)
    expect(compare('1.10.0', '1.9.0')).toBe(1)
  })

  it('reports equality', () => {
    expect(compare('2.3.4', '2.3.4')).toBe(0)
    expect(compare('0.0.0', '0.0.0')).toBe(0)
  })

  it('mixes the v prefix freely', () => {
    expect(compare('v1.0.0', '1.0.0')).toBe(0)
    expect(compare('1.0.0', 'v1.0.0')).toBe(0)
    expect(compare('v1.0.0', 'v1.0.0')).toBe(0)
    expect(compare('v1.9.0', '1.10.0')).toBe(-1)
    expect(compare('1.10.0', 'v1.9.0')).toBe(1)
    expect(compare('v2.0.0', '1.99.99')).toBe(1)
  })

  it('handles major and minor differences', () => {
    expect(compare('2.0.0', '1.99.99')).toBe(1)
    expect(compare('1.2.3', '1.3.0')).toBe(-1)
  })

  it('treats missing components as zero', () => {
    expect(compare('1.2', '1.2.0')).toBe(0)
    expect(compare('1', '1.0.0')).toBe(0)
    expect(compare('1.2', '1.2.1')).toBe(-1)
  })

  it('ranks a release above its own prereleases', () => {
    expect(compare('1.0.0', '1.0.0-beta.1')).toBe(1)
    expect(compare('1.0.0-beta.1', '1.0.0-beta.2')).toBe(-1)
    expect(compare('1.0.0-rc.1', '1.0.0-beta.9')).toBe(1)
  })

  it('ignores build metadata', () => {
    expect(compare('1.0.0+build.7', '1.0.0')).toBe(0)
  })

  it('tolerates surrounding whitespace', () => {
    expect(compare('  v1.4.0 ', '1.4.0')).toBe(0)
  })

  it('exposes isNewer as a strict greater-than', () => {
    expect(isNewer('1.0.1', '1.0.0')).toBe(true)
    expect(isNewer('1.0.0', '1.0.0')).toBe(false)
    expect(isNewer('1.0.0', '1.0.1')).toBe(false)
  })
})
