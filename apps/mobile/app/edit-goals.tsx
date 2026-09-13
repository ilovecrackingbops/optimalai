import { router } from 'expo-router'
import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { reconcileFromMacros } from '@nutai/totals'
import { currentGoal, overrideTargets, type CurrentGoal } from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { radius, space, type } from '../src/theme/tokens'

type MacroUnit = 'g' | '%'
const KCAL_PER_G = { protein: 4, fat: 9, carbs: 4 } as const

/**
 * Edit nutrition goals.
 *
 * Two rules carried over from the engine, because a settings screen that breaks
 * them re-introduces the exact bug the engine was built to prevent:
 *
 *   CARBS ARE THE DERIVED VARIABLE. Editing calories, protein or fat re-solves
 *   carbs as the remainder. There is always exactly one dependent value, so the
 *   four numbers can never drift out of agreement.
 *
 *   SAVING TURNS THE ADAPTIVE LOOP OFF. Silently overwriting a target someone
 *   deliberately typed is the fastest way to lose their trust in every other
 *   number in the app.
 *
 * Protein and fat can be typed as grams OR as % of calories — a g/% segmented
 * toggle, not two parallel fields to keep in sync. Grams stay the one thing
 * actually saved (`overrideTargets` takes grams, same as `goals.protein_g` in
 * the DB); % is purely a display/input transform of the same number, computed
 * live from whatever calories currently reads, so typing "30" in % mode and
 * then changing calories updates the resulting grams instead of silently
 * leaving a stale gram figure that no longer means 30%.
 */
export default function EditGoals() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [base, setBase] = useState<CurrentGoal | null>(null)
  const [kcal, setKcal] = useState('')
  const [proteinUnit, setProteinUnit] = useState<MacroUnit>('g')
  const [fatUnit, setFatUnit] = useState<MacroUnit>('g')
  const [proteinText, setProteinText] = useState('')
  const [fatText, setFatText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void currentGoal().then((g) => {
      if (!alive || !g) return
      setBase(g)
      setKcal(String(Math.round(g.targetKcal)))
      setProteinText(String(Math.round(g.protein_g)))
      setFatText(String(Math.round(g.fat_g)))
    })
    return () => {
      alive = false
    }
  }, [])

  const n = (s: string) => {
    const v = Number.parseFloat(s)
    return Number.isFinite(v) && v >= 0 ? v : 0
  }

  const kcalV = n(kcal)

  /** Grams are the one true value regardless of which unit is showing. */
  function gramsOf(text: string, unit: MacroUnit, kcalPerG: number): number {
    const v = n(text)
    return unit === 'g' ? v : kcalV > 0 ? (v / 100) * kcalV / kcalPerG : 0
  }
  function pctOf(grams: number, kcalPerG: number): number {
    return kcalV > 0 ? (grams * kcalPerG * 100) / kcalV : 0
  }

  const proteinV = gramsOf(proteinText, proteinUnit, KCAL_PER_G.protein)
  const fatV = gramsOf(fatText, fatUnit, KCAL_PER_G.fat)
  // The single derived value.
  const carbsV = Math.max(0, (kcalV - 4 * proteinV - 9 * fatV) / 4)
  const impossible = kcalV > 0 && 4 * proteinV + 9 * fatV > kcalV

  function switchUnit(macro: 'protein' | 'fat', next: MacroUnit) {
    if (macro === 'protein') {
      if (next === proteinUnit) return
      setProteinText(next === '%' ? String(Math.round(pctOf(proteinV, KCAL_PER_G.protein))) : String(Math.round(proteinV)))
      setProteinUnit(next)
    } else {
      if (next === fatUnit) return
      setFatText(next === '%' ? String(Math.round(pctOf(fatV, KCAL_PER_G.fat))) : String(Math.round(fatV)))
      setFatUnit(next)
    }
  }

  async function save() {
    if (!base || saving || kcalV <= 0 || impossible) return
    setSaving(true)
    await overrideTargets(
      {
        targetKcal: kcalV,
        macros: { protein_g: proteinV, fat_g: fatV, carbs_g: carbsV, carbsFloored: carbsV === 0 },
      },
      base,
      Date.now(),
    )
    router.back()
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + space.lg }}
    >
      <View style={styles.head}>
        <Text style={[type.title, { color: theme.text }]}>Nutrition goals</Text>
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
        <Field label="Calories" unit="kcal" value={kcal} onChange={setKcal} />

        <MacroField
          label="Protein"
          text={proteinText}
          onChangeText={setProteinText}
          unit={proteinUnit}
          onChangeUnit={(u) => switchUnit('protein', u)}
          grams={proteinV}
          pct={pctOf(proteinV, KCAL_PER_G.protein)}
        />
        <MacroField
          label="Fat"
          text={fatText}
          onChangeText={setFatText}
          unit={fatUnit}
          onChangeUnit={(u) => switchUnit('fat', u)}
          grams={fatV}
          pct={pctOf(fatV, KCAL_PER_G.fat)}
        />

        <View style={[styles.derived, { backgroundColor: theme.bgSunken }]}>
          <View style={{ flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <Text style={[type.body, { color: theme.textMuted }]}>Carbs</Text>
            <Text style={[styles.big, { color: theme.text }]}>
              {Math.round(carbsV)} g
              <Text style={[type.caption, { color: theme.textMuted }]}>
                {'  '}· {Math.round(pctOf(carbsV, KCAL_PER_G.carbs))}%
              </Text>
            </Text>
          </View>
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 18 }]}>
            Carbs are always the remainder, so your four numbers can never disagree with each other.
            Change calories, protein or fat and this re-solves.
          </Text>
        </View>

        {impossible ? (
          <View style={[styles.warn, { backgroundColor: theme.safetyBg }]}>
            <Text style={[type.caption, { color: theme.safety }]}>
              Protein and fat alone already exceed {Math.round(kcalV)} kcal
              ({Math.round(reconcileFromMacros(proteinV, 0, fatV))} kcal). Raise calories or lower one
              of them.
            </Text>
          </View>
        ) : null}

        <View style={[styles.note, { backgroundColor: theme.uncertainBg }]}>
          <Text style={[type.caption, { color: theme.text, lineHeight: 18 }]}>
            Saving switches OFF the adaptive target. We will not quietly overwrite a number you
            chose on purpose — you can turn adaptation back on by regenerating your plan.
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={save}
          disabled={kcalV <= 0 || impossible || saving}
          style={[styles.cta, { backgroundColor: kcalV > 0 && !impossible ? theme.text : theme.border }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>Save</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

function Field({
  label, unit, value, onChange,
}: {
  label: string
  unit: string
  value: string
  onChange: (v: string) => void
}) {
  const theme = useTheme()
  return (
    <View style={{ marginBottom: space.lg }}>
      <Text style={[type.label, { color: theme.textMuted, marginBottom: space.xs }]}>{label}</Text>
      <View style={[styles.field, { backgroundColor: theme.bgSunken, borderColor: theme.border }]}>
        <TextInput
          keyboardType="number-pad"
          value={value}
          onChangeText={onChange}
          accessibilityLabel={`${label} in ${unit}`}
          style={[styles.input, { color: theme.text }]}
        />
        <Text style={[type.body, { color: theme.textMuted }]}>{unit}</Text>
      </View>
    </View>
  )
}

/** A gram/percent field with a small toggle and the other unit shown as a live cross-reference. */
function MacroField({
  label, text, onChangeText, unit, onChangeUnit, grams, pct,
}: {
  label: string
  text: string
  onChangeText: (v: string) => void
  unit: MacroUnit
  onChangeUnit: (u: MacroUnit) => void
  grams: number
  pct: number
}) {
  const theme = useTheme()
  return (
    <View style={{ marginBottom: space.lg }}>
      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: space.xs }}>
        <Text style={[type.label, { color: theme.textMuted }]}>{label}</Text>
        <View style={[styles.segment, { backgroundColor: theme.bgSunken }]}>
          {(['g', '%'] as const).map((u) => (
            <Pressable
              key={u}
              accessibilityRole="button"
              accessibilityState={{ selected: unit === u }}
              onPress={() => onChangeUnit(u)}
              style={[styles.segItem, unit === u && { backgroundColor: theme.bgElevated }]}
            >
              <Text style={[type.caption, { color: unit === u ? theme.text : theme.textMuted, fontWeight: unit === u ? '700' : '400' }]}>
                {u}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
      <View style={[styles.field, { backgroundColor: theme.bgSunken, borderColor: theme.border }]}>
        <TextInput
          keyboardType="number-pad"
          value={text}
          onChangeText={onChangeText}
          accessibilityLabel={`${label} in ${unit === 'g' ? 'grams' : 'percent of calories'}`}
          style={[styles.input, { color: theme.text }]}
        />
        <Text style={[type.body, { color: theme.textMuted }]}>{unit === 'g' ? 'g' : '%'}</Text>
      </View>
      <Text style={[type.caption, { color: theme.textFaint, marginTop: 4 }]}>
        {unit === 'g' ? `${Math.round(pct)}% of calories` : `${Math.round(grams)} g`}
      </Text>
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  field: {
    flexDirection: 'row', alignItems: 'center', gap: space.sm,
    paddingHorizontal: space.lg, borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth, minHeight: 56,
  },
  input: { flex: 1, fontSize: 22, fontWeight: '700', paddingVertical: space.md },
  segment: { flexDirection: 'row', borderRadius: radius.pill, padding: 2 },
  segItem: { paddingHorizontal: space.md, paddingVertical: 4, borderRadius: radius.pill },
  derived: { padding: space.lg, borderRadius: radius.lg },
  big: { fontSize: 24, fontWeight: '800', letterSpacing: -0.6 },
  warn: { marginTop: space.md, padding: space.lg, borderRadius: radius.lg },
  note: { marginTop: space.md, padding: space.lg, borderRadius: radius.lg },
  dock: { padding: space.lg },
  cta: { height: 60, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
