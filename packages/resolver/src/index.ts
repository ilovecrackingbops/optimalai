import type { DbAdapter } from '@nutai/db-adapter'
import { normalizeGtin } from './gtin.js'
import { ladderStepWords, matchLadder } from './query.js'
import {
  type Candidate,
  type ResolutionOutcome,
  type ScoredCandidate,
  type ScoringContext,
  decideOutcome,
  scoreCandidates,
} from './scoring.js'

export * from './gtin.js'
export * from './query.js'
export * from './scoring.js'

/**
 * Nutrition resolution — food name to database row.
 *
 * SPEC-accuracy-engine.md §5. The stage between "the model says this is grilled
 * chicken breast" and "165 kcal per 100 g, from FDC row 171077".
 *
 * Everything here is offline. No network call has ever been part of this stage,
 * on either inference path, which is what makes the whole repair loop free.
 */

export interface ResolvedFood {
  foodId: string
  name: string
  brand: string | null
  /** Per-100 g. Always. There is exactly one computational basis. */
  energyKcal: number | null
  proteinG: number | null
  fatG: number | null
  carbG: number | null
  fiberG: number | null
  sugarG: number | null
  sodiumMg: number | null
  servingSizeG: number | null
  servingDesc: string | null
  license: string
  source: string
}

const CANDIDATE_SQL = `
SELECT f.id            AS foodId,
       f.name          AS name,
       b.canonical_name AS brand,
       f.category      AS category,
       f.prep_facet    AS prepFacet,
       f.basis_confidence AS basisConfidence,
       f.serving_size_g   AS servingSizeG,
       f.energy_kcal      AS energyKcal,
       f.popularity_rank  AS popularityRank,
       f.completeness_score AS completenessScore,
       bm25(food_fts, 10.0, 8.0, 4.0) AS rawBm25,
       (SELECT MIN(gram_weight) FROM food_portions fp WHERE fp.food_id = f.id) AS typicalGramsMin,
       (SELECT MAX(gram_weight) FROM food_portions fp WHERE fp.food_id = f.id) AS typicalGramsMax
FROM food_fts
JOIN foods f ON f.id = food_fts.rowid
LEFT JOIN brands b ON b.id = f.brand_id
WHERE food_fts MATCH ?
ORDER BY rawBm25
LIMIT 2000
`
/**
 * THE LIMIT ABOVE IS NOT A DISPLAY CAP — it decides which rows ever reach
 * either consumer's scoring at all, and an old value of 100 silently dropped
 * the correct answer outright. SQLite FTS5's bm25() penalizes a document by
 * its own length, with no way to turn that off: for the single-word query
 * "milk", "Milk, whole, 3.25% milkfat, with added vitamin D" — the single
 * most commonly eaten row in the whole corpus — ranked 221st by raw bm25,
 * entirely on account of being a longer, more fully-described USDA name.
 * `ORDER BY rawBm25 LIMIT 100` threw it away before a single line of
 * `scoring.ts` or `rankForSearch` ever ran — no amount of re-ranking
 * afterward can recover a row that was never fetched. 2000 comfortably
 * covers every real query against this ~7,900-row corpus (the broadest
 * single word tried, "beef", matches 1,120 rows) while still adding a hard
 * backstop against a pathological one; bm25 remains the retrieval-order
 * hint and the final tiebreak in `scoreCandidates`/`rankForSearch`, just no
 * longer a gate on which rows those functions are allowed to see.
 */

const FOOD_BY_ID_SQL = `
SELECT f.id AS foodId, f.name AS name, b.canonical_name AS brand,
       f.energy_kcal AS energyKcal, f.protein_g AS proteinG, f.fat_g AS fatG,
       f.carb_g AS carbG, f.fiber_g AS fiberG, f.sugar_g AS sugarG,
       f.sodium_mg AS sodiumMg, f.serving_size_g AS servingSizeG,
       f.serving_desc AS servingDesc, f.license AS license, f.source AS source
FROM foods f
LEFT JOIN brands b ON b.id = f.brand_id
WHERE f.id = ?
`

/**
 * Barcode path — deterministic, single row, no scoring.
 *
 * Normalizes to a canonical 13-digit GTIN first, so a UPC-A scanned off a US
 * package finds the same row as its EAN-13 equivalent. Skipping that step
 * produces the most confusing bug class available here: the barcode is in the
 * database, the scan succeeds, and the lookup misses.
 */
/**
 * SQLite returns `foods.id` as an INTEGER, but every consumer treats a food id as
 * an opaque string key (it is also used for `user_foods:` and `fdc:` prefixed
 * concept keys). Coercing at this boundary keeps the declared type honest —
 * without it, TypeScript believes `foodId: string` while the runtime hands back a
 * number, and every `===` comparison downstream silently fails.
 */
function coerceIds<T extends { foodId: unknown }>(row: T | null): (Omit<T, 'foodId'> & { foodId: string }) | null {
  return row == null ? null : { ...row, foodId: String(row.foodId) }
}

export async function resolveByBarcode(
  db: DbAdapter,
  rawBarcode: string,
): Promise<ResolvedFood | null> {
  const gtin = normalizeGtin(rawBarcode)
  if (!gtin) return null

  // Match the stored value whether it was indexed zero-padded or not.
  const unpadded = gtin.replace(/^0+/, '')
  const row = await db.get<ResolvedFood>(
    `${FOOD_BY_ID_SQL.replace('WHERE f.id = ?', 'WHERE f.barcode = ? OR f.barcode = ?')}`,
    [gtin, unpadded],
  )
  return coerceIds(row)
}

export async function loadFood(db: DbAdapter, foodId: string): Promise<ResolvedFood | null> {
  return coerceIds(await db.get<ResolvedFood>(FOOD_BY_ID_SQL, [foodId]))
}

export interface ResolveResult {
  outcome: ResolutionOutcome
  /**
   * The top `maxCandidates` scored rows, ALWAYS populated regardless of which
   * `outcome` fired — including on auto_accept, where `outcome.match` alone
   * would otherwise hide every runner-up. A dedicated search results screen
   * wants the ranked list either way; only the chip-sheet UI cares about the
   * auto_accept/disambiguate distinction.
   */
  candidates: ScoredCandidate[]
  /** How far down the broadening ladder we had to go. 0 = exact first try. */
  ladderStep: number
  /** True when every rung returned nothing — this is what the 5% trigger counts. */
  zeroHit: boolean
}

/**
 * Text resolution: FTS5 candidate generation, six-signal scoring, and the
 * two-part auto-accept decision.
 *
 * `maxCandidates` caps the disambiguation list on a miss/tie (default 5, the
 * AI-scan chip sheet's size) — pass a larger number for a dedicated search
 * results screen.
 */
export async function resolveByText(
  db: DbAdapter,
  ctx: ScoringContext,
  maxCandidates = 5,
): Promise<ResolveResult> {
  const ladder = matchLadder(ctx.canonicalFoodKey)

  for (let step = 0; step < ladder.length; step++) {
    const expr = ladder[step]
    if (!expr) continue

    let rows: Candidate[]
    try {
      rows = await db.all<Candidate>(CANDIDATE_SQL, [expr])
    } catch {
      // A malformed MATCH expression must not take down a scan. Move down the
      // ladder rather than surfacing a SQL error to someone photographing lunch.
      continue
    }

    if (rows.length === 0) continue

    // Same integer-vs-string coercion as loadFood — candidate ids flow straight
    // into loadFood and into IngredientRow.sourceFoodId.
    const scored = scoreCandidates(
      rows.map((r) => ({ ...r, foodId: String(r.foodId) })),
      ctx,
    )
    return {
      outcome: decideOutcome(scored, maxCandidates),
      candidates: scored.slice(0, maxCandidates),
      ladderStep: step,
      zeroHit: false,
    }
  }

  return { outcome: { kind: 'miss' }, candidates: [], ladderStep: ladder.length, zeroHit: true }
}

/** How many corpus rows contain this single word at all — a plain measure of how generic it is. */
async function tokenFrequency(db: DbAdapter, token: string): Promise<number> {
  try {
    const row = await db.get<{ c: number }>('SELECT COUNT(*) c FROM food_fts WHERE food_fts MATCH ?', [`"${token}"`])
    return row?.c ?? 0
  } catch {
    // A token FTS5 chokes on can't be searched at all — treat it as
    // maximally generic so it's the first thing dropped, not the last.
    return Number.POSITIVE_INFINITY
  }
}

export interface SearchResolveResult {
  /** Every scored candidate found, up to `maxCandidates` — no auto-accept/disambiguate decision, this is a browse list. */
  candidates: ScoredCandidate[]
  /**
   * Query words that matched nothing and had to be dropped, in their
   * original order — empty when the full phrase matched as typed. A caller
   * MUST disclose these rather than silently showing results for a quieter
   * query than the one the user actually typed.
   */
  droppedWords: string[]
  /** True when nothing matched even after dropping down to a single word and finally trying its OR of all words. */
  zeroHit: boolean
}

/**
 * Text resolution for a manual search box — same FTS5 candidate generation
 * and scoring as `resolveByText`, but a DIFFERENT broadening strategy for a
 * different kind of query.
 *
 * `resolveByText`'s `matchLadder` drops TRAILING tokens first, which is
 * correct for the AI-scan pipeline's own canonical keys: the system prompt
 * requires generic-noun-first phrasing ("chicken breast, grilled"), so the
 * least important word really is always last. Nobody typing into a search
 * box follows that convention — ordinary English puts adjectives before the
 * noun ("full fat kefir"), so the LAST word is usually the one that actually
 * names the food, not the least important one. Dropping trailing tokens on
 * a query like that discards "kefir" — the only word that named anything —
 * and keeps "full fat", which happened to match "Flour, soy, full-fat" (a
 * real, very commonly referenced row) instead: a completely unrelated food,
 * for a search that should have found the two real kefir rows in the corpus.
 *
 * This drops the single MOST COMMON remaining word instead of the last one,
 * measured against the corpus itself (`tokenFrequency`) rather than assumed
 * from position — "fat" and "full" both occur in far more rows than "kefir"
 * does, so they go first regardless of where they sat in the sentence.
 */
export async function resolveByTextForSearch(
  db: DbAdapter,
  ctx: ScoringContext,
  maxCandidates = 100,
): Promise<SearchResolveResult> {
  const original = ladderStepWords(ctx.canonicalFoodKey, 0)
  if (original.length === 0) return { candidates: [], droppedWords: [], zeroHit: true }

  async function tryMatch(expr: string): Promise<Candidate[]> {
    try {
      return await db.all<Candidate>(CANDIDATE_SQL, [expr])
    } catch {
      return []
    }
  }

  let remaining = [...original]
  while (remaining.length > 0) {
    const rows = await tryMatch(remaining.map((t) => `"${t}"`).join(' '))
    if (rows.length > 0) {
      const scored = scoreCandidates(rows.map((r) => ({ ...r, foodId: String(r.foodId) })), ctx)
      return {
        candidates: scored.slice(0, maxCandidates),
        droppedWords: original.filter((w) => !remaining.includes(w)),
        zeroHit: false,
      }
    }
    if (remaining.length === 1) break
    const freqs = await Promise.all(remaining.map((t) => tokenFrequency(db, t)))
    // A word matching NOTHING anywhere in the corpus (frequency 0) can never
    // contribute to a match no matter what survives alongside it — drop it
    // before anything else. It is not "rare and specific" the way "kefir"
    // is; it is absent, a qualitatively different case from merely uncommon.
    // Skipping this check was the bug: "beef tendon" saw beef=1120,
    // tendon=0, and "drop the most frequent" alone dropped "beef" — the one
    // real food word — while keeping "tendon", which cannot match anything
    // by itself either, and fell through to a nonsense OR fallback.
    let worst = freqs.findIndex((f) => f === 0)
    if (worst === -1) {
      worst = 0
      for (let i = 1; i < freqs.length; i++) {
        if (freqs[i]! > freqs[worst]!) worst = i
      }
    }
    remaining = remaining.filter((_, i) => i !== worst)
  }

  // Last resort, same as `matchLadder`'s own final rung: loosen to OR so a
  // partial match still surfaces something rather than an outright miss. No
  // subset of the words matched together, not even the single most specific
  // one alone — `droppedWords` reports every original word here, since
  // nothing survived jointly, and the caller should say so as "no single
  // match for the full phrase" rather than naming one specific culprit.
  const orRows = await tryMatch(original.map((t) => `"${t}"`).join(' OR '))
  if (orRows.length === 0) return { candidates: [], droppedWords: original, zeroHit: true }
  const scored = scoreCandidates(orRows.map((r) => ({ ...r, foodId: String(r.foodId) })), ctx)
  return { candidates: scored.slice(0, maxCandidates), droppedWords: original, zeroHit: false }
}
