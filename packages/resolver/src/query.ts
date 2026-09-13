/**
 * Query construction for FTS5.
 *
 * SPEC-accuracy-engine.md §5.4. Two things this module deliberately does NOT do,
 * because FTS5 already does them better:
 *
 *   PLURALS AND INFLECTION -> the porter tokenizer, not app code. It is applied
 *   identically to indexed content and to the query, so over-stemming
 *   (sauce -> sauc) is irrelevant: it only has to be internally consistent, which
 *   it is by construction.
 *
 *   WORD ORDER -> needs no handling at all. FTS5 ANDs bareword tokens regardless
 *   of order, so `chicken breast grilled` matches "Chicken, broilers or fryers,
 *   breast, meat only, cooked, grilled". USDA's comma-reversed attribute-heavy
 *   naming works naturally with unordered token matching, and no comma-permutation
 *   logic is needed anywhere.
 *
 * This is the concrete reason the system prompt insists on generic-noun-first
 * USDA-style keys: the query and the corpus share an idiom, and BM25 rewards that.
 */

/** FTS5 syntax characters that must never reach the matcher unescaped. */
const FTS_SPECIAL = /["()*:^-]/g

/**
 * Turn a canonical food key into an FTS5 MATCH expression.
 *
 * Every token is double-quoted, which makes it a literal bareword rather than a
 * potential operator. Without this, a food key containing `OR` or `NOT` — or a
 * user typing `chicken - breast` in the search box — silently becomes a different
 * query, and a stray unbalanced quote is a runtime error rather than zero results.
 */
export function toMatchExpression(text: string): string | null {
  const tokens = text
    .toLowerCase()
    .replace(FTS_SPECIAL, ' ')
    .split(/[\s,]+/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)

  if (tokens.length === 0) return null
  return tokens.map((t) => `"${t}"`).join(' ')
}

/**
 * Bare binary-state words dropped from the MANDATORY match tokens before the
 * ladder is built — NOT specific cooking methods (grilled, roasted, ... stay,
 * see toMatchExpression's test coverage). Requiring the literal word "raw" is
 * worse than requiring nothing: USDA overwhelmingly says "dry" for an uncooked
 * grain, never "raw" ("Cereals, oats, regular and quick, not fortified, dry"),
 * so AND-ing "raw" into the query doesn't broaden matching, it NARROWS to
 * whatever coincidentally happens to contain that literal word — for "oats,
 * raw" that is exactly one row, "Oat bran, raw", a different food entirely.
 * Because that rung returns a non-empty (if wrong) result, the ladder's
 * broaden-on-zero-hit rule never gets a chance to reach the correct "oats"
 * rung at all. Dropping these words from the QUERY doesn't lose the
 * raw-vs-cooked signal — `ctx.canonicalFoodKey` still carries it straight
 * through to `rawPreference`/`prepMatch`, which is where this distinction
 * belongs: a scored preference among the candidates FTS finds, not a
 * precondition for finding them.
 */
const STATE_WORDS = new Set(['raw', 'cooked', 'uncooked', 'unprepared', 'fresh'])

/**
 * A progressively broader ladder of MATCH expressions.
 *
 * The full AND query is precise but brittle: one token absent from the corpus
 * returns zero rows even when the rest matched perfectly. Rather than jumping
 * straight to the miss path, drop the least-informative tokens and retry.
 * Recorded per attempt so the zero-hit rate can be instrumented honestly — §5.5
 * sets a concrete upgrade trigger at ~5% zero-hit, which only means something if
 * the measurement counts real misses rather than first-attempt misses.
 */
export function matchLadder(canonicalFoodKey: string): string[] {
  const tokens = canonicalFoodKey
    .toLowerCase()
    .replace(FTS_SPECIAL, ' ')
    .split(/[\s,]+/)
    .filter((t) => t.length > 0 && !STATE_WORDS.has(t))

  if (tokens.length === 0) return []

  const ladder: string[] = []
  const all = tokens.map((t) => `"${t}"`).join(' ')
  ladder.push(all)

  // Drop trailing modifiers first — in USDA-style keys the head noun leads, so
  // "chicken breast, grilled" degrades to "chicken breast" rather than "grilled".
  for (let keep = tokens.length - 1; keep >= 1; keep--) {
    const expr = tokens.slice(0, keep).map((t) => `"${t}"`).join(' ')
    if (!ladder.includes(expr)) ladder.push(expr)
  }

  // Last resort: OR the tokens so a partial match still surfaces candidates for
  // the disambiguation sheet.
  if (tokens.length > 1) {
    ladder.push(tokens.map((t) => `"${t}"`).join(' OR '))
  }

  return ladder
}

/**
 * The plain, un-quoted words a given `matchLadder` step actually searched
 * for — so a caller can tell the user "no match for X, showing Y instead"
 * rather than silently returning results for a narrower query than the one
 * typed. A search for "beef tendon" that finds nothing containing "tendon"
 * broadens to "beef" alone at step 1 (`matchLadder`'s trailing-modifier
 * drop); without disclosing that, a wall of unrelated beef cuts reads as the
 * app ignoring what was typed rather than honestly saying it couldn't find
 * "tendon" at all.
 */
export function ladderStepWords(canonicalFoodKey: string, step: number): string[] {
  const tokens = canonicalFoodKey
    .toLowerCase()
    .replace(FTS_SPECIAL, ' ')
    .split(/[\s,]+/)
    .filter((t) => t.length > 0 && !STATE_WORDS.has(t))
  if (tokens.length === 0) return []
  // The final OR-fallback step (only reachable when there's more than one
  // token) doesn't drop anything — it loosens AND to OR over every token.
  if (step >= tokens.length) return tokens
  return tokens.slice(0, tokens.length - step)
}

/** Trigram query for the typo-tolerant shadow index. Needs >= 3 characters. */
export function toTrigramExpression(text: string): string | null {
  const cleaned = text.toLowerCase().replace(FTS_SPECIAL, ' ').trim()
  return cleaned.length >= 3 ? `"${cleaned}"` : null
}
