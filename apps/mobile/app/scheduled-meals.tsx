import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import {
  deletePlannedMeal,
  localDate,
  plannedMeals,
  savedMeals,
  schedulePlannedMeal,
  WEEKDAY_LABELS,
  type PlannedMealListEntry,
  type SavedMealListEntry,
} from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const MEAL_SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const

/**
 * Scheduled meals.
 *
 * A plan is a saved meal earmarked for a future day — a specific date, or
 * every week on a weekday. There is no push notification behind this: the
 * plan is realized into a real logged meal the next time that day's data is
 * opened on Home (`materializePlannedMeals`), so from the user's side it just
 * shows up already logged, the same as if they had typed it in that morning.
 */
export default function ScheduledMeals() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [plans, setPlans] = useState<PlannedMealListEntry[]>([])
  const [saved, setSaved] = useState<SavedMealListEntry[]>([])

  const [composing, setComposing] = useState(false)
  const [pickedMealId, setPickedMealId] = useState<number | null>(null)
  const [recurrence, setRecurrence] = useState<'once' | 'weekly'>('once')
  const [onceOffset, setOnceOffset] = useState(0)
  const [weeklyDays, setWeeklyDays] = useState<Set<number>>(new Set())
  const [mealSlot, setMealSlot] = useState<(typeof MEAL_SLOTS)[number] | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    let alive = true
    void Promise.all([plannedMeals(), savedMeals()]).then(([p, s]) => {
      if (!alive) return
      setPlans(p)
      setSaved(s)
    })
    return () => {
      alive = false
    }
  }, [])

  useFocusEffect(load)

  function openCompose() {
    setPickedMealId(null)
    setRecurrence('once')
    setOnceOffset(0)
    setWeeklyDays(new Set())
    setMealSlot(null)
    setComposing(true)
  }

  function toggleWeekday(d: number) {
    setWeeklyDays((cur) => {
      const next = new Set(cur)
      if (next.has(d)) next.delete(d)
      else next.add(d)
      return next
    })
  }

  const canSchedule = pickedMealId != null && (recurrence === 'once' || weeklyDays.size > 0)

  async function confirmSchedule() {
    if (!canSchedule || pickedMealId == null || saving) return
    setSaving(true)
    try {
      const now = Date.now()
      if (recurrence === 'once') {
        const targetDate = localDate(now + onceOffset * 86_400_000)
        await schedulePlannedMeal(pickedMealId, { localDate: targetDate }, mealSlot, now)
      } else {
        for (const weekday of weeklyDays) {
          await schedulePlannedMeal(pickedMealId, { weekday }, mealSlot, now)
        }
      }
      setComposing(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  function confirmDelete(p: PlannedMealListEntry) {
    Alert.alert('Cancel this scheduled meal?', `"${p.name}" will no longer log automatically.`, [
      { text: 'Keep it', style: 'cancel' },
      { text: 'Cancel plan', style: 'destructive', onPress: () => void deletePlannedMeal(p.id).then(load) },
    ])
  }

  function describe(p: PlannedMealListEntry): string {
    if (p.weekday != null) return `Every ${WEEKDAY_LABELS[p.weekday]}`
    if (p.localDate == null) return ''
    const today = localDate(Date.now())
    const tomorrow = localDate(Date.now() + 86_400_000)
    if (p.localDate === today) return 'Today'
    if (p.localDate === tomorrow) return 'Tomorrow'
    return new Date(`${p.localDate}T00:00:00`).toLocaleDateString(undefined, {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
    })
  }

  const pickedMeal = saved.find((s) => s.id === pickedMealId) ?? null

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + space.lg }}>
      <View style={styles.head}>
        <Text style={[type.title, { color: theme.text }]}>Scheduled meals</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <Pressable accessibilityRole="button" accessibilityLabel="Schedule a meal" onPress={openCompose} hitSlop={space.sm}>
            <Icon name="plus" size={22} color={theme.text} />
          </Pressable>
          <Pressable onPress={() => router.back()} hitSlop={space.md}>
            <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        {plans.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: theme.bgSunken }]}>
            <Text style={[type.bodyStrong, { color: theme.text }]}>Nothing scheduled</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
              Pick a saved meal and a day — one-time or every week — and it logs itself the moment
              that day's log is opened. No prompt to confirm, no chip to tap.
            </Text>
          </View>
        ) : (
          plans.map((p) => (
            <Pressable
              key={p.id}
              onLongPress={() => confirmDelete(p)}
              style={[styles.row, { backgroundColor: theme.bgSunken }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: theme.text }]}>{p.name}</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>
                  {describe(p)}
                  {p.mealSlot ? ` · ${p.mealSlot}` : ''} · {Math.round(p.kcal)} kcal
                </Text>
              </View>
              <Icon name={p.weekday != null ? 'clock' : 'calendar'} size={18} color={theme.protein} />
            </Pressable>
          ))
        )}
        {plans.length > 0 ? (
          <Text style={[type.micro, { color: theme.textFaint, marginTop: space.md, textAlign: 'center' }]}>
            Hold a scheduled meal to cancel it.
          </Text>
        ) : null}
      </ScrollView>

      {composing ? (
        <View style={[styles.composeOverlay, { backgroundColor: theme.bg, paddingTop: insets.top + space.lg }]}>
          <View style={styles.spread}>
            <Text style={[type.title, { color: theme.text, fontSize: 22 }]}>
              {pickedMeal ? pickedMeal.name : 'Schedule a meal'}
            </Text>
            <Pressable accessibilityRole="button" onPress={() => setComposing(false)} hitSlop={space.md}>
              <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.xl }}>
            {pickedMeal == null ? (
              saved.length === 0 ? (
                <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xl, lineHeight: 19 }]}>
                  You don't have any saved meals yet. Open a logged meal and tap "Save meal", or add a
                  custom recipe from Saved foods, then come back here to schedule it.
                </Text>
              ) : (
                <View style={{ marginTop: space.lg, gap: space.sm }}>
                  <Text style={[type.label, { color: theme.textMuted }]}>Pick a saved meal</Text>
                  {saved.map((m) => (
                    <Pressable
                      key={m.id}
                      onPress={() => setPickedMealId(m.id)}
                      style={[styles.row, { backgroundColor: theme.bgSunken }]}
                    >
                      <View style={{ flex: 1 }}>
                        <Text style={[type.bodyStrong, { color: theme.text }]}>{m.name}</Text>
                        <Text style={[type.caption, { color: theme.textMuted }]}>{Math.round(m.kcal)} kcal</Text>
                      </View>
                      <Icon name="chevron" size={14} color={theme.textFaint} />
                    </Pressable>
                  ))}
                </View>
              )
            ) : (
              <View style={{ marginTop: space.lg, gap: space.xl }}>
                <View>
                  <Text style={[type.label, { color: theme.textMuted, marginBottom: space.sm }]}>When</Text>
                  <View style={{ flexDirection: 'row', gap: space.sm }}>
                    <ChoiceChip label="One time" active={recurrence === 'once'} onPress={() => setRecurrence('once')} />
                    <ChoiceChip label="Every week" active={recurrence === 'weekly'} onPress={() => setRecurrence('weekly')} />
                  </View>
                </View>

                {recurrence === 'once' ? (
                  <View>
                    <Text style={[type.label, { color: theme.textMuted, marginBottom: space.sm }]}>Which day</Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                      {Array.from({ length: 7 }, (_, i) => i).map((i) => {
                        const d = new Date(Date.now() + i * 86_400_000)
                        const label = i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : WEEKDAY_SHORT[d.getDay()]
                        return (
                          <ChoiceChip key={i} label={label} active={onceOffset === i} onPress={() => setOnceOffset(i)} />
                        )
                      })}
                    </View>
                  </View>
                ) : (
                  <View>
                    <Text style={[type.label, { color: theme.textMuted, marginBottom: space.sm }]}>
                      Which day(s) of the week
                    </Text>
                    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                      {WEEKDAY_SHORT.map((label, i) => (
                        <ChoiceChip key={i} label={label} active={weeklyDays.has(i)} onPress={() => toggleWeekday(i)} />
                      ))}
                    </View>
                  </View>
                )}

                <View>
                  <Text style={[type.label, { color: theme.textMuted, marginBottom: space.sm }]}>
                    Meal (optional)
                  </Text>
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space.sm }}>
                    {MEAL_SLOTS.map((slot) => (
                      <ChoiceChip
                        key={slot}
                        label={slot[0]!.toUpperCase() + slot.slice(1)}
                        active={mealSlot === slot}
                        onPress={() => setMealSlot((cur) => (cur === slot ? null : slot))}
                      />
                    ))}
                  </View>
                </View>

                <Pressable onPress={() => setPickedMealId(null)}>
                  <Text style={[type.label, { color: theme.protein }]}>Choose a different saved meal</Text>
                </Pressable>
              </View>
            )}
          </ScrollView>

          {pickedMeal != null ? (
            <Pressable
              accessibilityRole="button"
              disabled={!canSchedule || saving}
              onPress={() => void confirmSchedule()}
              style={[
                styles.primary,
                { backgroundColor: canSchedule ? theme.text : theme.border, marginBottom: Math.max(insets.bottom, space.lg) },
              ]}
            >
              <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>
                {saving ? 'Scheduling…' : 'Schedule'}
              </Text>
            </Pressable>
          ) : null}
        </View>
      ) : null}
    </View>
  )
}

function ChoiceChip({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      onPress={onPress}
      style={[
        styles.chip,
        {
          borderColor: active ? theme.text : theme.border,
          backgroundColor: active ? theme.text : 'transparent',
        },
      ]}
    >
      <Text style={[type.label, { color: active ? theme.bg : theme.text }]}>{label}</Text>
    </Pressable>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  empty: { padding: space.lg, borderRadius: radius.xl },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, borderRadius: radius.lg, marginBottom: space.sm,
    minHeight: MIN_TAP_TARGET,
  },
  composeOverlay: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, paddingHorizontal: space.lg,
  },
  chip: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    minHeight: MIN_TAP_TARGET,
    alignItems: 'center',
    justifyContent: 'center',
  },
  primary: {
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
  },
})
