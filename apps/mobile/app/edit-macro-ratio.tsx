import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { computeMacros } from '@nutai/goals'
import { currentGoal, macroSplitPct, setMacroSplitPct, weightHistory, type CurrentGoal } from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { radius, space, type } from '../src/theme/tokens'

type Mode = 'auto' | 'custom'

/**
 * Macro ratio.
 *
 * Distinct from "Edit nutrition goals" (edit-goals.tsx) on purpose: that
 * screen is a one-time hand-typed override that turns the adaptive calorie
 * loop OFF. This is a standing PREFERENCE — "always split my calories this
 * way" — that keeps applying itself every time the target changes (a
 * target-weight edit, the adaptive loop's own recompute) and never touches
 * the adaptive flag. `setMacroSplitPct` is what makes that true.
 *
 * "Automatic" is the app's own default: protein scales with bodyweight, not
 * with the calorie budget (`@nutai/goals`' documented reasoning — percent-of-
 * calories protein silently shrinks on a cut, which is backwards). Custom is
 * an explicit, informed opt-out of that reasoning, not a replacement default.
 */
export default function EditMacroRatio() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [goal, setGoal] = useState<CurrentGoal | null>(null)
  const [weightKg, setWeightKg] = useState(80)
  const [mode, setMode] = useState<Mode>('auto')
  const [proteinText, setProteinText] = useState('30')
  const [fatText, setFatText] = useState('30')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      const [g, split, points] = await Promise.all([currentGoal(), macroSplitPct(), weightHistory()])
      if (!alive) return
      setGoal(g)
      setWeightKg(points[points.length - 1]?.weightKg ?? 80)
      if (split) {
        setMode('custom')
        setProteinText(String(split.proteinPct))
        setFatText(String(split.fatPct))
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  const proteinPct = Number.parseFloat(proteinText) || 0
  const fatPct = Number.parseFloat(fatText) || 0
  const carbsPct = 100 - proteinPct - fatPct
  const valid = proteinPct > 0 && fatPct > 0 && carbsPct > 0

  const preview = goal
    ? mode === 'custom' && valid
      ? computeMacros(goal.targetKcal, weightKg, goal.goalType, { proteinPct, fatPct })
      : computeMacros(goal.targetKcal, weightKg, goal.goalType)
    : null

  async function save() {
    if (saving || (mode === 'custom' && !valid)) return
    setSaving(true)
    try {
      await setMacroSplitPct(mode === 'custom' ? { proteinPct, fatPct } : null, Date.now())
      router.back()
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
        <Text style={[type.title, { color: theme.text }]}>Macro ratio</Text>
        <Pressable onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
        </Pressable>
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <View style={[styles.segment, { backgroundColor: theme.bgSunken }]}>
          <Pressable
            onPress={() => setMode('auto')}
            style={[styles.segItem, mode === 'auto' && { backgroundColor: theme.bgElevated }]}
          >
            <Text style={[type.bodyStrong, { color: mode === 'auto' ? theme.text : theme.textMuted }]}>Automatic</Text>
          </Pressable>
          <Pressable
            onPress={() => setMode('custom')}
            style={[styles.segItem, mode === 'custom' && { backgroundColor: theme.bgElevated }]}
          >
            <Text style={[type.bodyStrong, { color: mode === 'custom' ? theme.text : theme.textMuted }]}>
              Custom %
            </Text>
          </Pressable>
        </View>

        {mode === 'auto' ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.lg, lineHeight: 19 }]}>
            Protein scales with your bodyweight, not with the calorie budget — cutting calories never
            quietly cuts your protein too. Fat is a percentage of calories with a floor. This is the
            default, and what most people should use.
          </Text>
        ) : (
          <>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.lg, lineHeight: 19 }]}>
              Set protein and fat as a percentage of your daily calories. Carbs is always whatever's
              left — the same rule the app uses everywhere else, just fed by your percentages instead
              of your bodyweight.
            </Text>

            <View style={styles.macroFields}>
              <PctField label="Protein %" value={proteinText} onChangeText={setProteinText} />
              <PctField label="Fat %" value={fatText} onChangeText={setFatText} />
              <View style={{ flex: 1 }}>
                <Text style={[type.micro, { color: theme.textFaint }]}>Carbs %</Text>
                <View style={[styles.carbsBox, { borderColor: theme.border }]}>
                  <Text style={[type.bodyStrong, { color: carbsPct > 0 ? theme.text : theme.safety }]}>
                    {Math.round(carbsPct)}
                  </Text>
                </View>
              </View>
            </View>

            {!valid ? (
              <Text style={[type.caption, { color: theme.safety, marginTop: space.sm }]}>
                Protein and fat must each be above 0% and leave some room for carbs.
              </Text>
            ) : null}
          </>
        )}

        {preview && goal ? (
          <View style={[styles.previewCard, { backgroundColor: theme.bgSunken }]}>
            <Text style={[type.caption, { color: theme.textMuted }]}>
              At today's {Math.round(goal.targetKcal)} kcal target
            </Text>
            <View style={styles.previewRow}>
              <PreviewStat label="Protein" value={`${Math.round(preview.protein_g)}g`} />
              <PreviewStat label="Fat" value={`${Math.round(preview.fat_g)}g`} />
              <PreviewStat label="Carbs" value={`${Math.round(preview.carbs_g)}g`} />
            </View>
          </View>
        ) : null}

        <Text style={[type.caption, { color: theme.textFaint, marginTop: space.lg, lineHeight: 18 }]}>
          Unlike a manual macro override, this doesn't turn off automatic calorie adjustment — it
          only changes how a target, whatever it ends up being, gets split.
        </Text>
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={() => void save()}
          disabled={saving || (mode === 'custom' && !valid)}
          style={[
            styles.cta,
            { backgroundColor: mode === 'auto' || valid ? theme.text : theme.border },
          ]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>{saving ? 'Saving…' : 'Save'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

function PctField({ label, value, onChangeText }: { label: string; value: string; onChangeText: (v: string) => void }) {
  const theme = useTheme()
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.micro, { color: theme.textFaint }]}>{label}</Text>
      <TextInput
        keyboardType="number-pad"
        value={value}
        onChangeText={onChangeText}
        style={[styles.pctInput, { color: theme.text, borderColor: theme.border }]}
      />
    </View>
  )
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  const theme = useTheme()
  return (
    <View style={{ alignItems: 'center', flex: 1 }}>
      <Text style={[type.bodyStrong, { color: theme.text }]}>{value}</Text>
      <Text style={[type.micro, { color: theme.textFaint, marginTop: 2 }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  segment: { flexDirection: 'row', borderRadius: radius.pill, padding: 3 },
  segItem: { flex: 1, alignItems: 'center', paddingVertical: space.sm, borderRadius: radius.pill },
  macroFields: { flexDirection: 'row', gap: space.sm, marginTop: space.xl },
  pctInput: {
    marginTop: 4,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 20,
    fontWeight: '700',
    textAlign: 'center',
  },
  carbsBox: {
    marginTop: 4,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderStyle: 'dashed',
    alignItems: 'center',
  },
  previewCard: { marginTop: space.xl, padding: space.lg, borderRadius: radius.lg },
  previewRow: { flexDirection: 'row', marginTop: space.md },
  dock: { padding: space.lg },
  cta: { height: 60, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
