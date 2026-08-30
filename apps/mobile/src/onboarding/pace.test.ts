import { describe, expect, it } from 'vitest'
import { goalForRate, nearestRateStop, RATE_MAX_KG, RATE_STEP_KG, RATE_STOPS_KG } from './pace'

describe('RATE_STOPS_KG', () => {
  it('spans exactly -1.0 to 1.0 kg/week, signed', () => {
    expect(RATE_STOPS_KG[0]).toBe(-RATE_MAX_KG)
    expect(RATE_STOPS_KG[RATE_STOPS_KG.length - 1]).toBe(RATE_MAX_KG)
    expect(RATE_STOPS_KG).toContain(0)
  })

  it('steps by exactly RATE_STEP_KG with no float drift', () => {
    for (let i = 1; i < RATE_STOPS_KG.length; i++) {
      expect(RATE_STOPS_KG[i]! - RATE_STOPS_KG[i - 1]!).toBeCloseTo(RATE_STEP_KG, 10)
    }
  })
})

describe('nearestRateStop', () => {
  it('snaps to the closest stop', () => {
    expect(nearestRateStop(0.24)).toBe(0.25)
    expect(nearestRateStop(-0.24)).toBe(-0.25)
    expect(nearestRateStop(0)).toBe(0)
  })

  it('clamps a value beyond the range to the nearest endpoint', () => {
    expect(nearestRateStop(5)).toBe(1)
    expect(nearestRateStop(-5)).toBe(-1)
  })
})

describe('goalForRate', () => {
  it('reads direction off the sign alone', () => {
    expect(goalForRate(0)).toBe('maintain')
    expect(goalForRate(-0.5)).toBe('lose')
    expect(goalForRate(0.5)).toBe('gain')
  })

  it('treats the smallest negative or positive stop as a real direction, not maintain', () => {
    expect(goalForRate(-RATE_STEP_KG)).toBe('lose')
    expect(goalForRate(RATE_STEP_KG)).toBe('gain')
  })
})
