import * as ImagePicker from 'expo-image-picker'
import { router } from 'expo-router'
import { useState } from 'react'
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { PhysiqueEstimateZ, type PhysiqueEstimate } from '@nutai/core-schema'
import { cheapestModel, type ProviderId } from '@nutai/prompt'
import { Icon } from '../src/components/Icon'
import { logPhysique, setting } from '../src/data/repo'
import { loadCredential } from '../src/inference/credentials'
import { runPhysiqueEstimate } from '../src/inference/pathA/client'
import { preprocessPhoto } from '../src/media/preprocess'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Body photo — a rough visual body-fat estimate.
 *
 * Single screen, local state only: pick/take a photo, one model call, a
 * range-not-a-point result to save or discard. Unlike food scanning this needs
 * no background pipeline or global phase store — there is no ingredient list
 * to edit, no matching against a corpus, just one call and one honest range.
 *
 * Uses expo-image-picker rather than a second live CameraView screen — this is
 * a single still photo, not a live viewfinder with multiple capture modes.
 */

type Step =
  | { kind: 'idle' }
  | { kind: 'analyzing'; photoUri: string }
  | { kind: 'ready'; photoUri: string; estimate: PhysiqueEstimate; provider: string; model: string }
  | { kind: 'failed'; photoUri: string; message: string }

export default function BodyScan() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [step, setStep] = useState<Step>({ kind: 'idle' })
  const [saving, setSaving] = useState(false)

  async function pick(source: 'camera' | 'library') {
    const perm =
      source === 'camera'
        ? await ImagePicker.requestCameraPermissionsAsync()
        : await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) return

    const result =
      source === 'camera'
        ? await ImagePicker.launchCameraAsync({ quality: 1, allowsEditing: false })
        : await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsEditing: false })
    if (result.canceled || !result.assets?.[0]?.uri) return

    void analyze(result.assets[0].uri)
  }

  async function analyze(photoUri: string) {
    setStep({ kind: 'analyzing', photoUri })

    const provider = (await setting('provider')) as ProviderId | 'none' | ''
    if (!provider || provider === 'none') {
      setStep({ kind: 'failed', photoUri, message: 'Body photo estimates need an API key. Add one in Profile.' })
      return
    }
    const credential = await loadCredential(provider)
    if (!credential) {
      setStep({ kind: 'failed', photoUri, message: 'Your saved key is missing. Re-enter it in Profile.' })
      return
    }
    const model = (await setting('provider_model')) || cheapestModel(provider).id

    let base64: string
    try {
      base64 = await preprocessPhoto(photoUri)
    } catch {
      setStep({ kind: 'failed', photoUri, message: 'Could not read that photo. Try again.' })
      return
    }

    const outcome = await runPhysiqueEstimate(provider, { model, imageBase64: base64 }, credential)
    if (!outcome.ok) {
      setStep({ kind: 'failed', photoUri, message: outcome.error?.message ?? 'The estimate failed.' })
      return
    }

    const parsed = PhysiqueEstimateZ.safeParse(outcome.raw)
    if (!parsed.success) {
      setStep({ kind: 'failed', photoUri, message: 'The model answered in a shape we could not use. Try once more.' })
      return
    }
    if (!parsed.data.is_person) {
      setStep({ kind: 'failed', photoUri, message: parsed.data.refusal_reason || 'That photo does not clearly show a person.' })
      return
    }

    setStep({ kind: 'ready', photoUri, estimate: parsed.data, provider, model })
  }

  async function save() {
    if (step.kind !== 'ready' || saving) return
    setSaving(true)
    const e = step.estimate
    await logPhysique(
      {
        photoUri: step.photoUri,
        bodyFatPctLow: e.body_fat_pct_low,
        bodyFatPctHigh: e.body_fat_pct_high,
        bodyFatPctEstimate: e.body_fat_pct_estimate,
        confidence: e.confidence,
        caveats: e.caveats,
        provider: step.provider,
        model: step.model,
      },
      Date.now(),
    )
    router.back()
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
        <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>Body photo</Text>
        <View style={{ width: 44 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: space.lg, paddingBottom: 140 }}>
        {step.kind === 'idle' ? (
          <>
            <Text style={[type.title, { color: theme.text, fontSize: 26, marginTop: space.lg }]}>
              A rough body-fat estimate
            </Text>
            <Text style={[type.body, { color: theme.textMuted, marginTop: space.sm, lineHeight: 22 }]}>
              Take or choose a clear, well-lit photo. The AI gives a range, not a precise number —
              this is a visual read, not a body-composition measurement.
            </Text>

            <Pressable onPress={() => void pick('camera')} style={[styles.optionCard, { backgroundColor: theme.bgSunken }]}>
              <Icon name="scan" size={24} color={theme.text} />
              <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>Take a photo</Text>
            </Pressable>
            <Pressable onPress={() => void pick('library')} style={[styles.optionCard, { backgroundColor: theme.bgSunken, marginTop: space.md }]}>
              <Icon name="bookmark" size={24} color={theme.text} />
              <Text style={[type.bodyStrong, { color: theme.text, fontSize: 17 }]}>Choose from library</Text>
            </Pressable>
          </>
        ) : null}

        {step.kind === 'analyzing' ? (
          <View style={{ alignItems: 'center', marginTop: space.xxl }}>
            <ActivityIndicator color={theme.textMuted} />
            <Text style={[type.heading, { color: theme.text, marginTop: space.lg }]}>Analyzing…</Text>
          </View>
        ) : null}

        {step.kind === 'failed' ? (
          <View style={{ alignItems: 'center', marginTop: space.xxl }}>
            <Text style={[type.heading, { color: theme.text, textAlign: 'center' }]}>Could not estimate this</Text>
            <Text style={[type.caption, { color: theme.textMuted, marginTop: space.sm, textAlign: 'center', lineHeight: 19 }]}>
              {step.message}
            </Text>
            <Pressable onPress={() => setStep({ kind: 'idle' })} style={{ marginTop: space.xl }}>
              <Text style={[type.body, { color: theme.protein }]}>Try again</Text>
            </Pressable>
          </View>
        ) : null}

        {step.kind === 'ready' ? (
          <>
            <View style={{ alignItems: 'center', marginTop: space.lg }}>
              <Text style={[type.hero, { color: theme.text, fontSize: 44 }]}>
                {step.estimate.body_fat_pct_low != null && step.estimate.body_fat_pct_high != null
                  ? `${Math.round(step.estimate.body_fat_pct_low)}–${Math.round(step.estimate.body_fat_pct_high)}%`
                  : '—'}
              </Text>
              <Text style={[type.caption, { color: theme.textMuted, marginTop: space.xs }]}>
                estimated body fat · {step.estimate.confidence} confidence
              </Text>
            </View>

            {step.estimate.visual_markers.length > 0 ? (
              <View style={[styles.card, { backgroundColor: theme.bgSunken, marginTop: space.xl }]}>
                <Text style={[type.label, { color: theme.textMuted }]}>What informed this</Text>
                {step.estimate.visual_markers.map((m) => (
                  <Text key={m} style={[type.body, { color: theme.text, marginTop: space.sm }]}>
                    · {m}
                  </Text>
                ))}
              </View>
            ) : null}

            <View style={[styles.card, { backgroundColor: theme.uncertainBg, marginTop: space.md }]}>
              {step.estimate.caveats.map((c) => (
                <Text key={c} style={[type.caption, { color: theme.uncertain, lineHeight: 19, marginTop: space.xs }]}>
                  {c}
                </Text>
              ))}
            </View>
          </>
        ) : null}
      </ScrollView>

      {step.kind === 'ready' ? (
        <View style={[styles.actions, { paddingBottom: Math.max(insets.bottom, space.lg), backgroundColor: theme.bg, borderColor: theme.border }]}>
          <View style={{ flexDirection: 'row', gap: space.md }}>
            <Pressable onPress={() => setStep({ kind: 'idle' })} style={[styles.secondary, { borderColor: theme.border }]}>
              <Text style={[type.bodyStrong, { color: theme.text }]}>Discard</Text>
            </Pressable>
            <Pressable
              disabled={saving}
              onPress={() => void save()}
              style={[styles.primary, { flex: 1, backgroundColor: theme.text }, saving && { opacity: 0.6 }]}
            >
              <Text style={[type.bodyStrong, { color: theme.bg }]}>{saving ? 'Saving…' : 'Save to Progress'}</Text>
            </Pressable>
          </View>
        </View>
      ) : null}
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
  optionCard: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.lg,
    padding: space.lg,
    borderRadius: radius.lg,
    minHeight: 64,
    marginTop: space.xl,
  },
  card: { padding: space.lg, borderRadius: radius.lg },
  actions: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  secondary: {
    paddingHorizontal: space.xl,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
    borderWidth: 1,
  },
  primary: {
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
  },
})
