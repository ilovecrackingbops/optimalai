import { Image } from 'expo-image'
import { router, useFocusEffect } from 'expo-router'
import { useCallback, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import { physiqueHistory, type PhysiqueEntry } from '../src/data/repo'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Body composition history — every logged photo, newest first, with the
 * estimate that went with it. `physiqueHistory()` already existed and fed a
 * single "latest photo" preview on Progress; this is the screen that shows
 * the rest of them instead of leaving them queryable-but-invisible.
 */
export default function BodyHistory() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [entries, setEntries] = useState<PhysiqueEntry[]>([])

  useFocusEffect(
    useCallback(() => {
      let alive = true
      void physiqueHistory().then((rows) => {
        if (alive) setEntries([...rows].reverse())
      })
      return () => {
        alive = false
      }
    }, []),
  )

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
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>Body composition</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => router.push('/body-scan' as never)}
          hitSlop={space.sm}
        >
          <Icon name="scan" size={22} color={theme.text} />
        </Pressable>
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        {entries.length === 0 ? (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xl, textAlign: 'center' }]}>
            No body photos yet.
          </Text>
        ) : (
          entries.map((e) => (
            <View key={e.id} style={[styles.row, { backgroundColor: theme.bgSunken }]}>
              <Image source={{ uri: e.photoUri }} style={styles.thumb} />
              <View style={{ flex: 1 }}>
                <Text style={[type.bodyStrong, { color: theme.text }]}>
                  {e.bodyFatPctLow != null && e.bodyFatPctHigh != null
                    ? `${Math.round(e.bodyFatPctLow)}–${Math.round(e.bodyFatPctHigh)}% body fat`
                    : 'No estimate'}
                </Text>
                <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
                  {e.localDate} · {e.confidence ?? 'unknown'} confidence
                </Text>
                {e.caveats.length > 0 ? (
                  <Text style={[type.micro, { color: theme.textFaint, marginTop: 4 }]} numberOfLines={2}>
                    {e.caveats[0]}
                  </Text>
                ) : null}
              </View>
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    padding: space.md,
    borderRadius: radius.lg,
    marginBottom: space.sm,
  },
  thumb: { width: 64, height: 64, borderRadius: radius.md },
})
