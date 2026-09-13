import { describe, expect, it } from 'vitest'
import type { MacroTotals } from '@nutai/core-schema'
import { healthScore, type Adherence } from './health-score.js'

const meal = (over: Partial<MacroTotals>): MacroTotals => ({
  kcal: 500, protein_g: 20, fat_g: 15, carbs_g: 60, fiber_g: 5, sugar_g: 8, sodium_mg: 500,
  ...over,
})

const wholeAnimal: Adherence = { wholeFoodShare: 1, animalBasedShare: 1 }
const brandedNonAnimal: Adherence = { wholeFoodShare: 0, animalBasedShare: 0 }

describe('healthScore', () => {
  it('is deterministic arithmetic — same day, same score, every time', () => {
    const t = meal({})
    expect(healthScore(t, undefined, wholeAnimal)).toEqual(healthScore(t, undefined, wholeAnimal))
  })

  it('declines to score a trivial-calorie item instead of scoring it absurdly', () => {
    expect(healthScore(meal({ kcal: 5 }), undefined, wholeAnimal)).toBeNull()
  })

  it('rewards whole-food, animal-based adherence and punishes branded/processed, plant-only eating', () => {
    const steakAndEggs = healthScore(
      meal({ kcal: 420, protein_g: 45, fiber_g: 0, sugar_g: 1, sodium_mg: 380 }),
      450,
      wholeAnimal,
    )!
    const fastFood = healthScore(
      { kcal: 700, protein_g: 15, fat_g: 35, carbs_g: 70, fiber_g: 2, sugar_g: 20, sodium_mg: 1200 },
      300,
      brandedNonAnimal,
    )!
    expect(steakAndEggs.score).toBeGreaterThanOrEqual(8)
    expect(fastFood.score).toBeLessThanOrEqual(3)
  })

  it('does not penalize sugar that comes from a whole food', () => {
    // A banana: real sugar grams, but wholeFoodShare says it is a whole food —
    // the formula has no separate sugar rule to fight that.
    const banana = healthScore(
      { kcal: 105, protein_g: 1.3, fat_g: 0.4, carbs_g: 27, fiber_g: 3.1, sugar_g: 14, sodium_mg: 1 },
      118,
      { wholeFoodShare: 1, animalBasedShare: 0 },
    )!
    // A candy bar with the SAME sugar grams and similar calories, but flagged
    // as not-whole-food, should score meaningfully worse.
    const candyBar = healthScore(
      { kcal: 105, protein_g: 1.3, fat_g: 0.4, carbs_g: 27, fiber_g: 0, sugar_g: 14, sodium_mg: 1 },
      30,
      { wholeFoodShare: 0, animalBasedShare: 0 },
    )!
    expect(banana.score).toBeGreaterThan(candyBar.score)
  })

  it('every point traces to a named reason', () => {
    const s = healthScore(meal({ protein_g: 45, sodium_mg: 2400 }), undefined, wholeAnimal)!
    expect(s.reasons.length).toBeGreaterThanOrEqual(3)
    for (const r of s.reasons) expect(typeof r).toBe('string')
  })

  it('does not punish a calorie-dense WHOLE food the way it punishes a dense processed one', () => {
    const nuts = healthScore(meal({}), 30, { wholeFoodShare: 0.9, animalBasedShare: 0 })!
    const candy = healthScore(meal({}), 30, { wholeFoodShare: 0, animalBasedShare: 0 })!
    expect(nuts.score).toBeGreaterThan(candy.score)
  })

  it('degrades gracefully with no adherence data at all — never crashes, never guesses', () => {
    const s = healthScore(meal({}))!
    expect(s.score).toBeGreaterThanOrEqual(0)
    expect(s.score).toBeLessThanOrEqual(10)
  })

  it('stays inside 0..10 at the extremes', () => {
    const worst = healthScore(
      { kcal: 800, protein_g: 0, fat_g: 40, carbs_g: 100, fiber_g: 0, sugar_g: 95, sodium_mg: 4000 },
      180,
      brandedNonAnimal,
    )!
    const best = healthScore(
      { kcal: 300, protein_g: 30, fat_g: 8, carbs_g: 25, fiber_g: 10, sugar_g: 3, sodium_mg: 200 },
      420,
      wholeAnimal,
    )!
    expect(worst.score).toBeGreaterThanOrEqual(0)
    expect(best.score).toBeLessThanOrEqual(10)
  })
})
