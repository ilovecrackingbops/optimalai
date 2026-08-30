import { CameraView, useCameraPermissions } from 'expo-camera'
import { Image } from 'expo-image'
import * as ImagePicker from 'expo-image-picker'
import { router } from 'expo-router'
import { useRef, useState } from 'react'
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { Icon, type IconName } from '../src/components/Icon'
import { startBarcodeScan, startLabelScan, startReceiptScan, startScan } from '../src/scan/orchestrator'
import { setPhase } from '../src/scan/store'
import { useTheme } from '../src/theme/ThemeProvider'
import { MIN_TAP_TARGET, radius, space, type } from '../src/theme/tokens'

type CameraMode = 'food' | 'barcode' | 'label' | 'receipt'

const MODES: Array<{ id: CameraMode; label: string; icon: IconName }> = [
  { id: 'food', label: 'Scan food', icon: 'scan' },
  { id: 'barcode', label: 'Barcode', icon: 'barcode' },
  { id: 'label', label: 'Label', icon: 'nutritionLabel' },
  { id: 'receipt', label: 'Receipt', icon: 'receipt' },
]

/**
 * Capture.
 *
 * SPEC-accuracy-engine.md §1.1 stages 0 and 1.
 *
 * THE SHUTTER ALWAYS SUCCEEDS. It writes a draft row before anything else can
 * fail — no key, no network, no model, no permission to analyze. A capture that
 * fails because the network is down loses the user's meal, and losing a meal is
 * unrecoverable in a way that a wrong number never is.
 *
 * Everything after the shutter — preprocessing, the model call, the pipeline —
 * lives in src/scan/orchestrator.ts and runs behind the result screen's
 * progress states. This screen's whole job is to hand off and get out of the
 * way fast.
 */
export default function Camera() {
  const theme = useTheme()
  const insets = useSafeAreaInsets()
  const [permission, requestPermission] = useCameraPermissions()
  const cameraRef = useRef<CameraView>(null)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<CameraMode>('food')
  // Barcode frames arrive continuously; only the FIRST detection may fire.
  const barcodeFired = useRef(false)
  // Food-mode only: the captured photo waiting on an optional typed note before
  // it is handed to the model. Every other mode hands off immediately.
  const [describeUri, setDescribeUri] = useState<string | null>(null)
  const [note, setNote] = useState('')

  if (!permission) return <View style={{ flex: 1, backgroundColor: '#000' }} />

  if (!permission.granted) {
    return (
      <View style={[styles.center, { backgroundColor: theme.bg, paddingTop: insets.top }]}>
        <Text style={[type.heading, { color: theme.text, textAlign: 'center' }]}>
          Optimal AI needs your camera
        </Text>
        <Text style={[type.caption, { color: theme.textMuted, textAlign: 'center', marginTop: space.sm }]}>
          Photos stay on your device unless you chose a cloud provider during setup.
        </Text>
        <Pressable
          onPress={requestPermission}
          style={[styles.primary, { backgroundColor: theme.text, marginTop: space.xl }]}
        >
          <Text style={[type.bodyStrong, { color: theme.bg }]}>Allow camera</Text>
        </Pressable>
        <Pressable onPress={() => router.back()} hitSlop={space.md} style={{ marginTop: space.lg }}>
          <Text style={[type.body, { color: theme.textMuted }]}>Not now</Text>
        </Pressable>
      </View>
    )
  }

  /** Shared by the shutter and the library picker — same handoff either way. */
  function handlePhoto(uri: string) {
    // The draft exists from this moment. Everything after can fail safely.
    setPhase({ kind: 'captured', photoUri: uri })

    if (mode === 'label') {
      router.replace('/result')
      void startLabelScan(uri)
      return
    }
    if (mode === 'receipt') {
      router.replace('/result')
      void startReceiptScan(uri)
      return
    }
    // Food mode: pause for an optional typed note before handing off — it
    // measurably disambiguates the model's read of the photo. Skippable, so
    // it never slows down someone who has nothing to add.
    setDescribeUri(uri)
  }

  async function capture() {
    if (busy) return
    setBusy(true)
    try {
      const shot = await cameraRef.current?.takePictureAsync({ quality: 1, skipProcessing: false })
      if (!shot?.uri) return
      handlePhoto(shot.uri)
    } finally {
      setBusy(false)
    }
  }

  async function pickFromLibrary() {
    if (busy) return
    const perm = await ImagePicker.requestMediaLibraryPermissionsAsync()
    if (!perm.granted) return
    setBusy(true)
    try {
      const result = await ImagePicker.launchImageLibraryAsync({ quality: 1, allowsEditing: false })
      if (result.canceled || !result.assets?.[0]?.uri) return
      handlePhoto(result.assets[0].uri)
    } finally {
      setBusy(false)
    }
  }

  function continueFoodScan(noteOverride?: string) {
    const uri = describeUri
    if (!uri) return
    setDescribeUri(null)
    const trimmed = (noteOverride ?? note).trim()
    setNote('')
    // Navigate NOW. Preprocessing, the model call and the pipeline all run
    // behind the result screen's progress states — the user never stares at
    // a frozen screen wondering whether the shutter worked.
    router.replace('/result')
    void startScan(uri, trimmed || undefined)
  }

  function onBarcode(data: string) {
    if (barcodeFired.current || !data) return
    barcodeFired.current = true
    router.replace('/result')
    void startBarcodeScan(data)
  }

  return (
    <View style={{ flex: 1, backgroundColor: '#000' }}>
      <CameraView
        ref={cameraRef}
        style={StyleSheet.absoluteFill}
        facing="back"
        barcodeScannerSettings={{ barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e'] }}
        onBarcodeScanned={mode === 'barcode' ? ({ data }) => onBarcode(data) : undefined}
      />

      <View style={[styles.controls, { paddingBottom: Math.max(insets.bottom, space.xl) }]}>
        <View style={styles.modeRow}>
          {MODES.map((m) => {
            const active = mode === m.id
            return (
              <Pressable
                key={m.id}
                accessibilityRole="button"
                accessibilityLabel={m.label}
                onPress={() => {
                  barcodeFired.current = false
                  setMode(m.id)
                }}
                style={[styles.modePill, active && styles.modePillActive]}
              >
                <Icon name={m.icon} size={18} color={active ? '#000' : '#fff'} />
                <Text style={[type.label, { color: active ? '#000' : '#fff' }]}>{m.label}</Text>
              </Pressable>
            )
          })}
        </View>

        {mode === 'barcode' ? (
          <Text style={[type.caption, styles.hint]}>Point at the barcode — it scans on its own</Text>
        ) : (
          <View style={styles.shutterRow}>
            <View style={{ width: 52 }} />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take photo"
              onPress={capture}
              disabled={busy}
              style={[styles.shutter, busy && { opacity: 0.5 }]}
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose from photo library"
              onPress={() => void pickFromLibrary()}
              disabled={busy}
              style={[styles.libraryBtn, busy && { opacity: 0.5 }]}
            >
              <Icon name="bookmark" size={22} color="#fff" />
            </Pressable>
          </View>
        )}
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Close"
        onPress={() => router.back()}
        hitSlop={space.md}
        style={[styles.close, { top: insets.top + space.md }]}
      >
        <Text style={{ color: '#fff', fontSize: 22 }}>×</Text>
      </Pressable>

      {describeUri ? (
        <View style={[styles.describeOverlay, { paddingTop: insets.top + space.xl, paddingBottom: Math.max(insets.bottom, space.xl) }]}>
          <Image source={{ uri: describeUri }} style={styles.describePhoto} />
          <Text style={[type.heading, { color: '#fff', marginTop: space.xl }]}>Add a note?</Text>
          <Text style={[type.caption, styles.hint, { paddingVertical: space.xs }]}>
            Optional — a rough weight or what's under the sauce helps the AI a lot
          </Text>
          <TextInput
            autoFocus
            placeholder="e.g. about 300g of rice, chicken breast not thigh"
            placeholderTextColor="rgba(255,255,255,0.5)"
            value={note}
            onChangeText={setNote}
            onSubmitEditing={() => continueFoodScan()}
            returnKeyType="done"
            style={styles.describeInput}
          />
          <View style={{ flex: 1 }} />
          <Pressable
            accessibilityRole="button"
            onPress={() => continueFoodScan()}
            style={[styles.primary, { backgroundColor: '#fff' }]}
          >
            <Text style={[type.bodyStrong, { color: '#000' }]}>{note.trim() ? 'Add & scan' : 'Scan'}</Text>
          </Pressable>
          <Pressable
            onPress={() => continueFoodScan('')}
            hitSlop={space.md}
            style={{ alignSelf: 'center', marginTop: space.md }}
          >
            <Text style={[type.body, { color: 'rgba(255,255,255,0.8)' }]}>Skip</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  )
}

const styles = StyleSheet.create({
  center: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: space.xl },
  describeOverlay: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    backgroundColor: 'rgba(0,0,0,0.92)',
    paddingHorizontal: space.lg,
  },
  describePhoto: { width: 96, height: 96, borderRadius: radius.lg, alignSelf: 'center' },
  describeInput: {
    marginTop: space.lg,
    borderWidth: 1,
    borderColor: 'rgba(255,255,255,0.3)',
    borderRadius: radius.md,
    padding: space.md,
    minHeight: 56,
    fontSize: 16,
    color: '#fff',
  },
  primary: {
    paddingHorizontal: space.xl,
    paddingVertical: space.md,
    borderRadius: radius.pill,
    minHeight: MIN_TAP_TARGET,
    justifyContent: 'center',
  },
  controls: { position: 'absolute', left: 0, right: 0, bottom: 0, alignItems: 'center', gap: space.lg },
  shutterRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center', gap: space.xl },
  libraryBtn: {
    width: 52,
    height: 52,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // 2x2 — four pills in one row overflow both screen edges on every iPhone.
  modeRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space.sm,
    paddingHorizontal: space.lg,
    justifyContent: 'center',
    alignSelf: 'stretch',
  },
  modePill: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: space.xs,
    width: '47%',
    paddingVertical: space.sm,
    borderRadius: radius.md,
    backgroundColor: 'rgba(0,0,0,0.45)',
    minHeight: MIN_TAP_TARGET,
  },
  modePillActive: { backgroundColor: '#fff' },
  hint: { color: 'rgba(255,255,255,0.85)', paddingVertical: space.lg },
  shutter: {
    width: 74,
    height: 74,
    borderRadius: radius.pill,
    backgroundColor: '#fff',
    borderWidth: 4,
    borderColor: 'rgba(255,255,255,0.4)',
  },
  close: {
    position: 'absolute',
    left: space.lg,
    width: MIN_TAP_TARGET,
    height: MIN_TAP_TARGET,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(0,0,0,0.45)',
    alignItems: 'center',
    justifyContent: 'center',
  },
})
