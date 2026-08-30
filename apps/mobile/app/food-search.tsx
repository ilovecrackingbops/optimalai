import { router } from 'expo-router'
import { useEffect, useMemo, useState } from 'react'
import {
  ActivityIndicator,
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
import type { DbAdapter } from '@nutai/db-adapter'
import { resolveByText, type ScoredCandidate } from '@nutai/resolver'
import { nutritionCorpusInfo, openNutritionDb } from '../src/db/expo-adapter'
import { db as userDb } from '../src/data/repo'
import { resolveSelection } from '../src/data/food-search-select'
import { logManualFood } from '../src/data/manual-food'
import type { ManualFoodSelection } from '../src/data/manual-food'
import { Icon } from '../src/components/Icon'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

/**
 * Foods — the library that replaces the incumbent's `Groups` social feed.
 *
 * Right now it is also the honest way to test the whole resolution stack on
 * device WITHOUT an API key: type a food, and the query runs through the real
 * `@nutai/resolver` — FTS5 candidate generation, six-signal scoring, the two-part
 * auto-accept rule — against the real 7,928-row USDA corpus. Everything here is
 * local. No network request is made by this screen, ever.
 *
 * Tapping a result does NOT log it immediately — it resolves the food's
 * snapshot (`resolveSelection`) and opens a confirm panel so the portion can
 * be adjusted BEFORE anything is written. Logging without that step meant
 * every manually-added food landed at whatever the FNDDS default portion
 * happened to be, with no chance to say "actually I had 150 g, not 85."
 */
export default function FoodSearch() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()

  const [db, setDb] = useState<DbAdapter | null>(null)
  const [corpus, setCorpus] = useState<{ foods: number; portions: number; builtAt: string | null } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScoredCandidate[]>([])
  const [outcome, setOutcome] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const [pending, setPending] = useState<ManualFoodSelection | null>(null)
  const [gramsText, setGramsText] = useState('')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const handle = await openNutritionDb()
      const info = await nutritionCorpusInfo(handle)
      if (!alive) return
      setDb(handle)
      setCorpus(info)
    })()
    return () => { alive = false }
  }, [])

  useEffect(() => {
    if (!db || query.trim().length < 2) { setResults([]); setOutcome(''); return }
    let alive = true
    setBusy(true)
    const timer = setTimeout(async () => {
      const r = await resolveByText(
        db,
        {
          canonicalFoodKey: query,
          observedBrand: null,
          prepFacet: null,
          modelCategory: null,
          estimatedGrams: 150,
        },
        // A search screen shows a ranked list, not a 5-item multiple-choice
        // chip sheet — `candidates` is always the full ranked list regardless
        // of outcome, so a confident top match still shows its runners-up.
        30,
      )
      if (!alive) return
      setResults(r.candidates)
      if (r.outcome.kind === 'auto_accept') {
        setOutcome(`Best match: ${r.outcome.match.name}`)
      } else if (r.candidates.length > 0) {
        setOutcome(`${r.candidates.length} result${r.candidates.length === 1 ? '' : 's'}`)
      } else {
        setOutcome('no match — this would log as an AI estimate')
      }
      setBusy(false)
    }, 180)
    return () => { alive = false; clearTimeout(timer) }
  }, [db, query])

  async function openConfirm(candidate: ScoredCandidate) {
    if (!db || resolvingId != null) return
    setResolvingId(candidate.foodId)
    setError(null)
    try {
      const selection = await resolveSelection(db, candidate)
      setPending(selection)
      setGramsText(String(Math.round(selection.grams)))
    } catch {
      setError('Could not load that food — try again.')
    } finally {
      setResolvingId(null)
    }
  }

  async function confirmAdd() {
    if (!pending || saving) return
    const grams = Number.parseFloat(gramsText)
    if (!Number.isFinite(grams) || grams <= 0) return
    setSaving(true)
    try {
      const h = await userDb()
      await logManualFood(h, { ...pending, grams }, Date.now())
      Keyboard.dismiss()
      router.back()
    } catch {
      setError('Could not log that food — try again.')
      setSaving(false)
    }
  }

  const corpusLine = useMemo(() => {
    if (!corpus) return 'Loading corpus…'
    if (corpus.foods === 0) {
      return 'Corpus missing — the app bundled without nutrition.db. Run `npm run data:build`.'
    }
    return `${corpus.foods.toLocaleString()} foods · ${corpus.portions.toLocaleString()} portion weights · USDA, CC0`
  }, [corpus])

  const previewGrams = Number.parseFloat(gramsText)
  const previewScale = pending && Number.isFinite(previewGrams) && previewGrams > 0 ? previewGrams / 100 : 0
  const previewKcal = pending ? Math.round(pending.nutrientSnapshot.kcal * previewScale) : 0
  const previewProtein = pending ? Math.round(pending.nutrientSnapshot.protein_g * previewScale) : 0
  const previewCarbs = pending ? Math.round(pending.nutrientSnapshot.carbs_g * previewScale) : 0
  const previewFat = pending ? Math.round(pending.nutrientSnapshot.fat_g * previewScale) : 0
  const gramsValid = Number.isFinite(previewGrams) && previewGrams > 0

  return (
    <View style={{ flex: 1, backgroundColor: theme.bg }}>
      <ScrollView
        style={{ backgroundColor: theme.bg }}
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ padding: space.lg, paddingTop: insets.top + space.lg, paddingBottom: 160 }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <Text style={[type.title, { color: theme.text }]}>Food Database</Text>
          <Pressable accessibilityRole="button" onPress={() => router.back()} hitSlop={space.md}>
            <Text style={[type.body, { color: theme.textMuted }]}>Done</Text>
          </Pressable>
        </View>
        <Text style={[type.caption, { color: corpus?.foods === 0 ? theme.safety : theme.textMuted, marginTop: space.xs }]}>
          {corpusLine}
        </Text>

        <TextInput
          accessibilityLabel="Search foods"
          placeholder="Search — try “chicken breast”"
          placeholderTextColor={theme.textFaint}
          value={query}
          onChangeText={setQuery}
          autoCorrect={false}
          autoCapitalize="none"
          style={[styles.input, { color: theme.text, borderColor: theme.border, backgroundColor: theme.bgSunken }]}
        />

        {busy && <ActivityIndicator style={{ marginTop: space.lg }} color={theme.textFaint} />}

        {outcome !== '' && (
          <Text style={[type.micro, { color: theme.textFaint, marginTop: space.md }]}>{outcome.toUpperCase()}</Text>
        )}

        {error != null && (
          <Text style={[type.caption, { color: theme.safety, marginTop: space.md }]}>{error}</Text>
        )}

        {results.map((r) => (
          <Pressable
            key={r.foodId}
            testID={`food-search-row-${r.foodId}`}
            accessibilityRole="button"
            accessibilityLabel={`${r.name}, adjust portion and add`}
            disabled={resolvingId != null}
            onPress={() => void openConfirm(r)}
            style={({ pressed }) => [
              styles.row,
              { borderColor: theme.border, minHeight: MIN_TAP_TARGET, opacity: pressed ? 0.6 : 1 },
            ]}
          >
            <View style={{ flex: 1 }}>
              <Text style={[type.body, { color: theme.text }]} numberOfLines={2}>{r.name}</Text>
              <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>
                {r.energyKcal != null ? `${Math.round(r.energyKcal)} kcal / 100 g` : 'energy not reported'}
                {r.brand ? ` · ${r.brand}` : ''}
              </Text>
            </View>
            {resolvingId === r.foodId ? (
              <ActivityIndicator color={theme.textFaint} />
            ) : (
              <Icon name="chevron" size={16} color={theme.textFaint} />
            )}
          </Pressable>
        ))}

        {query.trim().length >= 2 && !busy && results.length === 0 && (
          <Text style={[type.caption, { color: theme.textMuted, marginTop: space.lg }]}>
            Nothing matched. That is not a failure — it logs as an AI estimate with an amber badge,
            and you can save it as your own food so it resolves instantly next time.
          </Text>
        )}
      </ScrollView>

      {pending ? (
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={[styles.confirmOverlay, { backgroundColor: theme.bg, paddingTop: insets.top + space.lg }]}
        >
          <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
            <Text style={[type.title, { color: theme.text, fontSize: 22, flex: 1 }]} numberOfLines={2}>
              {pending.displayName}
            </Text>
            <Pressable
              accessibilityRole="button"
              onPress={() => { Keyboard.dismiss(); setPending(null) }}
              hitSlop={space.md}
              style={{ marginLeft: space.md }}
            >
              <Text style={[type.body, { color: theme.textMuted }]}>Cancel</Text>
            </Pressable>
          </View>

          <Text style={[type.label, { color: theme.textMuted, marginTop: space.xl }]}>Amount (grams)</Text>
          <TextInput
            autoFocus
            keyboardType="decimal-pad"
            value={gramsText}
            onChangeText={setGramsText}
            selectTextOnFocus
            style={[styles.gramsInput, { color: theme.text, borderColor: theme.border }]}
          />

          <View style={[styles.previewRow, { borderColor: theme.border }]}>
            <PreviewStat label="Calories" value={gramsValid ? String(previewKcal) : '—'} />
            <PreviewStat label="Protein" value={gramsValid ? `${previewProtein}g` : '—'} />
            <PreviewStat label="Carbs" value={gramsValid ? `${previewCarbs}g` : '—'} />
            <PreviewStat label="Fat" value={gramsValid ? `${previewFat}g` : '—'} />
          </View>

          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            disabled={!gramsValid || saving}
            onPress={() => void confirmAdd()}
            style={[
              styles.primary,
              { backgroundColor: gramsValid ? theme.text : theme.border, marginBottom: Math.max(insets.bottom, space.lg) },
            ]}
          >
            <Text style={[type.bodyStrong, { color: theme.bg, fontSize: 18 }]}>
              {saving ? 'Adding…' : 'Add to log'}
            </Text>
          </Pressable>
        </KeyboardAvoidingView>
      ) : null}
    </View>
  )
}

function PreviewStat({ label, value }: { label: string; value: string }) {
  const theme = useTheme()
  return (
    <View style={{ flex: 1, alignItems: 'center' }}>
      <Text style={[type.bodyStrong, { color: theme.text, fontSize: 18 }]}>{value}</Text>
      <Text style={[type.caption, { color: theme.textMuted, marginTop: 2 }]}>{label}</Text>
    </View>
  )
}

const styles = StyleSheet.create({
  input: {
    marginTop: space.lg,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    fontSize: 16,
    minHeight: 48,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.md,
    paddingVertical: space.md,
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  confirmOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    paddingHorizontal: space.lg,
  },
  gramsInput: {
    marginTop: space.sm,
    paddingHorizontal: space.lg,
    paddingVertical: space.md,
    borderRadius: radius.md,
    borderWidth: 1.5,
    fontSize: 28,
    fontWeight: '800',
    minHeight: 64,
  },
  previewRow: {
    flexDirection: 'row',
    marginTop: space.xl,
    paddingTop: space.lg,
    borderTopWidth: StyleSheet.hairlineWidth,
  },
  primary: {
    paddingVertical: space.md,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: MIN_TAP_TARGET,
  },
})
