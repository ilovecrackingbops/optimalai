/**
 * Candidate scoring.
 *
 * SPEC-accuracy-engine.md §5.5. Six signals plus one penalty, combined linearly.
 * The weights are tunable constants to be fitted against real dogfood logs — they
 * are a reasoned starting point, not final numbers, and they live here in one
 * place precisely so fitting them is a one-file change.
 */

export interface Candidate {
  foodId: string
  name: string
  brand: string | null
  category: string | null
  prepFacet: string | null
  basisConfidence: 'high' | 'low'
  servingSizeG: number | null
  energyKcal: number | null
  popularityRank: number | null
  completenessScore: number | null
  /** FTS5 bm25(): more negative is more relevant. Normalized before use. */
  rawBm25: number
  /** True when this row came from the brand-filtered query. */
  brandFiltered?: boolean
  /** Typical portion range for this row, from food_portions. */
  typicalGramsMin?: number | null
  typicalGramsMax?: number | null
}

export interface ScoringContext {
  /** What the model asked for. */
  canonicalFoodKey: string
  /** Brand text read off packaging, if any. An observation, not an inference. */
  observedBrand: string | null
  /** grilled | fried | raw | ... from the model's cooking cues. */
  prepFacet: string | null
  modelCategory: string | null
  /** The gram engine's estimate, used for portion plausibility. */
  estimatedGrams: number | null
}

export const WEIGHTS = {
  // Cut from 0.35: BM25 alone reliably put "CRACKER BARREL, grilled sirloin
  // steak" and "DENNY'S, top sirloin steak" ahead of a plain cut of beef for
  // the query "steak" — short, tightly-worded branded rows out-score longer
  // generic USDA descriptions on term density every time. categoryQuality
  // below is what actually fixes that; bm25 still breaks ties within a
  // category tier.
  bm25: 0.22,
  /** Large, because directly-observed packaging text is an observation. */
  brandMatch: 0.2,
  prepMatch: 0.1,
  categoryPrior: 0.1,
  portionPlausibility: 0.1,
  popularityPrior: 0.1,
  /** v1.x only. Zero for now; the remaining weights already sum to 1.0. */
  embeddingCosine: 0,
  /**
   * Plain queries prefer plain food. BM25 alone rewards a short, tightly-worded
   * row like "Chicken breast tenders, breaded, uncooked" over the longer, more
   * heavily qualified "Chicken, broiler or fryers, breast, skinless, boneless,
   * meat only, raw" for the query "chicken breast" — precisely backwards from
   * what someone typing the plain query wants. This signal only fires when
   * neither the query nor the row is asking for a processed form, so a genuine
   * "chicken tenders" search is untouched.
   */
  wholeFoodPrior: 0.08,
  /** "Always prioritize showing the raw stuff first" — an explicit, repeated ask. */
  rawPreference: 0.14,
  /** "Chicken breast" defaults to skinless; "steak" defaults to the trimmed cut. */
  leanPreference: 0.1,
  /**
   * The decisive signal for "I just need whole foods." Built from USDA's own
   * category taxonomy (see build.mjs), not a name guess: a row filed under
   * Fast Foods / Restaurant Foods / Branded Food Products Database / Meals,
   * Entrees & Side Dishes / Sausages & Luncheon Meats loses this outright,
   * regardless of how plain its name reads, while a row filed under one of
   * the ten single-ingredient categories (Beef, Poultry, Vegetables, Fruits,
   * ...) gets the full bonus. Weighted ABOVE bm25 on purpose — this is a
   * search whose primary job is keeping restaurant/branded noise out.
   */
  categoryQuality: 0.3,
  basisAmbiguityPenalty: 0.15,
  /**
   * "Eggs" means whole eggs. Egg yolk and egg white are filed under the same
   * "Dairy and Egg Products" category, the same "Egg, ___, raw" name shape, and
   * match a plain "egg raw" query on bm25 EXACTLY as well as the whole egg does
   * (same token count) — every other signal above ties all three too, at their
   * max value, and the tie used to fall to popularityPrior, which favors
   * "Egg, yolk, raw, fresh" by a hair — silently more than doubling the
   * calories of every text-logged "eggs" entry (322 kcal/100g yolk vs 143
   * kcal/100g whole egg). A SUBTRACTED penalty, not an added bonus, because the
   * tied signals already sum past 1.0 and get clamped there: a bonus on the
   * whole-egg row would just be absorbed by the clamp and change nothing.
   */
  eggPartPenalty: 0.2,
} as const

/**
 * Auto-accept thresholds. BOTH must hold.
 *
 * The two-part rule is the structurally important part:
 *   - An absolute floor alone would auto-accept a mediocre top score just because
 *     nothing else came close — a genuinely novel dish with five equally-bad
 *     candidates.
 *   - A relative-gap rule alone would auto-accept a great score sitting beside an
 *     almost-as-great near-duplicate — two branded SKUs of the same product at
 *     different pack sizes — when the user really should glance at it.
 */
export const AUTO_ACCEPT = {
  minScore: 0.6,
  minGap: 0.12,
} as const

/**
 * FTS5 bm25() returns more-negative-is-more-relevant and is unbounded. Map the
 * result set onto 0-1 by its own range, so a query whose best hit is weak does not
 * get a free 1.0 just for being the best of a bad set — which is exactly what the
 * absolute auto-accept floor then catches.
 */
export function normalizeBm25(candidates: readonly Candidate[]): Map<string, number> {
  const out = new Map<string, number>()
  if (candidates.length === 0) return out

  const scores = candidates.map((c) => -c.rawBm25)
  const min = Math.min(...scores)
  const max = Math.max(...scores)
  const range = max - min

  candidates.forEach((c, i) => {
    const s = scores[i] ?? 0
    // A single candidate, or an all-equal set, gets a neutral 0.5 rather than a
    // free 1.0 — being the only option is not evidence of being a good one.
    out.set(c.foodId, range === 0 ? 0.5 : (s - min) / range)
  })
  return out
}

function normalizeText(s: string): string {
  return s.trim().toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ')
}

/** 1.0 on exact brand match, 0 otherwise. */
export function brandMatch(c: Candidate, ctx: ScoringContext): number {
  if (!ctx.observedBrand || !c.brand) return 0
  return normalizeText(c.brand) === normalizeText(ctx.observedBrand) ? 1 : 0
}

/**
 * 1.0 on match, 0.5 when the row has NO prep facet, 0 on explicit conflict.
 *
 * The 0.5 is the load-bearing part: an untagged row is UNKNOWN, not contradicted.
 * Scoring it as a conflict would systematically punish generic USDA rows, which
 * frequently carry no prep facet at all, in favour of over-specified branded rows.
 */
export function prepMatch(c: Candidate, ctx: ScoringContext): number {
  if (!ctx.prepFacet) return 0.5
  if (!c.prepFacet) return 0.5
  return normalizeText(c.prepFacet) === normalizeText(ctx.prepFacet) ? 1 : 0
}

/** Same three-way logic. A scoring PRIOR, never a hard filter. */
export function categoryPrior(c: Candidate, ctx: ScoringContext): number {
  if (!ctx.modelCategory || !c.category) return 0.5
  return normalizeText(c.category) === normalizeText(ctx.modelCategory) ? 1 : 0
}

/**
 * How plausible this row is at the estimated mass.
 *
 * Penalizes matching "bouillon cube" when the plate clearly holds 150 g. Uses the
 * row's own typical portion range where known, falling back to its serving size.
 */
export function portionPlausibility(c: Candidate, ctx: ScoringContext): number {
  if (ctx.estimatedGrams == null || ctx.estimatedGrams <= 0) return 0.5

  const min = c.typicalGramsMin ?? (c.servingSizeG != null ? c.servingSizeG * 0.25 : null)
  const max = c.typicalGramsMax ?? (c.servingSizeG != null ? c.servingSizeG * 4 : null)
  if (min == null || max == null) return 0.5

  if (ctx.estimatedGrams >= min && ctx.estimatedGrams <= max) return 1

  // Decay smoothly by how many multiples outside the range we landed, rather than
  // cliff-edging to zero — a row can be right even at an unusual portion.
  const distance =
    ctx.estimatedGrams < min ? min / Math.max(ctx.estimatedGrams, 0.1) : ctx.estimatedGrams / max
  return Math.max(0, 1 / distance)
}

/**
 * Words that mark a food as a manufactured/processed FORM of an ingredient
 * rather than the ingredient itself — a tender, a nugget, a deli slice, a
 * jerky — as opposed to prep words like "grilled" or "raw" that describe how a
 * whole food was cooked without changing what it fundamentally is.
 */
const PROCESSED_FORM = /\b(tenders?|nuggets?|patt(?:y|ies)|breaded|sausages?|link|deli|luncheon|roll|loaf|spread|jerky|hot ?dogs?|bologna|glazed|fat-free|smoked)\b/i

/**
 * 1.0 when a plain query matches a plain (unprocessed) row, 0 when a plain
 * query hits a processed-form row, and neutral 0.5 whenever the query itself
 * asked for a processed form — the user's own words settle it, this signal
 * should never fight them.
 */
export function wholeFoodPrior(c: Candidate, ctx: ScoringContext): number {
  if (PROCESSED_FORM.test(ctx.canonicalFoodKey)) return 0.5
  return PROCESSED_FORM.test(c.name) ? 0 : 1
}

/**
 * `foods.prep_facet` is never populated (no build step derives it), so this
 * reads USDA's own cooking-state wording straight off the name — the same
 * approach as PROCESSED_FORM above. "raw"/"uncooked" wins by default; any
 * named cooking method loses by default; unlabeled rows stay neutral. Only
 * fires when the query itself is silent on cooking method — search "grilled
 * chicken breast" and this steps aside for the word the user actually typed.
 */
const RAW_MARKER = /\b(raw|uncooked)\b/i
const COOKED_MARKER =
  /\b(cooked|roasted|grilled|boiled|steamed|baked|broiled|stewed|poached|braised|fried|rotisserie|bbq|barbecue|smoked|toasted|simmered)\b/i

export function rawPreference(c: Candidate, ctx: ScoringContext): number {
  if (RAW_MARKER.test(ctx.canonicalFoodKey) || COOKED_MARKER.test(ctx.canonicalFoodKey)) return 0.5
  if (RAW_MARKER.test(c.name)) return 1
  if (COOKED_MARKER.test(c.name)) return 0
  return 0.5
}

/**
 * "Chicken breast" with no other qualifier means the skinless, boneless,
 * trimmed cut in every diet-tracking context — but USDA lists "meat and
 * skin" first alphabetically before "skinless, boneless, meat only" for the
 * same bird, and that extra "and skin" wording was winning on bm25 alone
 * (denser token match, shorter document). Same shape as rawPreference: only
 * fires when the query itself doesn't ask for the fattier cut.
 */
const LEAN_MARKER = /\b(skinless|meat only|lean only|separable lean only)\b/i
const FATTY_MARKER = /\b(meat and skin|with skin|skin on|separable lean and fat|meat and fat)\b/i

export function leanPreference(c: Candidate, ctx: ScoringContext): number {
  if (LEAN_MARKER.test(ctx.canonicalFoodKey) || FATTY_MARKER.test(ctx.canonicalFoodKey)) return 0.5
  if (LEAN_MARKER.test(c.name)) return 1
  if (FATTY_MARKER.test(c.name)) return 0
  return 0.5
}

/**
 * USDA's own 28-category taxonomy (`foods.category`, populated in build.mjs
 * from food_category.csv — real data, not a guess). Ten categories are a
 * single whole ingredient; five are branded, restaurant, or multi-ingredient
 * prepared food. Everything else (Baked Products, Snacks, Beverages, Sweets,
 * Cereal Grains, ...) is neither — it is real food, just not the target of
 * this signal, so it stays neutral.
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

const LOW_PRIORITY_CATEGORIES = new Set([
  'Fast Foods',
  'Restaurant Foods',
  'Branded Food Products Database',
  'Meals, Entrees, and Side Dishes',
  'Sausages and Luncheon Meats',
])

/**
 * "Lamb, Veal, and Game Products" bundles two everyday proteins with two
 * specialty ones — bison and (bulk-labeled) "Game meat" cover venison, elk,
 * ostrich and the like. A plain "steak" or "chicken" search has no business
 * surfacing bison next to beef; someone who means bison types "bison." This
 * only demotes the row when the QUERY itself doesn't ask for it — searching
 * "bison steak" gets the full whole-food credit like anything else.
 */
const SPECIALTY_GAME_NAME = /^(game meat|bison)\b/i
const GAME_QUERY_TERMS = /\b(bison|venison|elk|ostrich|game|deer|boar|rabbit|buffalo)\b/i

/** 1.0 for a plain single-ingredient category, 0 for branded/restaurant/prepared, 0.5 otherwise, unknown, or unrequested specialty game. */
export function categoryQuality(c: Candidate, ctx: ScoringContext): number {
  if (c.category == null) return 0.5
  if (LOW_PRIORITY_CATEGORIES.has(c.category)) return 0
  if (WHOLE_FOOD_CATEGORIES.has(c.category)) {
    if (SPECIALTY_GAME_NAME.test(c.name) && !GAME_QUERY_TERMS.test(ctx.canonicalFoodKey)) return 0.5
    return 1
  }
  return 0.5
}

/**
 * 1.0 when this row is egg yolk or egg white AND the query never asked for a
 * component (so the penalty applies), 0 otherwise. Only fires on the exact
 * USDA "Egg, yolk|white, ..." naming so it never touches unrelated
 * "white"/"yolk" words elsewhere in the corpus (e.g. "Rice, white, long-grain").
 */
const EGG_PART_NAME = /^egg,\s*(yolk|white)\b/i
const EGG_PART_QUERY = /\b(yolk|whites?)\b/i

export function eggPartPenalty(c: Candidate, ctx: ScoringContext): number {
  if (EGG_PART_QUERY.test(ctx.canonicalFoodKey)) return 0
  return EGG_PART_NAME.test(c.name) ? 1 : 0
}

/** Zipfian tie-break toward the more commonly logged row. */
export function popularityPrior(c: Candidate): number {
  if (c.popularityRank == null || c.popularityRank <= 0) return 0.3
  // Rank 1 -> 1.0, decaying with the log of rank.
  return 1 / (1 + Math.log10(c.popularityRank))
}

/**
 * Subtracted when serving metadata is incomplete. An incomplete row is a worse
 * candidate because its onward unit math is less trustworthy — not because it is
 * less likely to be the right food.
 */
export function basisAmbiguity(c: Candidate): number {
  let penalty = 0
  if (c.basisConfidence === 'low') penalty += 0.6
  if (c.energyKcal == null) penalty += 0.4
  if (c.completenessScore != null && c.completenessScore < 0.5) penalty += 0.3
  return Math.min(1, penalty)
}

export interface ScoredCandidate extends Candidate {
  score: number
  breakdown: Record<string, number>
}

export function scoreCandidates(
  candidates: readonly Candidate[],
  ctx: ScoringContext,
): ScoredCandidate[] {
  const bm25 = normalizeBm25(candidates)

  return candidates
    .map((c) => {
      const parts = {
        bm25: bm25.get(c.foodId) ?? 0,
        brandMatch: brandMatch(c, ctx),
        prepMatch: prepMatch(c, ctx),
        categoryPrior: categoryPrior(c, ctx),
        portionPlausibility: portionPlausibility(c, ctx),
        popularityPrior: popularityPrior(c),
        wholeFoodPrior: wholeFoodPrior(c, ctx),
        categoryQuality: categoryQuality(c, ctx),
        rawPreference: rawPreference(c, ctx),
        leanPreference: leanPreference(c, ctx),
        eggPartPenalty: eggPartPenalty(c, ctx),
        basisAmbiguity: basisAmbiguity(c),
      }

      const score =
        WEIGHTS.bm25 * parts.bm25 +
        WEIGHTS.brandMatch * parts.brandMatch +
        WEIGHTS.prepMatch * parts.prepMatch +
        WEIGHTS.categoryPrior * parts.categoryPrior +
        WEIGHTS.portionPlausibility * parts.portionPlausibility +
        WEIGHTS.popularityPrior * parts.popularityPrior +
        WEIGHTS.wholeFoodPrior * parts.wholeFoodPrior +
        WEIGHTS.categoryQuality * parts.categoryQuality +
        WEIGHTS.rawPreference * parts.rawPreference +
        WEIGHTS.leanPreference * parts.leanPreference -
        WEIGHTS.basisAmbiguityPenalty * parts.basisAmbiguity -
        WEIGHTS.eggPartPenalty * parts.eggPartPenalty

      return { ...c, score: Math.max(0, Math.min(1, score)), breakdown: parts }
    })
    .sort((a, b) => b.score - a.score)
}

export type ResolutionOutcome =
  | { kind: 'auto_accept'; match: ScoredCandidate }
  | { kind: 'disambiguate'; candidates: ScoredCandidate[] }
  | { kind: 'miss' }

/**
 * Apply the two-part auto-accept rule.
 *
 * `maxCandidates` defaults to 5 — right for the AI-scan disambiguation chip
 * sheet this was designed for, where the list sits inline in a mid-review
 * flow. The manual Food Database search screen is a dedicated results list
 * with room to scroll, and passes a much larger number so "search for steak"
 * behaves like search, not like a 5-item multiple-choice question.
 */
export function decideOutcome(scored: readonly ScoredCandidate[], maxCandidates = 5): ResolutionOutcome {
  if (scored.length === 0) return { kind: 'miss' }

  const top = scored[0]
  if (!top) return { kind: 'miss' }
  const second = scored[1]
  const gap = second ? top.score - second.score : Number.POSITIVE_INFINITY

  if (top.score >= AUTO_ACCEPT.minScore && gap >= AUTO_ACCEPT.minGap) {
    return { kind: 'auto_accept', match: top }
  }

  return { kind: 'disambiguate', candidates: scored.slice(0, maxCandidates) }
}
