import { describe, expect, it } from 'vitest'
import { atDate, countStreak, localDate, slotFor } from './date-utils'

describe('atDate', () => {
  it('moves a timestamp to the given date while keeping its time of day', () => {
    const tuesday7pm = new Date(2026, 8, 8, 19, 30, 0).getTime() // 2026-09-08 19:30 local
    const moved = atDate('2026-09-11', tuesday7pm)
    expect(localDate(moved)).toBe('2026-09-11')
    const d = new Date(moved)
    expect(d.getHours()).toBe(19)
    expect(d.getMinutes()).toBe(30)
  })

  it('keeps the resulting slot consistent with the time of day it was moved from', () => {
    const dinnerTime = new Date(2026, 8, 8, 19, 0, 0).getTime()
    expect(slotFor(atDate('2026-09-20', dinnerTime))).toBe('dinner')
  })

  it('works moving backward (backdating) the same as forward (advance logging)', () => {
    const now = new Date(2026, 8, 9, 8, 0, 0).getTime() // 2026-09-09 08:00
    expect(localDate(atDate('2026-09-01', now))).toBe('2026-09-01')
    expect(localDate(atDate('2026-12-25', now))).toBe('2026-12-25')
  })

  it('defaults to the current time of day when `from` is omitted', () => {
    const moved = atDate('2026-09-15')
    expect(localDate(moved)).toBe('2026-09-15')
  })
})

describe('countStreak', () => {
  const day = 86_400_000
  const today = new Date(2026, 8, 9, 20, 0, 0).getTime() // Wed 2026-09-09, 8pm

  it('is 0 with no logged dates', () => {
    expect(countStreak([], today)).toBe(0)
  })

  it('counts consecutive days ending today', () => {
    const dates = [localDate(today), localDate(today - day), localDate(today - 2 * day)]
    expect(countStreak(dates, today)).toBe(3)
  })

  it('a day still in progress does not break an otherwise-intact streak — counts from yesterday', () => {
    const dates = [localDate(today - day), localDate(today - 2 * day), localDate(today - 3 * day)]
    expect(countStreak(dates, today)).toBe(3)
  })

  it('stops at the first genuine gap', () => {
    const dates = [localDate(today), localDate(today - day), localDate(today - 3 * day)]
    expect(countStreak(dates, today)).toBe(2)
  })

  it('a future-dated log (logged ahead of time) does not itself inflate the streak before that day arrives', () => {
    // Only yesterday and today logged; a meal already pre-logged for tomorrow
    // must not count until tomorrow actually is today.
    const dates = [localDate(today), localDate(today - day), localDate(today + day)]
    expect(countStreak(dates, today)).toBe(2)
  })

  it('ignores duplicate entries for the same date', () => {
    const d = localDate(today)
    expect(countStreak([d, d, d], today)).toBe(1)
  })
})
