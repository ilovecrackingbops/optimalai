import { beforeEach, describe, expect, it } from 'vitest'
import type { Band } from '@nutai/confidence'
import type { IngredientRow, LoggedMeal } from '@nutai/core-schema'
import { recomputeAfterEdit } from '@nutai/pipeline'
import type { ScanResult } from '@nutai/pipeline'
import { QUESTION_BANK, type SelectedQuestion } from '@nutai/repair'
import {
  answerQuestion,
  applyWebOption,
  editGrams,
  getPhase,
  removeRow,
  reset,
  setPhase,
  setPortionEaten,
  setWebLookup,
} from './store'

/**
 * The scan store's arithmetic — the numbers the user actually edits.
 *
 * Every mutation must recompute locally and keep the invariant that displayed
 * calories are reproducible from displayed macros. applyWebOption gets the
 * hardest scrutiny: it converts PER-SERVING published values into a per-100g
 * snapshot, and an error there mislabels every branded food in the app.
 */

function row(over: Partial<IngredientRow> = {}): IngredientRow {
  return {
    id: 'r1',
    displayName: 'Grilled chicken breast',
    sourceFoodId: '1',
    grams: 170,
    nutrientSnapshot: { kcal: 165, protein_g: 31, fat_g: 3.6, carbs_g: 0, fiber_g: 0, sugar_g: 0, sodium_mg: 74 },
    origin: 'vision_model',
    gramPathway: 'fndds_standard_portion' as IngredientRow['gramPathway'],
    bandHalfPct: 0.2,
    isEstimate: false,
    assumptions: [],
    ...over,
  }
}

function readyWith(rows: IngredientRow[]): void {
  const meal: LoggedMeal = {
    id: 'm1',
    loggedAt: '2026-08-01T12:00:00Z',
    ingredients: rows,
    portionEatenFraction: 1,
    engineId: 'test',
    promptVersion: null,
    schemaVersion: null,
    clampFlags: [],
  }
  const bands: Band[] = rows.map((r) => ({ halfPct: r.bandHalfPct, tier: 'moderate', reasons: [] }))
  const { totals, mealBand } = recomputeAfterEdit(meal, bands)
  const result: ScanResult = {
    isFood: true,
    refusalReason: null,
    items: rows.map((r, i) => ({ row: r, band: bands[i]!, resolution: 'auto_accept', gramPathway: r.gramPathway })),
    meal,
    totals,
    mealBand,
    questions: [],
    clampFlags: [],
    zeroHitCount: 0,
  }
  setPhase({ kind: 'ready', photoUri: null, result, bands, meta: null, webLookups: {} })
}

const readyPhase = () => {
  const p = getPhase()
  if (p.kind !== 'ready') throw new Error(`expected ready, got ${p.kind}`)
  return p
}

beforeEach(() => reset())

describe('editGrams', () => {
  it('scales totals linearly and instantly', () => {
    readyWith([row()])
    const before = readyPhase().result.totals.kcal
    editGrams('r1', 340)
    const after = readyPhase().result.totals.kcal
    expect(after).toBeGreaterThan(before * 1.8)
    expect(after).toBeLessThan(before * 2.2)
  })

  it('ignores garbage input rather than corrupting the row', () => {
    readyWith([row()])
    const before = readyPhase().result.totals.kcal
    editGrams('r1', Number.NaN)
    editGrams('r1', -50)
    expect(readyPhase().result.totals.kcal).toBe(before)
  })
})

describe('answerQuestion — raw_or_cooked', () => {
  const rawOrCooked = QUESTION_BANK.find((q) => q.id === 'raw_or_cooked')!

  function questionFor(rowId: string): SelectedQuestion {
    return {
      question: rawOrCooked,
      text: rawOrCooked.text,
      expectedValue: 100,
      state: 'highlighted',
      appliedDefault: null,
      disclosure: rawOrCooked.defaultDisclosure,
      rowId,
    }
  }

  // Regression for a real bug: tapping "Raw weight" / "Cooked weight" did
  // nothing at all — SelectedQuestion carried no rowId, so answerQuestion had
  // no way to know which ingredient the answer was even about, and this
  // question id was not one of the two (portion_eaten, cooking_oil) with a
  // hand-rolled workaround.

  it('converts a cooked-basis match toward raw weight when the user says the number was raw', () => {
    readyWith([row({ displayName: 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', grams: 200 })])
    answerQuestion(questionFor('r1'), 'raw')
    // Cooking concentrates mass loss; a cooked-basis row told "that 200 was
    // raw" should scale DOWN to the cooked-equivalent grams actually eaten.
    expect(readyPhase().result.meal.ingredients[0]?.grams).toBeCloseTo(150, 0)
  })

  it('converts a raw-basis match toward cooked weight when the user says the number was cooked', () => {
    readyWith([row({ displayName: 'Chicken, broiler or fryers, breast, skinless, boneless, meat only, raw', grams: 200 })])
    answerQuestion(questionFor('r1'), 'cooked')
    expect(readyPhase().result.meal.ingredients[0]?.grams).toBeCloseTo(266.67, 0)
  })

  it('does nothing when the answer already matches the row — no spurious edit', () => {
    readyWith([row({ displayName: 'Chicken, breast, raw', grams: 200 })])
    answerQuestion(questionFor('r1'), 'raw')
    expect(readyPhase().result.meal.ingredients[0]?.grams).toBe(200)
  })

  it('is a safe no-op when the row cannot be identified or the name gives no basis to reconcile', () => {
    readyWith([row({ id: 'r1', displayName: 'Mystery casserole', grams: 200 })])
    answerQuestion(questionFor('nonexistent-row'), 'raw')
    expect(readyPhase().result.meal.ingredients[0]?.grams).toBe(200)
    answerQuestion(questionFor('r1'), 'raw')
    expect(readyPhase().result.meal.ingredients[0]?.grams).toBe(200)
  })
})

describe('answerQuestion — regular_or_diet', () => {
  const regularOrDiet = QUESTION_BANK.find((q) => q.id === 'regular_or_diet')!

  function questionFor(rowId: string): SelectedQuestion {
    return {
      question: regularOrDiet,
      text: regularOrDiet.text,
      expectedValue: 100,
      state: 'highlighted',
      appliedDefault: null,
      disclosure: regularOrDiet.defaultDisclosure,
      rowId,
    }
  }

  // Regression for a real bug: neither "Regular" nor "Diet / zero" did
  // anything — this question id had no handler at all, and the "wired at the
  // screen level" swap the store.ts comment promised was never actually built
  // into the result screen, so both buttons were silently inert.

  it('zeroes out calories, protein, fat, and carbs when the user says diet', () => {
    readyWith([row({ displayName: 'Cola', grams: 355, nutrientSnapshot: { kcal: 42, protein_g: 0, fat_g: 0, carbs_g: 10.6, fiber_g: 0, sugar_g: 10.6, sodium_mg: 4 } })])
    answerQuestion(questionFor('r1'), 'diet')
    const snap = readyPhase().result.meal.ingredients[0]!.nutrientSnapshot
    expect(snap.kcal).toBe(0)
    expect(snap.carbs_g).toBe(0)
    // Sodium is independent of sweetener choice — left as-is, not zeroed.
    expect(snap.sodium_mg).toBe(4)
  })

  it('leaves the row untouched when the user confirms regular — it was already the default', () => {
    readyWith([row({ displayName: 'Cola', grams: 355, nutrientSnapshot: { kcal: 42, protein_g: 0, fat_g: 0, carbs_g: 10.6, fiber_g: 0, sugar_g: 10.6, sodium_mg: 4 } })])
    answerQuestion(questionFor('r1'), 'regular')
    expect(readyPhase().result.meal.ingredients[0]!.nutrientSnapshot.kcal).toBe(42)
  })

  it('is a safe no-op when the row cannot be identified', () => {
    readyWith([row({ id: 'r1', displayName: 'Cola', grams: 355 })])
    answerQuestion(questionFor('nonexistent-row'), 'diet')
    expect(readyPhase().result.meal.ingredients[0]?.nutrientSnapshot.kcal).toBe(165)
  })
})

describe('removeRow', () => {
  it('drops the row and its contribution', () => {
    readyWith([row(), row({ id: 'r2', displayName: 'Rice', nutrientSnapshot: { kcal: 130, protein_g: 2.7, fat_g: 0.3, carbs_g: 28, fiber_g: 0, sugar_g: 0, sodium_mg: 1 }, grams: 180 })])
    removeRow('r2')
    const p = readyPhase()
    expect(p.result.meal.ingredients).toHaveLength(1)
    expect(p.result.totals.kcal).toBeLessThan(300)
  })
})

describe('setPortionEaten', () => {
  it('applies as a final multiplier and clamps to [0,1]', () => {
    readyWith([row()])
    const full = readyPhase().result.totals.kcal
    setPortionEaten(0.5)
    const half = readyPhase().result.totals.kcal
    expect(half).toBeGreaterThan(full * 0.4)
    expect(half).toBeLessThan(full * 0.6)

    setPortionEaten(7)
    expect(readyPhase().result.meal.portionEatenFraction).toBe(1)
  })
})

describe('applyWebOption — per-serving to per-100g', () => {
  const option = {
    label: 'Spicy Chicken Sandwich',
    serving_g: 232,
    serving_desc: '1 sandwich (232 g)',
    calories_kcal: 450,
    protein_g: 28,
    carbs_g: 45,
    fat_g: 19,
    fiber_g: 3,
    sodium_mg: 1650,
  }

  it('round-trips: snapshot x grams / 100 recovers the published per-serving values', () => {
    readyWith([row({ isEstimate: true, sourceFoodId: null })])
    applyWebOption('r1', option, 'https://www.chick-fil-a.com/nutrition')

    const r = readyPhase().result.meal.ingredients[0]!
    expect(r.grams).toBe(232)
    expect((r.nutrientSnapshot.kcal * r.grams) / 100).toBeCloseTo(450, 6)
    expect((r.nutrientSnapshot.protein_g * r.grams) / 100).toBeCloseTo(28, 6)
    expect((r.nutrientSnapshot.sodium_mg! * r.grams) / 100).toBeCloseTo(1650, 6)
  })

  it('upgrades provenance: cited web row, no longer an AI estimate', () => {
    readyWith([row({ isEstimate: true, sourceFoodId: null })])
    applyWebOption('r1', option, 'https://www.chick-fil-a.com/nutrition')
    const r = readyPhase().result.meal.ingredients[0]!
    expect(r.origin).toBe('web_lookup')
    expect(r.isEstimate).toBe(false)
    expect(r.sourceUrl).toContain('chick-fil-a.com')
    expect(r.displayName).toBe('Spicy Chicken Sandwich')
  })

  it('keeps the current grams when the source lists no serving weight', () => {
    readyWith([row({ grams: 200 })])
    applyWebOption('r1', { ...option, serving_g: null }, null)
    const r = readyPhase().result.meal.ingredients[0]!
    expect(r.grams).toBe(200)
    // The per-serving values are then spread over those 200 g.
    expect((r.nutrientSnapshot.kcal * r.grams) / 100).toBeCloseTo(450, 6)
  })

  it('a nutrient the source does not list stays null — never a fabricated zero', () => {
    readyWith([row()])
    applyWebOption('r1', { ...option, fiber_g: null, sodium_mg: null }, null)
    const r = readyPhase().result.meal.ingredients[0]!
    expect(r.nutrientSnapshot.fiber_g).toBeNull()
    expect(r.nutrientSnapshot.sodium_mg).toBeNull()
  })
})

describe('setWebLookup', () => {
  it('attaches per-row lookup state on the ready phase only', () => {
    setWebLookup('r1', { status: 'running' })
    expect(getPhase().kind).toBe('idle')

    readyWith([row()])
    setWebLookup('r1', { status: 'running' })
    expect(readyPhase().webLookups['r1']).toEqual({ status: 'running' })
  })
})
