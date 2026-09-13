import { router, useLocalSearchParams } from 'expo-router'
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
import { ladderStepWords, rankForSearch, resolveByTextForSearch, type ScoredCandidate, type ScoringContext } from '@nutai/resolver'
import { nutritionCorpusInfo, openNutritionDb } from '../src/db/expo-adapter'
import { atDate, db as userDb } from '../src/data/repo'
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

/**
 * "Beef tendon" isn't in this corpus at all (a real data gap, not a ranking
 * bug) — `resolveByTextForSearch` drops "tendon" and searches "beef" alone
 * instead. Without this note, that reads as the app ignoring half of what
 * was typed and showing arbitrary beef cuts; with it, the honest thing that
 * actually happened is visible instead of silently assumed.
 */
function broadenedNote(query: string, droppedWords: readonly string[]): string {
  if (droppedWords.length === 0) return ''
  const kept = ladderStepWords(query, 0).filter((w) => !droppedWords.includes(w))
  if (kept.length === 0) {
    return ' — no single food matched every word, showing partial matches'
  }
  return ` — no match for "${droppedWords.join(', ')}", showing "${kept.join(' ')}" instead`
}
export default function FoodSearch() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const { forDate } = useLocalSearchParams<{ forDate?: string }>()

  const [db, setDb] = useState<DbAdapter | null>(null)
  const [corpus, setCorpus] = useState<{ foods: number; portions: number; builtAt: string | null } | null>(null)
  const [query, setQuery] = useState('')
  const [results, setResults] = useState<ScoredCandidate[]>([])
  const [outcome, setOutcome] = useState<string>('')
  // Set whenever the corpus didn't have an exact match for the full phrase —
  // zero results, or a broadened search that had to drop some of what was
  // typed. Drives the "Describe it instead" offer rather than leaving
  // someone stuck scrolling results that aren't what they searched for.
  const [imperfectMatch, setImperfectMatch] = useState(false)
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
    if (!db || query.trim().length < 2) { setResults([]); setOutcome(''); setImperfectMatch(false); return }
    let alive = true
    setBusy(true)
    const timer = setTimeout(async () => {
      const ctx: ScoringContext = {
        canonicalFoodKey: query,
        observedBrand: null,
        prepFacet: null,
        modelCategory: null,
        estimatedGrams: 150,
      }
      const r = await resolveByTextForSearch(
        db,
        ctx,
        // MUST match (or exceed) the corpus's own candidate fetch limit
        // (2000) — asking for fewer here used to mean the ranking below only
        // ever got to reorder whichever handful the fetch already preferred,
        // and could never recover a plain, common row (a plain "Milk, whole"
        // search) that had been pushed past the cutoff. Asking for the full
        // pool and re-ranking it ourselves is what makes `rankForSearch`
        // actually decide the order.
        2000,
      )
      if (!alive) return
      // Re-ranked for "surface the food I actually typed" — the AI-scan
      // pipeline's composite score alone (tuned for auto-accept/disambiguate
      // decisions) let bm25's length penalty bury a plain "Milk, ..." row
      // under branded noise, and let "Sweet potato leaves" — a different
      // food that merely shares the phrase — outrank "Sweet potato" itself.
      const ranked = rankForSearch(r.candidates, ctx).slice(0, 40)
      setResults(ranked)
      setImperfectMatch(ranked.length === 0 || r.droppedWords.length > 0)
      if (ranked.length > 0) {
        setOutcome(`${ranked.length} result${ranked.length === 1 ? '' : 's'}${broadenedNote(query, r.droppedWords)}`)
      } else {
        setOutcome('no match in the database')
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
      await logManualFood(h, { ...pending, grams }, forDate ? atDate(forDate) : Date.now())
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
        keyboardDismissMode="on-drag"
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

        {imperfectMatch ? (
          <Pressable
            accessibilityRole="button"
            onPress={() =>
              router.push({
                pathname: '/log-food-text',
                params: forDate ? { prefill: query, forDate } : { prefill: query },
              } as never)
            }
            style={[styles.describeCta, { backgroundColor: theme.bgSunken, borderColor: theme.border }]}
          >
            <Icon name="pencil" size={16} color={theme.protein} />
            <Text style={[type.label, { color: theme.protein, flex: 1 }]}>
              Not in the database? Describe "{query}" instead
            </Text>
            <Icon name="chevron" size={14} color={theme.protein} />
          </Pressable>
        ) : null}

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
          {forDate ? (
            <Text style={[type.caption, { color: theme.protein, marginTop: space.xs }]}>
              Logging for {new Date(atDate(forDate)).toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' })}, not today
            </Text>
          ) : null}

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
  describeCta: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space.sm,
    marginTop: space.md,
    padding: space.md,
    borderRadius: radius.md,
    borderWidth: StyleSheet.hairlineWidth,
    minHeight: MIN_TAP_TARGET,
  },
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
