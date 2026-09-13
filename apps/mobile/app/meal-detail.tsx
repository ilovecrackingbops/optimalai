import { Image } from 'expo-image'
import { router, useFocusEffect, useLocalSearchParams } from 'expo-router'
import { useCallback, useState } from 'react'
import { Alert, Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import { deleteLogItem, deleteMeal, mealDetail, saveMealAsTemplate, updateLogItemGrams, type MealDetail } from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Meal detail — the edit route for a meal that is already logged.
 *
 * Grams and removal were only ever editable on the pre-log review screen
 * (`app/result.tsx`). Once `logMeal()` commits, there was no way back in. This
 * screen closes that gap with the exact same editable-row shape `result.tsx`
 * uses, except every change writes straight to `log_items` — `dayTotals()`
 * already derives every number live from that table, so nothing else needs to
 * be told a meal changed.
 */
export default function MealDetail() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { id } = useLocalSearchParams<{ id: string }>()
  const mealId = Number(id)

  const [meal, setMeal] = useState<MealDetail | null>(null)
  const [saving, setSaving] = useState(false)

  const load = useCallback(() => {
    void mealDetail(mealId).then((m) => setMeal(m))
  }, [mealId])

  function saveAsMeal() {
    if (saving) return
    Alert.prompt(
      'Save this meal',
      'Give it a name — you can relog it later from Saved foods with zero network calls.',
      (name) => {
        if (name == null) return
        setSaving(true)
        void saveMealAsTemplate(mealId, name, Date.now()).finally(() => setSaving(false))
      },
      'plain-text',
      meal?.items[0]?.displayName ?? '',
    )
  }

  useFocusEffect(
    useCallback(() => {
      load()
    }, [load]),
  )

  if (!meal) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg }]}>
        <Text style={[type.body, { color: theme.textMuted }]}>Loading…</Text>
      </View>
    )
  }

  const totalKcal = meal.items.reduce((a, i) => a + i.kcal, 0) * meal.portionEatenFraction

  function confirmDeleteMeal() {
    Alert.alert('Delete this meal?', 'Removes it and every ingredient in it from today’s log.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void deleteMeal(mealId).then(() => router.back())
        },
      },
    ])
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: theme.bgSunken }]}
        >
          <View style={{ transform: [{ scaleX: -1 }] }}>
            <Icon name="chevron" size={18} color={theme.text} />
          </View>
        </Pressable>
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>Edit meal</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
      >
        {meal.photoUri ? <Image source={{ uri: meal.photoUri }} style={styles.photo} /> : null}

        <Text style={[type.hero, { color: theme.text, marginTop: space.lg, fontSize: 40 }]}>
          {Math.round(totalKcal)}
        </Text>
        <Text style={[type.caption, { color: theme.textMuted }]}>kcal</Text>

        <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Ingredients</Text>

        {meal.items.map((item) => (
          <View key={item.id} style={[styles.row, { borderColor: theme.border }]}>
            <View style={{ flex: 1 }}>
              <Text style={[type.body, { color: theme.text }]}>{item.displayName}</Text>
              <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
                {Math.round(item.kcal * meal.portionEatenFraction)} kcal · {Math.round(item.proteinG * meal.portionEatenFraction)}p
                {' '}
                {Math.round(item.carbsG * meal.portionEatenFraction)}c {Math.round(item.fatG * meal.portionEatenFraction)}f
              </Text>
              {item.isEstimate ? (
                <Text style={[type.micro, { color: theme.uncertain, marginTop: 2 }]}>AI ESTIMATE</Text>
              ) : null}
            </View>

            <TextInput
              accessibilityLabel={`Grams of ${item.displayName}`}
              keyboardType="numeric"
              defaultValue={String(Math.round(item.grams))}
              onEndEditing={(e) => {
                const grams = Number(e.nativeEvent.text)
                if (!Number.isFinite(grams) || grams < 0) return
                void updateLogItemGrams(item.id, grams).then(load)
              }}
              style={[styles.gramInput, { color: theme.text, borderColor: theme.border }]}
            />

            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ${item.displayName}`}
              onPress={() => void deleteLogItem(item.id).then(load)}
              hitSlop={space.md}
              style={styles.remove}
            >
              <Text style={{ color: theme.textFaint, fontSize: 20 }}>×</Text>
            </Pressable>
          </View>
        ))}

        {meal.items.length === 0 ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.lg }]}>
            Every ingredient was removed. Delete the meal below to clear it from today's log.
          </Text>
        ) : null}
      </ScrollView>

      <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg, borderColor: theme.border }]}>
        <View style={{ flexDirection: 'row', gap: space.md }}>
          <Pressable
            accessibilityRole="button"
            disabled={saving || meal.items.length === 0}
            onPress={saveAsMeal}
            style={[styles.saveBtn, { borderColor: theme.border, opacity: saving ? 0.6 : 1 }]}
          >
            <Icon name="bookmark" size={16} color={theme.text} />
            <Text style={[type.bodyStrong, { color: theme.text }]}>{saving ? 'Saving…' : 'Save meal'}</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            onPress={confirmDeleteMeal}
            style={[styles.deleteBtn, { borderColor: theme.safety, flex: 1 }]}
          >
            <Text style={[type.bodyStrong, { color: theme.safety }]}>Delete meal</Text>
          </Pressable>
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
    paddingBottom: space.sm,
  },
  backBtn: {
    width: 44,
    height: 44,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  photo: { width: '100%', height: 200, borderRadius: radius.lg },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  gramInput: {
    width: 64,
    textAlign: 'right',
    paddingVertical: space.sm,
    paddingHorizontal: space.sm,
    borderRadius: radius.sm,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: MIN_TAP_TARGET,
  },
  remove: { width: MIN_TAP_TARGET, height: MIN_TAP_TARGET, alignItems: 'center', justifyContent: 'center' },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  deleteBtn: {
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
    borderWidth: 1.5,
  },
  saveBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    paddingHorizontal: space.lg,
    borderRadius: radius.pill,
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1.5,
  },
})
