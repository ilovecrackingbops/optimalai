import { router, useFocusEffect } from 'expo-router'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { Keyboard, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import Svg, { Circle, Line as SvgLine, Path, Rect, Text as SvgText } from 'react-native-svg'
import { Image } from 'expo-image'
import { bmi, ffmi, computeTrend, trendSlopeLbPerWeek, type TrendPoint, type WeightPoint } from '@nutai/goals'
import {
  countStreak,
  currentGoal,
  db,
  loggedDates,
  physiqueHistory,
  putSetting,
  setting,
  strengthExerciseNames,
  strengthHistory,
  weightHistory,
  type CurrentGoal,
  type PhysiqueEntry,
  type StrengthPoint,
} from '../../src/data/repo'
import { displayWeight, getUnitPref, LB_PER_KG, weightUnitLabel, type UnitPref } from '../../src/data/units'
import { Icon } from '../../src/components/Icon'
import { useTheme } from '../../src/theme/ThemeProvider'
import { radius, space, type } from '../../src/theme/tokens'

const WINDOWS = [
  { key: '90D', days: 90 },
  { key: '6M', days: 182 },
  { key: '1Y', days: 365 },
  { key: 'ALL', days: Number.POSITIVE_INFINITY },
] as const

const CHANGE_WINDOWS = [3, 7, 14, 30, 90] as const

export default function Progress() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [points, setPoints] = useState<WeightPoint[]>([])
  const [goal, setGoal] = useState<CurrentGoal | null>(null)
  const [heightCm, setHeightCm] = useState<number | null>(null)
  const [goalKg, setGoalKg] = useState<number | null>(null)
  const [streak, setStreak] = useState(0)
  const [window, setWindow] = useState<(typeof WINDOWS)[number]['key']>('90D')
  const [physique, setPhysique] = useState<PhysiqueEntry[]>([])
  const [unitPref, setUnitPref] = useState<UnitPref>('imperial')
  const [exerciseNames, setExerciseNames] = useState<string[]>([])
  const [selectedExercise, setSelectedExercise] = useState<string | null>(null)
  const [strengthPoints, setStrengthPoints] = useState<StrengthPoint[]>([])
  const [bodyFatPctText, setBodyFatPctText] = useState('')

  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const h = await db()
        const [pts, g, target, profile, days, phys, units, names, bodyFatPctStr] = await Promise.all([
          weightHistory(),
          currentGoal(),
          setting('goal.desiredWeightKg', ''),
          h.get<{ height_cm: number }>('SELECT height_cm FROM user_profile WHERE id = 1'),
          loggedDates(),
          physiqueHistory(),
          getUnitPref(),
          strengthExerciseNames(),
          setting('bodyFatPct', ''),
        ])
        if (!alive) return
        setPoints(pts)
        setGoal(g)
        setGoalKg(target ? Number(target) : null)
        setHeightCm(profile?.height_cm ?? null)
        setStreak(countStreak(days))
        setPhysique(phys)
        setUnitPref(units)
        setExerciseNames(names)
        setBodyFatPctText(bodyFatPctStr)
        // Keep the current selection if it is still valid (still-trained
        // exercise, screen just refocused); otherwise default to the most
        // recently trained one — never silently reset a deliberate pick.
        setSelectedExercise((cur) => (cur && names.includes(cur) ? cur : (names[0] ?? null)))
      })()
      return () => {
        alive = false
      }
    }, []),
  )

  useEffect(() => {
    if (!selectedExercise) {
      setStrengthPoints([])
      return
    }
    let alive = true
    void strengthHistory(selectedExercise).then((pts) => {
      if (alive) setStrengthPoints(pts)
    })
    return () => {
      alive = false
    }
  }, [selectedExercise])

  const trend = useMemo(() => computeTrend(points), [points])
  const raw = trend.filter((p) => p.rawKg != null)
  const slope = useMemo(() => trendSlopeLbPerWeek(trend), [trend])

  const currentKg = points[points.length - 1]?.weightKg ?? null
  const startKg = points[0]?.weightKg ?? null

  const pctOfGoal =
    startKg != null && currentKg != null && goalKg != null && Math.abs(goalKg - startKg) > 0.01
      ? Math.max(0, Math.min(1, (currentKg - startKg) / (goalKg - startKg)))
      : 0

  const visible = useMemo(() => {
    const w = WINDOWS.find((x) => x.key === window)
    if (!w || !Number.isFinite(w.days)) return trend
    const last = trend[trend.length - 1]
    if (!last) return trend
    return trend.filter((p) => p.day > last.day - w.days)
  }, [trend, window])

  const bodyBmi = currentKg != null && heightCm != null ? bmi(currentKg, heightCm) : null

  const bodyFatPct = Number.parseFloat(bodyFatPctText)
  const bodyFatPctValid = Number.isFinite(bodyFatPct) && bodyFatPct > 0 && bodyFatPct < 70
  const bodyFfmi =
    bodyFatPctValid && currentKg != null && heightCm != null ? ffmi(currentKg, heightCm, bodyFatPct) : null

  function saveBodyFatPct(text: string) {
    setBodyFatPctText(text)
    const v = Number.parseFloat(text)
    if (text.trim() === '') {
      void putSetting('bodyFatPct', '')
    } else if (Number.isFinite(v) && v > 0 && v < 70) {
      void putSetting('bodyFatPct', text.trim())
    }
    // An out-of-range or unparseable value is left uncommitted rather than
    // silently clamped or discarded — the text box just won't show an FFMI
    // until it reads back something plausible.
  }

  return (
    <ScrollView
      style={{ backgroundColor: theme.bg }}
      contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 150 }}
      showsVerticalScrollIndicator={false}
    >
      <Text style={[type.title, { color: theme.text }]}>Progress</Text>

      {/* Streak credits logging INTENT, so our own failures never break it. */}
      <View style={styles.row}>
        <View style={[styles.tile, { backgroundColor: theme.bgSunken }]}>
          <Icon name="flame" size={30} color={theme.text} />
          <Text style={[styles.tileNum, { color: theme.text }]}>{streak}</Text>
          <Text style={[type.caption, { color: theme.textMuted }]}>Day streak</Text>
        </View>
        <View style={[styles.tile, { backgroundColor: theme.bgSunken }]}>
          <Icon name="scale" size={30} color={theme.text} />
          <Text style={[styles.tileNum, { color: theme.text }]}>{raw.length}</Text>
          <Text style={[type.caption, { color: theme.textMuted }]}>Weigh-ins</Text>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
        <View style={styles.spread}>
          <Text style={[type.caption, { color: theme.textMuted }]}>Current weight</Text>
          <Pressable onPress={() => router.push('/log-weight' as never)} hitSlop={space.sm}>
            <Text style={[type.label, { color: theme.protein }]}>Log weight</Text>
          </Pressable>
        </View>
        <Text style={[styles.big, { color: theme.text }]}>
          {currentKg != null ? `${displayWeight(currentKg, unitPref).toFixed(1)} ${weightUnitLabel(unitPref)}` : '—'}
        </Text>

        <View style={[styles.bar, { backgroundColor: theme.ringTrack }]}>
          <View style={{ width: `${pctOfGoal * 100}%`, height: 6, borderRadius: 3, backgroundColor: theme.text }} />
        </View>
        <View style={styles.spread}>
          <Text style={[type.caption, { color: theme.textMuted }]}>
            Start: {startKg != null ? `${displayWeight(startKg, unitPref).toFixed(1)} ${weightUnitLabel(unitPref)}` : '—'}
          </Text>
          <Text style={[type.caption, { color: theme.textMuted }]}>
            Goal: {goalKg != null ? `${displayWeight(goalKg, unitPref).toFixed(1)} ${weightUnitLabel(unitPref)}` : '—'}
          </Text>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
        <View style={styles.spread}>
          <Text style={[type.heading, { color: theme.text }]}>Weight progress</Text>
          <View style={[styles.badge, { backgroundColor: theme.bgElevated }]}>
            <Text style={[type.caption, { color: theme.text }]}>{Math.round(pctOfGoal * 100)}% of goal</Text>
          </View>
        </View>

        {raw.length === 0 ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.md }]}>
            No weigh-ins yet. It takes about five before a slope means anything.
          </Text>
        ) : (
          <WeightChart trend={visible} unitPref={unitPref} />
        )}

        <View style={[styles.segment, { backgroundColor: theme.bgElevated }]}>
          {WINDOWS.map((w) => (
            <Pressable
              key={w.key}
              onPress={() => setWindow(w.key)}
              style={[styles.segItem, window === w.key && { backgroundColor: theme.bg }]}
            >
              <Text style={[type.label, { color: window === w.key ? theme.text : theme.textMuted }]}>
                {w.key}
              </Text>
            </Pressable>
          ))}
        </View>

        <View style={styles.legend}>
          <View style={styles.legendItem}>
            <View style={[styles.dot, { backgroundColor: theme.textFaint }]} />
            <Text style={[type.caption, { color: theme.textMuted }]}>Each weigh-in</Text>
          </View>
          <View style={styles.legendItem}>
            <View style={[styles.line, { backgroundColor: theme.text }]} />
            <Text style={[type.caption, { color: theme.textMuted }]}>Trend</Text>
          </View>
        </View>
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
        <Text style={[type.heading, { color: theme.text }]}>Strength</Text>

        {exerciseNames.length === 0 ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.md }]}>
            No weighted sets logged yet. Log a split under Exercise → My splits with a weight per
            exercise, and it shows up here.
          </Text>
        ) : (
          <>
            <ScrollView
              horizontal
              showsHorizontalScrollIndicator={false}
              contentContainerStyle={{ gap: space.sm, marginTop: space.md }}
            >
              {exerciseNames.map((name) => {
                const active = name === selectedExercise
                return (
                  <Pressable
                    key={name}
                    accessibilityRole="button"
                    onPress={() => setSelectedExercise(name)}
                    style={[
                      styles.exChip,
                      active
                        ? { backgroundColor: theme.text }
                        : { backgroundColor: theme.bgElevated },
                    ]}
                  >
                    <Text style={[type.label, { color: active ? theme.bg : theme.text }]}>{name}</Text>
                  </Pressable>
                )
              })}
            </ScrollView>

            {strengthPoints.length === 0 ? (
              <Text style={[type.caption, { color: theme.textMuted, marginTop: space.md }]}>
                No sessions logged for this exercise yet.
              </Text>
            ) : (
              <>
                <StrengthChart points={strengthPoints} />
                {(() => {
                  const first = strengthPoints[0]!
                  const last = strengthPoints[strengthPoints.length - 1]!
                  const deltaLb = (last.weightLb ?? 0) - (first.weightLb ?? 0)
                  return (
                    <View style={styles.spread}>
                      <Text style={[type.caption, { color: theme.textMuted }]}>
                        {strengthPoints.length} session{strengthPoints.length === 1 ? '' : 's'}
                      </Text>
                      <Text style={[type.caption, { color: Math.abs(deltaLb) < 0.5 ? theme.textMuted : theme.protein }]}>
                        {Math.abs(deltaLb) < 0.5
                          ? 'No change'
                          : `${deltaLb > 0 ? '+' : ''}${deltaLb.toFixed(0)} lb since first logged`}
                      </Text>
                    </View>
                  )
                })()}
              </>
            )}
          </>
        )}
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
        <Text style={[type.heading, { color: theme.text }]}>Weight changes</Text>
        {CHANGE_WINDOWS.map((d) => (
          <ChangeRow key={d} label={`${d} day`} lbs={changeOver(trend, d)} unitPref={unitPref} />
        ))}
        <ChangeRow label="All time" lbs={changeOver(trend, Number.POSITIVE_INFINITY)} unitPref={unitPref} />
        <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md, lineHeight: 18 }]}>
          Measured on the trend line, not raw weigh-ins — a 3 lb overnight swing is water, and
          reporting it as a change would be reporting noise as progress.
        </Text>
      </View>

      <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
        <Text style={[type.heading, { color: theme.text }]}>Rate of change</Text>
        <Text style={[styles.big, { color: theme.text }]}>
          {slope == null
            ? '—'
            : unitPref === 'metric'
              ? `${slope > 0 ? '+' : ''}${(slope / LB_PER_KG).toFixed(2)} kg/wk`
              : `${slope > 0 ? '+' : ''}${slope.toFixed(2)} lb/wk`}
        </Text>
        <Text style={[type.caption, { color: theme.textMuted }]}>
          {slope == null ? 'Not enough weigh-ins yet.' : `From ${raw.length} weigh-ins.`}
        </Text>
      </View>

      {bodyBmi != null ? (
        <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
          <Text style={[type.heading, { color: theme.text }]}>Your BMI</Text>
          <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.md }}>
            <Text style={[styles.big, { color: theme.text }]}>{bodyBmi.toFixed(1)}</Text>
            <Text style={[type.caption, { color: theme.textMuted }]}>{bmiBand(bodyBmi)}</Text>
          </View>
          <BmiScale value={bodyBmi} />
          <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md, lineHeight: 18 }]}>
            BMI cannot tell muscle from fat and says nothing about an individual's health. It is
            here because it is a common reference point, not because it is a verdict.
          </Text>

          <View style={[styles.divider, { backgroundColor: theme.border }]} />

          <View style={styles.spread}>
            <Text style={[type.label, { color: theme.textMuted }]}>Body fat %</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
              <TextInput
                value={bodyFatPctText}
                onChangeText={saveBodyFatPct}
                onEndEditing={() => Keyboard.dismiss()}
                placeholder="—"
                placeholderTextColor={theme.textFaint}
                keyboardType="decimal-pad"
                maxLength={4}
                style={[styles.bfInput, { color: theme.text, borderColor: theme.border }]}
              />
              <Text style={[type.body, { color: theme.textMuted }]}>%</Text>
            </View>
          </View>

          {bodyFfmi != null ? (
            <>
              <Text style={[type.heading, { color: theme.text, marginTop: space.lg }]}>Your FFMI</Text>
              <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: space.md }}>
                <Text style={[styles.big, { color: theme.text }]}>{bodyFfmi.normalized.toFixed(1)}</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>{ffmiBand(bodyFfmi.normalized)}</Text>
              </View>
              <Text style={[type.caption, { color: theme.textFaint, marginTop: space.sm, lineHeight: 18 }]}>
                Fat-free mass index — muscle mass relative to height, the thing BMI can't tell from
                fat. Normalized to a 5'11" frame so height doesn't skew it. Only as accurate as the
                body-fat % typed in above, which is never estimated for you. That same % also
                sharpens your calorie target's BMR (Katch-McArdle instead of a weight-only formula).
              </Text>
            </>
          ) : (
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.md }]}>
              Enter a body fat % to see your FFMI here.
            </Text>
          )}
        </View>
      ) : null}

      <Pressable
        onPress={() => physique.length > 0 && router.push('/body-history' as never)}
        style={[styles.card, { backgroundColor: theme.bgSunken }]}
      >
        <View style={styles.spread}>
          <Text style={[type.heading, { color: theme.text }]}>Body composition</Text>
          <Pressable onPress={() => router.push('/body-scan' as never)} hitSlop={space.sm}>
            <Text style={[type.label, { color: theme.protein }]}>Log body photo</Text>
          </Pressable>
        </View>

        {physique.length === 0 ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.md }]}>
            No body photos yet. A rough AI estimate, tracked over time — never a bare number,
            always a range.
          </Text>
        ) : (
          <>
            {(() => {
              const latest = physique[physique.length - 1]!
              return (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.md, marginTop: space.md }}>
                  <Image source={{ uri: latest.photoUri }} style={styles.physiqueThumb} />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.big, { color: theme.text, marginTop: 0 }]}>
                      {latest.bodyFatPctLow != null && latest.bodyFatPctHigh != null
                        ? `${Math.round(latest.bodyFatPctLow)}–${Math.round(latest.bodyFatPctHigh)}%`
                        : '—'}
                    </Text>
                    <Text style={[type.caption, { color: theme.textMuted }]}>
                      {latest.localDate} · {latest.confidence ?? 'unknown'} confidence
                    </Text>
                  </View>
                  <Icon name="chevron" size={16} color={theme.textFaint} />
                </View>
              )
            })()}
            <Text style={[type.caption, { color: theme.protein, marginTop: space.md }]}>
              {physique.length} photo{physique.length === 1 ? '' : 's'} logged · view history
            </Text>
          </>
        )}
        <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md, lineHeight: 18 }]}>
          A rough visual estimate, not a body-composition measurement — see the estimate's own
          caveats for what limited it.
        </Text>
      </Pressable>

      {goal ? (
        <View style={[styles.card, { backgroundColor: theme.bgSunken }]}>
          <Text style={[type.heading, { color: theme.text }]}>Daily target</Text>
          <Text style={[styles.big, { color: theme.text }]}>{Math.round(goal.targetKcal)} kcal</Text>
          <Text style={[type.caption, { color: theme.textMuted }]}>
            {goal.adaptive ? 'Adapting from your own trend and intake.' : 'Fixed — you set this by hand.'}
          </Text>
        </View>
      ) : null}
    </ScrollView>
  )
}

/** Change over N days, measured on the TREND rather than raw entries. */
function changeOver(trend: TrendPoint[], days: number): number | null {
  const last = trend[trend.length - 1]
  const first = trend[0]
  if (!last || !first) return null
  const target = Number.isFinite(days) ? last.day - days : first.day
  const start = [...trend].reverse().find((p) => p.day <= target) ?? first
  return (last.trendKg - start.trendKg) * LB_PER_KG
}

function ChangeRow({ label, lbs, unitPref }: { label: string; lbs: number | null; unitPref: UnitPref }) {
  const theme = useTheme()
  const none = lbs == null || Math.abs(lbs) < 0.05
  const up = (lbs ?? 0) > 0
  const shown = lbs == null ? null : unitPref === 'metric' ? lbs / LB_PER_KG : lbs
  const unit = weightUnitLabel(unitPref)
  return (
    <View style={styles.changeRow}>
      <Text style={[type.body, { color: theme.textMuted, width: 78 }]}>{label}</Text>
      <Text style={[type.bodyStrong, { color: theme.text, flex: 1 }]}>
        {shown == null ? '—' : `${shown > 0 ? '+' : ''}${shown.toFixed(1)} ${unit}`}
      </Text>
      <Text style={[type.caption, { color: none ? theme.textMuted : theme.protein }]}>
        {none ? 'No change' : up ? 'Increase' : 'Decrease'}
      </Text>
    </View>
  )
}

function WeightChart({ trend, unitPref }: { trend: TrendPoint[]; unitPref: UnitPref }) {
  const theme = useTheme()
  const W = 300
  const H = 170

  if (trend.length === 0) return null

  const values = trend.flatMap((p) => [p.trendKg, ...(p.rawKg != null ? [p.rawKg] : [])])
  const min = Math.min(...values)
  const max = Math.max(...values)
  const span = max - min < 0.5 ? 1 : max - min
  const pad = span * 0.2

  const x = (i: number) => (trend.length <= 1 ? W / 2 : (i / (trend.length - 1)) * (W - 50) + 40)
  const y = (kg: number) => H - 24 - ((kg - min + pad) / (span + pad * 2)) * (H - 48)

  const gridVals = [min + span, min + span / 2, min]
  let d = ''
  trend.forEach((p, i) => {
    d += `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.trendKg)} `
  })

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ marginTop: space.md }}>
      {gridVals.map((v, i) => (
        <SvgLine key={i} x1={40} y1={y(v)} x2={W - 10} y2={y(v)} stroke={theme.border} strokeWidth="1" />
      ))}
      {gridVals.map((v, i) => (
        <SvgText key={`t${i}`} x={2} y={y(v) + 4} fontSize="10" fill={theme.textFaint}>
          {displayWeight(v, unitPref).toFixed(0)}
        </SvgText>
      ))}
      {trend.map((p, i) =>
        p.rawKg != null ? <Circle key={i} cx={x(i)} cy={y(p.rawKg)} r="3" fill={theme.textFaint} /> : null,
      )}
      <Path d={d} stroke={theme.text} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
    </Svg>
  )
}

/**
 * Weight lifted per session for one exercise — no trend smoothing, unlike
 * WeightChart. Body weight is noisy day to day and the trend line is the
 * actual signal; a lifted weight is a deliberate number someone chose to put
 * on the bar, so the raw session-to-session value already IS the signal.
 */
function StrengthChart({ points }: { points: StrengthPoint[] }) {
  const theme = useTheme()
  const W = 300
  const H = 170

  const weights = points.map((p) => p.weightLb ?? 0)
  const min = Math.min(...weights)
  const max = Math.max(...weights)
  const span = max - min < 5 ? 5 : max - min
  const pad = span * 0.2

  const x = (i: number) => (points.length <= 1 ? W / 2 : (i / (points.length - 1)) * (W - 50) + 40)
  const y = (lb: number) => H - 24 - ((lb - min + pad) / (span + pad * 2)) * (H - 48)

  const gridVals = [min + span, min + span / 2, min]
  let d = ''
  points.forEach((p, i) => {
    d += `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(p.weightLb ?? 0)} `
  })

  return (
    <Svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} style={{ marginTop: space.md }}>
      {gridVals.map((v, i) => (
        <SvgLine key={i} x1={40} y1={y(v)} x2={W - 10} y2={y(v)} stroke={theme.border} strokeWidth="1" />
      ))}
      {gridVals.map((v, i) => (
        <SvgText key={`t${i}`} x={2} y={y(v) + 4} fontSize="10" fill={theme.textFaint}>
          {Math.round(v)}
        </SvgText>
      ))}
      <Path d={d} stroke={theme.protein} strokeWidth="2.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
      {points.map((p, i) => (
        <Circle key={i} cx={x(i)} cy={y(p.weightLb ?? 0)} r="3.5" fill={theme.protein} />
      ))}
    </Svg>
  )
}

function bmiBand(v: number): string {
  if (v < 18.5) return 'Underweight'
  if (v < 25) return 'Healthy'
  if (v < 30) return 'Overweight'
  return 'Obese'
}

/**
 * Descriptive only, same spirit as `bmiBand` — no pass/fail, and deliberately
 * no editorializing about the very top of the range, which usually says more
 * about the accuracy of a hand-typed body-fat % than about the person.
 */
function ffmiBand(v: number): string {
  if (v < 18) return 'Below average'
  if (v < 20) return 'Average'
  if (v < 22) return 'Above average'
  if (v < 25) return 'High'
  return 'Very high'
}

function BmiScale({ value }: { value: number }) {
  const theme = useTheme()
  const W = 300
  const pos = Math.max(0, Math.min(1, (value - 15) / 20))
  const segs = [
    { w: (18.5 - 15) / 20, c: '#6E9BFF' },
    { w: (25 - 18.5) / 20, c: '#2E9E6B' },
    { w: (30 - 25) / 20, c: '#F2A93B' },
    { w: (35 - 30) / 20, c: '#D5453B' },
  ]
  let cursor = 0
  return (
    <Svg width="100%" height={26} viewBox={`0 0 ${W} 26`} style={{ marginTop: space.md }}>
      {segs.map((s, i) => {
        const x = cursor * W
        cursor += s.w
        return <Rect key={i} x={x} y={9} width={s.w * W - 3} height={8} rx={4} fill={s.c} />
      })}
      <Rect x={pos * W - 1.5} y={3} width={3} height={20} rx={1.5} fill={theme.text} />
    </Svg>
  )
}

const styles = StyleSheet.create({
  row: { flexDirection: 'row', gap: space.md, marginTop: space.lg },
  tile: { flex: 1, padding: space.lg, borderRadius: radius.xl, alignItems: 'center' },
  tileNum: { fontSize: 26, fontWeight: '800', letterSpacing: -0.8, marginTop: space.xs },
  card: { marginTop: space.md, padding: space.lg, borderRadius: radius.xl },
  spread: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  big: { fontSize: 30, fontWeight: '800', letterSpacing: -1, marginTop: space.xs },
  bar: { height: 6, borderRadius: 3, marginTop: space.md, marginBottom: space.sm, overflow: 'hidden' },
  badge: { paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  segment: { flexDirection: 'row', borderRadius: radius.pill, padding: 3, marginTop: space.md },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.pill },
  legend: { flexDirection: 'row', gap: space.lg, marginTop: space.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: space.xs },
  dot: { width: 8, height: 8, borderRadius: 4 },
  line: { width: 18, height: 3, borderRadius: 2 },
  changeRow: { flexDirection: 'row', alignItems: 'center', gap: space.sm, marginTop: space.md },
  physiqueThumb: { width: 56, height: 56, borderRadius: radius.md },
  exChip: { paddingHorizontal: space.md, paddingVertical: space.sm, borderRadius: radius.pill },
  divider: { height: StyleSheet.hairlineWidth, marginVertical: space.lg },
  bfInput: {
    width: 52,
    textAlign: 'right',
    fontSize: 17,
    fontWeight: '700',
    borderBottomWidth: 1.5,
    paddingVertical: 2,
  },
})
