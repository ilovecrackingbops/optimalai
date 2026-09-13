import { beforeEach, describe, expect, it } from 'vitest'
import { migrate } from './migrate.js'
import { openMemoryDb } from './node.js'
import type { DbAdapter } from './types.js'

/**
 * Scheduled meals and day-copying, against the REAL migrated schema.
 *
 * repo.ts's `schedulePlannedMeal` / `materializePlannedMeals` / `copyMealsFromDate`
 * cannot run under bare Node — they go through the expo-sqlite adapter. These
 * tests exercise the exact SQL shapes those functions use, the same
 * arrangement `meal-roundtrip.test.ts` uses for `dayTotals`, so a schema
 * rename or a wrong column count shows up here instead of only on device.
 */

let db: DbAdapter
const NOW = 1_754_000_000_000 // a Sunday-ish instant; exact weekday doesn't matter here

beforeEach(async () => {
  db = openMemoryDb()
  await migrate(db, NOW)
})

async function saveMeal(name: string, kcal: number): Promise<number> {
  const items = [
    {
      displayName: name,
      grams: 100,
      nutrientSnapshot: { kcal, protein_g: 10, fat_g: 5, carbs_g: 20, fiber_g: null, sugar_g: null, sodium_mg: null },
      isEstimate: true,
      matchedFoodId: null,
      isWholeFood: null,
      isAnimalBased: null,
    },
  ]
  const r = await db.run(
    `INSERT INTO saved_meals (name, items_json, use_count, last_used_at, created_at) VALUES (?,?,0,NULL,?)`,
    [name, JSON.stringify(items), NOW],
  )
  return Number(r.lastInsertRowId)
}

async function schedule(
  savedMealId: number,
  target: { localDate: string } | { weekday: number },
  mealSlot: string | null,
): Promise<void> {
  await db.run(
    `INSERT INTO planned_meals (saved_meal_id, meal_slot, local_date, weekday, created_at) VALUES (?,?,?,?,?)`,
    [savedMealId, mealSlot, 'localDate' in target ? target.localDate : null, 'weekday' in target ? target.weekday : null, NOW],
  )
}

/** Mirrors repo.ts's materializePlannedMeals — same query, same insert shape. */
async function materialize(date: string, weekday: number): Promise<number> {
  const due = await db.all<{ id: number; saved_meal_id: number; meal_slot: string | null; local_date: string | null; items_json: string }>(
    `SELECT pm.id, pm.saved_meal_id, pm.meal_slot, pm.local_date, sm.items_json
     FROM planned_meals pm JOIN saved_meals sm ON sm.id = pm.saved_meal_id
     WHERE (pm.local_date = ? OR pm.weekday = ?)
       AND NOT EXISTS (SELECT 1 FROM planned_meal_log l WHERE l.planned_meal_id = pm.id AND l.local_date = ?)`,
    [date, weekday, date],
  )
  for (const plan of due) {
    const items = JSON.parse(plan.items_json) as { displayName: string; grams: number; nutrientSnapshot: { kcal: number } }[]
    const meal = await db.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
       VALUES (?,?,?,1.0,'complete',?)`,
      [NOW, date, plan.meal_slot, NOW],
    )
    const mealId = Number(meal.lastInsertRowId)
    for (const item of items) {
      await db.run(
        `INSERT INTO log_items (meal_id, matched_food_source, display_name, grams, gram_pathway, portion_source,
                                snap_energy_kcal, is_estimate, macros_user_edited, sort_order, logged_at)
         VALUES (?,'estimate',?,?,'saved_meal','saved_meal',?,1,0,0,?)`,
        [mealId, item.displayName, item.grams, item.nutrientSnapshot.kcal, NOW],
      )
    }
    await db.run(`INSERT INTO planned_meal_log (planned_meal_id, local_date, meal_id) VALUES (?,?,?)`, [
      plan.id,
      date,
      mealId,
    ])
    if (plan.local_date != null) {
      await db.run('DELETE FROM planned_meals WHERE id = ?', [plan.id])
    }
  }
  return due.length
}

describe('scheduled meals', () => {
  it('rejects a plan with neither a date nor a weekday', async () => {
    const mealId = await saveMeal('Oats', 300)
    await expect(
      db.run(`INSERT INTO planned_meals (saved_meal_id, meal_slot, local_date, weekday, created_at) VALUES (?,?,?,?,?)`, [
        mealId,
        null,
        null,
        null,
        NOW,
      ]),
    ).rejects.toThrow()
  })

  it('rejects a plan with BOTH a date and a weekday', async () => {
    const mealId = await saveMeal('Oats', 300)
    await expect(
      db.run(`INSERT INTO planned_meals (saved_meal_id, meal_slot, local_date, weekday, created_at) VALUES (?,?,?,?,?)`, [
        mealId,
        null,
        '2026-09-10',
        1,
        NOW,
      ]),
    ).rejects.toThrow()
  })

  it('materializes a one-off plan into a real logged meal on its date', async () => {
    const mealId = await saveMeal('Overnight oats', 320)
    await schedule(mealId, { localDate: '2026-09-10' }, 'breakfast')

    const n = await materialize('2026-09-10', 4)
    expect(n).toBe(1)

    const logged = await db.get<{ kcal: number; meal_slot: string }>(
      `SELECT SUM(li.snap_energy_kcal * li.grams / 100.0) kcal, m.meal_slot
       FROM meals m JOIN log_items li ON li.meal_id = m.id
       WHERE m.local_date = '2026-09-10' GROUP BY m.id`,
    )
    expect(logged!.kcal).toBeCloseTo(320, 6)
    expect(logged!.meal_slot).toBe('breakfast')
  })

  it('deletes a one-off plan after it fires — it can never match that date again', async () => {
    const mealId = await saveMeal('Overnight oats', 320)
    await schedule(mealId, { localDate: '2026-09-10' }, null)
    await materialize('2026-09-10', 4)

    const remaining = await db.get<{ c: number }>('SELECT COUNT(*) c FROM planned_meals')
    expect(remaining!.c).toBe(0)
  })

  it('is idempotent — viewing the same day twice never double-logs', async () => {
    const mealId = await saveMeal('Overnight oats', 320)
    await schedule(mealId, { localDate: '2026-09-10' }, null)
    await materialize('2026-09-10', 4)
    await materialize('2026-09-10', 4) // plan already deleted; simulates a second reload

    const meals = await db.all('SELECT id FROM meals')
    expect(meals).toHaveLength(1)
  })

  it('a recurring weekly plan survives firing and fires again next week, but not twice the same week', async () => {
    const mealId = await saveMeal('Protein shake', 220)
    await schedule(mealId, { weekday: 1 }, null) // every Monday

    const firstMonday = await materialize('2026-09-07', 1)
    expect(firstMonday).toBe(1)

    // Same Monday viewed again (e.g. app reopened): the dedupe ledger blocks it.
    const sameMondayAgain = await materialize('2026-09-07', 1)
    expect(sameMondayAgain).toBe(0)

    // Next Monday: a new date, no ledger entry for THAT date yet, fires again.
    const nextMonday = await materialize('2026-09-14', 1)
    expect(nextMonday).toBe(1)

    const meals = await db.all('SELECT id FROM meals')
    expect(meals).toHaveLength(2)
    const stillScheduled = await db.get<{ c: number }>('SELECT COUNT(*) c FROM planned_meals')
    expect(stillScheduled!.c).toBe(1)
  })

  it('never materializes a plan for a day that has not arrived — the guard lives in repo.ts, not the SQL, so this documents the query alone still fires if called directly', async () => {
    // This test intentionally shows the raw query has no date guard of its
    // own — `materializePlannedMeals` in repo.ts refuses `date > localDate(now)`
    // before ever running this query. Documented here so the guard is not
    // mistaken for redundant if someone "simplifies" it away later.
    const mealId = await saveMeal('Future feast', 500)
    await schedule(mealId, { localDate: '2099-01-01' }, null)
    const n = await materialize('2099-01-01', 4)
    expect(n).toBe(1)
  })
})

describe('copying a day', () => {
  async function insertMeal(date: string, slot: string, portionEaten = 1): Promise<number> {
    const r = await db.run(
      `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
       VALUES (?,?,?,?,'complete',?)`,
      [NOW, date, slot, portionEaten, NOW],
    )
    return Number(r.lastInsertRowId)
  }
  async function insertItem(mealId: number, kcal: number, grams: number): Promise<void> {
    await db.run(
      `INSERT INTO log_items (meal_id, matched_food_source, display_name, grams, gram_pathway, portion_source,
                              snap_energy_kcal, is_estimate, macros_user_edited, sort_order, logged_at)
       VALUES (?,'corpus',?,?,'fndds_standard_portion','db_search',?,0,0,0,?)`,
      [mealId, 'Chicken breast', grams, kcal, NOW],
    )
  }

  /** Mirrors repo.ts's copyMealsFromDate. */
  async function copyDay(fromDate: string, toDate: string): Promise<number> {
    const sourceMeals = await db.all<{ id: number; meal_slot: string | null; portion_eaten_fraction: number }>(
      `SELECT id, meal_slot, portion_eaten_fraction FROM meals
       WHERE local_date = ? AND analysis_status IN ('complete','manual') ORDER BY logged_at`,
      [fromDate],
    )
    for (const meal of sourceMeals) {
      const items = await db.all<{ display_name: string; grams: number; snap_energy_kcal: number | null }>(
        'SELECT display_name, grams, snap_energy_kcal FROM log_items WHERE meal_id = ? ORDER BY sort_order',
        [meal.id],
      )
      const inserted = await db.run(
        `INSERT INTO meals (logged_at, local_date, meal_slot, portion_eaten_fraction, analysis_status, created_at)
         VALUES (?,?,?,?,'complete',?)`,
        [NOW, toDate, meal.meal_slot, meal.portion_eaten_fraction, NOW],
      )
      const newMealId = Number(inserted.lastInsertRowId)
      for (const item of items) {
        await db.run(
          `INSERT INTO log_items (meal_id, matched_food_source, display_name, grams, gram_pathway, portion_source,
                                  snap_energy_kcal, is_estimate, macros_user_edited, sort_order, logged_at)
           VALUES (?,'corpus',?,?,'fndds_standard_portion','db_search',?,0,0,0,?)`,
          [newMealId, item.display_name, item.grams, item.snap_energy_kcal, NOW],
        )
      }
    }
    return sourceMeals.length
  }

  it('clones every complete meal from one day onto another', async () => {
    const m1 = await insertMeal('2026-09-09', 'breakfast')
    await insertItem(m1, 165, 150)
    const m2 = await insertMeal('2026-09-09', 'dinner')
    await insertItem(m2, 250, 200)

    const n = await copyDay('2026-09-09', '2026-09-10')
    expect(n).toBe(2)

    const totals = await db.get<{ kcal: number; meals: number }>(
      `SELECT SUM(li.snap_energy_kcal * li.grams / 100.0) kcal, COUNT(DISTINCT m.id) meals
       FROM meals m JOIN log_items li ON li.meal_id = m.id WHERE m.local_date = '2026-09-10'`,
    )
    expect(totals!.meals).toBe(2)
    expect(totals!.kcal).toBeCloseTo(165 * 1.5 + 250 * 2, 6)

    // The source day is untouched — this is a copy, not a move.
    const sourceStillThere = await db.get<{ c: number }>("SELECT COUNT(*) c FROM meals WHERE local_date = '2026-09-09'")
    expect(sourceStillThere!.c).toBe(2)
  })

  it('copies nothing from an empty or pending-only day', async () => {
    const pending = await db.run(
      `INSERT INTO meals (logged_at, local_date, analysis_status, created_at) VALUES (?,?, 'analyzing', ?)`,
      [NOW, '2026-09-09', NOW],
    )
    void pending
    const n = await copyDay('2026-09-09', '2026-09-10')
    expect(n).toBe(0)
  })
})
