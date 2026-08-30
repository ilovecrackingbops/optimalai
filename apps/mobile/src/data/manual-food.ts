import type { DbAdapter } from '@nutai/db-adapter'
import type { NutrientRow100g } from '@nutai/core-schema'
import { localDate, slotFor } from './date-utils'

/**
 * A food picked directly off the Food Database search screen — no photo, no
 * model call. `nutrientSnapshot` is the resolved row's real per-100 g values;
 * `logManualFood` scales them to `grams` and copies the result in at log
 * time, exactly like every other logging path, so a later corpus rebuild can
 * never move a historical log's numbers.
 *
 * This takes its `DbAdapter` as a parameter rather than reaching for repo.ts's
 * cached app singleton — same shape as `backup-core.ts` — specifically so it
 * is testable under plain Node against `@nutai/db-adapter/node`'s
 * `openMemoryDb()`. The singleton's `db()` calls `openUserDb()` in
 * `apps/mobile/src/db/expo-adapter.ts`, which imports `expo-sqlite`; that
 * import throws under Node, so any function that hard-codes it can only ever
 * be exercised inside a running app, never in this test suite.
 */
export interface ManualFoodSelection {
  foodId: number
  displayName: string
  grams: number
  nutrientSnapshot: NutrientRow100g
  isWholeFood: boolean | null
  isAnimalBased: boolean | null
}

export async function logManualFood(h: DbAdapter, selection: ManualFoodSelection, now: number): Promise<number> {
  const date = localDate(now)
  const n = selection.nutrientSnapshot

  return h.transaction(async (tx) => {
    const meal = await tx.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
       VALUES (?,?,?,1.0,'complete',?)`,
      [now, date, slotFor(now), now],
    )
    const mealId = Number(meal.lastInsertRowId)

    await tx.run(
      `INSERT INTO log_items (meal_id, matched_food_id, matched_food_source, display_name, grams,
                              gram_pathway, portion_source, snap_energy_kcal, snap_protein_g, snap_fat_g,
                              snap_carb_g, snap_fiber_g, snap_sugar_g, snap_sodium_mg,
                              is_whole_food, is_animal_based,
                              is_estimate, macros_user_edited, sort_order, logged_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,0,0,0,?)`,
      [
        mealId,
        selection.foodId,
        'corpus',
        selection.displayName,
        selection.grams,
        'fndds_standard_portion',
        'db_search',
        // Per-100 g, unscaled — every reader (dayTotals, mealDetail, ...)
        // multiplies snap_* by grams/100 itself. Pre-scaling here was double-
        // applying that factor: a 28 g default portion got stored as its
        // ALREADY-scaled ~77 kcal, and dayTotals then scaled it AGAIN by
        // 28/100. Editing the grams afterward (a very natural "actually I
        // want 100 g" correction) made it worse, not better — the stale
        // pre-scaled number just got multiplied by the new gram figure
        // instead of the true per-100g rate, which is the exact "100 g of
        // bread came out to 79 kcal" bug this fixes.
        n.kcal,
        n.protein_g,
        n.fat_g,
        n.carbs_g,
        n.fiber_g ?? null,
        n.sugar_g ?? null,
        n.sodium_mg ?? null,
        selection.isWholeFood == null ? null : selection.isWholeFood ? 1 : 0,
        selection.isAnimalBased == null ? null : selection.isAnimalBased ? 1 : 0,
        now,
      ],
    )

    return mealId
  })
}
