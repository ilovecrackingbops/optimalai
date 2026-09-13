import { router, useLocalSearchParams } from 'expo-router'
import { useEffect, useState } from 'react'
import { KeyboardAvoidingView, Platform, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import { saveSplit, splitDetail, type SplitExerciseInput } from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

interface Row extends SplitExerciseInput {
  key: string
}

let seq = 0
const newRow = (): Row => ({ key: `r${seq++}`, name: '', sets: 3, reps: 10, weightLb: null })

/**
 * Split editor — name the day, then a repeatable list of exercise / weight /
 * reps rows. Saved as one unit: editing an existing split replaces its whole
 * exercise list rather than diffing rows (`saveSplit` in repo.ts), which is
 * simpler and safe here because a split has no history to preserve — it is a
 * template, not a log.
 */
export default function SplitEditor() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id?: string }>()
  const splitId = id ? Number(id) : null

  const [name, setName] = useState('')
  const [rows, setRows] = useState<Row[]>([newRow()])
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (splitId == null) return
    void splitDetail(splitId).then((d) => {
      if (!d) return
      setName(d.name)
      if (d.exercises.length > 0) {
        setRows(d.exercises.map((e) => ({ key: `r${seq++}`, name: e.name, sets: e.sets, reps: e.reps, weightLb: e.weightLb })))
      }
    })
  }, [splitId])

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  function removeRow(key: string) {
    setRows((cur) => cur.filter((r) => r.key !== key))
  }

  const validExercises = rows.filter((r) => r.name.trim().length > 0)
  const canSave = name.trim().length > 0 && validExercises.length > 0

  async function save() {
    if (!canSave || saving) return
    setSaving(true)
    try {
      await saveSplit(splitId, name, validExercises, Date.now())
      router.back()
    } finally {
      setSaving(false)
    }
  }

  return (
    <KeyboardAvoidingView
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      style={{ flex: 1, backgroundColor: theme.bg }}
    >
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
        </Pressable>
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>
          {splitId == null ? 'New split' : 'Edit split'}
        </Text>
        <View style={{ width: 60 }} />
      </View>

      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{ padding: space.lg }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        <Text style={[type.label, { color: theme.textMuted }]}>Split name</Text>
        <TextInput
          autoFocus={splitId == null}
          placeholder="Upper"
          placeholderTextColor={theme.textFaint}
          value={name}
          onChangeText={setName}
          style={[styles.nameInput, { color: theme.text, borderColor: theme.border }]}
        />

        <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Exercises</Text>

        {rows.map((r) => (
          <View key={r.key} style={[styles.exRow, { backgroundColor: theme.bgSunken }]}>
            <TextInput
              placeholder="Exercise name"
              placeholderTextColor={theme.textFaint}
              value={r.name}
              onChangeText={(t) => updateRow(r.key, { name: t })}
              style={[styles.exName, { color: theme.text, borderColor: theme.border }]}
            />
            <View style={styles.exFields}>
              <Field
                label="Sets"
                value={String(r.sets)}
                onCommit={(t) => updateRow(r.key, { sets: clampInt(t, r.sets) })}
              />
              <Field
                label="Reps"
                value={String(r.reps)}
                onCommit={(t) => updateRow(r.key, { reps: clampInt(t, r.reps) })}
              />
              <Field
                label="Weight (lb)"
                value={r.weightLb == null ? '' : String(r.weightLb)}
                placeholder="0"
                onCommit={(t) => updateRow(r.key, { weightLb: t.trim() === '' ? null : clampInt(t, 0) })}
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Remove ${r.name || 'exercise'}`}
                onPress={() => removeRow(r.key)}
                hitSlop={space.sm}
                style={styles.remove}
              >
                <Text style={{ color: theme.textFaint, fontSize: 18 }}>×</Text>
              </Pressable>
            </View>
          </View>
        ))}

        <Pressable
          onPress={() => setRows((cur) => [...cur, newRow()])}
          style={[styles.addRow, { borderColor: theme.border }]}
        >
          <Icon name="plus" size={18} color={theme.text} />
          <Text style={[type.body, { color: theme.text }]}>Add exercise</Text>
        </Pressable>
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={save}
          disabled={!canSave || saving}
          style={[styles.cta, { backgroundColor: canSave ? theme.text : theme.border }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>{saving ? 'Saving…' : 'Save split'}</Text>
        </Pressable>
      </View>
    </KeyboardAvoidingView>
  )
}

/**
 * Uncontrolled on purpose: a controlled numeric field that clamps on every
 * keystroke snaps back to the old value the instant the box goes empty mid-edit
 * (typing over "3" starts with a delete, which parses to NaN, which fell back to
 * the OLD value — so the input was permanently stuck showing that first digit).
 * Clamping only on blur lets the user actually clear and retype.
 */
function Field({
  label, value, onCommit, placeholder,
}: {
  label: string
  value: string
  onCommit: (t: string) => void
  placeholder?: string
}) {
  const theme = useTheme()
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.micro, { color: theme.textFaint }]}>{label}</Text>
      <TextInput
        keyboardType="number-pad"
        placeholder={placeholder}
        placeholderTextColor={theme.textFaint}
        defaultValue={value}
        onEndEditing={(e) => onCommit(e.nativeEvent.text)}
        style={[styles.fieldInput, { color: theme.text, borderColor: theme.border }]}
      />
    </View>
  )
}

function clampInt(text: string, fallback: number): number {
  const n = Number.parseInt(text, 10)
  return Number.isFinite(n) && n >= 0 && n <= 2000 ? n : fallback
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  nameInput: {
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    fontSize: 20,
    fontWeight: '700',
    minHeight: 56,
  },
  exRow: { marginTop: space.md, padding: space.md, borderRadius: radius.lg },
  exName: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: MIN_TAP_TARGET,
  },
  exFields: { flexDirection: 'row', alignItems: 'flex-end', gap: space.sm, marginTop: space.sm },
  fieldInput: {
    marginTop: 4,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    textAlign: 'center',
    minHeight: MIN_TAP_TARGET,
  },
  remove: { width: MIN_TAP_TARGET, height: MIN_TAP_TARGET, alignItems: 'center', justifyContent: 'center' },
  addRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    marginTop: space.md,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    minHeight: MIN_TAP_TARGET,
  },
  dock: { padding: space.lg },
  cta: { height: 60, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
