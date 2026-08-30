import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import {
  ActivityIndicator,
  Alert,
  Keyboard,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { deleteSavedMeal, logSavedMeal, saveCustomRecipe, savedMeals, type SavedMealListEntry } from '../src/data/repo'
import { Icon } from '../src/components/Icon'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Saved meals.
 *
 * A saved meal stores the CORRECTED ingredient array, not a food name to
 * re-analyze. That is what makes relogging free: zero network requests, zero
 * clarifying questions, and identical numbers to the day you fixed them.
 * Saved from a logged meal's edit screen ("Save meal" in meal-detail.tsx), or
 * typed here directly as a custom recipe — a name and its macros, no photo
 * and no corpus match needed.
 */
export default function SavedFoods() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [meals, setMeals] = useState<SavedMealListEntry[]>([])
  const [loggingId, setLoggingId] = useState<number | null>(null)

  const [composing, setComposing] = useState(false)
  const [name, setName] = useState('')
  const [kcalText, setKcalText] = useState('')
  const [proteinText, setProteinText] = useState('')
  const [carbsText, setCarbsText] = useState('')
  const [fatText, setFatText] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    let alive = true
    void savedMeals().then((rows) => {
      if (alive) setMeals(rows)
    })
    return () => { alive = false }
  }, [])

  useFocusEffect(load)

  async function relog(id: number) {
    if (loggingId != null) return
    setLoggingId(id)
    try {
      await logSavedMeal(id, Date.now())
      router.back()
    } finally {
      setLoggingId(null)
    }
  }

  function confirmDelete(m: SavedMealListEntry) {
    Alert.alert('Remove this saved meal?', `"${m.name}" will no longer show up here.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => void deleteSavedMeal(m.id).then(load) },
    ])
  }

  function openCompose() {
    setName('')
    setKcalText('')
    setProteinText('')
    setCarbsText('')
    setFatText('')
    setComposing(true)
  }

  const kcal = Number.parseFloat(kcalText)
  const recipeValid = name.trim().length > 0 && Number.isFinite(kcal) && kcal > 0

  async function saveRecipe() {
    if (!recipeValid || saving) return
    setSaving(true)
    try {
      await saveCustomRecipe(
        name,
        {
          kcal,
          protein_g: Number.parseFloat(proteinText) || 0,
          carbs_g: Number.parseFloat(carbsText) || 0,
          fat_g: Number.parseFloat(fatText) || 0,
        },
        Date.now(),
      )
      Keyboard.dismiss()
      setComposing(false)
      load()
    } finally {
      setSaving(false)
    }
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg, paddingTop: insets.top + space.lg }}>
      <View style={styles.head}>
        <Text style={[type.title, { color: theme.text }]}>Saved foods</Text>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.lg }}>
          <Pressable accessibilityRole="button" accessibilityLabel="New recipe" onPress={openCompose} hitSlop={space.sm}>
            <Icon name="plus" size={22} color={theme.text} />
          </Pressable>
          <Pressable onPress={() => router.back()} hitSlop={space.md}>
            <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
          </Pressable>
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        {meals.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: theme.bgSunken }]}>
            <Text style={[type.bodyStrong, { color: theme.text }]}>Nothing saved yet</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
              Open a logged meal and tap "Save meal", or tap + above to type in a custom recipe by
              hand. Relogging either later costs nothing — no scan, no network request.
            </Text>
          </View>
        ) : (
          meals.map((m) => (
            <Pressable
              key={m.id}
              disabled={loggingId != null}
              onPress={() => void relog(m.id)}
              onLongPress={() => confirmDelete(m)}
              style={[styles.row, { backgroundColor: theme.bgSunken }]}
            >
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: theme.text }]}>{m.name}</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>
                  {Math.round(m.kcal)} kcal · {m.itemCount} ingredient{m.itemCount === 1 ? '' : 's'}
                  {m.useCount > 0 ? ` · logged ${m.useCount} time${m.useCount === 1 ? '' : 's'}` : ''}
                </Text>
              </View>
              {loggingId === m.id ? (
                <ActivityIndicator color={theme.textFaint} />
              ) : (
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.xs }}>
                  <Text style={[type.label, { color: theme.protein }]}>Log again</Text>
                  <Icon name="chevron" size={14} color={theme.protein} />
                </View>
              )}
            </Pressable>
          ))
        )}
        {meals.length > 0 ? (
          <Text style={[type.micro, { color: theme.textFaint, marginTop: space.md, textAlign: 'center' }]}>
            Hold a saved meal to remove it.
          </Text>
        ) : null}
      </ScrollView>

      {composing ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.composeOverlay, { backgroundColor: theme.bg, paddingTop: insets.top + space.lg }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[type.title, { color: theme.text, fontSize: 22 }]}>New recipe</Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => { Keyboard.dismiss(); setComposing(false) }}
              hitSlop={space.md}
            >
              <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
            </Pressable>
          </View>

          <ScrollView style={{ flex: 1 }} contentContainerStyle={{ paddingBottom: space.xl }} keyboardShouldPersistTaps="handled">
            <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Name</Text>
            <TextInput
              autoFocus
              placeholder="Mom's chili"
              placeholderTextColor={theme.textFaint}
              value={name}
              onChangeText={setName}
              style={[styles.input, { color: theme.text, borderColor: theme.border, fontSize: 17, fontWeight: '400' }]}
            />

            <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Calories (whole recipe)</Text>
            <TextInput
              keyboardType="decimal-pad"
              placeholder="0"
              placeholderTextColor={theme.textFaint}
              value={kcalText}
              onChangeText={setKcalText}
              style={[styles.input, { color: theme.text, borderColor: theme.border, marginTop: space.sm }]}
            />

            <View style={styles.macroFields}>
              <MacroField label="Protein (g)" value={proteinText} onChangeText={setProteinText} />
              <MacroField label="Carbs (g)" value={carbsText} onChangeText={setCarbsText} />
              <MacroField label="Fat (g)" value={fatText} onChangeText={setFatText} />
            </View>

            <Text style={[type.caption, { color: theme.textFaint, marginTop: space.lg, lineHeight: 19 }]}>
              Enter the totals for the whole thing — one serving, whatever that means for this
              recipe. Logging it later adds exactly these numbers, every time.
            </Text>
          </ScrollView>

          <Pressable
            accessibilityRole="button"
            disabled={!recipeValid || saving}
            onPress={() => void saveRecipe()}
            style={[
              styles.primary,
              { backgroundColor: recipeValid ? theme.text : theme.border, marginBottom: Math.max(insets.bottom, space.lg) },
            ]}
          >
            <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>
              {saving ? 'Saving…' : 'Save recipe'}
            </Text>
          </Pressable>
        </KeyboardAvoidingView>
      ) : null}
    </View>
  )
}

function MacroField({
  label, value, onChangeText,
}: {
  label: string
  value: string
  onChangeText: (t: string) => void
}) {
  const theme = useTheme()
  return (
    <View style={{ flex: 1 }}>
      <Text style={[type.micro, { color: theme.textFaint }]}>{label}</Text>
      <TextInput
        keyboardType="decimal-pad"
        placeholder="0"
        placeholderTextColor={theme.textFaint}
        value={value}
        onChangeText={onChangeText}
        style={[styles.macroInput, { color: theme.text, borderColor: theme.border }]}
      />
    </View>
  )
}

const styles = StyleSheet.create({
  head: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: space.lg,
  },
  empty: { padding: space.lg, borderRadius: radius.xl },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: space.md,
    padding: space.lg, borderRadius: radius.lg, marginBottom: space.sm,
    minHeight: MIN_TAP_TARGET,
  },
  composeOverlay: {
    position: 'absolute', left: 0, right: 0, top: 0, bottom: 0, paddingHorizontal: space.lg,
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
  macroFields: { flexDirection: 'row', gap: space.sm, marginTop: space.xl },
  macroInput: {
    marginTop: 4,
    paddingHorizontal: space.sm,
    paddingVertical: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    textAlign: 'center',
    minHeight: MIN_TAP_TARGET,
  },
  primary: {
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
  },
})
