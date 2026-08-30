import { router } from 'expo-router'
import { useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon } from '../src/components/Icon'
import { startTextScan } from '../src/scan/orchestrator'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Describe a meal — no photo, no barcode. A free-text quick-add for when a
 * picture isn't practical, or as the fastest way to log something roughly
 * weighed out. iOS's own keyboard dictation mic works on this box for free,
 * which is the "voice" entry point — no separate recording pipeline needed.
 *
 * Submitting hands off to `startTextScan`, which produces the SAME shape a
 * photo scan does, so this lands on the ordinary `/result` review screen —
 * editable rows, confidence bands, everything a photo scan gets — rather than
 * saving blind.
 */
export default function LogFoodText() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [text, setText] = useState('')
  const [submitted, setSubmitted] = useState(false)

  function submit() {
    const desc = text.trim()
    if (!desc || submitted) return
    setSubmitted(true)
    router.replace('/result')
    void startTextScan(desc)
  }

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <View style={[styles.header, { paddingTop: insets.top + space.sm }]}>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close"
          onPress={() => router.back()}
          style={[styles.backBtn, { backgroundColor: theme.bgSunken }]}
        >
          <Text style={{ color: theme.text, fontSize: 22 }}>×</Text>
        </Pressable>
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>Describe a meal</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg }} keyboardShouldPersistTaps="handled">
        <TextInput
          autoFocus
          multiline
          placeholder="What did you eat? Roughly weighed out or not — either is fine."
          placeholderTextColor={theme.textFaint}
          value={text}
          onChangeText={setText}
          style={[styles.input, { color: theme.text, borderColor: theme.border }]}
        />

        <View style={[styles.aiPill, { borderColor: theme.border }]}>
          <Icon name="scan" size={14} color={theme.text} />
          <Text style={[type.label, { color: theme.text }]}>Estimated with your API key</Text>
        </View>

        <View style={[styles.example, { backgroundColor: theme.bgSunken }]}>
          <Text style={[type.body, { color: theme.textMuted, lineHeight: 22 }]}>
            <Text style={{ fontWeight: '700', color: theme.text }}>Examples:</Text> "About 300g grilled
            chicken breast with a cup of rice and some broccoli" or just "a bowl of cereal with milk".
            Tap the mic on the keyboard to say it instead of typing it.
          </Text>
        </View>
      </ScrollView>

      <View style={[styles.dock, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg }]}>
        <Pressable
          onPress={submit}
          disabled={!text.trim() || submitted}
          style={[styles.cta, { backgroundColor: text.trim() && !submitted ? theme.text : theme.border }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>
            {submitted ? 'Analyzing…' : 'Log it'}
          </Text>
        </Pressable>
      </View>
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
  input: {
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    fontSize: 17,
    minHeight: 120,
    textAlignVertical: 'top',
  },
  aiPill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.xs,
    alignSelf: 'flex-start',
    paddingHorizontal: space.md,
    paddingVertical: space.sm,
    borderRadius: radius.pill,
    borderWidth: 1.5,
    marginTop: space.lg,
  },
  example: { marginTop: space.lg, padding: space.lg, borderRadius: radius.lg },
  dock: { position: 'absolute', left: 0, right: 0, bottom: 0, padding: space.lg },
  cta: { height: 60, borderRadius: radius.pill, alignItems: 'center', justifyContent: 'center' },
})
