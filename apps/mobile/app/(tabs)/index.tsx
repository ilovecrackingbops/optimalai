import { Image } from 'expo-image'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useMemo, useState } from 'react'
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle } from 'react-native-svg'
import { healthScore } from '@nutai/totals'
import { Icon, type IconName } from '../../src/components/Icon'
import { stepsFallbackKcal } from '../../src/exercise/met'
import { formatWeightKg, getUnitPref, type UnitPref } from '../../src/data/units'
import { nutrientHighlights, type NutrientHighlight } from '../../src/data/micronutrients'
import { openNutritionDb } from '../../src/db/expo-adapter'
import {
  currentGoal,
  dayTotals,
  db,
  deleteExerciseEntry,
  exerciseEntries,
  exerciseTotals,
  localDate,
  logWater,
  mealsForDate,
  runAdaptive,
  setting,
  undoLastWater,
  waterTotal,
  weightHistory,
  type AdaptiveOutcome,
  type CurrentGoal,
  type DayTotals,
  type ExerciseListEntry,
  type MealListEntry,
} from '../../src/data/repo'
import {
  availability,
  readToday,
  readTodayWorkouts,
  type HealthAvailability,
  type HealthReadout,
  type HealthWorkout,
} from '../../src/health/healthkit'
import { useTheme } from '../../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../../src/theme/tokens'

const DEFAULT_STEPS_GOAL = 10_000
const ML_PER_FL_OZ = 29.5735
const WATER_QUICK_ADD_ML = 8 * ML_PER_FL_OZ

const DAY_LABELS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']

/**
 * Home.
 *
 * Three rules this screen will not break, all of them about not moralising:
 *
 *   A day with nothing logged reads "no entries logged" in a neutral colour.
 *   Never "missed", never red — red is reserved for safety warnings.
 *
 *   Over target is STATED, not scolded. The ring draws a second overflow arc
 *   rather than clamping at 100% and lying about it.
 *
 *   Pending scans contribute ZERO calories and show as a count. A number that
 *   silently grows later is worse than one that is visibly incomplete.
 */
export default function Home() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()

  const [goal, setGoal] = useState<CurrentGoal | null>(null)
  const [totals, setTotals] = useState<DayTotals | null>(null)
  const [adaptive, setAdaptive] = useState<AdaptiveOutcome | null>(null)
  const [offset, setOffset] = useState(0)
  const [page, setPage] = useState(0)
  const [exercise, setExercise] = useState<{ kcal: number; count: number }>({ kcal: 0, count: 0 })
  const [exerciseList, setExerciseList] = useState<ExerciseListEntry[]>([])
  const [healthWorkouts, setHealthWorkouts] = useState<HealthWorkout[]>([])
  const [health, setHealth] = useState<HealthReadout | null>(null)
  const [healthAvail, setHealthAvail] = useState<HealthAvailability>('unavailable')
  const [meals, setMeals] = useState<MealListEntry[]>([])
  const [latestWeightKg, setLatestWeightKg] = useState<number | null>(null)
  const [weightLoggedToday, setWeightLoggedToday] = useState(false)
  const [waterMl, setWaterMl] = useState(0)
  const [unitPref, setUnitPref] = useState<UnitPref>('imperial')
  const [micros, setMicros] = useState<NutrientHighlight[]>([])
  const [stepGoal, setStepGoal] = useState(DEFAULT_STEPS_GOAL)

  const selected = useMemo(() => Date.now() + offset * 86_400_000, [offset])

  const reload = useCallback(() => {
    let alive = true
    void (async () => {
      // The adaptive loop runs BEFORE reading the goal, so a target it just
      // changed is the one rendered. Its own gates decide whether it may act.
      const outcome = await runAdaptive(Date.now())
      const date = localDate(selected)
      const [g, t, ex, exList, ml, avail, hk, hkWorkouts, weights, water, units, stepGoalStr] = await Promise.all([
        currentGoal(),
        dayTotals(date),
        exerciseTotals(date),
        exerciseEntries(date),
        mealsForDate(date),
        availability(),
        readToday(selected),
        readTodayWorkouts(selected),
        weightHistory(),
        waterTotal(date),
        getUnitPref(),
        setting('stepGoal', String(DEFAULT_STEPS_GOAL)),
      ])
      if (!alive) return
      setAdaptive(outcome)
      setGoal(g)
      setTotals(t)
      setStepGoal(Number(stepGoalStr) || DEFAULT_STEPS_GOAL)
      setExercise(ex)
      setExerciseList(exList)
      setHealthWorkouts(hkWorkouts)
      setMeals(ml)
      setHealthAvail(avail)
      setHealth(hk)
      setLatestWeightKg(weights[weights.length - 1]?.weightKg ?? hk.latestWeightKg)
      setWaterMl(water)
      setUnitPref(units)

      const [userDb, nutritionDb] = await Promise.all([db(), openNutritionDb()])
      const highlights = await nutrientHighlights(userDb, nutritionDb, date)
      if (alive) setMicros(highlights)

      const todayDay = Math.floor(Date.parse(`${localDate(Date.now())}T00:00:00Z`) / 86_400_000)
      setWeightLoggedToday(weights[weights.length - 1]?.day === todayDay)
    })()
    return () => {
      alive = false
    }
  }, [selected])

  useFocusEffect(reload)

  const date = localDate(selected)
  function addWater() {
    setWaterMl((v) => v + WATER_QUICK_ADD_ML)
    void logWater(WATER_QUICK_ADD_ML, Date.now())
  }
  function removeWater() {
    if (waterMl <= 0) return
    setWaterMl((v) => Math.max(0, v - WATER_QUICK_ADD_ML))
    void undoLastWater(date)
  }

  if (!goal || !totals) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={[type.body, { color: theme.textMuted }]}>Loading your day…</Text>
      </View>
    )
  }

  // Active Energy from HealthKit is the trusted number when it exists; the
  // steps-based estimate is a fallback for phones with no paired Watch, never
  // added on top of a real Active Energy sample.
  const healthKcal =
    health?.activeEnergyToday ??
    (health?.stepsToday != null ? stepsFallbackKcal(health.stepsToday, latestWeightKg ?? 70) : 0)
  const burnedKcal = exercise.kcal + healthKcal

  const remaining = goal.targetKcal - totals.kcal + burnedKcal
  const over = remaining < 0
  const pct = goal.targetKcal > 0 ? Math.max(0, (totals.kcal - burnedKcal) / goal.targetKcal) : 0
  const empty = totals.mealCount === 0 && totals.pendingCount === 0 && meals.length === 0
  const hs = healthScore(
    { kcal: totals.kcal, protein_g: totals.protein_g, fat_g: totals.fat_g, carbs_g: totals.carbs_g, fiber_g: totals.fiber_g, sugar_g: totals.sugar_g, sodium_mg: totals.sodium_mg },
    totals.grams > 0 ? totals.grams : undefined,
    {
      wholeFoodShare: totals.classifiedKcal > 0 ? totals.wholeFoodKcal / totals.classifiedKcal : null,
      animalBasedShare: totals.classifiedKcal > 0 ? totals.animalBasedKcal / totals.classifiedKcal : null,
    },
  )
  const waterFlOz = waterMl / ML_PER_FL_OZ
  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={{ paddingTop: insets.top + space.sm, paddingBottom: 150 }}
      showsVerticalScrollIndicator={false}
    >
      {/* Header */}
      <View style={styles.header}>
        <Text style={[styles.wordmark, { color: theme.text }]}>Optimal AI</Text>
        <View style={[styles.streakPill, { backgroundColor: theme.bgSunken }]}>
          <Icon name="flame" size={16} color={theme.text} />
          <Text style={[type.bodyStrong, { color: theme.text }]}>0</Text>
        </View>
      </View>

      {/* Day strip */}
      <DayStrip selected={offset} onSelect={setOffset} />

      {/* Paged carousel. pagingEnabled snaps by the VIEWPORT width, so each
          page must be exactly `width` wide with its own internal padding —
          sizing pages narrower and padding the container makes every swipe
          drift further off-grid, clipping the left card and bleeding the
          neighbor in. That was the "30g Fiber left" cut-off. */}
      <ScrollView
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        scrollEventThrottle={16}
        onScroll={(e: NativeSyntheticEvent<NativeScrollEvent>) =>
          setPage(Math.round(e.nativeEvent.contentOffset.x / width))
        }
        style={{ marginTop: space.md }}
      >
        {/* Page 1 — calories and the three macros */}
        <View style={{ width, paddingHorizontal: space.lg }}>
          <View style={[styles.heroCard, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[styles.hero, { color: theme.text }]}>
                {Math.abs(Math.round(remaining))}
              </Text>
              <Text style={[type.body, { color: theme.textMuted }]}>
                {over ? 'Calories over' : 'Calories left'}
              </Text>
            </View>
            <Ring pct={pct} over={over} size={128} stroke={12}>
              <Icon name="flame" size={26} color={theme.text} />
            </Ring>
          </View>

          <View style={styles.macroRow}>
            <MacroCard label="Protein" icon="protein" eaten={totals.protein_g} target={goal.protein_g} color={theme.protein} />
            <MacroCard label="Carbs" icon="carbs" eaten={totals.carbs_g} target={goal.carbs_g} color={theme.carbs} />
            <MacroCard label="Fat" icon="fat" eaten={totals.fat_g} target={goal.fat_g} color={theme.fat} />
          </View>
        </View>

        {/* Page 2 — the health score */}
        <View style={{ width, paddingHorizontal: space.lg }}>
          <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
            <View style={styles.spread}>
              <Text style={[type.heading, { color: theme.text }]}>Health Score</Text>
              <Text style={[type.heading, { color: theme.textMuted }]}>
                {hs ? `${hs.score}/10` : 'N/A'}
              </Text>
            </View>
            <View style={[styles.scoreTrack, { backgroundColor: theme.ringTrack }]}>
              {hs ? (
                <View
                  style={{
                    height: 8,
                    borderRadius: 4,
                    width: `${hs.score * 10}%` as const,
                    backgroundColor: theme.affirm,
                  }}
                />
              ) : null}
            </View>
            {hs ? (
              <View style={{ marginTop: space.md, gap: 4 }}>
                {hs.reasons.slice(0, 3).map((r) => (
                  <Text key={r} style={[type.caption, { color: theme.textMuted }]}>
                    · {r}
                  </Text>
                ))}
              </View>
            ) : (
              <Text style={[type.caption, { color: theme.textMuted, marginTop: space.md, lineHeight: 19 }]}>
                Log a few foods to generate today's score. Unlike the app we're replacing, the
                formula is published and readable — it is arithmetic over what you logged, not an
                opaque "AI" number. It favors whole, animal-forward foods: protein density counts
                for the most, fruit's fiber still counts in its favor, and sodium is a light touch.
              </Text>
            )}
          </View>

          {micros.length > 0 ? (
            <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border, marginTop: space.md }]}>
              <Text style={[type.heading, { color: theme.text }]}>Micronutrient highlights</Text>
              <View style={{ marginTop: space.md, gap: space.md }}>
                {micros.slice(0, 6).map((m) => (
                  <View key={m.code}>
                    <View style={styles.spread}>
                      <Text style={[type.body, { color: theme.text }]}>{m.label}</Text>
                      <Text style={[type.caption, { color: theme.textMuted }]}>{Math.round(m.pctDv)}% DV</Text>
                    </View>
                    <View style={[styles.microTrack, { backgroundColor: theme.ringTrack }]}>
                      <View
                        style={{
                          height: 6,
                          borderRadius: 3,
                          width: `${Math.min(100, m.pctDv)}%` as const,
                          backgroundColor: theme.affirm,
                        }}
                      />
                    </View>
                  </View>
                ))}
              </View>
            </View>
          ) : null}
        </View>

        {/* Page 3 — activity and water */}
        <View style={{ width, paddingHorizontal: space.lg }}>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <View style={[styles.card, { flex: 1, backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
              <Text style={[type.caption, { color: theme.textMuted }]}>Steps</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                <Text style={[styles.mid, { color: theme.text }]}>
                  {health?.stepsToday != null ? health.stepsToday.toLocaleString() : '—'}
                </Text>
                <Text style={[type.caption, { color: theme.textFaint }]}>/{stepGoal.toLocaleString()}</Text>
              </View>
              <View style={{ alignItems: 'center', marginTop: space.md }}>
                <Ring pct={(health?.stepsToday ?? 0) / stepGoal} over={false} size={92} stroke={9}>
                  <Icon name="steps" size={22} color={theme.textMuted} />
                </Ring>
              </View>
              <Text style={[type.micro, { color: theme.textFaint, marginTop: space.sm }]}>
                {healthAvail === 'available' ? (health?.stepsToday == null ? 'No steps yet today' : ' ') : 'Needs Apple Health'}
              </Text>
            </View>

            <View style={[styles.card, { flex: 1, backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
              <Text style={[type.caption, { color: theme.textMuted }]}>Calories burned</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: 4 }}>
                <Text style={[styles.mid, { color: theme.text }]}>{Math.round(burnedKcal)}</Text>
                <Text style={[type.caption, { color: theme.textFaint }]}>cal</Text>
              </View>
              <Pressable
                onPress={() => router.push('/log-exercise' as never)}
                style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs, marginTop: space.lg }}
              >
                <Icon name="dumbbell" size={18} color={theme.protein} />
                <Text style={[type.label, { color: theme.protein }]}>Log exercise</Text>
              </Pressable>
            </View>
          </View>

          <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border, marginTop: space.md }]}>
            <View style={styles.spread}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Icon name="moon" size={22} color={theme.protein} />
                <View>
                  <Text style={[type.caption, { color: theme.textMuted }]}>Sleep score</Text>
                  <Text style={[type.bodyStrong, { color: theme.text }]}>
                    {health?.sleepScore != null
                      ? `${health.sleepScore}/100${health.sleepHoursLastNight != null ? ` · ${health.sleepHoursLastNight.toFixed(1)}h` : ''}`
                      : '—'}
                  </Text>
                </View>
              </View>
            </View>
            {/* Same fallback rule as the Steps card above: say WHY it's empty
                rather than silently vanishing, which reads as a missing
                feature rather than a missing measurement. */}
            <Text style={[type.micro, { color: theme.textFaint, marginTop: space.sm }]}>
              {healthAvail === 'available' ? (health?.sleepScore == null ? 'No sleep data yet' : ' ') : 'Needs Apple Health'}
            </Text>
          </View>

          {exerciseList.length > 0 || healthWorkouts.length > 0 ? (
            <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border, marginTop: space.md }]}>
              <Text style={[type.label, { color: theme.textMuted }]}>Today's exercise</Text>
              {exerciseList.map((e) => (
                <Pressable
                  key={`log-${e.id}`}
                  accessibilityRole="button"
                  onPress={() => router.push({ pathname: '/exercise-detail', params: { id: String(e.id) } } as never)}
                  style={[styles.exerciseRow, { borderColor: theme.border }]}
                >
                  <Text style={[type.body, { color: theme.text, flex: 1 }]} numberOfLines={1}>
                    {e.name}
                  </Text>
                  <Text style={[type.body, { color: theme.textMuted }]}>{Math.round(e.kcal)} cal</Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${e.name}`}
                    onPress={() => {
                      setExerciseList((cur) => cur.filter((x) => x.id !== e.id))
                      setExercise((cur) => ({ kcal: cur.kcal - e.kcal, count: cur.count - 1 }))
                      void deleteExerciseEntry(e.id)
                    }}
                    hitSlop={space.md}
                    style={styles.remove}
                  >
                    <Text style={{ color: theme.textFaint, fontSize: 18 }}>×</Text>
                  </Pressable>
                </Pressable>
              ))}
              {/* From Apple Health: informational only. Its energy is already
                  folded into "Calories burned" via activeEnergyToday, so these
                  rows carry no delete/edit control — removing one here would
                  imply it changes the total, and it would not. */}
              {healthWorkouts.map((w) => (
                <View key={`hk-${w.id}`} style={[styles.exerciseRow, { borderColor: theme.border }]}>
                  <Icon name="heart" size={16} color={theme.textFaint} />
                  <Text style={[type.body, { color: theme.text, flex: 1 }]} numberOfLines={1}>
                    {w.name}
                  </Text>
                  <Text style={[type.body, { color: theme.textMuted }]}>
                    {w.kcal != null ? `${Math.round(w.kcal)} cal` : `${Math.round(w.durationMin)} min`}
                  </Text>
                </View>
              ))}
            </View>
          ) : null}

          <View style={[styles.card, { backgroundColor: theme.bgElevated, borderColor: theme.border, marginTop: space.md }]}>
            <View style={styles.spread}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md }}>
                <Icon name="water" size={22} color={theme.protein} />
                <View>
                  <Text style={[type.caption, { color: theme.textMuted }]}>Water</Text>
                  <Text style={[type.bodyStrong, { color: theme.text }]}>{Math.round(waterFlOz)} fl oz</Text>
                </View>
              </View>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                {waterMl > 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Remove last water entry"
                    onPress={removeWater}
                    hitSlop={space.md}
                    style={[styles.waterStep, { borderColor: theme.border }]}
                  >
                    <Text style={[type.bodyStrong, { color: theme.text }]}>–</Text>
                  </Pressable>
                ) : null}
                <Pressable
                  accessibilityRole="button"
                  onPress={addWater}
                  style={[styles.ghost, { borderColor: theme.border }]}
                >
                  <Text style={[type.label, { color: theme.text }]}>+8 fl oz</Text>
                </Pressable>
              </View>
            </View>
          </View>

          {healthAvail === 'available' && burnedKcal > 0 ? (
            <Text style={[type.micro, { color: theme.textFaint, marginTop: space.md, lineHeight: 16 }]}>
              Includes Apple Health activity. Logging a workout by hand that a paired Apple Watch
              also measured can count it twice.
            </Text>
          ) : null}
        </View>
      </ScrollView>

      {/* Page dots */}
      <View style={styles.dots}>
        {[0, 1, 2].map((i) => (
          <View
            key={i}
            style={[styles.dot, { backgroundColor: i === page ? theme.text : theme.border }]}
          />
        ))}
      </View>

      {/* A real target change is news — surfaced once, on its own, never buried
          inside the daily weigh-in prompt below. */}
      {adaptive?.surfaced ? (
        <View style={{ paddingHorizontal: space.lg }}>
          <View style={[styles.card, { backgroundColor: theme.bgSunken, borderColor: 'transparent' }]}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
              <Icon name="target" size={18} color={theme.text} />
              <Text style={[type.bodyStrong, { color: theme.text }]}>Your target changed</Text>
            </View>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
              Updated to {Math.round(adaptive.newKcal ?? 0)} kcal. {adaptive.explanation}
            </Text>
          </View>
        </View>
      ) : null}

      {/* Today's weigh-in — a plain check-in, not a status report on a number
          most people don't know how to read. */}
      <View style={{ paddingHorizontal: space.lg, marginTop: adaptive?.surfaced ? space.md : 0 }}>
        <Pressable
          onPress={() => router.push('/log-weight' as never)}
          style={[styles.card, styles.spread, { backgroundColor: theme.bgSunken, borderColor: 'transparent' }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, flex: 1 }}>
            <View
              style={[
                styles.checkbox,
                {
                  borderColor: weightLoggedToday ? theme.affirm : theme.border,
                  backgroundColor: weightLoggedToday ? theme.affirm : 'transparent',
                },
              ]}
            >
              {weightLoggedToday ? <Icon name="check" size={14} color={theme.bg} /> : null}
            </View>
            <View style={{ flex: 1 }}>
              <Text style={[type.bodyStrong, { color: theme.text }]}>Log weight today</Text>
              <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
                {weightLoggedToday && latestWeightKg != null
                  ? `Logged — ${formatWeightKg(latestWeightKg, unitPref)}`
                  : 'Not logged yet today'}
              </Text>
            </View>
          </View>
          <Icon name="scale" size={18} color={theme.protein} />
        </Pressable>
      </View>

      {/* Today's log — tappable, so a logged meal is editable, not a dead end */}
      <View style={{ paddingHorizontal: space.lg, marginTop: space.xl }}>
        <Text style={[type.title, { color: theme.text, fontSize: 24 }]}>Today's log</Text>

        {empty ? (
          <View style={[styles.emptyCard, { backgroundColor: theme.bgSunken }]}>
            <View style={[styles.ghostRow, { backgroundColor: theme.bgElevated }]}>
              <Icon name="bowl" size={26} color={theme.textFaint} />
              <View style={{ flex: 1, gap: 6 }}>
                <View style={[styles.skeleton, { backgroundColor: theme.ringTrack, width: '70%' }]} />
                <View style={[styles.skeleton, { backgroundColor: theme.ringTrack, width: '45%' }]} />
              </View>
            </View>
            <Text style={[type.body, { color: theme.textMuted, textAlign: 'center', marginTop: space.lg }]}>
              Tap + to add your first meal of the day
            </Text>
          </View>
        ) : (
          <View style={{ marginTop: space.sm, gap: space.sm }}>
            {meals.map((m) => (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                onPress={() => router.push({ pathname: '/meal-detail', params: { id: String(m.id) } } as never)}
                style={[styles.mealRow, { backgroundColor: theme.bgSunken }]}
              >
                {m.photoUri ? (
                  <Image source={{ uri: m.photoUri }} style={styles.mealThumb} />
                ) : (
                  <View style={[styles.mealThumb, styles.mealThumbFallback, { backgroundColor: theme.bgElevated }]}>
                    <Icon name="bowl" size={20} color={theme.textFaint} />
                  </View>
                )}
                <View style={{ flex: 1 }}>
                  <Text style={[type.bodyStrong, { color: theme.text }]} numberOfLines={1}>
                    {m.name}
                  </Text>
                  <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
                    {m.mealSlot ?? 'meal'}
                  </Text>
                </View>
                <Text style={[type.bodyStrong, { color: theme.text }]}>{Math.round(m.kcal)} cal</Text>
                <Icon name="chevron" size={16} color={theme.textFaint} />
              </Pressable>
            ))}
            {totals.pendingCount > 0 ? (
              <Text style={[type.caption, { color: theme.uncertain, marginTop: space.xs }]}>
                +{totals.pendingCount} still analyzing — not counted yet
              </Text>
            ) : null}
          </View>
        )}
      </View>
    </ScrollView>
  )
}

function DayStrip({ selected, onSelect }: { selected: number; onSelect: (o: number) => void }) {
  const theme = useTheme()
  const now = new Date()
  // Monday-first week containing today.
  const dow = (now.getDay() + 6) % 7
  const days = Array.from({ length: 7 }, (_, i) => i - dow)

  return (
    <View style={styles.strip}>
      {days.map((off) => {
        const d = new Date(Date.now() + off * 86_400_000)
        const isSel = off === selected
        const future = off > 0
        return (
          <Pressable
            key={off}
            disabled={future}
            onPress={() => onSelect(off)}
            accessibilityRole="button"
            accessibilityState={{ selected: isSel, disabled: future }}
            style={[styles.dayCol, isSel && { backgroundColor: theme.bgElevated }]}
          >
            <Text style={[type.caption, { color: future ? theme.textFaint : theme.textMuted }]}>
              {DAY_LABELS[d.getDay()]}
            </Text>
            <View
              style={[
                styles.dayCircle,
                {
                  borderColor: isSel ? theme.text : theme.border,
                  borderStyle: off < 0 ? 'dashed' : 'solid',
                  opacity: future ? 0.4 : 1,
                },
              ]}
            >
              <Text style={[type.bodyStrong, { color: future ? theme.textFaint : theme.text }]}>
                {d.getDate()}
              </Text>
            </View>
          </Pressable>
        )
      })}
    </View>
  )
}

function Ring({
  pct, over, size, stroke, children,
}: {
  pct: number
  over: boolean
  size: number
  stroke: number
  children?: React.ReactNode
}) {
  const theme = useTheme()
  const r = size / 2 - stroke
  const c = 2 * Math.PI * r
  const primary = Math.min(1, pct)
  const overflow = over ? Math.min(1, pct - 1) : 0
  const innerR = r - stroke - 3
  const innerC = 2 * Math.PI * innerR

  return (
    <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
      <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
        <Circle cx={size / 2} cy={size / 2} r={r} stroke={theme.ringTrack} strokeWidth={stroke} fill="none" />
        <Circle
          cx={size / 2} cy={size / 2} r={r}
          stroke={theme.ring} strokeWidth={stroke} fill="none"
          strokeDasharray={`${c * primary} ${c}`}
          strokeLinecap="round"
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
        {overflow > 0 ? (
          <Circle
            cx={size / 2} cy={size / 2} r={innerR}
            stroke={theme.uncertain} strokeWidth={stroke * 0.6} fill="none"
            strokeDasharray={`${innerC * overflow} ${innerC}`}
            strokeLinecap="round"
            transform={`rotate(-90 ${size / 2} ${size / 2})`}
          />
        ) : null}
      </Svg>
      {children}
    </View>
  )
}

function MacroCard({
  label, icon, eaten, target, color, unit = 'g',
}: {
  label: string
  icon: IconName
  eaten: number
  target: number
  color: string
  unit?: string
}) {
  const theme = useTheme()
  const left = Math.max(0, target - eaten)
  const pct = target > 0 ? Math.min(1, eaten / target) : 0
  const size = 74
  const r = size / 2 - 5
  const c = 2 * Math.PI * r

  return (
    <View style={[styles.macroCard, { backgroundColor: theme.bgElevated, borderColor: theme.border }]}>
      {/* "2300mg" must shrink, never wrap — a two-line number reads broken. */}
      <Text style={[styles.macroNum, { color: theme.text }]} numberOfLines={1} adjustsFontSizeToFit>
        {Math.round(left)}
        {unit}
      </Text>
      <Text style={[type.caption, { color: theme.textMuted }]}>{label} left</Text>

      <View style={{ alignItems: 'center', marginTop: space.md }}>
        <View style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}>
          <Svg width={size} height={size} style={StyleSheet.absoluteFill}>
            <Circle cx={size / 2} cy={size / 2} r={r} stroke={theme.ringTrack} strokeWidth={5} fill="none" />
            <Circle
              cx={size / 2} cy={size / 2} r={r}
              stroke={color} strokeWidth={5} fill="none"
              strokeDasharray={`${c * pct} ${c}`}
              strokeLinecap="round"
              transform={`rotate(-90 ${size / 2} ${size / 2})`}
            />
          </Svg>
          <Icon name={icon} size={22} color={color} />
        </View>
      </View>
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  wordmark: { fontSize: 30, fontWeight: '800', letterSpacing: -1.2 },
  streakPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
  },
  strip: { flexDirection: 'row', paddingHorizontal: space.md, marginTop: space.lg },
  dayCol: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.lg, gap: space.sm },
  dayCircle: {
    width: 40, height: 40, borderRadius: radius.pill, borderWidth: 1.5,
    alignItems: 'center', justifyContent: 'center',
  },
  heroCard: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space.xl,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  hero: { fontSize: 46, fontWeight: '800', letterSpacing: -1.8 },
  mid: { fontSize: 26, fontWeight: '800', letterSpacing: -0.8 },
  macroRow: { flexDirection: 'row', gap: space.sm, marginTop: space.md },
  macroCard: {
    flex: 1,
    padding: space.md,
    borderRadius: radius.xl,
    borderWidth: StyleSheet.hairlineWidth,
  },
  macroNum: { fontSize: 22, fontWeight: '800', letterSpacing: -0.6 },
  card: { padding: space.lg, borderRadius: radius.xl, borderWidth: StyleSheet.hairlineWidth },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  checkbox: {
    width: 24,
    height: 24,
    borderRadius: 7,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  scoreTrack: { height: 8, borderRadius: 4, marginTop: space.md },
  ghost: {
    paddingHorizontal: space.lg, paddingVertical: space.sm,
    borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
  },
  microTrack: { height: 6, borderRadius: 3, marginTop: space.xs, overflow: 'hidden' },
  waterStep: {
    width: MIN_TAP_TARGET, height: MIN_TAP_TARGET,
    borderRadius: radius.pill, borderWidth: StyleSheet.hairlineWidth,
    alignItems: 'center', justifyContent: 'center',
  },
  dots: { flexDirection: 'row', justifyContent: 'center', gap: space.sm, marginTop: space.lg },
  dot: { width: 7, height: 7, borderRadius: 4 },
  emptyCard: { marginTop: space.md, padding: space.lg, borderRadius: radius.xl },
  ghostRow: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, borderRadius: radius.lg,
  },
  skeleton: { height: 8, borderRadius: 4 },
  exerciseRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    paddingVertical: space.sm,
    borderTopWidth: StyleSheet.hairlineWidth,
    marginTop: space.sm,
  },
  remove: { width: MIN_TAP_TARGET, height: MIN_TAP_TARGET, alignItems: 'center', justifyContent: 'center' },
  mealRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    minHeight: MIN_TAP_TARGET,
  },
  mealThumb: { width: 48, height: 48, borderRadius: radius.md },
  mealThumbFallback: { alignItems: 'center', justifyContent: 'center' },
})
