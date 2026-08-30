import { migrate, type DbAdapter } from '@nutai/db-adapter'
import {
  computeCalorieTarget,
  computeMacros,
  computeTrend,
  isDayCompleteEnough,
  trendSlopeLbPerWeek,
  updateAdaptiveTdee,
  type ActivityLevel,
  type Goal,
  type MacroTargets,
  type Sex,
  type WeightPoint,
} from '@nutai/goals'
import Storage from 'expo-sqlite/kv-store'
import { ONBOARDING_DONE_KEY } from '../onboarding/done-key'
import { EXPORT_TABLES, WIPE_ONLY_TABLES } from './backup-core'
import { localDate, slotFor } from './date-utils'
import { clearCredential } from '../inference/credentials'
import { openNutritionDb, openUserDb } from '../db/expo-adapter'
import { classifyCategory, type FoodClassification } from './food-category'
import { exerciseKcal } from '../exercise/met'

export { localDate, slotFor }

/**
 * The read/write layer over `user.db`.
 *
 * Every screen goes through here rather than holding its own SQL, so the
 * invariants live in one place: goals are append-only, day totals are always
 * derived from log_items rather than stored, and the adaptive loop can never run
 * on days it should not admit.
 */

let cached: DbAdapter | null = null

export async function db(): Promise<DbAdapter> {
  if (cached) return cached
  const handle = await openUserDb()
  await migrate(handle, Date.now())
  cached = handle
  return handle
}


/**
 * Wipe every local trace and send the app back to the first onboarding screen.
 *
 * Deletes user data, drops the stored API credentials out of the Keychain, and
 * clears the completion flag. The bundled nutrition corpus is left alone — it is
 * a read-only build artifact, not user data, and re-importing 4.7 MB to prove a
 * point would just make this slow.
 */
export async function resetEverything(): Promise<void> {
  const h = await db()
  // ONE source of truth for "what counts as user data": the backup lists.
  // Children before parents, so foreign keys never block the wipe.
  const tables: string[] = [...([...EXPORT_TABLES] as string[]).reverse(), ...WIPE_ONLY_TABLES]
  await h.transaction(async (tx) => {
    for (const t of tables) {
      // A missing table is not an error here — an interrupted migration should
      // still be resettable, which is exactly when someone reaches for this.
      try {
        await tx.run(`DELETE FROM ${t}`)
      } catch {
        /* table absent */
      }
    }
  })

  for (const p of ['anthropic', 'openai', 'google'] as const) {
    await clearCredential(p)
  }

  await Storage.removeItem(ONBOARDING_DONE_KEY)
}

// ---------------------------------------------------------------------------
// Goals
// ---------------------------------------------------------------------------

export interface CurrentGoal {
  goalType: Goal
  targetKcal: number
  targetRawKcal: number
  floorApplied: boolean
  protein_g: number
  fat_g: number
  carbs_g: number
  bmr: number
  tdee: number
  adaptive: boolean
  effectiveFrom: number
}

/**
 * The goal in force right now.
 *
 * `goals` is append-only, so "current" means the newest row — and a historical
 * day can still be read against whichever row was in force that day. Recomputing
 * March against August's target would silently rewrite whether someone hit their
 * goal three months ago.
 */
export async function currentGoal(): Promise<CurrentGoal | null> {
  const h = await db()
  const row = await h.get<{
    goal_type: string
    target_kcal: number
    target_raw_kcal: number
    floor_applied: number
    protein_g: number
    fat_g: number
    carbs_g: number
    bmr: number
    tdee: number
    adaptive: number
    effective_from: number
  }>('SELECT * FROM goals ORDER BY effective_from DESC, id DESC LIMIT 1')

  if (!row) return null
  return {
    goalType: row.goal_type as Goal,
    targetKcal: row.target_kcal,
    targetRawKcal: row.target_raw_kcal,
    floorApplied: row.floor_applied === 1,
    protein_g: row.protein_g,
    fat_g: row.fat_g,
    carbs_g: row.carbs_g,
    bmr: row.bmr,
    tdee: row.tdee,
    adaptive: row.adaptive === 1,
    effectiveFrom: row.effective_from,
  }
}

export async function setting(key: string, fallback = ''): Promise<string> {
  const h = await db()
  const row = await h.get<{ value: string }>('SELECT value FROM settings WHERE key = ?', [key])
  return row?.value ?? fallback
}

export async function putSetting(key: string, value: string): Promise<void> {
  const h = await db()
  await h.run('INSERT OR REPLACE INTO settings (key, value) VALUES (?,?)', [key, value])
}

/** Manual target override from the plan screen's pencil icons. */
export async function overrideTargets(
  next: { targetKcal: number; macros: MacroTargets },
  base: CurrentGoal,
  now: number,
): Promise<void> {
  const h = await db()
  await h.run(
    `INSERT INTO goals
       (effective_from, goal_type, rate_lb_per_week, target_kcal, target_raw_kcal,
        floor_applied, protein_g, fat_g, carbs_g, bmr, tdee, adaptive)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      now,
      base.goalType,
      null,
      next.targetKcal,
      next.targetKcal,
      0,
      next.macros.protein_g,
      next.macros.fat_g,
      next.macros.carbs_g,
      base.bmr,
      base.tdee,
      // A hand-set target turns the adaptive loop OFF. Silently overwriting a
      // number the user deliberately chose is the fastest way to lose their
      // trust in every other number.
      0,
    ],
  )
}

export interface BodyProfile {
  sex: Sex
  ageYears: number
  heightCm: number
  activity: ActivityLevel
}

/** Body inputs the goals formula needs, read from onboarding's `user_profile` row. */
export async function bodyProfile(now: number): Promise<BodyProfile | null> {
  const h = await db()
  const row = await h.get<{
    sex: string | null
    birth_year: number | null
    height_cm: number | null
    activity_level: string | null
  }>('SELECT sex, birth_year, height_cm, activity_level FROM user_profile WHERE id = 1')
  if (!row || row.height_cm == null) return null

  const ageYears =
    row.birth_year != null
      ? Math.max(13, Math.min(100, new Date(now).getUTCFullYear() - row.birth_year))
      : 30

  return {
    sex: (row.sex as Sex | null) ?? 'unspecified',
    ageYears,
    heightCm: row.height_cm,
    activity: (row.activity_level as ActivityLevel | null) ?? 'sedentary',
  }
}

/**
 * Recompute and save a target from a target weight, a direction, and a chosen
 * pace.
 *
 * Unlike `overrideTargets`, this is NOT a manual override — the number still
 * comes from the same formula onboarding used, just re-run with new inputs.
 * The adaptive loop stays ON, because "I want to hit 165 lb at a slower pace"
 * is a plan change, not a hand-typed number that the app must stop touching.
 *
 * Direction is a caller-supplied `goalType`, not derived from target weight
 * here — the target-weight screen's pace wheel is signed (loss through gain
 * in one control) and IS the direction; re-deriving it from weight deltas
 * would let the two disagree silently.
 */
export async function setGoalTarget(desiredWeightKg: number, goalType: Goal, rateLbPerWeek: number, now: number): Promise<CurrentGoal> {
  const profile = await bodyProfile(now)
  if (!profile) throw new Error('Finish onboarding before setting a target weight.')

  const points = await weightHistory()
  const currentKg = points[points.length - 1]?.weightKg ?? desiredWeightKg
  const rate = goalType === 'maintain' ? 0 : rateLbPerWeek

  const target = computeCalorieTarget({
    sex: profile.sex,
    weightKg: currentKg,
    heightCm: profile.heightCm,
    ageYears: profile.ageYears,
    activity: profile.activity,
    goal: goalType,
    rateLbPerWeek: rate,
  })
  const macros = computeMacros(target.target, currentKg, goalType)

  const h = await db()
  await h.run(
    `INSERT INTO goals
       (effective_from, goal_type, rate_lb_per_week, target_kcal, target_raw_kcal,
        floor_applied, protein_g, fat_g, carbs_g, bmr, tdee, adaptive)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      now,
      goalType,
      goalType === 'maintain' ? null : rate,
      target.target,
      target.targetRaw,
      target.floorApplied ? 1 : 0,
      macros.protein_g,
      macros.fat_g,
      macros.carbs_g,
      target.bmr,
      target.tdee,
    ],
  )

  await putSetting('goal.desiredWeightKg', String(desiredWeightKg))
  await putSetting('goal.rateLbPerWeek', String(rate))

  const updated = await currentGoal()
  if (!updated) throw new Error('Goal write did not take.')
  return updated
}

// ---------------------------------------------------------------------------
// Day totals
// ---------------------------------------------------------------------------

export interface DayTotals {
  kcal: number
  protein_g: number
  fat_g: number
  carbs_g: number
  fiber_g: number
  sugar_g: number
  sodium_mg: number
  grams: number
  /** Calories from items classified either way — the denominator for the two shares below. */
  classifiedKcal: number
  wholeFoodKcal: number
  animalBasedKcal: number
  mealCount: number
  distinctSlots: number
  pendingCount: number
}

/**
 * Derived from log_items on every read, never stored.
 *
 * `day_summaries` exists as a cache for the widget, but it is droppable and
 * rebuildable — this query is the source of truth.
 */
export async function dayTotals(date: string): Promise<DayTotals> {
  const h = await db()

  const row = await h.get<{
    kcal: number | null
    p: number | null
    f: number | null
    c: number | null
    fiber: number | null
    sugar: number | null
    sodium: number | null
    grams: number | null
    classifiedKcal: number | null
    wholeFoodKcal: number | null
    animalBasedKcal: number | null
    meals: number | null
    slots: number | null
  }>(
    `SELECT
       SUM(li.snap_energy_kcal * li.grams / 100.0 * m.portion_eaten_fraction) AS kcal,
       SUM(li.snap_protein_g   * li.grams / 100.0 * m.portion_eaten_fraction) AS p,
       SUM(li.snap_fat_g       * li.grams / 100.0 * m.portion_eaten_fraction) AS f,
       SUM(li.snap_carb_g      * li.grams / 100.0 * m.portion_eaten_fraction) AS c,
       SUM(li.snap_fiber_g     * li.grams / 100.0 * m.portion_eaten_fraction) AS fiber,
       SUM(li.snap_sugar_g     * li.grams / 100.0 * m.portion_eaten_fraction) AS sugar,
       SUM(li.snap_sodium_mg   * li.grams / 100.0 * m.portion_eaten_fraction) AS sodium,
       SUM(li.grams * m.portion_eaten_fraction) AS grams,
       SUM(CASE WHEN li.is_whole_food IS NOT NULL
                THEN li.snap_energy_kcal * li.grams / 100.0 * m.portion_eaten_fraction ELSE 0 END) AS classifiedKcal,
       SUM(CASE WHEN li.is_whole_food = 1
                THEN li.snap_energy_kcal * li.grams / 100.0 * m.portion_eaten_fraction ELSE 0 END) AS wholeFoodKcal,
       SUM(CASE WHEN li.is_animal_based = 1
                THEN li.snap_energy_kcal * li.grams / 100.0 * m.portion_eaten_fraction ELSE 0 END) AS animalBasedKcal,
       COUNT(DISTINCT m.id)        AS meals,
       COUNT(DISTINCT m.meal_slot) AS slots
     FROM meals m
     JOIN log_items li ON li.meal_id = m.id
     WHERE m.local_date = ? AND m.analysis_status IN ('complete','manual')`,
    [date],
  )

  const pending = await h.get<{ c: number }>(
    `SELECT COUNT(*) c FROM meals
     WHERE local_date = ? AND analysis_status IN ('captured','queued','analyzing')`,
    [date],
  )

  return {
    kcal: row?.kcal ?? 0,
    protein_g: row?.p ?? 0,
    fat_g: row?.f ?? 0,
    carbs_g: row?.c ?? 0,
    // NULL fiber/sugar/sodium on some rows means "not reported," not zero — SUM
    // over SQLite already skips NULLs the same way, so this only substitutes a
    // display zero when EVERY row was silent.
    fiber_g: row?.fiber ?? 0,
    sugar_g: row?.sugar ?? 0,
    sodium_mg: row?.sodium ?? 0,
    grams: row?.grams ?? 0,
    classifiedKcal: row?.classifiedKcal ?? 0,
    wholeFoodKcal: row?.wholeFoodKcal ?? 0,
    animalBasedKcal: row?.animalBasedKcal ?? 0,
    mealCount: row?.meals ?? 0,
    distinctSlots: row?.slots ?? 0,
    // Pending scans contribute ZERO calories. A number that silently grows later
    // is worse than a number that is visibly incomplete.
    pendingCount: pending?.c ?? 0,
  }
}

// ---------------------------------------------------------------------------
// Meals
// ---------------------------------------------------------------------------

/**
 * Batch-classify a list of corpus food ids (from `IngredientRow.sourceFoodId`,
 * `null` for AI-estimate/web-lookup rows) against the read-only nutrition
 * corpus. Keyed by the original id string so a `null` entry and a real one
 * never collide.
 */
async function classifyIngredients(
  sourceFoodIds: readonly (string | null)[],
): Promise<Map<string, FoodClassification>> {
  const ids = [...new Set(sourceFoodIds.filter((id): id is string => id != null))]
  const out = new Map<string, FoodClassification>()
  if (ids.length === 0) return out

  const nutritionDb = await openNutritionDb()
  const placeholders = ids.map(() => '?').join(',')
  const rows = await nutritionDb.all<{ id: number; category: string | null }>(
    `SELECT id, category FROM foods WHERE id IN (${placeholders})`,
    ids.map((id) => Number(id)),
  )
  const byId = new Map(rows.map((r) => [String(r.id), r.category]))
  for (const id of ids) out.set(id, classifyCategory(byId.get(id) ?? null))
  return out
}

/**
 * Persist a reviewed scan. One transaction: the meal row, every ingredient with
 * its per-100 g snapshot copied in (never re-looked-up live), and the cost
 * ledger entry with REAL token counts. analysis_status lands as 'complete',
 * which is what dayTotals reads — logging is what makes the Today ring move.
 */
export async function logMeal(
  result: import('@nutai/pipeline').ScanResult,
  meta: {
    provider: string
    model: string
    inputTokens: number
    outputTokens: number
    costUsd: number
  } | null,
  photoUri: string | null,
  now: number,
): Promise<number> {
  const h = await db()
  const date = localDate(now)

  // Looked up ONCE, up front, and copied into each row's snapshot — the same
  // rule as every other snap_* column: never a live join, so a later corpus
  // rebuild can't quietly change what a past day's Health Score was.
  const classifications = await classifyIngredients(
    result.meal.ingredients.map((r) => r.sourceFoodId ?? null),
  )

  return h.transaction(async (tx) => {
    const meal = await tx.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, photo_uri, portion_eaten_fraction,
                          analysis_status, engine_id, prompt_version, schema_version,
                          clamp_flags_json, created_at)
       VALUES (?,?,?,?,?,'complete',?,?,?,?,?)`,
      [
        now,
        date,
        slotFor(now),
        photoUri,
        result.meal.portionEatenFraction,
        result.meal.engineId,
        result.meal.promptVersion,
        result.meal.schemaVersion,
        JSON.stringify(result.clampFlags ?? []),
        now,
      ],
    )
    const mealId = Number(meal.lastInsertRowId)

    let sort = 0
    for (const row of result.meal.ingredients) {
      const foodId = row.sourceFoodId == null ? null : Number(row.sourceFoodId)
      const cls = classifications.get(row.sourceFoodId ?? '') ?? { isWholeFood: null, isAnimalBased: null }
      await tx.run(
        `INSERT INTO log_items (meal_id, matched_food_id, matched_food_source, raw_model_label,
                                display_name, grams, gram_pathway, portion_source,
                                snap_energy_kcal, snap_protein_g, snap_fat_g, snap_carb_g,
                                snap_fiber_g, snap_sugar_g, snap_sodium_mg,
                                is_whole_food, is_animal_based,
                                is_estimate, macros_user_edited, band_half_pct,
                                assumptions_json, sort_order, logged_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          mealId,
          Number.isFinite(foodId as number) ? foodId : null,
          row.origin === 'web_lookup' ? 'web' : row.sourceFoodId != null ? 'corpus' : 'estimate',
          row.sourceUrl ?? null,
          row.displayName,
          row.grams,
          row.gramPathway,
          row.origin,
          row.nutrientSnapshot.kcal,
          row.nutrientSnapshot.protein_g,
          row.nutrientSnapshot.fat_g,
          row.nutrientSnapshot.carbs_g,
          row.nutrientSnapshot.fiber_g ?? null,
          row.nutrientSnapshot.sugar_g ?? null,
          row.nutrientSnapshot.sodium_mg ?? null,
          cls.isWholeFood == null ? null : cls.isWholeFood ? 1 : 0,
          cls.isAnimalBased == null ? null : cls.isAnimalBased ? 1 : 0,
          row.isEstimate ? 1 : 0,
          row.macrosUserEdited ? 1 : 0,
          row.bandHalfPct,
          JSON.stringify(row.assumptions ?? []),
          sort++,
          now,
        ],
      )
    }

    if (meta) {
      await tx.run(
        `INSERT INTO scan_cost_ledger (meal_id, provider, model, input_tokens, output_tokens,
                                       cost_usd, local_month, created_at)
         VALUES (?,?,?,?,?,?,?,?)`,
        [mealId, meta.provider, meta.model, meta.inputTokens, meta.outputTokens, meta.costUsd, date.slice(0, 7), now],
      )
    }

    return mealId
  })
}

// ---------------------------------------------------------------------------
// Today's log — meals, listed and editable after they're committed
// ---------------------------------------------------------------------------

export interface MealListEntry {
  id: number
  loggedAt: number
  mealSlot: string | null
  photoUri: string | null
  name: string
  kcal: number
}

/** One row per logged meal for a day, for the "today's log" list on Home. */
export async function mealsForDate(date: string): Promise<MealListEntry[]> {
  const h = await db()
  const rows = await h.all<{
    id: number
    logged_at: number
    meal_slot: string | null
    photo_uri: string | null
    name: string | null
    kcal: number | null
    portion_eaten_fraction: number
  }>(
    `SELECT
       m.id, m.logged_at, m.meal_slot, m.photo_uri, m.portion_eaten_fraction,
       (SELECT li.display_name FROM log_items li WHERE li.meal_id = m.id ORDER BY li.sort_order LIMIT 1) AS name,
       (SELECT SUM(li.snap_energy_kcal * li.grams / 100.0) FROM log_items li WHERE li.meal_id = m.id) AS kcal
     FROM meals m
     WHERE m.local_date = ? AND m.analysis_status IN ('complete','manual')
     ORDER BY m.logged_at DESC`,
    [date],
  )
  return rows.map((r) => ({
    id: r.id,
    loggedAt: r.logged_at,
    mealSlot: r.meal_slot,
    photoUri: r.photo_uri,
    name: r.name ?? 'Meal',
    kcal: (r.kcal ?? 0) * r.portion_eaten_fraction,
  }))
}

export interface MealDetailItem {
  id: number
  displayName: string
  grams: number
  kcal: number
  proteinG: number
  fatG: number
  carbsG: number
  isEstimate: boolean
}

export interface MealDetail {
  id: number
  loggedAt: number
  photoUri: string | null
  portionEatenFraction: number
  items: MealDetailItem[]
}

/** A single logged meal with its editable ingredient rows. */
export async function mealDetail(mealId: number): Promise<MealDetail | null> {
  const h = await db()
  const meal = await h.get<{ id: number; logged_at: number; photo_uri: string | null; portion_eaten_fraction: number }>(
    'SELECT id, logged_at, photo_uri, portion_eaten_fraction FROM meals WHERE id = ?',
    [mealId],
  )
  if (!meal) return null

  const items = await h.all<{
    id: number
    display_name: string
    grams: number
    snap_energy_kcal: number | null
    snap_protein_g: number | null
    snap_fat_g: number | null
    snap_carb_g: number | null
    is_estimate: number
  }>(
    `SELECT id, display_name, grams, snap_energy_kcal, snap_protein_g, snap_fat_g, snap_carb_g, is_estimate
     FROM log_items WHERE meal_id = ? ORDER BY sort_order`,
    [mealId],
  )

  return {
    id: meal.id,
    loggedAt: meal.logged_at,
    photoUri: meal.photo_uri,
    portionEatenFraction: meal.portion_eaten_fraction,
    items: items.map((i) => ({
      id: i.id,
      displayName: i.display_name,
      grams: i.grams,
      kcal: ((i.snap_energy_kcal ?? 0) * i.grams) / 100,
      proteinG: ((i.snap_protein_g ?? 0) * i.grams) / 100,
      fatG: ((i.snap_fat_g ?? 0) * i.grams) / 100,
      carbsG: ((i.snap_carb_g ?? 0) * i.grams) / 100,
      isEstimate: i.is_estimate === 1,
    })),
  }
}

/**
 * Edit a gram figure on an already-logged item. `dayTotals` derives live from
 * `log_items`, so nothing else needs recomputing — the Home ring updates for free
 * the next time it reads.
 */
export async function updateLogItemGrams(logItemId: number, grams: number): Promise<void> {
  if (!Number.isFinite(grams) || grams < 0) return
  const h = await db()
  await h.run('UPDATE log_items SET grams = ?, macros_user_edited = 1 WHERE id = ?', [grams, logItemId])
}

export async function deleteLogItem(logItemId: number): Promise<void> {
  const h = await db()
  await h.run('DELETE FROM log_items WHERE id = ?', [logItemId])
}

/** Cascades to log_items via the FK's ON DELETE CASCADE. */
export async function deleteMeal(mealId: number): Promise<void> {
  const h = await db()
  await h.run('DELETE FROM meals WHERE id = ?', [mealId])
}

// ---------------------------------------------------------------------------
// Exercise
// ---------------------------------------------------------------------------

export interface ExerciseListEntry {
  id: number
  name: string
  kcal: number
  loggedAt: number
}

export async function exerciseEntries(date: string): Promise<ExerciseListEntry[]> {
  const h = await db()
  const rows = await h.all<{ id: number; name: string; kcal: number; logged_at: number }>(
    'SELECT id, name, kcal, logged_at FROM exercise_entries WHERE local_date = ? ORDER BY logged_at DESC',
    [date],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, kcal: r.kcal, loggedAt: r.logged_at }))
}

export async function exerciseTotals(date: string): Promise<{ kcal: number; count: number }> {
  const h = await db()
  const row = await h.get<{ kcal: number | null; count: number | null }>(
    'SELECT SUM(kcal) AS kcal, COUNT(*) AS count FROM exercise_entries WHERE local_date = ?',
    [date],
  )
  return { kcal: row?.kcal ?? 0, count: row?.count ?? 0 }
}

export async function deleteExerciseEntry(id: number): Promise<void> {
  const h = await db()
  await h.run('DELETE FROM exercise_entries WHERE id = ?', [id])
}

export async function exerciseEntry(id: number): Promise<ExerciseListEntry | null> {
  const h = await db()
  const r = await h.get<{ id: number; name: string; kcal: number; logged_at: number }>(
    'SELECT id, name, kcal, logged_at FROM exercise_entries WHERE id = ?',
    [id],
  )
  return r ? { id: r.id, name: r.name, kcal: r.kcal, loggedAt: r.logged_at } : null
}

/** Editable after the fact, same as a logged meal — "recorded exactly as entered" cuts both ways. */
export async function updateExerciseEntry(id: number, patch: { name: string; kcal: number }): Promise<void> {
  const h = await db()
  await h.run('UPDATE exercise_entries SET name = ?, kcal = ? WHERE id = ?', [patch.name, patch.kcal, id])
}

// ---------------------------------------------------------------------------
// Workout splits — a reusable, repeatable training day: a name and a list of
// exercises, each with the weight and reps the user actually trains.
// ---------------------------------------------------------------------------

export interface SplitExerciseInput {
  name: string
  sets: number
  reps: number
  weightLb: number | null
}

export interface SplitExercise extends SplitExerciseInput {
  id: number
}

export interface SplitListEntry {
  id: number
  name: string
  exerciseCount: number
}

export interface SplitDetail {
  id: number
  name: string
  exercises: SplitExercise[]
}

export async function listSplits(): Promise<SplitListEntry[]> {
  const h = await db()
  const rows = await h.all<{ id: number; name: string; c: number }>(
    `SELECT s.id, s.name, COUNT(e.id) AS c
     FROM workout_splits s LEFT JOIN workout_split_exercises e ON e.split_id = s.id
     GROUP BY s.id ORDER BY s.sort_order, s.id`,
  )
  return rows.map((r) => ({ id: r.id, name: r.name, exerciseCount: r.c }))
}

export async function splitDetail(id: number): Promise<SplitDetail | null> {
  const h = await db()
  const split = await h.get<{ id: number; name: string }>('SELECT id, name FROM workout_splits WHERE id = ?', [id])
  if (!split) return null
  const rows = await h.all<{ id: number; name: string; sets: number; reps: number; weight_lb: number | null }>(
    'SELECT id, name, sets, reps, weight_lb FROM workout_split_exercises WHERE split_id = ? ORDER BY sort_order, id',
    [id],
  )
  return {
    id: split.id,
    name: split.name,
    exercises: rows.map((r) => ({ id: r.id, name: r.name, sets: r.sets, reps: r.reps, weightLb: r.weight_lb })),
  }
}

/** Replaces a split's whole exercise list in one transaction — simpler and safer than diffing rows. */
export async function saveSplit(
  splitId: number | null,
  name: string,
  exercises: readonly SplitExerciseInput[],
  now: number,
): Promise<number> {
  const h = await db()
  return h.transaction(async (tx) => {
    let id = splitId
    if (id == null) {
      const res = await tx.run('INSERT INTO workout_splits (name, sort_order, created_at) VALUES (?,0,?)', [
        name.trim() || 'Split',
        now,
      ])
      id = Number(res.lastInsertRowId)
    } else {
      await tx.run('UPDATE workout_splits SET name = ? WHERE id = ?', [name.trim() || 'Split', id])
      await tx.run('DELETE FROM workout_split_exercises WHERE split_id = ?', [id])
    }

    let sort = 0
    for (const ex of exercises) {
      if (!ex.name.trim()) continue
      await tx.run(
        'INSERT INTO workout_split_exercises (split_id, name, sets, reps, weight_lb, sort_order) VALUES (?,?,?,?,?,?)',
        [id, ex.name.trim(), ex.sets, ex.reps, ex.weightLb, sort++],
      )
    }
    return id
  })
}

export async function deleteSplit(id: number): Promise<void> {
  const h = await db()
  await h.run('DELETE FROM workout_splits WHERE id = ?', [id])
}

// ---------------------------------------------------------------------------
// Logged workouts — the itemized sets/reps/weight behind an exercise_entries
// row, editable after the fact the same way a meal's log_items are.
// ---------------------------------------------------------------------------

/** Roughly 2.5 min per working set, including rest — the same estimate splits.tsx uses to log one. */
const MIN_PER_SET = 2.5

/** Logs a split as one workout: the summary row plus its itemized sets/reps/weight, in one transaction. */
export async function logSplitWorkout(splitId: number, now: number): Promise<number | null> {
  const detail = await splitDetail(splitId)
  if (!detail || detail.exercises.length === 0) return null

  const totalSets = detail.exercises.reduce((a, e) => a + e.sets, 0)
  const minutes = totalSets * MIN_PER_SET
  const weights = await weightHistory()
  const kg = weights[weights.length - 1]?.weightKg ?? 80
  const kcal = exerciseKcal('weights', 'medium', kg, minutes)

  const h = await db()
  return h.transaction(async (tx) => {
    const entry = await tx.run(
      `INSERT INTO exercise_entries (local_date, name, kcal, provenance, external_id, logged_at)
       VALUES (?,?,?,'manual',NULL,?)`,
      [localDate(now), `${detail.name} — ${totalSets} sets`, kcal, now],
    )
    const entryId = Number(entry.lastInsertRowId)

    let sort = 0
    for (const ex of detail.exercises) {
      await tx.run(
        'INSERT INTO exercise_entry_items (exercise_entry_id, name, sets, reps, weight_lb, sort_order) VALUES (?,?,?,?,?,?)',
        [entryId, ex.name, ex.sets, ex.reps, ex.weightLb, sort++],
      )
    }
    return entryId
  })
}

export async function exerciseEntryItems(entryId: number): Promise<SplitExercise[]> {
  const h = await db()
  const rows = await h.all<{ id: number; name: string; sets: number; reps: number; weight_lb: number | null }>(
    'SELECT id, name, sets, reps, weight_lb FROM exercise_entry_items WHERE exercise_entry_id = ? ORDER BY sort_order, id',
    [entryId],
  )
  return rows.map((r) => ({ id: r.id, name: r.name, sets: r.sets, reps: r.reps, weightLb: r.weight_lb }))
}

/**
 * Replaces an entry's whole item list AND recomputes its calorie total from
 * the new total sets — the same deterministic MET arithmetic every other
 * weight-lifting entry uses, so editing reps doesn't leave a stale number
 * sitting next to a changed workout.
 */
export async function saveExerciseEntryItems(
  entryId: number,
  name: string,
  items: readonly SplitExerciseInput[],
): Promise<void> {
  const h = await db()
  const totalSets = items.reduce((a, e) => a + e.sets, 0)
  const weights = await weightHistory()
  const kg = weights[weights.length - 1]?.weightKg ?? 80
  const kcal = exerciseKcal('weights', 'medium', kg, totalSets * MIN_PER_SET)

  await h.transaction(async (tx) => {
    await tx.run('DELETE FROM exercise_entry_items WHERE exercise_entry_id = ?', [entryId])
    let sort = 0
    for (const ex of items) {
      if (!ex.name.trim()) continue
      await tx.run(
        'INSERT INTO exercise_entry_items (exercise_entry_id, name, sets, reps, weight_lb, sort_order) VALUES (?,?,?,?,?,?)',
        [entryId, ex.name.trim(), ex.sets, ex.reps, ex.weightLb, sort++],
      )
    }
    await tx.run('UPDATE exercise_entries SET name = ?, kcal = ? WHERE id = ?', [name.trim() || 'Workout', kcal, entryId])
  })
}

// ---------------------------------------------------------------------------
// Physique — dated photos with an AI body-fat range, never a bare point number
// ---------------------------------------------------------------------------

export interface PhysiqueEntry {
  id: number
  localDate: string
  photoUri: string
  bodyFatPctLow: number | null
  bodyFatPctHigh: number | null
  bodyFatPctEstimate: number | null
  confidence: string | null
  caveats: string[]
  loggedAt: number
}

export async function logPhysique(
  entry: {
    photoUri: string
    bodyFatPctLow: number | null
    bodyFatPctHigh: number | null
    bodyFatPctEstimate: number | null
    confidence: string | null
    caveats: string[]
    provider: string | null
    model: string | null
  },
  now: number,
): Promise<void> {
  const h = await db()
  await h.run(
    `INSERT INTO physique_entries
       (local_date, photo_uri, body_fat_pct_low, body_fat_pct_high, body_fat_pct_estimate,
        confidence, caveats_json, provider, model, logged_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      localDate(now),
      entry.photoUri,
      entry.bodyFatPctLow,
      entry.bodyFatPctHigh,
      entry.bodyFatPctEstimate,
      entry.confidence,
      JSON.stringify(entry.caveats),
      entry.provider,
      entry.model,
      now,
    ],
  )
}

export async function physiqueHistory(): Promise<PhysiqueEntry[]> {
  const h = await db()
  const rows = await h.all<{
    id: number
    local_date: string
    photo_uri: string
    body_fat_pct_low: number | null
    body_fat_pct_high: number | null
    body_fat_pct_estimate: number | null
    confidence: string | null
    caveats_json: string | null
    logged_at: number
  }>('SELECT * FROM physique_entries ORDER BY local_date ASC, id ASC')
  return rows.map((r) => ({
    id: r.id,
    localDate: r.local_date,
    photoUri: r.photo_uri,
    bodyFatPctLow: r.body_fat_pct_low,
    bodyFatPctHigh: r.body_fat_pct_high,
    bodyFatPctEstimate: r.body_fat_pct_estimate,
    confidence: r.confidence,
    caveats: r.caveats_json ? (JSON.parse(r.caveats_json) as string[]) : [],
    loggedAt: r.logged_at,
  }))
}

// ---------------------------------------------------------------------------
// Water
// ---------------------------------------------------------------------------

export async function logWater(ml: number, now: number): Promise<void> {
  if (!Number.isFinite(ml) || ml <= 0) return
  const h = await db()
  await h.run('INSERT INTO water_entries (local_date, ml, logged_at) VALUES (?,?,?)', [localDate(now), ml, now])
}

export async function waterTotal(date: string): Promise<number> {
  const h = await db()
  const row = await h.get<{ ml: number | null }>(
    'SELECT SUM(ml) AS ml FROM water_entries WHERE local_date = ?',
    [date],
  )
  return row?.ml ?? 0
}

/** Undo the most recent add for today — the only correction a quick-add needs. */
export async function undoLastWater(date: string): Promise<void> {
  const h = await db()
  const last = await h.get<{ id: number }>(
    'SELECT id FROM water_entries WHERE local_date = ? ORDER BY logged_at DESC LIMIT 1',
    [date],
  )
  if (last) await h.run('DELETE FROM water_entries WHERE id = ?', [last.id])
}

// ---------------------------------------------------------------------------
// Saved meals — a corrected ingredient list, replayed with zero network calls
// ---------------------------------------------------------------------------

export interface SavedMealItemSnapshot {
  displayName: string
  grams: number
  nutrientSnapshot: {
    kcal: number
    protein_g: number
    fat_g: number
    carbs_g: number
    fiber_g: number | null
    sugar_g: number | null
    sodium_mg: number | null
  }
  isEstimate: boolean
  matchedFoodId: number | null
  isWholeFood: boolean | null
  isAnimalBased: boolean | null
}

export interface SavedMealListEntry {
  id: number
  name: string
  useCount: number
  kcal: number
  itemCount: number
}

/**
 * A hand-typed recipe — no photo, no scan, no corpus match. The whole recipe
 * is one item, its macros entered directly and stored at `grams: 100` so
 * relogging it (which scales by grams/100 like every other saved meal)
 * reproduces exactly what was typed, unscaled.
 */
export async function saveCustomRecipe(
  name: string,
  macros: { kcal: number; protein_g: number; carbs_g: number; fat_g: number },
  now: number,
): Promise<void> {
  const h = await db()
  const payload: SavedMealItemSnapshot[] = [
    {
      displayName: name.trim() || 'Recipe',
      grams: 100,
      nutrientSnapshot: {
        kcal: macros.kcal,
        protein_g: macros.protein_g,
        fat_g: macros.fat_g,
        carbs_g: macros.carbs_g,
        fiber_g: null,
        sugar_g: null,
        sodium_mg: null,
      },
      isEstimate: true,
      matchedFoodId: null,
      isWholeFood: null,
      isAnimalBased: null,
    },
  ]
  await h.run(
    `INSERT INTO saved_meals (name, items_json, use_count, last_used_at, created_at)
     VALUES (?,?,0,NULL,?)`,
    [name.trim() || 'Recipe', JSON.stringify(payload), now],
  )
}

/** Snapshots a logged meal's CURRENT ingredient rows under a name for one-tap relogging. */
export async function saveMealAsTemplate(mealId: number, name: string, now: number): Promise<void> {
  const h = await db()
  const items = await h.all<{
    display_name: string
    grams: number
    snap_energy_kcal: number | null
    snap_protein_g: number | null
    snap_fat_g: number | null
    snap_carb_g: number | null
    snap_fiber_g: number | null
    snap_sugar_g: number | null
    snap_sodium_mg: number | null
    is_estimate: number
    matched_food_id: number | null
    is_whole_food: number | null
    is_animal_based: number | null
  }>(
    `SELECT display_name, grams, snap_energy_kcal, snap_protein_g, snap_fat_g, snap_carb_g,
            snap_fiber_g, snap_sugar_g, snap_sodium_mg, is_estimate, matched_food_id,
            is_whole_food, is_animal_based
     FROM log_items WHERE meal_id = ? ORDER BY sort_order`,
    [mealId],
  )
  if (items.length === 0) return

  const payload: SavedMealItemSnapshot[] = items.map((i) => ({
    displayName: i.display_name,
    grams: i.grams,
    nutrientSnapshot: {
      kcal: i.snap_energy_kcal ?? 0,
      protein_g: i.snap_protein_g ?? 0,
      fat_g: i.snap_fat_g ?? 0,
      carbs_g: i.snap_carb_g ?? 0,
      fiber_g: i.snap_fiber_g,
      sugar_g: i.snap_sugar_g,
      sodium_mg: i.snap_sodium_mg,
    },
    isEstimate: i.is_estimate === 1,
    matchedFoodId: i.matched_food_id,
    isWholeFood: i.is_whole_food == null ? null : i.is_whole_food === 1,
    isAnimalBased: i.is_animal_based == null ? null : i.is_animal_based === 1,
  }))

  await h.run(
    `INSERT INTO saved_meals (name, items_json, use_count, last_used_at, created_at)
     VALUES (?,?,0,NULL,?)`,
    [name.trim() || 'Saved meal', JSON.stringify(payload), now],
  )
}

export async function savedMeals(): Promise<SavedMealListEntry[]> {
  const h = await db()
  const rows = await h.all<{ id: number; name: string; use_count: number; items_json: string }>(
    'SELECT id, name, use_count, items_json FROM saved_meals ORDER BY use_count DESC, last_used_at DESC',
  )
  return rows.map((r) => {
    const items = JSON.parse(r.items_json) as SavedMealItemSnapshot[]
    const kcal = items.reduce((a, i) => a + (i.nutrientSnapshot.kcal * i.grams) / 100, 0)
    return { id: r.id, name: r.name, useCount: r.use_count, kcal, itemCount: items.length }
  })
}

export async function deleteSavedMeal(id: number): Promise<void> {
  const h = await db()
  await h.run('DELETE FROM saved_meals WHERE id = ?', [id])
}

/** Relog a saved meal: one transaction, zero network calls, identical numbers to the day it was saved. */
export async function logSavedMeal(savedMealId: number, now: number): Promise<number | null> {
  const h = await db()
  const row = await h.get<{ items_json: string }>('SELECT items_json FROM saved_meals WHERE id = ?', [savedMealId])
  if (!row) return null
  const items = JSON.parse(row.items_json) as SavedMealItemSnapshot[]
  const date = localDate(now)

  const mealId = await h.transaction(async (tx) => {
    const meal = await tx.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
       VALUES (?,?,?,1.0,'complete',?)`,
      [now, date, slotFor(now), now],
    )
    const id = Number(meal.lastInsertRowId)

    let sort = 0
    for (const item of items) {
      const n = item.nutrientSnapshot
      await tx.run(
        `INSERT INTO log_items (meal_id, matched_food_id, matched_food_source, display_name, grams,
                                gram_pathway, portion_source, snap_energy_kcal, snap_protein_g, snap_fat_g,
                                snap_carb_g, snap_fiber_g, snap_sugar_g, snap_sodium_mg,
                                is_whole_food, is_animal_based,
                                is_estimate, macros_user_edited, sort_order, logged_at)
         VALUES (?,?,?,?,?,'saved_meal','saved_meal',?,?,?,?,?,?,?,?,?,?,0,?,?)`,
        [
          id,
          item.matchedFoodId,
          item.matchedFoodId != null ? 'corpus' : 'estimate',
          item.displayName,
          item.grams,
          n.kcal,
          n.protein_g,
          n.fat_g,
          n.carbs_g,
          n.fiber_g,
          n.sugar_g,
          n.sodium_mg,
          item.isWholeFood == null ? null : item.isWholeFood ? 1 : 0,
          item.isAnimalBased == null ? null : item.isAnimalBased ? 1 : 0,
          item.isEstimate ? 1 : 0,
          sort++,
          now,
        ],
      )
    }
    return id
  })

  await h.run(
    'UPDATE saved_meals SET use_count = use_count + 1, last_used_at = ? WHERE id = ?',
    [now, savedMealId],
  )

  return mealId
}

// ---------------------------------------------------------------------------
// Weight
// ---------------------------------------------------------------------------

export async function logWeight(kg: number, now: number): Promise<void> {
  const h = await db()
  await h.run(
    'INSERT OR REPLACE INTO weight_entries (local_date, weight_kg, logged_at) VALUES (?,?,?)',
    [localDate(now), kg, now],
  )
}

export async function weightHistory(): Promise<WeightPoint[]> {
  const h = await db()
  const rows = await h.all<{ local_date: string; weight_kg: number }>(
    'SELECT local_date, weight_kg FROM weight_entries ORDER BY local_date ASC',
  )
  return rows.map((r) => ({
    day: Math.floor(Date.parse(`${r.local_date}T00:00:00Z`) / 86_400_000),
    weightKg: r.weight_kg,
  }))
}

// ---------------------------------------------------------------------------
// The adaptive loop
// ---------------------------------------------------------------------------

export interface AdaptiveOutcome {
  ran: boolean
  reason: string
  previousKcal?: number
  newKcal?: number
  surfaced?: boolean
  explanation?: string
}

/**
 * Run the adaptive-TDEE estimator and, if it moved enough to matter, write a new
 * goals row.
 *
 * Three gates before it is allowed to change anything, each guarding a real
 * failure:
 *
 *   1. ENOUGH WEIGH-INS. A slope from two points is noise wearing a trend's
 *      clothes.
 *   2. ONLY COMPLETE DAYS feed the intake average. Admitting half-logged days
 *      biases intake downward, which inflates observed TDEE, which RAISES the
 *      target — a silent feedback loop that rewards under-logging.
 *   3. A >= 75 kcal MOVE before anything is surfaced. A target that shifts daily
 *      teaches people to ignore it.
 */
export async function runAdaptive(now: number): Promise<AdaptiveOutcome> {
  const goal = await currentGoal()
  if (!goal) return { ran: false, reason: 'No goal set yet.' }
  if (!goal.adaptive) return { ran: false, reason: 'Adaptive targets are off — you set this target by hand.' }

  const points = await weightHistory()
  if (points.length < 5) {
    return { ran: false, reason: `Needs about ${5 - points.length} more weigh-ins before the trend means anything.` }
  }

  const trend = computeTrend(points)
  const slope = trendSlopeLbPerWeek(trend)
  if (slope == null) return { ran: false, reason: 'Not enough spread in your weigh-ins yet.' }

  const h = await db()
  const days = await h.all<{ local_date: string }>(
    'SELECT DISTINCT local_date FROM meals ORDER BY local_date DESC LIMIT 21',
  )

  let sum = 0
  let admitted = 0
  for (const d of days) {
    const t = await dayTotals(d.local_date)
    const complete = isDayCompleteEnough({
      mealCount: t.mealCount,
      distinctSlotCount: t.distinctSlots,
      hasQueuedEntries: t.pendingCount > 0,
    })
    if (!complete) continue
    sum += t.kcal
    admitted++
  }

  if (admitted < 5) {
    return { ran: false, reason: `Needs about ${5 - admitted} more fully-logged days before adjusting your target.` }
  }

  const updateCount = Number(await setting('adaptive.updateCount', '0'))
  const result = updateAdaptiveTdee({
    currentTdee: goal.targetKcal,
    avgDailyIntakeKcal: sum / admitted,
    trendSlopeLbPerWeek: slope,
    updateCount,
  })

  await putSetting('adaptive.updateCount', String(updateCount + 1))
  await putSetting('adaptive.lastRunAt', String(now))

  if (!result.shouldSurface) {
    return {
      ran: true,
      reason: 'Your target is still right — no change worth showing.',
      previousKcal: goal.targetKcal,
      newKcal: result.newTdee,
      surfaced: false,
    }
  }

  // Macros re-derive from the new target so protein tracks the body, not the
  // budget, and carbs stay the single derived remainder.
  const profile = await h.get<{ height_cm: number }>('SELECT height_cm FROM user_profile WHERE id = 1')
  const latestKg = points[points.length - 1]?.weightKg ?? 80
  const macros = computeMacros(result.newTdee, latestKg, goal.goalType)

  await h.run(
    `INSERT INTO goals
       (effective_from, goal_type, rate_lb_per_week, target_kcal, target_raw_kcal,
        floor_applied, protein_g, fat_g, carbs_g, bmr, tdee, adaptive)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,1)`,
    [
      now,
      goal.goalType,
      null,
      result.newTdee,
      result.newTdee,
      0,
      macros.protein_g,
      macros.fat_g,
      macros.carbs_g,
      goal.bmr,
      result.observedTdee,
    ],
  )
  void profile

  return {
    ran: true,
    reason: 'Target updated.',
    previousKcal: goal.targetKcal,
    newKcal: result.newTdee,
    surfaced: true,
    explanation: result.explanation,
  }
}
