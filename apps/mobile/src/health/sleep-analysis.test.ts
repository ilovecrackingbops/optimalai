import { describe, expect, it } from 'vitest'
import { isAsleepValue, isAwakeValue, SESSION_GAP_MS, summarizeLastSleepSession, type SleepSample } from './sleep-analysis'

describe('isAsleepValue', () => {
  it('matches every numeric HealthKit asleep constant', () => {
    for (const v of [1, 3, 4, 5]) expect(isAsleepValue(v)).toBe(true)
  })

  it('matches the same states by string key, in case the bridge sends the name', () => {
    for (const v of ['asleep', 'asleepCore', 'asleepDeep', 'asleepREM', 'asleepUnspecified']) {
      expect(isAsleepValue(v)).toBe(true)
    }
  })

  it('rejects inBed (0) and awake (2) — time in bed is not time asleep', () => {
    expect(isAsleepValue(0)).toBe(false)
    expect(isAsleepValue(2)).toBe(false)
    expect(isAsleepValue('inBed')).toBe(false)
    expect(isAsleepValue('awake')).toBe(false)
  })
})

describe('isAwakeValue', () => {
  it('matches numeric and string forms of awake only', () => {
    expect(isAwakeValue(2)).toBe(true)
    expect(isAwakeValue('awake')).toBe(true)
    expect(isAwakeValue('Awake')).toBe(true)
    expect(isAwakeValue(1)).toBe(false)
    expect(isAwakeValue('asleep')).toBe(false)
  })
})

const HOUR = 3_600_000

/** A run of 90-minute asleep-core cycles ending at `endMs`, oldest first. */
function nightOf(endMs: number, hours: number): SleepSample[] {
  const out: SleepSample[] = []
  let cursor = endMs
  let remaining = hours * HOUR
  while (remaining > 0) {
    const chunk = Math.min(1.5 * HOUR, remaining)
    out.unshift({ value: 3, start: cursor - chunk, end: cursor })
    cursor -= chunk
    remaining -= chunk
  }
  return out
}

describe('summarizeLastSleepSession', () => {
  it('returns null for both fields when there are no samples', () => {
    expect(summarizeLastSleepSession([])).toEqual({ sleepHours: null, sleepScore: null })
  })

  it('sums a single unbroken night regardless of input order', () => {
    const now = Date.parse('2026-08-30T07:00:00Z')
    const night = nightOf(now, 8)
    const shuffled = [...night].reverse()
    const summary = summarizeLastSleepSession(shuffled)
    expect(summary.sleepHours).toBeCloseTo(8, 5)
    expect(summary.sleepScore).toBe(100)
  })

  it('picks only the MOST RECENT session when two nights are present, separated by a gap', () => {
    const now = Date.parse('2026-08-30T07:00:00Z')
    const lastNight = nightOf(now, 6)
    // A much shorter, older night more than the gap threshold earlier — must
    // be excluded from the sum entirely, not blended in.
    const twoNightsAgo = nightOf(now - 30 * HOUR, 3)
    const summary = summarizeLastSleepSession([...twoNightsAgo, ...lastNight])
    expect(summary.sleepHours).toBeCloseTo(6, 5)
  })

  it('excludes inBed time and deducts for fragmented awake-in-bed time', () => {
    const start = Date.parse('2026-08-30T00:00:00Z')
    const samples: SleepSample[] = [
      { value: 0, start, end: start + 8 * HOUR }, // inBed — never counted as asleep
      { value: 4, start, end: start + 3 * HOUR }, // asleepDeep
      { value: 2, start: start + 3 * HOUR, end: start + 4 * HOUR }, // awake, 1h
      { value: 5, start: start + 4 * HOUR, end: start + 7 * HOUR }, // asleepREM
    ]
    const summary = summarizeLastSleepSession(samples)
    expect(summary.sleepHours).toBeCloseTo(6, 5) // 3h + 3h asleep, NOT +8h inBed
    expect(summary.sleepScore).toBeLessThan(75) // 6/8*100=75, minus a fragmentation penalty
  })

  it('treats a gap larger than SESSION_GAP_MS as a session boundary, smaller as continuous', () => {
    const end = Date.parse('2026-08-30T07:00:00Z')
    const justUnderGap: SleepSample[] = [
      { value: 1, start: end - 2 * HOUR, end },
      { value: 1, start: end - 2 * HOUR - (SESSION_GAP_MS - 1), end: end - 2 * HOUR - (SESSION_GAP_MS - 1) + HOUR },
    ]
    expect(summarizeLastSleepSession(justUnderGap).sleepHours).toBeCloseTo(3, 1)

    const overGap: SleepSample[] = [
      { value: 1, start: end - 2 * HOUR, end },
      { value: 1, start: end - 2 * HOUR - (SESSION_GAP_MS + 1) - HOUR, end: end - 2 * HOUR - (SESSION_GAP_MS + 1) },
    ]
    expect(summarizeLastSleepSession(overGap).sleepHours).toBeCloseTo(2, 5)
  })
})
