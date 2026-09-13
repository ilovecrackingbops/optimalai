/**
 * HKCategoryTypeIdentifierSleepAnalysis value classification. A standalone,
 * platform-free module — kept out of healthkit.ts, which imports
 * `react-native` and so cannot be unit-tested under plain Node/Vitest.
 *
 * Checked as BOTH the numeric HealthKit constant and its string key: these
 * Nitro bindings are inconsistent about whether a typed enum crosses the
 * bridge as its number or as its name, and getting this wrong doesn't
 * throw — it silently classifies every sample as neither asleep nor awake, so
 * a sleep score stays null forever with no error to catch.
 */
const ASLEEP_VALUES = new Set([1, 3, 4, 5]) // asleepUnspecified/asleep, asleepCore, asleepDeep, asleepREM
const ASLEEP_KEYS = new Set(['asleep', 'asleepunspecified', 'asleepcore', 'asleepdeep', 'asleeprem'])
const AWAKE_VALUE = 2
const AWAKE_KEY = 'awake'

export function isAsleepValue(v: number | string): boolean {
  return typeof v === 'number' ? ASLEEP_VALUES.has(v) : ASLEEP_KEYS.has(v.toLowerCase())
}

export function isAwakeValue(v: number | string): boolean {
  return typeof v === 'number' ? v === AWAKE_VALUE : v.toLowerCase() === AWAKE_KEY
}

export interface SleepSample {
  value: number | string
  /** Epoch ms. */
  start: number
  /** Epoch ms. */
  end: number
}

export interface SleepSummary {
  sleepHours: number | null
  /**
   * 0-100, arithmetic from the session's own samples — NOT a clinical sleep
   * score. Duration against an 8-hour target, adjusted down for a rough
   * awake-while-in-bed ratio when that is measurable.
   */
  sleepScore: number | null
}

const EMPTY_SUMMARY: SleepSummary = { sleepHours: null, sleepScore: null }

/** No two samples in the same night are ever this far apart; a gap this big means a new session. */
export const SESSION_GAP_MS = 4 * 3_600_000

/**
 * Find the most recent sleep SESSION directly from a batch of samples
 * (newest-first is NOT required — this sorts them itself), rather than
 * filtering by a computed calendar time window. A fixed "last 24h" window has
 * to guess where last night starts, and that guess is wrong for anyone who
 * opens the app late at night, right after waking, or across a timezone
 * change — and a wrong guess doesn't error, it just quietly returns zero
 * samples. Walking back from the newest sample until a multi-hour gap
 * appears finds "last night" unambiguously regardless of when "now" is.
 */
export function summarizeLastSleepSession(samples: readonly SleepSample[]): SleepSummary {
  if (samples.length === 0) return EMPTY_SUMMARY

  const sorted = [...samples].sort((a, b) => b.end - a.end)

  const session: SleepSample[] = []
  for (const s of sorted) {
    const prev = session[session.length - 1]
    if (prev && prev.start - s.end > SESSION_GAP_MS) break
    session.push(s)
  }

  let asleepMs = 0
  let awakeMs = 0
  for (const s of session) {
    const dur = Math.max(0, s.end - s.start)
    if (isAsleepValue(s.value)) asleepMs += dur
    else if (isAwakeValue(s.value)) awakeMs += dur
  }
  if (asleepMs <= 0) return EMPTY_SUMMARY

  const sleepHours = asleepMs / 3_600_000
  // Duration against an 8h target is the dominant term; a modest deduction
  // for time spent awake-in-bed penalizes fragmented sleep without
  // pretending to measure sleep stages we were not asked for.
  const durationScore = Math.min(100, (sleepHours / 8) * 100)
  const fragmentation = asleepMs + awakeMs > 0 ? awakeMs / (asleepMs + awakeMs) : 0
  const sleepScore = Math.max(0, Math.round(durationScore - fragmentation * 30))

  return { sleepHours, sleepScore }
}
