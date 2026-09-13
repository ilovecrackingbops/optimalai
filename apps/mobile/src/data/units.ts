import { LB_PER_KG, kgToLb, lbToKg } from '../onboarding/store'
import { db, putSetting, setting } from './repo'

export { LB_PER_KG, kgToLb, lbToKg }

export type UnitPref = 'metric' | 'imperial'

/**
 * One setting, read from one place, everywhere weight is shown.
 *
 * Onboarding writes the user's choice into `user_profile.units`; nothing ever
 * read it back afterward, so `log-weight.tsx` and `progress.tsx` each hardcoded
 * their own answer (one defaulted to imperial, the other never asked at all).
 * `settings.units` is now the one flag every screen reads and the Profile
 * toggle writes, falling back to the onboarding column for anyone who set a
 * preference before this existed.
 */
export async function getUnitPref(): Promise<UnitPref> {
  const fromSettings = await setting('units', '')
  if (fromSettings === 'metric' || fromSettings === 'imperial') return fromSettings

  const h = await db()
  const row = await h.get<{ units: string | null }>('SELECT units FROM user_profile WHERE id = 1')
  return row?.units === 'metric' ? 'metric' : 'imperial'
}

export async function setUnitPref(pref: UnitPref): Promise<void> {
  await putSetting('units', pref)
}

/** kg -> the number to show, in the user's preferred unit. */
export function displayWeight(kg: number, pref: UnitPref): number {
  return pref === 'metric' ? kg : kgToLb(kg)
}

/** The number the user typed, in their preferred unit -> kg for storage. */
export function toKg(value: number, pref: UnitPref): number {
  return pref === 'metric' ? value : lbToKg(value)
}

export function weightUnitLabel(pref: UnitPref): 'kg' | 'lbs' {
  return pref === 'metric' ? 'kg' : 'lbs'
}

export function formatWeightKg(kg: number, pref: UnitPref, decimals = 1): string {
  return `${displayWeight(kg, pref).toFixed(decimals)} ${weightUnitLabel(pref)}`
}

/**
 * A rate of weight change (lb/week is the calorie engine's canonical unit —
 * see @nutai/goals) formatted for display in whichever unit the user prefers.
 * Regression: the Goals & tracking summary used to hard-code "lb/wk"
 * regardless of this setting, so a metric user saw a pace that was never
 * actually converted.
 */
export function formatRatePerWeek(rateLbPerWeek: number, pref: UnitPref, decimals = 2): string {
  const value = pref === 'metric' ? rateLbPerWeek / LB_PER_KG : rateLbPerWeek
  return `${value.toFixed(decimals)} ${pref === 'metric' ? 'kg' : 'lb'}/wk`
}
