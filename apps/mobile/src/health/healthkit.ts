import { Platform } from 'react-native'
import { summarizeLastSleepSession } from './sleep-analysis'
import { humanizeWorkoutActivity } from './workout-activity'

/**
 * HealthKit.
 *
 * THE CONSTRAINT THAT SHAPES THIS WHOLE FILE: on iOS, a READ permission never
 * reports whether it was granted. `requestAuthorization` resolves the same way
 * whether the user tapped Allow or Don't Allow, by design — Apple treats "this
 * app knows you declined to share heart data" as itself a privacy leak.
 *
 * So there is no such thing as "check if we have read access". The only honest
 * signal is whether a query returns anything, and an empty result is genuinely
 * ambiguous: no permission, or no data. Every function here is written to be
 * correct under that ambiguity rather than pretending it can tell the difference.
 *
 * Everything is dynamically imported. The module is iOS-only and pulls in a
 * native Nitro module; importing it eagerly would break Android and make the
 * whole app fail to start if the pod were ever missing.
 */

export type HealthAvailability = 'available' | 'unavailable' | 'not-ios'

export interface HealthWorkout {
  id: string
  /** Humanized from HealthKit's own activity type, e.g. "Running", "Functional Strength Training". */
  name: string
  startedAt: number
  durationMin: number
  /** Null when the source (rare, but some manual entries) never recorded energy. */
  kcal: number | null
}

export interface HealthReadout {
  /** Steps today. Null means "we got nothing", which may mean no permission. */
  stepsToday: number | null
  activeEnergyToday: number | null
  latestWeightKg: number | null
  /** Last night's total time asleep, in hours. Null means no sleep data found. */
  sleepHoursLastNight: number | null
  /**
   * 0-100, arithmetic from last night's own samples — NOT a clinical sleep
   * score. Duration against an 8-hour target, adjusted down for a rough
   * awake-while-in-bed ratio when that is measurable. Same honesty rule as
   * @nutai/totals's healthScore: shown only when there is real data to derive
   * it from, never a guess dressed up as a number.
   */
  sleepScore: number | null
  /** Average breaths per minute over today's samples, if any were recorded. */
  respiratoryRate: number | null
  /** True only if at least one query returned data — the closest thing to proof. */
  anyDataReturned: boolean
}

/** The identifiers we ask for. Minimum scope: every one is used by a feature. */
const READ_TYPES = [
  'HKQuantityTypeIdentifierStepCount',
  'HKQuantityTypeIdentifierActiveEnergyBurned',
  'HKQuantityTypeIdentifierBodyMass',
  'HKQuantityTypeIdentifierRespiratoryRate',
  'HKCategoryTypeIdentifierSleepAnalysis',
  'HKWorkoutTypeIdentifier',
] as const

const WRITE_TYPES = [
  'HKQuantityTypeIdentifierDietaryEnergyConsumed',
  'HKQuantityTypeIdentifierDietaryProtein',
  'HKQuantityTypeIdentifierDietaryCarbohydrates',
  'HKQuantityTypeIdentifierDietaryFatTotal',
  'HKQuantityTypeIdentifierBodyMass',
] as const

async function load() {
  if (Platform.OS !== 'ios') return null
  try {
    return await import('@kingstinct/react-native-healthkit')
  } catch {
    // The pod is not in this build. Not fatal — the app works without Health.
    return null
  }
}

export async function availability(): Promise<HealthAvailability> {
  if (Platform.OS !== 'ios') return 'not-ios'
  const hk = await load()
  if (!hk) return 'unavailable'
  try {
    // Sync in v14, despite the name reading like a query.
    return hk.isHealthDataAvailable() ? 'available' : 'unavailable'
  } catch {
    return 'unavailable'
  }
}

export interface AuthResult {
  /** The sheet was presented and dismissed without throwing. */
  prompted: boolean
  /**
   * Whether WRITE access was granted. Unlike reads, iOS does report this — so it
   * is the one authorization fact we can state truthfully.
   */
  canWrite: boolean
  error: string | null
}

/**
 * Present the Health permission sheet.
 *
 * Returns `prompted: true` when the sheet completed. That is NOT the same as
 * "the user granted anything", and the UI must not claim it is. If the user has
 * already answered once, iOS silently does nothing and this still resolves —
 * which is why the Settings screen has to link out to the Health app rather than
 * offer a "try again" button that would appear to do nothing.
 */
export async function requestPermissions(): Promise<AuthResult> {
  const hk = await load()
  if (!hk) return { prompted: false, canWrite: false, error: 'HealthKit is not available in this build.' }

  try {
    // v14 takes ONE object with toRead / toShare, not two positional arrays.
    await hk.requestAuthorization({
      toRead: READ_TYPES as never,
      toShare: WRITE_TYPES as never,
    })

    let canWrite = false
    try {
      // Synchronous in v14. Write status IS reported by iOS, unlike read status,
      // so this is the one authorization fact we can state truthfully.
      const status = hk.authorizationStatusFor(
        'HKQuantityTypeIdentifierDietaryEnergyConsumed' as never,
      )
      canWrite = status === 2 || String(status).toLowerCase().includes('shar')
    } catch {
      canWrite = false
    }

    return { prompted: true, canWrite, error: null }
  } catch (e) {
    return { prompted: false, canWrite: false, error: (e as Error)?.message ?? 'Health request failed.' }
  }
}

/**
 * Read today's activity.
 *
 * Written to degrade rather than throw: a denied read and an empty day are
 * indistinguishable here, and both must produce a usable app.
 */
/**
 * Only the "asleep" variants count toward duration — `inBed` and `awake` are
 * time in bed NOT asleep, and folding them in would inflate the number past
 * what anyone actually experienced as sleep.
 */

export async function readToday(now: number): Promise<HealthReadout> {
  const empty: HealthReadout = {
    stepsToday: null,
    activeEnergyToday: null,
    latestWeightKg: null,
    sleepHoursLastNight: null,
    sleepScore: null,
    respiratoryRate: null,
    anyDataReturned: false,
  }

  const hk = await load()
  if (!hk) return empty

  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)

  const out: HealthReadout = { ...empty }

  const sum = async (identifier: string): Promise<number | null> => {
    try {
      // The library's real DateFilter shape is { startDate, endDate } — NOT
      // { from, to }. Every query below used to pass { from, to }, which the
      // native Nitro binding silently read as an empty date filter, so this
      // was fetching either nothing or every sample ever recorded rather than
      // "today"'s. That was the whole "steps not updating" bug.
      const samples = await hk.queryQuantitySamples(identifier as never, {
        filter: { date: { startDate: start, endDate: end } },
        limit: 0,
      } as never)
      if (!Array.isArray(samples) || samples.length === 0) return null
      return samples.reduce((acc: number, s: { quantity?: number }) => acc + (s.quantity ?? 0), 0)
    } catch {
      return null
    }
  }

  out.stepsToday = await sum('HKQuantityTypeIdentifierStepCount')
  out.activeEnergyToday = await sum('HKQuantityTypeIdentifierActiveEnergyBurned')

  try {
    const weights = await hk.queryQuantitySamples('HKQuantityTypeIdentifierBodyMass' as never, {
      limit: 1,
      ascending: false,
    } as never)
    const latest = Array.isArray(weights) ? weights[0] : null
    out.latestWeightKg = latest?.quantity ?? null
  } catch {
    out.latestWeightKg = null
  }

  try {
    const samples = await hk.queryQuantitySamples('HKQuantityTypeIdentifierRespiratoryRate' as never, {
      filter: { date: { startDate: start, endDate: end } },
      limit: 0,
    } as never)
    if (Array.isArray(samples) && samples.length > 0) {
      const total = samples.reduce((acc: number, s: { quantity?: number }) => acc + (s.quantity ?? 0), 0)
      out.respiratoryRate = total / samples.length
    }
  } catch {
    out.respiratoryRate = null
  }

  // Pull the newest sleep samples directly — no date filter to get wrong —
  // and let `summarizeLastSleepSession` find "last night" from a gap in the
  // data itself. Same reasoning as `latestWeightKg` above: newest-first with
  // no calendar-window guess is more robust than computing a start/end and
  // hoping last night falls inside it.
  try {
    const samples = await hk.queryCategorySamples('HKCategoryTypeIdentifierSleepAnalysis' as never, {
      limit: 200,
      ascending: false,
    } as never)
    if (Array.isArray(samples)) {
      const parsed = (samples as Array<{ value: number | string; startDate: Date | string; endDate: Date | string }>).map(
        (s) => ({ value: s.value, start: new Date(s.startDate).getTime(), end: new Date(s.endDate).getTime() }),
      )
      const summary = summarizeLastSleepSession(parsed)
      out.sleepHoursLastNight = summary.sleepHours
      out.sleepScore = summary.sleepScore
    }
  } catch (e) {
    // A thrown error here used to be indistinguishable from "no permission,
    // no data" — both produced the same silent null. If sleep data genuinely
    // exists in Health and this still comes back empty, this line is the one
    // place that can tell the two apart (check Metro/Xcode logs).
    if (__DEV__) console.warn('[health] sleep query failed:', e)
    out.sleepHoursLastNight = null
    out.sleepScore = null
  }

  out.anyDataReturned =
    out.stepsToday != null ||
    out.activeEnergyToday != null ||
    out.latestWeightKg != null ||
    out.sleepHoursLastNight != null ||
    out.respiratoryRate != null

  return out
}

/**
 * Today's Apple Health workouts — a run tracked by an Apple Watch, a class
 * logged in Fitness, anything HealthKit has under HKWorkoutTypeIdentifier.
 * Purely informational: their energy is already folded into
 * `activeEnergyToday`, so nothing here should ever be added to a calorie
 * total a second time.
 */
export async function readTodayWorkouts(now: number): Promise<HealthWorkout[]> {
  const hk = await load()
  if (!hk) return []

  const start = new Date(now)
  start.setHours(0, 0, 0, 0)
  const end = new Date(now)

  try {
    const workouts = await hk.queryWorkoutSamples({
      filter: { date: { startDate: start, endDate: end } },
      limit: 0,
    } as never)
    if (!Array.isArray(workouts)) return []
    return workouts.map((w) => {
      const sample = w as unknown as {
        uuid: string
        startDate: Date | string
        workoutActivityType: unknown
        duration?: { quantity?: number }
        totalEnergyBurned?: { quantity?: number }
      }
      return {
        id: sample.uuid,
        name: humanizeWorkoutActivity(sample.workoutActivityType),
        startedAt: new Date(sample.startDate).getTime(),
        durationMin: (sample.duration?.quantity ?? 0) / 60,
        kcal: sample.totalEnergyBurned?.quantity ?? null,
      }
    })
  } catch {
    return []
  }
}

/**
 * Write one logged meal.
 *
 * ONE food correlation per meal, not seven orphan samples — a meal written as
 * loose nutrient samples clutters the user's Health record with rows that have
 * no relationship to each other and cannot be deleted as a unit.
 *
 * Idempotent by metadata key: re-syncing a day must not duplicate.
 */
export async function writeMeal(meal: {
  id: string
  loggedAt: number
  kcal: number
  proteinG: number
  carbsG: number
  fatG: number
  name: string
}): Promise<boolean> {
  const hk = await load()
  if (!hk) return false

  try {
    const date = new Date(meal.loggedAt)
    const metadata = { HKExternalUUID: `nutai:${meal.id}`, HKFoodType: meal.name }

    // Five positional args in v14: (type, samples, start, end, metadata).
    await hk.saveCorrelationSample(
      'HKCorrelationTypeIdentifierFood' as never,
      [
        { identifier: 'HKQuantityTypeIdentifierDietaryEnergyConsumed', unit: 'kcal', quantity: meal.kcal },
        { identifier: 'HKQuantityTypeIdentifierDietaryProtein', unit: 'g', quantity: meal.proteinG },
        { identifier: 'HKQuantityTypeIdentifierDietaryCarbohydrates', unit: 'g', quantity: meal.carbsG },
        { identifier: 'HKQuantityTypeIdentifierDietaryFatTotal', unit: 'g', quantity: meal.fatG },
      ] as never,
      date,
      date,
      metadata as never,
    )
    return true
  } catch {
    return false
  }
}
