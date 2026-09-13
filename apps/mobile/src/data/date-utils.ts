/**
 * Local-date and meal-slot helpers.
 *
 * ZERO React Native imports, deliberately — same reasoning as backup-core.ts.
 * repo.ts re-exports these for its existing callers; manual-food.ts imports
 * them from here directly rather than from repo.ts, so it never pulls in
 * repo.ts's `expo-sqlite`/`../db/expo-adapter` imports and can run under bare
 * Node in the test suite.
 */

export function localDate(ms: number): string {
  // Local, not UTC. An 11pm meal must not migrate to tomorrow, and a user who
  // flies must not have yesterday's log rewritten under them.
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** Local hour → slot. Deterministic, editable later; never inferred by a model. */
export function slotFor(ms: number): string {
  const h = new Date(ms).getHours()
  if (h < 11) return 'breakfast'
  if (h < 16) return 'lunch'
  if (h < 21) return 'dinner'
  return 'snack'
}

/**
 * `dateStr` (YYYY-MM-DD) combined with the wall-clock time of day from
 * `from` — moves a timestamp to a different DAY while keeping a believable
 * time, so logging something "for Friday" while it's 7pm Tuesday still lands
 * in the dinner slot (`slotFor` reads only the hour) instead of always
 * defaulting to midnight. Used to log ahead to a future day, or to backdate
 * to a past one — `meals.local_date` has no constraint tying it to today.
 */
export function atDate(dateStr: string, from: number = Date.now()): number {
  const [y, m, d] = dateStr.split('-').map(Number)
  const t = new Date(from)
  t.setFullYear(y as number, (m as number) - 1, d)
  return t.getTime()
}

/**
 * Consecutive logged days ending today. `dates` is any list of local-date
 * strings (duplicates and any order are fine — it's read as a set). A day
 * still in progress must not break a streak that is otherwise intact, so
 * today missing simply starts the count from yesterday instead of reading 0.
 *
 * `now` defaults to the real clock but takes an explicit value so this stays
 * pure and testable without stubbing `Date.now`.
 */
export function countStreak(dates: readonly string[], now: number = Date.now()): number {
  if (dates.length === 0) return 0
  const set = new Set(dates)
  const day = 86_400_000
  let n = 0
  let cursor = now
  if (!set.has(localDate(cursor))) cursor -= day
  while (set.has(localDate(cursor))) {
    n++
    cursor -= day
  }
  return n
}
