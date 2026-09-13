import { beforeEach, describe, expect, it } from 'vitest'
import { NUTRITION_FTS_SCHEMA, NUTRITION_SCHEMA, type DbAdapter } from '@nutai/db-adapter'
import { openMemoryDb } from '@nutai/db-adapter/node'
import {
  AUTO_ACCEPT,
  decideOutcome,
  gs1CheckDigit,
  isValidGtin,
  ladderStepWords,
  matchLadder,
  nameCloseness,
  normalizeBm25,
  normalizeGtin,
  prepMatch,
  rankForSearch,
  resolveByBarcode,
  resolveByText,
  resolveByTextForSearch,
  scoreCandidates,
  toMatchExpression,
  upcEToUpcA,
  type Candidate,
  type ScoringContext,
} from './index.js'

// ---------------------------------------------------------------------------
// GTIN normalization
// ---------------------------------------------------------------------------

describe('GTIN normalization', () => {
  it('resolves a UPC-A and its EAN-13 equivalent to the same canonical form', () => {
    // A UPC-A is an EAN-13 with a leading zero.
    const upcA = '012345678905'
    const ean13 = '0012345678905'
    expect(normalizeGtin(upcA)).toBe(normalizeGtin(ean13))
    expect(normalizeGtin(upcA)).toHaveLength(13)
  })

  it('computes GS1 mod-10 check digits', () => {
    expect(gs1CheckDigit('01234567890')).toBe(5)
    expect(isValidGtin('012345678905')).toBe(true)
    expect(isValidGtin('012345678901')).toBe(false)
  })

  it('expands UPC-E to UPC-A', () => {
    const upce = '01234565'
    const expanded = upcEToUpcA(upce)
    expect(expanded).not.toBeNull()
    expect(expanded).toHaveLength(12)
  })

  it('rejects nonsense rather than guessing', () => {
    expect(normalizeGtin('hello')).toBeNull()
    expect(normalizeGtin('')).toBeNull()
    expect(normalizeGtin('123')).toBeNull()
  })

  it('strips a GTIN-14 packaging indicator when the inner 13 validates', () => {
    const inner = normalizeGtin('012345678905')!
    expect(normalizeGtin(`1${inner}`)).toBe(inner)
  })
})

// ---------------------------------------------------------------------------
// Query construction
// ---------------------------------------------------------------------------

describe('FTS query construction', () => {
  it('quotes every token so operators cannot leak in from food names', () => {
    expect(toMatchExpression('chicken OR breast')).toBe('"chicken" "or" "breast"')
    expect(toMatchExpression('chicken - breast')).toBe('"chicken" "breast"')
  })

  it('splits on commas, matching USDA naming', () => {
    expect(toMatchExpression('chicken breast, grilled')).toBe('"chicken" "breast" "grilled"')
  })

  it('returns null for an empty query rather than a matcher that errors', () => {
    expect(toMatchExpression('   ')).toBeNull()
    expect(toMatchExpression('***')).toBeNull()
  })

  it('builds a ladder that drops trailing modifiers before the head noun', () => {
    const ladder = matchLadder('chicken breast, grilled')
    expect(ladder[0]).toBe('"chicken" "breast" "grilled"')
    expect(ladder[1]).toBe('"chicken" "breast"')
    expect(ladder[2]).toBe('"chicken"')
    expect(ladder.at(-1)).toContain('OR')
  })
})

describe('ladderStepWords — disclosing which words a broadened search actually used', () => {
  it('reports every word at step 0, the unbroadened query', () => {
    expect(ladderStepWords('beef tendon', 0)).toEqual(['beef', 'tendon'])
  })

  it('reports only the surviving word once the ladder drops a trailing one', () => {
    // Reproduces the reported bug: "tendon" matches nothing in the corpus,
    // so the real search that ran was just "beef" — this must say so.
    expect(ladderStepWords('beef tendon', 1)).toEqual(['beef'])
  })

  it('reports every word again for the final OR-fallback step', () => {
    expect(ladderStepWords('beef tendon', 2)).toEqual(['beef', 'tendon'])
  })

  it('matches matchLadder token-for-token at every step', () => {
    const key = 'chicken breast, grilled'
    const ladder = matchLadder(key)
    for (let step = 0; step < ladder.length; step++) {
      const words = ladderStepWords(key, step)
      const expected = ladder[step]!.replace(/"/g, '').split(/ OR | /).filter((w, i, arr) => arr.indexOf(w) === i)
      expect(words).toEqual(expected)
    }
  })

  it('returns an empty list for an empty query', () => {
    expect(ladderStepWords('   ', 0)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function cand(over: Partial<Candidate> = {}): Candidate {
  return {
    foodId: 'f1',
    name: 'Chicken breast, grilled',
    brand: null,
    category: 'poultry',
    prepFacet: 'grilled',
    basisConfidence: 'high',
    servingSizeG: 85,
    energyKcal: 165,
    popularityRank: 10,
    completenessScore: 0.9,
    rawBm25: -5,
    ...over,
  }
}

const ctx: ScoringContext = {
  canonicalFoodKey: 'chicken breast, grilled',
  observedBrand: null,
  prepFacet: 'grilled',
  modelCategory: 'poultry',
  estimatedGrams: 170,
}

describe('scoring', () => {
  it('treats an untagged prep facet as unknown, not as a conflict', () => {
    expect(prepMatch(cand({ prepFacet: null }), ctx)).toBe(0.5)
    expect(prepMatch(cand({ prepFacet: 'grilled' }), ctx)).toBe(1)
    expect(prepMatch(cand({ prepFacet: 'raw' }), ctx)).toBe(0)
  })

  it('does not hand a lone candidate a free perfect relevance score', () => {
    const norm = normalizeBm25([cand()])
    expect(norm.get('f1')).toBe(0.5)
  })

  it('ranks an exact brand match above a generic row', () => {
    const scored = scoreCandidates(
      [
        cand({ foodId: 'generic', brand: null, rawBm25: -5 }),
        cand({ foodId: 'branded', brand: 'Perdue', rawBm25: -5 }),
      ],
      { ...ctx, observedBrand: 'Perdue' },
    )
    expect(scored[0]?.foodId).toBe('branded')
  })

  it('penalizes a row whose typical portion is nowhere near the estimate', () => {
    const scored = scoreCandidates(
      [
        cand({ foodId: 'cube', servingSizeG: 4, typicalGramsMin: 2, typicalGramsMax: 6 }),
        cand({ foodId: 'breast', servingSizeG: 85, typicalGramsMin: 60, typicalGramsMax: 250 }),
      ],
      ctx,
    )
    expect(scored[0]?.foodId).toBe('breast')
  })

  it('penalizes an incomplete row for untrustworthy unit math', () => {
    const good = scoreCandidates([cand({ foodId: 'a' })], ctx)[0]!
    const bad = scoreCandidates(
      [cand({ foodId: 'b', basisConfidence: 'low', completenessScore: 0.2 })],
      ctx,
    )[0]!
    expect(bad.score).toBeLessThan(good.score)
  })

  it('ranks whole egg above egg yolk for a plain "egg, raw" query, even when every other tied signal would clamp to the same ceiling', () => {
    const eggCtx: ScoringContext = {
      canonicalFoodKey: 'egg, raw', observedBrand: null, prepFacet: 'raw', modelCategory: null, estimatedGrams: 200,
    }
    const shared = { category: 'Dairy and Egg Products', prepFacet: null, servingSizeG: 50, popularityRank: 1000 }
    const scored = scoreCandidates(
      [
        cand({ foodId: 'whole', name: 'Egg, whole, raw, fresh', ...shared, rawBm25: -7.4 }),
        // Yolk is MORE popular (lower rank) than whole, which is what let it win
        // the old tie-break — this must not be enough to beat it now.
        cand({ foodId: 'yolk', name: 'Egg, yolk, raw, fresh', ...shared, popularityRank: 900, rawBm25: -7.4 }),
      ],
      eggCtx,
    )
    expect(scored[0]?.foodId).toBe('whole')
    expect(scored[0]!.score - scored[1]!.score).toBeGreaterThanOrEqual(AUTO_ACCEPT.minGap)
  })

  it('does not penalize egg yolk when the query actually asks for yolk', () => {
    const scored = scoreCandidates(
      [cand({ foodId: 'yolk', name: 'Egg, yolk, raw, fresh', category: 'Dairy and Egg Products' })],
      { canonicalFoodKey: 'egg yolk, raw', observedBrand: null, prepFacet: 'raw', modelCategory: null, estimatedGrams: 20 },
    )
    expect(scored[0]!.breakdown['eggPartPenalty']).toBe(0)
  })

  it('does not treat unrelated "white" or "yolk" words as an egg-part match', () => {
    const scored = scoreCandidates(
      [cand({ foodId: 'rice', name: 'Rice, white, long-grain, regular, cooked', category: null })],
      { canonicalFoodKey: 'rice', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 150 },
    )
    expect(scored[0]!.breakdown['eggPartPenalty']).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// rankForSearch — the manual Food Database search screen's own re-ranking
// ---------------------------------------------------------------------------

describe('nameCloseness', () => {
  it('scores 1 when every content word in the name came from the query', () => {
    expect(nameCloseness(cand({ name: 'Potatoes, raw' }), { ...ctx, canonicalFoodKey: 'potato raw' })).toBe(1)
  })

  it('drops as the name accumulates words the query never asked for', () => {
    const q: ScoringContext = { ...ctx, canonicalFoodKey: 'potato' }
    const plain = nameCloseness(cand({ name: 'Potatoes, baked, flesh, without salt' }), q)
    const dish = nameCloseness(cand({ name: 'Potatoes, au gratin, dry mix, unprepared' }), q)
    expect(plain).toBeGreaterThan(dish)
  })

  it('ignores grammatical filler ("and", "with", "without") on both sides', () => {
    const q: ScoringContext = { ...ctx, canonicalFoodKey: 'potato' }
    const withFiller = nameCloseness(cand({ name: 'Potatoes, flesh and skin, without salt' }), q)
    const noFiller = nameCloseness(cand({ name: 'Potatoes, flesh, skin, salt' }), q)
    expect(withFiller).toBe(noFiller)
  })
})

describe('rankForSearch', () => {
  const potatoCtx: ScoringContext = {
    canonicalFoodKey: 'potato', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 150,
  }
  const veg = { category: 'Vegetables and Vegetable Products', prepFacet: null, brand: null }

  it('surfaces a plain baked/raw potato ahead of prepared dishes that merely mention potato, reproducing the reported "potato" search bug', () => {
    // Real USDA rows for the query "potato" — before this fix, "Potatoes,
    // baked, flesh, without salt" fell to position 23 of 30 because
    // rawPreference scored it WORSE (a recognized cooked-verb penalty) than
    // "canned"/"scalloped"/"au gratin"/"hash brown" rows, which match none of
    // rawPreference's cooking-verb list and so read as neutral — better than
    // an honestly-labeled "baked" row got.
    const rows = [
      cand({ foodId: 'flesh-and-skin-raw', name: 'Potatoes, flesh and skin, raw', ...veg, rawBm25: -6 }),
      cand({ foodId: 'baked-flesh', name: 'Potatoes, baked, flesh, without salt', ...veg, rawBm25: -5.5 }),
      cand({ foodId: 'au-gratin', name: 'Potatoes, au gratin, dry mix, unprepared', ...veg, rawBm25: -6.5 }),
      cand({ foodId: 'scalloped', name: 'Potatoes, scalloped, dry mix, unprepared', ...veg, rawBm25: -6.5 }),
      cand({ foodId: 'hash-brown', name: 'Potatoes, hash brown, refrigerated, unprepared', ...veg, rawBm25: -6.2 }),
    ]
    const ranked = rankForSearch(scoreCandidates(rows, potatoCtx), potatoCtx)
    const posOf = (id: string) => ranked.findIndex((r) => r.foodId === id)

    expect(posOf('baked-flesh')).toBeLessThan(posOf('au-gratin'))
    expect(posOf('baked-flesh')).toBeLessThan(posOf('scalloped'))
    expect(posOf('baked-flesh')).toBeLessThan(posOf('hash-brown'))
    // The plain baked potato belongs near the top, not just "less bad" than
    // the prepared dishes — this is what "nowhere to be found" actually meant.
    expect(posOf('baked-flesh')).toBeLessThanOrEqual(1)
  })

  it('still keeps "sweet potato leaves" from outranking "sweet potato" itself', () => {
    const spCtx: ScoringContext = {
      canonicalFoodKey: 'sweet potato', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 150,
    }
    const rows = [
      cand({ foodId: 'leaves', name: 'Sweet potato leaves, raw', ...veg, rawBm25: -7 }),
      cand({ foodId: 'plain', name: 'Sweet potato, raw, unprepared', ...veg, rawBm25: -4 }),
    ]
    const ranked = rankForSearch(scoreCandidates(rows, spCtx), spCtx)
    expect(ranked[0]?.foodId).toBe('plain')
  })

  it('still keeps branded/restaurant rows below a plain generic row', () => {
    const rows = [
      cand({
        foodId: 'branded',
        name: 'Big Deal Foods, Potato Salad, family size',
        category: 'Branded Food Products Database',
        brand: 'Big Deal Foods',
        rawBm25: -8,
      }),
      cand({ foodId: 'plain', name: 'Potato salad, home-prepared', ...veg, rawBm25: -4 }),
    ]
    const ranked = rankForSearch(scoreCandidates(rows, potatoCtx), potatoCtx)
    expect(ranked[0]?.foodId).toBe('plain')
  })

  it('surfaces the most commonly eaten whole milk ahead of rarer milks whose SHORTER name only looks closer, reproducing the reported "milk" search bug', () => {
    // Real USDA rows for "milk": the standard, most-drunk whole milk row
    // carries mandatory FDA labeling ("with added vitamin D") that reads as
    // "padding" to nameCloseness exactly like a genuinely different dish
    // would — popularityRank has to outrank nameCloseness for this case,
    // not just follow it, or the rarer-but-shorter-named milk wins.
    const dairy = { category: 'Dairy and Egg Products', prepFacet: null, brand: null }
    const milkCtx: ScoringContext = {
      canonicalFoodKey: 'milk', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 240,
    }
    const rows = [
      cand({
        foodId: 'whole',
        name: 'Milk, whole, 3.25% milkfat, with added vitamin D',
        ...dairy,
        popularityRank: 396,
        rawBm25: -6.9,
      }),
      cand({ foodId: 'sheep', name: 'Milk, sheep, fluid', ...dairy, popularityRank: 823, rawBm25: -7.3 }),
    ]
    const ranked = rankForSearch(scoreCandidates(rows, milkCtx), milkCtx)
    expect(ranked[0]?.foodId).toBe('whole')
  })

  it('falls back to nameCloseness when popularity is absent or tied', () => {
    const q: ScoringContext = { ...potatoCtx }
    const rows = [
      cand({ foodId: 'plain', name: 'Potatoes, baked, flesh, without salt', ...veg, popularityRank: null, rawBm25: -5 }),
      cand({ foodId: 'dish', name: 'Potatoes, au gratin, dry mix, unprepared', ...veg, popularityRank: null, rawBm25: -5 }),
    ]
    const ranked = rankForSearch(scoreCandidates(rows, q), q)
    expect(ranked[0]?.foodId).toBe('plain')
  })
})

describe('the two-part auto-accept rule', () => {
  const strong = { ...cand({ foodId: 'top' }), score: 0.8, breakdown: {} }
  const near = { ...cand({ foodId: 'near' }), score: 0.75, breakdown: {} }
  const weak = { ...cand({ foodId: 'weak' }), score: 0.4, breakdown: {} }

  it('auto-accepts a strong, clearly-separated top match', () => {
    const out = decideOutcome([strong, weak])
    expect(out.kind).toBe('auto_accept')
  })

  it('refuses to auto-accept a great score beside a near-duplicate', () => {
    // Two branded SKUs of the same product at different pack sizes. Both clear
    // the absolute floor; the user should glance at it.
    const out = decideOutcome([strong, near])
    expect(out.kind).toBe('disambiguate')
  })

  it('refuses to auto-accept a mediocre top score just because nothing else came close', () => {
    // A genuinely novel dish with five equally-bad candidates.
    const out = decideOutcome([{ ...weak, score: 0.45 }, { ...cand({ foodId: 'x' }), score: 0.1, breakdown: {} }])
    expect(out.kind).toBe('disambiguate')
  })

  it('reports a miss on an empty candidate set', () => {
    expect(decideOutcome([]).kind).toBe('miss')
  })

  it('caps the disambiguation sheet at five options', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({
      ...cand({ foodId: `f${i}` }), score: 0.5 - i * 0.001, breakdown: {},
    }))
    const out = decideOutcome(many)
    expect(out.kind).toBe('disambiguate')
    if (out.kind === 'disambiguate') expect(out.candidates).toHaveLength(5)
  })

  it('uses the documented thresholds', () => {
    expect(AUTO_ACCEPT.minScore).toBe(0.6)
    expect(AUTO_ACCEPT.minGap).toBe(0.12)
  })
})

// ---------------------------------------------------------------------------
// Against a real SQLite database
// ---------------------------------------------------------------------------

describe('resolution against a real corpus', () => {
  let db: DbAdapter

  beforeEach(async () => {
    db = openMemoryDb()
    await db.exec(NUTRITION_SCHEMA)
    await db.exec(NUTRITION_FTS_SCHEMA)

    const foods: Array<[number, string, string, string | null, number, string | null, number]> = [
      [1, 'fdc_sr_legacy', 'Chicken, broilers or fryers, breast, meat only, cooked, grilled', 'grilled', 165, null, 10],
      [2, 'fdc_sr_legacy', 'Chicken, broilers or fryers, breast, meat only, cooked, roasted', 'roasted', 172, null, 20],
      [3, 'fdc_sr_legacy', 'Rice, white, long-grain, regular, cooked', 'boiled', 130, null, 5],
      [4, 'fdc_branded', 'Granola Bar, Chewy', null, 400, '0012345678905', 100],
    ]
    for (const [id, source, name, prep, kcal, barcode, rank] of foods) {
      await db.run(
        `INSERT INTO foods (id, source, name, prep_facet, energy_kcal, barcode, popularity_rank,
                            license, basis_confidence, completeness_score)
         VALUES (?,?,?,?,?,?,?,'CC0','high',0.9)`,
        [id, source, name, prep, kcal, barcode, rank],
      )
      await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [
        id, name, '', '',
      ])
    }
  })

  it('finds a food regardless of word order', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'chicken breast grilled',
      observedBrand: null, prepFacet: 'grilled', modelCategory: null, estimatedGrams: 170,
    })
    expect(r.zeroHit).toBe(false)
    const ids = r.outcome.kind === 'auto_accept'
      ? [r.outcome.match.foodId]
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates.map((c) => c.foodId) : []
    expect(ids.map(String)).toContain('1')
  })

  it('prefers the grilled row over the roasted one when the model saw grill marks', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'chicken breast',
      observedBrand: null, prepFacet: 'grilled', modelCategory: null, estimatedGrams: 170,
    })
    const first = r.outcome.kind === 'auto_accept'
      ? r.outcome.match
      : r.outcome.kind === 'disambiguate' ? r.outcome.candidates[0] : null
    expect(String(first?.foodId)).toBe('1')
  })

  it('broadens down the ladder rather than giving up on one absent token', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'chicken breast, sousvide',
      observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 170,
    })
    expect(r.zeroHit).toBe(false)
    expect(r.ladderStep).toBeGreaterThan(0)
  })

  it('reports an honest zero-hit for a food that is genuinely absent', async () => {
    const r = await resolveByText(db, {
      canonicalFoodKey: 'zzzzqqqx',
      observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 100,
    })
    expect(r.zeroHit).toBe(true)
    expect(r.outcome.kind).toBe('miss')
  })

  it('resolves a barcode deterministically, in either GTIN form', async () => {
    const byEan = await resolveByBarcode(db, '0012345678905')
    const byUpc = await resolveByBarcode(db, '012345678905')
    expect(byEan?.name).toBe('Granola Bar, Chewy')
    expect(byUpc?.foodId).toBe(byEan?.foodId)
  })

  it('returns null for an unknown barcode instead of a wrong row', async () => {
    expect(await resolveByBarcode(db, '9999999999994')).toBeNull()
  })

  it('never throws on a hostile query string', async () => {
    for (const q of ['"', '(((', 'a OR OR b', '*', 'NEAR/']) {
      const r = await resolveByText(db, {
        canonicalFoodKey: q, observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 100,
      })
      expect(r).toBeDefined()
    }
  })

  it('resolves a plain "eggs" log to the whole egg, not the yolk, even though the yolk row is more popular', async () => {
    // Regression for a real user report: "4 raw eggs" logged as 644 kcal for
    // 200 g, which is egg YOLK's 322 kcal/100 g, not whole egg's 143. Every
    // other scoring signal ties whole/yolk/white on a bare "egg raw" query
    // (identical bm25, identical category, identical raw-preference), so
    // without this fix the tie broke on popularityPrior — and the yolk row
    // legitimately IS logged more often than the whole-egg row in the real
    // corpus, so it must not win here on that basis alone.
    const eggs: Array<[number, string, number, number]> = [
      [101, 'Egg, whole, raw, fresh', 143, 1064],
      [102, 'Egg, yolk, raw, fresh', 322, 991],
      [103, 'Egg, white, raw, fresh', 52, 1063],
    ]
    for (const [id, name, kcal, rank] of eggs) {
      await db.run(
        `INSERT INTO foods (id, source, name, category, energy_kcal, popularity_rank,
                            license, basis_confidence, completeness_score)
         VALUES (?,'fdc_sr_legacy',?,'Dairy and Egg Products',?,?,'CC0','high',1.0)`,
        [id, name, kcal, rank],
      )
      await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [
        id, name, '', '',
      ])
    }

    const r = await resolveByText(db, {
      canonicalFoodKey: 'egg, raw',
      observedBrand: null, prepFacet: 'raw', modelCategory: null, estimatedGrams: 200,
    })

    expect(r.outcome.kind).toBe('auto_accept')
    if (r.outcome.kind === 'auto_accept') {
      expect(String(r.outcome.match.foodId)).toBe('101')
      expect(r.outcome.match.energyKcal).toBe(143)
    }
  })

  it('still resolves to egg yolk when the query actually asks for it', async () => {
    const eggs: Array<[number, string, number, number]> = [
      [101, 'Egg, whole, raw, fresh', 143, 1064],
      [102, 'Egg, yolk, raw, fresh', 322, 991],
    ]
    for (const [id, name, kcal, rank] of eggs) {
      await db.run(
        `INSERT INTO foods (id, source, name, category, energy_kcal, popularity_rank,
                            license, basis_confidence, completeness_score)
         VALUES (?,'fdc_sr_legacy',?,'Dairy and Egg Products',?,?,'CC0','high',1.0)`,
        [id, name, kcal, rank],
      )
      await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [
        id, name, '', '',
      ])
    }

    const r = await resolveByText(db, {
      canonicalFoodKey: 'egg yolk, raw',
      observedBrand: null, prepFacet: 'raw', modelCategory: null, estimatedGrams: 20,
    })

    expect(r.outcome.kind).toBe('auto_accept')
    if (r.outcome.kind === 'auto_accept') expect(String(r.outcome.match.foodId)).toBe('102')
  })
})

// ---------------------------------------------------------------------------
// Retrieval limit — the SQL fetch cap, not a display cap
// ---------------------------------------------------------------------------

describe('the candidate fetch limit', () => {
  it('does not silently drop a genuinely relevant row that bm25 ranks worse for being longer', async () => {
    // Reproduces the real bug found against the bundled corpus: for "milk",
    // SQLite FTS5's bm25() ranked the single most commonly drunk row —
    // "Milk, whole, 3.25% milkfat, with added vitamin D" — 221st out of 221
    // matches, purely for being a longer, more fully-described name than
    // short filler rows. The old `LIMIT 100` in CANDIDATE_SQL threw it away
    // before scoreCandidates or rankForSearch ever ran. This test builds the
    // same shape at a smaller scale: 150 short "noise" rows that all match
    // the query more densely than one long, genuinely-correct row.
    const db = openMemoryDb()
    await db.exec(NUTRITION_SCHEMA)
    await db.exec(NUTRITION_FTS_SCHEMA)

    for (let i = 0; i < 150; i++) {
      const name = `Milk product ${i}`
      await db.run(
        `INSERT INTO foods (id, source, name, category, energy_kcal, popularity_rank, license, basis_confidence, completeness_score)
         VALUES (?,'fdc_sr_legacy',?,'Dairy and Egg Products',100,5000,'CC0','high',0.9)`,
        [i + 1, name],
      )
      await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [i + 1, name, '', ''])
    }

    const longId = 9999
    const longName =
      'Milk, whole, three and one quarter percent milkfat, with added vitamin A and vitamin D, homogenized and pasteurized, standard grade'
    await db.run(
      `INSERT INTO foods (id, source, name, category, energy_kcal, popularity_rank, license, basis_confidence, completeness_score)
       VALUES (?,'fdc_sr_legacy',?,'Dairy and Egg Products',60,1,'CC0','high',1.0)`,
      [longId, longName],
    )
    await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [longId, longName, '', ''])

    const r = await resolveByText(
      db,
      { canonicalFoodKey: 'milk', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 240 },
      1000,
    )
    expect(r.candidates.map((c) => c.foodId)).toContain(String(longId))
  })
})

// ---------------------------------------------------------------------------
// resolveByTextForSearch — frequency-aware broadening for a manual search box
// ---------------------------------------------------------------------------

describe('resolveByTextForSearch', () => {
  let db: DbAdapter

  beforeEach(async () => {
    db = openMemoryDb()
    await db.exec(NUTRITION_SCHEMA)
    await db.exec(NUTRITION_FTS_SCHEMA)
  })

  async function seed(id: number, name: string, category = 'Dairy and Egg Products') {
    await db.run(
      `INSERT INTO foods (id, source, name, category, energy_kcal, popularity_rank, license, basis_confidence, completeness_score)
       VALUES (?,'fdc_sr_legacy',?,?,100,1000,'CC0','high',0.9)`,
      [id, name, category],
    )
    await db.run('INSERT INTO food_fts (rowid, name, brand, synonyms) VALUES (?,?,?,?)', [id, name, '', ''])
  }

  it('does not broaden at all when the full phrase matches as typed', async () => {
    await seed(1, 'Yogurt, Greek, plain')
    const r = await resolveByTextForSearch(db, {
      canonicalFoodKey: 'greek yogurt', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 150,
    })
    expect(r.droppedWords).toEqual([])
    expect(r.candidates.map((c) => c.foodId)).toEqual(['1'])
  })

  it('drops a word that matches NOTHING anywhere in the corpus, not the real food word that survives just fine alone — reproduces "beef tendon"', async () => {
    // 50 real beef rows exist; "tendon" is in none of them (a genuine data
    // gap, same as the real bundled corpus). Naively dropping the MORE
    // common remaining word would drop "beef" (appears 50 times) and keep
    // "tendon" (appears 0 times) — exactly backwards.
    for (let i = 0; i < 50; i++) await seed(i + 1, `Beef, cut ${i}, raw`, 'Beef Products')
    const r = await resolveByTextForSearch(db, {
      canonicalFoodKey: 'beef tendon', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 150,
    })
    expect(r.droppedWords).toEqual(['tendon'])
    expect(r.zeroHit).toBe(false)
    expect(r.candidates.length).toBe(50)
  })

  it('drops the more GENERIC word first when both survive individually, keeping the rarer, more specific one — reproduces "full fat kefir"', async () => {
    // "full" and "fat" both appear across many unrelated filler rows; "kefir"
    // appears only on the two real rows, and no row has all three together.
    for (let i = 0; i < 30; i++) await seed(i + 1, `Full fat snack ${i}`, 'Snacks')
    await seed(101, 'Kefir, lowfat, plain, LIFEWAY')
    await seed(102, 'Kefir, lowfat, strawberry, LIFEWAY')

    const r = await resolveByTextForSearch(db, {
      canonicalFoodKey: 'full fat kefir', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 240,
    })
    expect(r.droppedWords.sort()).toEqual(['fat', 'full'])
    expect(r.candidates.map((c) => c.foodId).sort()).toEqual(['101', '102'])
  })

  it('reports a genuine zero-hit for a single word absent from the whole corpus', async () => {
    await seed(1, 'Chicken, breast, raw', 'Poultry Products')
    const r = await resolveByTextForSearch(db, {
      canonicalFoodKey: 'xyzzy', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 100,
    })
    expect(r.zeroHit).toBe(true)
    expect(r.candidates).toEqual([])
  })

  it('returns nothing for an empty query rather than throwing', async () => {
    const r = await resolveByTextForSearch(db, {
      canonicalFoodKey: '   ', observedBrand: null, prepFacet: null, modelCategory: null, estimatedGrams: 100,
    })
    expect(r.zeroHit).toBe(true)
    expect(r.droppedWords).toEqual([])
  })
})
