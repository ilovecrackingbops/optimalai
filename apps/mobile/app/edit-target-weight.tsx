import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { bmi, computeCalorieTarget, UNDERWEIGHT_BMI, type BodyInputs, type Goal } from '@nutai/goals'
import { EditableValue, RulerPicker, Segmented, Wheel, WheelHighlight } from '../src/components/onboarding/Controls'
import { bodyProfile, currentGoal, setGoalTarget, setting, weightHistory, type BodyProfile } from '../src/data/repo'
import { displayWeight, getUnitPref, LB_PER_KG, setUnitPref, toKg, weightUnitLabel, type UnitPref } from '../src/data/units'
import { goalForRate, nearestRateStop, RATE_STOPS_KG } from '../src/onboarding/pace'
import { kgToLb, MAINTAIN_THRESHOLD_LB } from '../src/onboarding/store'
import { useTheme } from '../src/theme/ThemeProvider'
import { radius, space, type } from '../src/theme/tokens'

const GOAL_LABEL: Record<Goal, string> = { lose: 'Cut', maintain: 'Maintain', gain: 'Lean bulk' }

/**
 * Target weight & pace.
 *
 * The pace wheel is the SOLE source of direction and magnitude for the
 * calorie math — signed, -1 to +1 kg/week, scroll-wheel interaction (matching
 * every other numeric picker in onboarding) rather than a slider or a row of
 * preset buttons. Target weight stays as a separate field for reference (an
 * ETA, an underweight check) but no longer decides cut vs. lean bulk; asking
 * two different controls to agree on direction is exactly the kind of silent
 * disagreement this screen used to risk when target weight alone decided it.
 *
 * Saving here is a PLAN CHANGE, not a hand-typed override: it goes through
 * `setGoalTarget`, which leaves the adaptive loop ON. Manual macro edits
 * (edit-goals.tsx) are the only path that turns it off.
 */
export default function EditTargetWeight() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { width } = useWindowDimensions()

  const [unitPref, setUnitPrefState] = useState<UnitPref>('imperial')
  const [profile, setProfile] = useState<BodyProfile | null>(null)
  const [currentKg, setCurrentKg] = useState<number | null>(null)
  const [targetKg, setTargetKg] = useState<number | null>(null)
  const [rateKg, setRateKg] = useState(0)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [units, bp, points, storedTarget, storedRateLb, existingGoal] = await Promise.all([
        getUnitPref(),
        bodyProfile(Date.now()),
        weightHistory(),
        setting('goal.desiredWeightKg', ''),
        setting('goal.rateLbPerWeek', ''),
        currentGoal(),
      ])
      if (!alive) return
      const latest = points[points.length - 1]?.weightKg ?? null
      setUnitPrefState(units)
      setProfile(bp)
      setCurrentKg(latest)
      const storedKg = Number.parseFloat(storedTarget)
      setTargetKg(Number.isFinite(storedKg) && storedKg > 0 ? storedKg : (latest ?? 80))

      // Reconstruct the signed rate from the stored UNSIGNED magnitude (the
      // engine's own unit, lb/week) plus the direction of the goal it was
      // last saved under — that pairing is exactly what this screen writes.
      const parsedRateLb = Number.parseFloat(storedRateLb)
      const magnitudeKg = Number.isFinite(parsedRateLb) && parsedRateLb > 0 ? parsedRateLb / LB_PER_KG : 0
      const sign = existingGoal?.goalType === 'lose' ? -1 : existingGoal?.goalType === 'gain' ? 1 : 0
      setRateKg(nearestRateStop(sign * magnitudeKg))
    })()
    return () => {
      alive = false
    }
  }, [])

  function toggleUnits(pref: UnitPref) {
    setUnitPrefState(pref)
    void setUnitPref(pref)
  }

  const imperial = unitPref === 'imperial'
  const min = imperial ? 60 : 30
  const max = imperial ? 500 : 227
  const shown = targetKg != null ? displayWeight(targetKg, unitPref) : min

  const goal = goalForRate(rateKg)
  const rateLbUnsigned = Math.abs(kgToLb(rateKg))

  const rateItems = useMemo(
    () =>
      RATE_STOPS_KG.map((v) => ({
        value: v,
        label: unitPref === 'metric' ? `${v.toFixed(2)} kg/wk` : `${(v * LB_PER_KG).toFixed(2)} lb/wk`,
      })),
    [unitPref],
  )

  const goalBmi = profile != null && targetKg != null ? bmi(targetKg, profile.heightCm) : null
  const underweight = goalBmi != null && goalBmi < UNDERWEIGHT_BMI

  // Whether the target weight even points the same way as the chosen pace —
  // shown so a real disagreement between the two is visible, never silently
  // resolved by picking a winner.
  const targetDeltaLb = currentKg != null && targetKg != null ? kgToLb(targetKg) - kgToLb(currentKg) : 0
  const targetDirection: Goal =
    Math.abs(targetDeltaLb) < MAINTAIN_THRESHOLD_LB ? 'maintain' : targetDeltaLb > 0 ? 'gain' : 'lose'
  const directionsConflict = goal !== 'maintain' && targetDirection !== 'maintain' && goal !== targetDirection

  const paceCaption = useMemo(() => {
    if (goal === 'maintain') return 'Pace set to maintain — no calorie adjustment for weight change.'
    if (directionsConflict) {
      return `Your target weight points the other way. The pace above — not the target — is what sets your calorie target.`
    }
    if (targetDirection === 'maintain') {
      return `That pace still sets your calorie target; your target weight is close enough to current that there's no ETA to show.`
    }
    const weeks = rateLbUnsigned > 0 ? Math.abs(targetDeltaLb) / rateLbUnsigned : 0
    return `${Math.abs(targetDeltaLb).toFixed(1)} lbs to ${goal === 'gain' ? 'gain' : 'lose'} at this pace — about ${Math.round(weeks)} week${Math.round(weeks) === 1 ? '' : 's'} to your target.`
  }, [goal, directionsConflict, targetDirection, targetDeltaLb, rateLbUnsigned])

  // The live preview — the exact formula `setGoalTarget` will save, run here
  // client-side so the calorie number updates as the wheel or ruler moves,
  // with nothing written yet.
  const preview = useMemo(() => {
    if (profile == null || currentKg == null) return null
    const body: BodyInputs = {
      sex: profile.sex,
      weightKg: currentKg,
      heightCm: profile.heightCm,
      ageYears: profile.ageYears,
      bodyFatFraction: profile.bodyFatFraction,
    }
    return computeCalorieTarget({
      ...body,
      activity: profile.activity,
      goal,
      rateLbPerWeek: goal === 'maintain' ? 0 : rateLbUnsigned,
    })
  }, [profile, currentKg, goal, rateLbUnsigned])

  async function save() {
    if (targetKg == null || saving) return
    setSaving(true)
    setError(null)
    try {
      await setGoalTarget(targetKg, goal, rateLbUnsigned, Date.now())
      router.back()
    } catch (e) {
      setError((e as Error)?.message ?? 'Could not save — try again.')
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + space.lg }}
    >
      <View style={styles.head}>
        <Text style={[type.title, { color: theme.text }]}>Target weight</Text>
        <Pressable onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        <View style={{ alignItems: 'center', marginTop: space.lg }}>
          <Segmented
            options={[
              { value: 'imperial', label: 'lbs' },
              { value: 'metric', label: 'kg' },
            ]}
            value={unitPref}
            // Converts rather than resets — switching units should never cost
            // the target weight already dialed in.
            onChange={toggleUnits}
          />

          <View style={{ marginTop: space.lg }}>
            <EditableValue
              label="Target weight"
              value={shown}
              unit={weightUnitLabel(unitPref)}
              min={min}
              max={max}
              onCommit={(v) => setTargetKg(toKg(v, unitPref))}
            />
          </View>
        </View>

        <View style={{ marginTop: space.lg, marginHorizontal: -space.lg }}>
          <RulerPicker
            width={width}
            min={min}
            max={max}
            step={0.1}
            value={Number(shown.toFixed(1))}
            onChange={(v) => setTargetKg(toKg(v, unitPref))}
          />
        </View>

        {underweight ? (
          <View style={[styles.note, { backgroundColor: theme.uncertainBg }]}>
            <Text style={[type.caption, { color: theme.text }]}>
              That target is below a BMI of 18.5. You can still choose it — we just want you to
              know, and we'll never set a calorie target below a safe floor.
            </Text>
          </View>
        ) : null}

        <View style={{ marginTop: space.xl, alignItems: 'center' }}>
          <Text style={[type.label, { color: theme.textMuted, marginBottom: space.sm }]}>
            Pace — {GOAL_LABEL[goal]}
          </Text>
          <WheelHighlight>
            <Wheel label="Pace, kg or lb per week" items={rateItems} value={rateKg} width={220} onChange={setRateKg} />
          </WheelHighlight>
        </View>

        <Text style={[type.caption, { color: theme.textMuted, textAlign: 'center', marginTop: space.md }]}>
          {paceCaption}
        </Text>

        {directionsConflict ? (
          <View style={[styles.note, { backgroundColor: theme.uncertainBg }]}>
            <Text style={[type.caption, { color: theme.text }]}>
              Target weight and pace disagree on direction. That's allowed — maybe you're recomping
              — but double-check it's what you meant.
            </Text>
          </View>
        ) : null}

        <View style={[styles.previewCard, { backgroundColor: theme.bgSunken, marginTop: space.xl }]}>
          <Text style={[type.caption, { color: theme.textMuted }]}>New daily target</Text>
          <Text style={[styles.previewKcal, { color: theme.text }]}>
            {preview ? Math.round(preview.target) : '—'} kcal
          </Text>
          {preview?.floorApplied ? (
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 18 }]}>
              {preview.floorExplanation}
            </Text>
          ) : null}
          {preview?.warnings.map((w) => (
            <Text key={w} style={[type.caption, { color: theme.uncertain, marginTop: space.xs, lineHeight: 18 }]}>
              {w}
            </Text>
          ))}
          {profile?.bodyFatFraction != null ? (
            <Text style={[type.caption, { color: theme.textFaint, marginTop: space.xs, lineHeight: 18 }]}>
              Using the body fat % you entered on Progress for a sharper BMR (Katch-McArdle) instead
              of the usual weight-only estimate.
            </Text>
          ) : null}
        </View>

        {error ? (
          <View style={[styles.warn, { backgroundColor: theme.safetyBg }]}>
            <Text style={[type.caption, { color: theme.safety }]}>{error}</Text>
          </View>
        ) : null}
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={save}
          disabled={saving || targetKg == null || profile == null}
          style={[styles.cta, { backgroundColor: targetKg != null && profile != null ? theme.text : theme.border }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>{saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  note: { marginTop: space.lg, padding: space.lg, borderRadius: radius.lg },
  previewCard: { padding: space.lg, borderRadius: radius.lg },
  previewKcal: { fontSize: 32, fontWeight: '800', letterSpacing: -0.8, marginTop: space.xs },
  warn: { marginTop: space.md, padding: space.lg, borderRadius: radius.lg },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg },
  cta: { height: 60, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
