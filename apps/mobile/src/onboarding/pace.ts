import type { Goal } from '@nutai/goals'

/**
 * The target-weight screen's pace wheel, in kg/week, signed: negative is
 * loss, positive is gain, zero is maintain — ONE control for both direction
 * and magnitude, rather than direction coming from target weight and
 * magnitude from a separate picker. -1 to +1 kg/week at 0.05 kg steps (41
 * stops) reads as "fully flexible" rather than a handful of named presets,
 * while still landing on a value a scroll wheel can display without a stray
 * float remainder.
 */
export const RATE_STEP_KG = 0.05
export const RATE_MAX_KG = 1.0

export const RATE_STOPS_KG: readonly number[] = Array.from(
  { length: Math.round((RATE_MAX_KG * 2) / RATE_STEP_KG) + 1 },
  (_, i) => Number((-RATE_MAX_KG + i * RATE_STEP_KG).toFixed(2)),
)

export function nearestRateStop(v: number): number {
  return RATE_STOPS_KG.reduce((best, cur) => (Math.abs(cur - v) < Math.abs(best - v) ? cur : best), 0)
}

export function goalForRate(rateKg: number): Goal {
  return rateKg === 0 ? 'maintain' : rateKg < 0 ? 'lose' : 'gain'
}
