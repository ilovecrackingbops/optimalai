import type { DbAdapter } from '@nutai/db-adapter'

/**
 * The same headline micronutrient list and FDA adult daily values as
 * tools/nutrition-data/src/build.mjs's MICRO_NUTRIENTS — duplicated rather
 * than shared, the same call as WHOLE_FOOD_CATEGORIES in food-category.ts:
 * build.mjs runs as plain Node outside the app's TypeScript workspace graph.
 */
export const MICRO_NUTRIENTS: Record<string, { label: string; unit: string; dvAmount: number }> = {
  iron_mg: { label: 'Iron', unit: 'mg', dvAmount: 18 },
  vitamin_b12_ug: { label: 'Vitamin B12', unit: 'µg', dvAmount: 2.4 },
  choline_mg: { label: 'Choline', unit: 'mg', dvAmount: 550 },
  zinc_mg: { label: 'Zinc', unit: 'mg', dvAmount: 11 },
  vitamin_d_ug: { label: 'Vitamin D', unit: 'µg', dvAmount: 20 },
  magnesium_mg: { label: 'Magnesium', unit: 'mg', dvAmount: 420 },
  potassium_mg: { label: 'Potassium', unit: 'mg', dvAmount: 4700 },
  vitamin_a_rae_ug: { label: 'Vitamin A', unit: 'µg', dvAmount: 900 },
  vitamin_c_mg: { label: 'Vitamin C', unit: 'mg', dvAmount: 90 },
  calcium_mg: { label: 'Calcium', unit: 'mg', dvAmount: 1300 },
  folate_ug: { label: 'Folate', unit: 'µg', dvAmount: 400 },
  vitamin_b6_mg: { label: 'Vitamin B6', unit: 'mg', dvAmount: 1.7 },
  selenium_ug: { label: 'Selenium', unit: 'µg', dvAmount: 55 },
}

export interface NutrientHighlight {
  code: string
  label: string
  /** Summed %DV across every logged item that reported this nutrient, clamped to 999. */
  pctDv: number
}

interface LoggedItemRow {
  matched_food_id: number | null
  grams: number
  portion_eaten_fraction: number
}

/**
 * A simple %DV bar per headline micronutrient — a live join between today's
 * corpus-matched log_items and the corpus's own food_micros table. Advisory
 * and informational, not a tracked or stored total (like Health Score), so a
 * live join here does not risk a past day's NUMBER silently changing the way
 * it would for kcal/macros — there is no stored micronutrient figure to drift.
 * Only listed once the day's total clears 8% DV — the FDA's own "good
 * source" threshold — so a trace amount doesn't clutter the list.
 */
export async function nutrientHighlights(
  userDb: DbAdapter,
  nutritionDb: DbAdapter,
  date: string,
): Promise<NutrientHighlight[]> {
  const items = await userDb.all<LoggedItemRow>(
    `SELECT li.matched_food_id, li.grams, m.portion_eaten_fraction
     FROM log_items li
     JOIN meals m ON m.id = li.meal_id
     WHERE m.local_date = ? AND m.analysis_status IN ('complete','manual') AND li.matched_food_id IS NOT NULL`,
    [date],
  )
  if (items.length === 0) return []

  const foodIds = [...new Set(items.map((i) => i.matched_food_id).filter((id): id is number => id != null))]
  const placeholders = foodIds.map(() => '?').join(',')
  const micros = await nutritionDb.all<{ food_id: number; nutrient_code: string; amount: number }>(
    `SELECT food_id, nutrient_code, amount FROM food_micros WHERE food_id IN (${placeholders})`,
    foodIds,
  )
  const byFood = new Map<number, Map<string, number>>()
  for (const m of micros) {
    if (!byFood.has(m.food_id)) byFood.set(m.food_id, new Map())
    byFood.get(m.food_id)!.set(m.nutrient_code, m.amount)
  }

  const totalsPctDv = new Map<string, number>()
  for (const item of items) {
    if (item.matched_food_id == null) continue
    const perFood = byFood.get(item.matched_food_id)
    if (!perFood) continue
    const scale = (item.grams / 100) * item.portion_eaten_fraction

    for (const [code, ref] of Object.entries(MICRO_NUTRIENTS)) {
      const per100g = perFood.get(code)
      if (per100g == null) continue
      const pctDv = ((per100g * scale) / ref.dvAmount) * 100
      totalsPctDv.set(code, (totalsPctDv.get(code) ?? 0) + pctDv)
    }
  }

  const out: NutrientHighlight[] = []
  for (const [code, pctDv] of totalsPctDv) {
    if (pctDv < 8) continue
    const ref = MICRO_NUTRIENTS[code]
    if (!ref) continue
    out.push({ code, label: ref.label, pctDv: Math.min(999, pctDv) })
  }
  return out.sort((a, b) => b.pctDv - a.pctDv)
}
