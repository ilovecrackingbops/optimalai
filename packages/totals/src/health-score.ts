import type { MacroTotals } from '@nutai/core-schema'

/**
 * Whole-food and animal-based adherence, as a share of the day's CALORIES
 * (not item count — one candy bar shouldn't be diluted to nothing by nine
 * grams of parsley). Comes from `foods.category` in the corpus (USDA's own
 * taxonomy, see tools/nutrition-data/src/build.mjs), snapshotted onto each
 * log_item at log time. `null` on either field means "no classified items to
 * judge by" (e.g. everything logged was an AI estimate with no corpus match)
 * — the rule it feeds is skipped entirely rather than guessing.
 */
export interface Adherence {
  wholeFoodShare: number | null
  animalBasedShare: number | null
}

/**
 * The health score: 0-10, computed by ARITHMETIC over the day's totals.
 *
 * D16 applies here with full force — the model never produces this number, and
 * there is no "AI thinks this is healthy" anywhere in the app. Every point comes
 * from a named, threshold-based rule the user can read by tapping the score, and
 * the same day always scores the same.
 *
 * Rebuilt around whole-food and animal-based ADHERENCE rather than fiber and
 * sugar totals: those two nutrients are a poor proxy for "whole foods, animal
 * forward" eating on their own — a candy bar and an apple can carry the same
 * sugar grams, and a day of oysters and ribeye carries next to no fiber at all
 * without being anything other than exactly what this score means to reward.
 * Sugar is not scored directly at all: as long as it comes from a whole food,
 * this formula has no objection to it — the whole-food-share rule already
 * prices in a soda or a candy bar through THAT signal instead.
 *
 *   + whole-food share of calories   (THE primary lever — plain ingredients,
 *                                      not branded, restaurant, or prepared
 *                                      food, regardless of their macros)
 *   + animal-based share of calories (red meat, organ meat, eggs, oysters and
 *                                      other seafood, dairy — Paul-Saladino-
 *                                      style priority, independent of the
 *                                      whole-food share so a day of grilled
 *                                      chicken and steak scores as well as a
 *                                      day of produce)
 *   + protein share of energy        (still rewarded — satiety and lean-mass
 *                                      preservation, and it is usually the
 *                                      same foods scoring well above anyway)
 *   - sodium per 100 kcal            (a light touch, not a hard gate — meat and
 *                                      seafood are naturally sodium-bearing)
 *   - energy density, when grams are known, UNLESS the food is whole (a dense
 *     whole food like nuts or olive oil should not be punished for being
 *     calorie-dense the way a candy bar should)
 *
 * Saturated fat is deliberately absent, and deliberately not treated as a
 * negative on principle — a whole-foods, animal-forward diet does not avoid
 * fat, so this score never penalizes fat share the way a low-fat-diet scoring
 * model would.
 */

export interface HealthScore {
  /** 0-10 integer. */
  score: number
  /** One line per rule that actually fired, for the tap-to-see-why sheet. */
  reasons: string[]
}

export function healthScore(t: MacroTotals, totalGrams?: number, adherence?: Adherence): HealthScore | null {
  // Below ~30 kcal the shares are numerically meaningless (black coffee, a
  // pickle). No score beats a silly one.
  if (!Number.isFinite(t.kcal) || t.kcal < 30) return null

  let score = 3.5
  const reasons: string[] = []

  const wholeFoodShare = adherence?.wholeFoodShare ?? null
  const animalBasedShare = adherence?.animalBasedShare ?? null

  if (wholeFoodShare != null) {
    if (wholeFoodShare >= 0.85) {
      score += 3
      reasons.push('Almost entirely whole foods — little to no branded or prepared food')
    } else if (wholeFoodShare >= 0.6) {
      score += 2
      reasons.push('Mostly whole foods')
    } else if (wholeFoodShare >= 0.3) {
      score += 0.5
      reasons.push('A mix of whole and processed or prepared food')
    } else {
      score -= 1
      reasons.push('Mostly branded, restaurant, or prepared food')
    }
  }

  if (animalBasedShare != null) {
    if (animalBasedShare >= 0.5) {
      score += 2
      reasons.push('Animal-forward — meat, seafood, eggs or dairy carried most of these calories')
    } else if (animalBasedShare >= 0.2) {
      score += 1
      reasons.push('A solid share of animal-based calories')
    }
  }

  const proteinShare = (4 * t.protein_g) / t.kcal
  if (proteinShare >= 0.25) {
    score += 1.5
    reasons.push('Very high in protein for its calories — red meat, organ meat, eggs and seafood territory')
  } else if (proteinShare >= 0.15) {
    score += 1
    reasons.push('High in protein for its calories')
  } else if (proteinShare >= 0.08) {
    score += 0.5
    reasons.push('A reasonable amount of protein')
  }

  const sodiumPer100 = (t.sodium_mg * 100) / t.kcal
  if (sodiumPer100 >= 600) {
    score -= 1
    reasons.push('Very high in sodium for its calories')
  } else if (sodiumPer100 >= 350) {
    score -= 0.5
    reasons.push('High in sodium for its calories')
  }

  if (totalGrams != null && totalGrams > 0) {
    const density = t.kcal / totalGrams
    // A dense whole food (nuts, olive oil, salmon) should not be punished the
    // way a dense candy bar should — gate the penalty on wholeFoodShare when
    // it is known, and fall back to a neutral gate when it is not.
    const denseButWhole = wholeFoodShare != null && wholeFoodShare >= 0.6
    if (density >= 3 && !denseButWhole) {
      score -= 1
      reasons.push('Calorie-dense — a small weight carries a lot of energy')
    } else if (density <= 1 && wholeFoodShare !== 0) {
      // wholeFoodShare === 0 (known and entirely non-whole) is the soda/candy
      // case: low density because it is water or air, not because it is
      // filling. Anything else — unknown, or genuinely whole — earns the
      // bonus, the same way a watermelon should.
      score += 1
      reasons.push('Low calorie density — filling for its calories')
    }
  }

  return {
    score: Math.max(0, Math.min(10, Math.round(score))),
    reasons,
  }
}
