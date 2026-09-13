import type { DbAdapter } from '@nutai/db-adapter'

/**
 * Whole-food / animal-based classification from USDA's own 28-category
 * taxonomy (`foods.category`, populated in tools/nutrition-data/src/build.mjs
 * from food_category.csv — real data, not a guess).
 *
 * Kept in ONE place because it now feeds two different things that must never
 * silently disagree: the resolver's search ranking (packages/resolver's
 * categoryQuality, which duplicates this list since that package can't import
 * from the mobile app) and this app's Health Score.
 */

const WHOLE_FOOD_CATEGORIES = new Set([
  'Dairy and Egg Products',
  'Poultry Products',
  'Fruits and Fruit Juices',
  'Pork Products',
  'Vegetables and Vegetable Products',
  'Nut and Seed Products',
  'Beef Products',
  'Finfish and Shellfish Products',
  'Legumes and Legume Products',
  'Lamb, Veal, and Game Products',
])

const ANIMAL_BASED_CATEGORIES = new Set([
  'Dairy and Egg Products',
  'Poultry Products',
  'Pork Products',
  'Beef Products',
  'Finfish and Shellfish Products',
  'Lamb, Veal, and Game Products',
  'Sausages and Luncheon Meats',
])

export interface FoodClassification {
  /** true = a single whole ingredient. false = branded/restaurant/prepared/refined. null = unknown category. */
  isWholeFood: boolean | null
  /** true = meat, fish, dairy, or eggs. false = plant-based or clearly non-animal. null = unknown category. */
  isAnimalBased: boolean | null
}

export function classifyCategory(category: string | null | undefined): FoodClassification {
  if (category == null) return { isWholeFood: null, isAnimalBased: null }
  return {
    isWholeFood: WHOLE_FOOD_CATEGORIES.has(category),
    isAnimalBased: ANIMAL_BASED_CATEGORIES.has(category),
  }
}

export interface AdherenceShares {
  wholeFoodShare: number | null
  animalBasedShare: number | null
}

type IngredientLike = { sourceFoodId: string | null; grams: number; nutrientSnapshot: { kcal: number } }

/**
 * The DB half: which corpus foods classify which way. Split out from the
 * aggregation below so a caller (the scan-review screen) can re-run the cheap
 * synchronous math on every gram edit without re-querying the database each
 * keystroke — the classification of a food doesn't change just because its
 * quantity did.
 */
export async function fetchClassifications(
  nutritionDb: DbAdapter,
  sourceFoodIds: readonly (string | null)[],
): Promise<Map<string, FoodClassification>> {
  const ids = [...new Set(sourceFoodIds.filter((id): id is string => id != null))]
  const out = new Map<string, FoodClassification>()
  if (ids.length === 0) return out
  const placeholders = ids.map(() => '?').join(',')
  const rows = await nutritionDb.all<{ id: number; category: string | null }>(
    `SELECT id, category FROM foods WHERE id IN (${placeholders})`,
    ids.map((id) => Number(id)),
  )
  const byId = new Map(rows.map((r) => [String(r.id), r.category]))
  for (const id of ids) out.set(id, classifyCategory(byId.get(id) ?? null))
  return out
}

/** Pure, synchronous: kcal-weighted whole-food / animal-based share from an already-fetched classification map. */
export function aggregateAdherence(
  ingredients: readonly IngredientLike[],
  classifications: ReadonlyMap<string, FoodClassification>,
): AdherenceShares {
  let classifiedKcal = 0
  let wholeFoodKcal = 0
  let animalBasedKcal = 0
  for (const item of ingredients) {
    if (item.sourceFoodId == null) continue
    const cls = classifications.get(item.sourceFoodId)
    if (cls == null || cls.isWholeFood == null) continue
    const kcal = (item.nutrientSnapshot.kcal * item.grams) / 100
    classifiedKcal += kcal
    if (cls.isWholeFood) wholeFoodKcal += kcal
    if (cls.isAnimalBased) animalBasedKcal += kcal
  }
  return {
    wholeFoodShare: classifiedKcal > 0 ? wholeFoodKcal / classifiedKcal : null,
    animalBasedShare: classifiedKcal > 0 ? animalBasedKcal / classifiedKcal : null,
  }
}

/**
 * Whole-food / animal-based share of calories for an UNLOGGED set of
 * ingredients — the scan-review screen's own preview of what its Health Score
 * will be once logged. A live corpus lookup, not a stored snapshot: nothing
 * here is written to the diary, so there is no historical number to protect
 * from drifting the way `classifyIngredients` in repo.ts protects log_items.
 */
export async function previewAdherence(
  nutritionDb: DbAdapter,
  ingredients: readonly IngredientLike[],
): Promise<AdherenceShares> {
  const classifications = await fetchClassifications(nutritionDb, ingredients.map((i) => i.sourceFoodId))
  return aggregateAdherence(ingredients, classifications)
}
