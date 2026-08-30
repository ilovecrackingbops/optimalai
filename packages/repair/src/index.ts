import type { Item } from '@nutai/core-schema'
import {
  QUESTION_BANK,
  inferStructuralUncertainty,
  type BankQuestion,
} from './question-bank.js'

export * from './question-bank.js'

/**
 * The interruption rule.
 *
 * SPEC-accuracy-engine.md §8.1.
 *
 *   expected_value(Q) = P(assumption_wrong) x expected_kcal_swing(Q) x severity
 *
 *   ASK Q as a highlighted chip iff  expected_value(Q) > INTERRUPTION_THRESHOLD
 *                                    AND selected_this_scan < MAX_QUESTIONS
 *   ELSE apply the silent default and render it as a visibly-editable,
 *        clearly-labeled, PRE-ANSWERED chip. Never a hidden assumption.
 *
 * THE SINGLE MOST IMPORTANT PROPERTY OF THE ENTIRE DESIGN is the asymmetry this
 * produces: a typical home-cooked mixed-dish photo surfaces 1-2 questions, while a
 * banana or a plain grilled chicken breast surfaces ZERO and logs in one tap. That
 * asymmetry is what stops the feature becoming a 30-second chore, which is the
 * failure mode that kills food logging apps.
 */

/**
 * Both constants are INFERRED, not measured. No study surfaced a user-tolerance
 * curve for question count. They live here, together, as named dials so that "how
 * chatty is the app" is one auditable knob rather than scattered heuristics — and
 * they are explicitly A/B-testable from day one.
 */
export const MAX_QUESTIONS = 2
export const INTERRUPTION_THRESHOLD = 45

export interface SelectionInput {
  item: Item
  /**
   * The IngredientRow this question is about — carried through onto every
   * SelectedQuestion it produces so an answer can be applied to the RIGHT
   * row. Without this, a multi-item meal's chips had no way to say which
   * ingredient they were even asking about, and answering most of them
   * (anything past portion_eaten and cooking_oil, which happen to have their
   * own row-finding workarounds) was a silent no-op.
   */
  rowId?: string | undefined
  /** Model reasons UNIONED with structural ones. Never replaced. */
  extraReasons?: readonly string[] | undefined
  /** Attributes this user has already answered 3+ times — these go silent. */
  rememberedAnswers?: ReadonlyMap<string, string> | undefined
  /** Nudged up when the user's calorie budget is tight. */
  severityWeight?: number | undefined
  /** Set when the gram engine's top two signals disagreed past threshold. */
  gramDisagreement?: { low: number; high: number } | undefined
  /** Set when the matched row has servings_per_container > 1.3. */
  multiServingPackage?: boolean | undefined
}

export interface SelectedQuestion {
  question: BankQuestion
  /** Rendered text, with any placeholders filled. */
  text: string
  expectedValue: number
  /** Highlighted = we are asking. Pre-answered = default applied and disclosed. */
  state: 'highlighted' | 'pre_answered'
  appliedDefault: string | null
  disclosure: string
  /** The ingredient row this question is about, when it is about one specific row. */
  rowId?: string | undefined
}

/**
 * Probability the silent default is wrong for this item.
 *
 * Deliberately RELATIVE, never treated as a calibrated absolute probability — see
 * §7.1 on why the model's own numbers cannot carry that weight. The structural
 * prior fires INDEPENDENT of model confidence, because the category itself is
 * high-variance (oil in a stir-fry) regardless of how confident the model claims
 * to be.
 */
function probabilityWrong(q: BankQuestion, item: Item, structural: boolean): number {
  let p = structural ? 0.55 : 0.3
  if (item.uncertainty_reason !== 'none' && q.reasons.includes(item.uncertainty_reason)) {
    p = Math.max(p, 0.7)
  }
  // Low model portion confidence raises it, but only as a nudge.
  if (item.portion_confidence < 0.4) p = Math.min(0.9, p + 0.15)
  else if (item.portion_confidence > 0.8) p = Math.max(0.15, p - 0.1)
  return p
}

export function expectedValue(
  q: BankQuestion,
  item: Item,
  structural: boolean,
  severityWeight: number,
): number {
  return probabilityWrong(q, item, structural) * q.expectedSwingKcal * severityWeight
}

/**
 * Select questions for one item.
 *
 * Returns ALL applicable questions — the highlighted ones we are asking, and the
 * pre-answered ones whose defaults we applied. Both are rendered; only the
 * highlighted ones interrupt. Nothing applicable is ever dropped silently, because
 * an undisclosed assumption is the failure this whole subsystem exists to prevent.
 */
export function selectQuestions(input: SelectionInput): SelectedQuestion[] {
  const { item } = input
  const severity = input.severityWeight ?? 1
  const structural = inferStructuralUncertainty(item)
  const structuralIds = new Set(structural.questionIds)

  const applicable: Array<{ q: BankQuestion; ev: number; structural: boolean }> = []

  for (const q of QUESTION_BANK) {
    // A question the user has answered the same way 3+ times becomes the silent
    // default and stops being asked. That is the whole "it learns from you" claim,
    // and it is a frequency table, not machine learning.
    if (input.rememberedAnswers?.has(q.id)) continue

    let isApplicable = false

    // Rank 1 applies to every plated scan. Ranks 2 and 9 have explicit triggers.
    if (q.id === 'portion_eaten') isApplicable = item.legible_label_text == null
    else if (q.id === 'servings_consumed') isApplicable = input.multiServingPackage === true
    else if (q.id === 'gram_disagreement') isApplicable = input.gramDisagreement != null
    else if (q.id === 'regular_or_diet') {
      // 'identity_ambiguous' is a generic "not sure what this food is" reason —
      // the model sets it for an egg it can't size up just as readily as for a
      // soda it can't read the label on. Bound to the reason alone, this asked
      // "Regular or diet?" on every kind of identity uncertainty, eggs included.
      // The question only means anything for an actual soda-type drink.
      isApplicable = item.is_beverage && item.beverage_category === 'soda_juice_other' &&
        q.reasons.includes(item.uncertainty_reason)
    } else {
      isApplicable =
        structuralIds.has(q.id) ||
        q.reasons.includes(item.uncertainty_reason) ||
        (input.extraReasons?.some((r) => (q.reasons as string[]).includes(r)) ?? false)
    }

    if (!isApplicable) continue
    applicable.push({ q, ev: expectedValue(q, item, structuralIds.has(q.id), severity), structural: structuralIds.has(q.id) })
  }

  // META-RULE: ranks 1-2 are closer to "always ask when applicable" than genuinely
  // threshold-gated. Their swing is multiplicative and their resolution is cheap
  // AND CERTAIN — they are factual questions, not perceptual ones. Ranks 3-11 are
  // what the expected-value computation should genuinely gate, because asking
  // about oil on a plain grilled breast with no visible sauce is a wasted
  // interruption with near-zero expected value.
  applicable.sort((a, b) => {
    if (a.q.multiplicative !== b.q.multiplicative) return a.q.multiplicative ? -1 : 1
    return b.ev - a.ev
  })

  let highlighted = 0
  return applicable.map(({ q, ev }) => {
    const clears = q.multiplicative || ev > INTERRUPTION_THRESHOLD
    const ask = clears && highlighted < MAX_QUESTIONS
    if (ask) highlighted++

    let text = q.text
    if (input.gramDisagreement && q.id === 'gram_disagreement') {
      text = text
        .replace('{low}', String(Math.round(input.gramDisagreement.low)))
        .replace('{high}', String(Math.round(input.gramDisagreement.high)))
    }

    return {
      question: q,
      text,
      expectedValue: ev,
      state: ask ? 'highlighted' : 'pre_answered',
      appliedDefault: ask ? null : q.silentDefault,
      disclosure: q.defaultDisclosure,
      rowId: input.rowId,
    }
  })
}

/**
 * Questions that describe the WHOLE PLATE, not one ingredient on it.
 * `selectQuestions` runs once per item, so without this a three-ingredient meal
 * would surface "Did you eat all of this, or some of it?" three times — once
 * per ingredient that happened to qualify — instead of the single, obviously
 * meal-wide question it actually is. Every other question in the bank (cooking
 * oil, sauce type, milk type...) genuinely can differ ingredient to ingredient,
 * so only these two are collapsed.
 */
const MEAL_SCOPED_QUESTION_IDS = new Set(['portion_eaten', 'servings_consumed'])

/** Keeps one instance of each meal-scoped question — the highlighted one if any, else the highest-value one. */
function dedupeMealScoped(qs: readonly SelectedQuestion[]): SelectedQuestion[] {
  const kept = new Map<string, SelectedQuestion>()
  const order: string[] = []
  const rest: SelectedQuestion[] = []

  for (const q of qs) {
    if (!MEAL_SCOPED_QUESTION_IDS.has(q.question.id)) {
      rest.push(q)
      continue
    }
    const existing = kept.get(q.question.id)
    if (!existing) order.push(q.question.id)
    if (!existing || (q.state === 'highlighted' && existing.state !== 'highlighted') || q.expectedValue > existing.expectedValue) {
      kept.set(q.question.id, q)
    }
  }

  return [...order.map((id) => kept.get(id)!), ...rest]
}

/** Highlighted questions across a whole meal, respecting the global cap. */
export function selectMealQuestions(items: readonly SelectionInput[]): SelectedQuestion[] {
  const all = dedupeMealScoped(items.flatMap((i) => selectQuestions(i)))
  const highlighted = all.filter((q) => q.state === 'highlighted')

  if (highlighted.length <= MAX_QUESTIONS) return all

  // Never more than MAX_QUESTIONS highlighted regardless of how many cleared the
  // threshold. Demote the lowest-value ones to pre-answered rather than dropping
  // them — their defaults still get disclosed.
  const keep = new Set(
    [...highlighted].sort((a, b) => b.expectedValue - a.expectedValue).slice(0, MAX_QUESTIONS),
  )
  return all.map((q) =>
    q.state === 'highlighted' && !keep.has(q)
      ? { ...q, state: 'pre_answered' as const, appliedDefault: q.question.silentDefault }
      : q,
  )
}

/**
 * Answer memory.
 *
 * SPEC §8.7. After the same answer for the same food concept 3 times, the 4th scan
 * applies it silently. A frequency table, nothing more — no fine-tuning, no
 * provider personalization API, no on-device training.
 */
export const REMEMBER_AFTER_ANSWERS = 3

export interface AttributeMemory {
  foodConceptKey: string
  attribute: string
  value: string
  answerCount: number
}

export function shouldApplySilently(memory: AttributeMemory | null): boolean {
  return memory != null && memory.answerCount >= REMEMBER_AFTER_ANSWERS
}

export function recordAnswer(
  existing: AttributeMemory | null,
  foodConceptKey: string,
  attribute: string,
  value: string,
): AttributeMemory {
  if (!existing || existing.value !== value) {
    // A changed answer resets the count. Someone who switches from whole milk to
    // oat has changed their habit, and three old answers should not outvote it.
    return { foodConceptKey, attribute, value, answerCount: 1 }
  }
  return { ...existing, answerCount: existing.answerCount + 1 }
}
