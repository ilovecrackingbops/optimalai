import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { ActivityIndicator, Alert, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import { deleteSplit, listSplits, logSplitWorkout, type SplitListEntry } from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Splits — a repeatable training day, saved once and reused every time it
 * comes back around. Logging one writes the summary entry AND its itemized
 * sets/reps/weight (`logSplitWorkout` in repo.ts) — editable afterward from
 * the exercise-detail screen, not just a collapsed calorie number.
 */
export default function Splits() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [splits, setSplits] = useState<SplitListEntry[]>([])
  const [loggingId, setLoggingId] = useState<number | null>(null)

  const load = useCallback(() => {
    let alive = true
    void listSplits().then((rows) => {
      if (alive) setSplits(rows)
    })
    return () => { alive = false }
  }, [])

  useFocusEffect(load)

  async function logSplit(id: number) {
    if (loggingId != null) return
    setLoggingId(id)
    try {
      const entryId = await logSplitWorkout(id, Date.now())
      if (entryId != null) router.back()
    } finally {
      setLoggingId(null)
    }
  }

  function confirmDelete(s: SplitListEntry) {
    Alert.alert('Delete this split?', `"${s.name}" and its exercise list will be removed.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void deleteSplit(s.id).then(load) },
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
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>My splits</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New split"
          onPress={() => router.push('/split-editor' as never)}
          hitSlop={space.sm}
        >
          <Icon name="plus" size={22} color={theme.text} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        {splits.length === 0 ? (
          <View style={[styles.empty, { backgroundColor: theme.bgSunken }]}>
            <Text style={[type.bodyStrong, { color: theme.text }]}>No splits yet</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs, lineHeight: 19 }]}>
              Name a training day — "Upper", "Push" — and list the exercises, weight and reps
              you actually do. Log it in one tap every time that day comes back around.
            </Text>
            <Pressable
              onPress={() => router.push('/split-editor' as never)}
              style={[styles.newBtn, { backgroundColor: theme.text }]}
            >
              <Text style={[type.bodyStrong, { color: theme.bg }]}>New split</Text>
            </Pressable>
          </View>
        ) : (
          splits.map((s) => (
            <View key={s.id} style={[styles.row, { backgroundColor: theme.bgSunken }]}>
              <Pressable
                style={{ flex: 1 }}
                onPress={() => router.push({ pathname: '/split-editor', params: { id: String(s.id) } } as never)}
              >
                <Text style={[type.bodyStrong, { color: theme.text }]}>{s.name}</Text>
                <Text style={[type.caption, { color: theme.textMuted }]}>
                  {s.exerciseCount} exercise{s.exerciseCount === 1 ? '' : 's'}
                </Text>
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Log ${s.name}`}
                disabled={loggingId != null || s.exerciseCount === 0}
                onPress={() => void logSplit(s.id)}
                style={[styles.logBtn, { borderColor: theme.border }]}
              >
                {loggingId === s.id ? (
                  <ActivityIndicator color={theme.textFaint} size="small" />
                ) : (
                  <Text style={[type.label, { color: theme.protein }]}>Log</Text>
                )}
              </Pressable>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Delete ${s.name}`}
                onPress={() => confirmDelete(s)}
                hitSlop={space.sm}
                style={styles.remove}
              >
                <Text style={{ color: theme.textFaint, fontSize: 18 }}>×</Text>
              </Pressable>
            </View>
          ))
        )}
      </ScrollView>
    </View>
  )
}

const styles = StyleSheet.create({
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space.lg,
    paddingBottom: space.sm,
  },
  backBtn: {
    width: MIN_TAP_TARGET,
    height: MIN_TAP_TARGET,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  empty: { padding: space.lg, borderRadius: radius.xl },
  newBtn: {
    marginTop: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.lg,
    borderRadius: radius.lg,
    marginBottom: space.sm,
    minHeight: MIN_TAP_TARGET,
  },
  logBtn: {
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    minHeight: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  remove: { width: MIN_TAP_TARGET, height: MIN_TAP_TARGET, alignItems: 'center', justifyContent: 'center' },
})
