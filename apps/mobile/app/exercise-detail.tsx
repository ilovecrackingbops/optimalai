import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import {
  deleteExerciseEntry,
  exerciseEntry,
  exerciseEntryItems,
  saveExerciseEntryItems,
  updateExerciseEntry,
  type SplitExerciseInput,
} from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

interface Row extends SplitExerciseInput {
  key: string
}

let seq = 0
const newRow = (): Row => ({ key: `r${seq++}`, name: '', sets: 3, reps: 10, weightLb: null })

/**
 * Exercise detail — the edit route for a logged exercise entry.
 *
 * An entry logged from a split carries its itemized sets/reps/weight
 * (exercise_entry_items) and is editable at that level — the whole point of
 * "I can't edit the sets and weight and reps." A Run/Manual/Describe entry
 * has no items — there is no "sets" concept for those — but the same "Add
 * exercise" affordance lets any entry gain a structured breakdown, so a
 * workout logged loosely can still be corrected into one afterward.
 */
export default function ExerciseDetail() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const entryId = Number(id)

  const [name, setName] = useState('')
  const [kcalText, setKcalText] = useState('')
  const [rows, setRows] = useState<Row[]>([])
  const [loaded, setLoaded] = useState(false)
  const [saving, setSaving] = useState(false)

  useFocusEffect(
    useCallback(() => {
      let alive = true
      void (async () => {
        const [e, items] = await Promise.all([exerciseEntry(entryId), exerciseEntryItems(entryId)])
        if (!alive || !e) return
        setName(e.name)
        setKcalText(String(Math.round(e.kcal)))
        setRows(items.map((i) => ({ key: `r${seq++}`, name: i.name, sets: i.sets, reps: i.reps, weightLb: i.weightLb })))
        setLoaded(true)
      })()
      return () => {
        alive = false
      }
    }, [entryId]),
  )

  const hasItems = rows.length > 0
  const kcal = Number.parseInt(kcalText, 10)
  const validSimple = name.trim().length > 0 && Number.isFinite(kcal) && kcal >= 0 && kcal <= 10_000
  const validItems = name.trim().length > 0 && rows.some((r) => r.name.trim().length > 0)
  const valid = hasItems ? validItems : validSimple

  function updateRow(key: string, patch: Partial<Row>) {
    setRows((cur) => cur.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  }

  function removeRow(key: string) {
    setRows((cur) => cur.filter((r) => r.key !== key))
  }

  async function save() {
    if (!valid || saving) return
    setSaving(true)
    try {
      if (hasItems) {
        await saveExerciseEntryItems(entryId, name, rows.filter((r) => r.name.trim().length > 0))
      } else {
        await updateExerciseEntry(entryId, { name: name.trim(), kcal })
      }
      router.back()
    } finally {
      setSaving(false)
    }
  }

  function confirmDelete() {
    Alert.alert('Delete this exercise?', 'Removes it from your log.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void deleteExerciseEntry(entryId).then(() => router.back()),
      },
    ])
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
          <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
        </Pressable>
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>Edit exercise</Text>
        <View style={{ width: 60 }} />
      </View>

      {loaded ? (
        <ScrollView
          contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}
          keyboardShouldPersistTaps="handled"
          keyboardDismissMode="on-drag"
        >
          <Text style={[type.label, { color: theme.textMuted }]}>Name</Text>
          <TextInput
            value={name}
            onChangeText={setName}
            style={[styles.input, { color: theme.text, borderColor: theme.border, fontSize: 17, fontWeight: '400' }]}
          />

          {hasItems ? (
            <>
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
                    <Field label="Sets" value={String(r.sets)} onCommit={(t) => updateRow(r.key, { sets: clampInt(t, r.sets) })} />
                    <Field label="Reps" value={String(r.reps)} onCommit={(t) => updateRow(r.key, { reps: clampInt(t, r.reps) })} />
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
              <Text style={[type.caption, { color: theme.textFaint, marginTop: space.md, lineHeight: 18 }]}>
                Calories recompute from total sets when you save.
              </Text>
            </>
          ) : (
            <>
              <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Calories burned</Text>
              <TextInput
                keyboardType="number-pad"
                value={kcalText}
                onChangeText={setKcalText}
                style={[styles.input, { color: theme.text, borderColor: theme.border, marginTop: space.sm }]}
              />
            </>
          )}

          <Pressable
            onPress={() => setRows((cur) => [...cur, newRow()])}
            style={[styles.addRow, { borderColor: theme.border }]}
          >
            <Icon name="plus" size={18} color={theme.text} />
            <Text style={[type.body, { color: theme.text }]}>Add exercise</Text>
          </Pressable>
        </ScrollView>
      ) : null}

      <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg, borderColor: theme.border }]}>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Pressable
            accessibilityRole="button"
            onPress={confirmDelete}
            style={[styles.deleteBtn, { borderColor: theme.safety }]}
          >
            <Text style={[type.bodyStrong, { color: theme.safety }]}>Delete</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            disabled={!valid || saving}
            onPress={save}
            style={[styles.primary, { flex: 1, backgroundColor: valid ? theme.text : theme.border }]}
          >
            <Text style={[type.bodyStrong, { color: theme.bg }]}>{saving ? 'Saving…' : 'Save'}</Text>
          </Pressable>
        </View>
      </View>
    </View>
  )
}

/** Uncontrolled on purpose — see split-editor.tsx's Field for why. */
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
  input: {
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
    marginTop: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.lg,
    borderWidth: 1.5,
    borderStyle: 'dashed',
    minHeight: MIN_TAP_TARGET,
  },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  deleteBtn: {
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1.5,
  },
  primary: {
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
  },
})
