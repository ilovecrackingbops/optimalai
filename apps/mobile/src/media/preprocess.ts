import * as ImageManipulator from 'expo-image-manipulator'

/**
 * Resize + JPEG-encode a captured photo to base64, ready for a vision API call.
 * Resize BEFORE encoding — the order is what bounds memory, not the format.
 *
 * Shared by the food-scan orchestrator and the body-scan screen: identical
 * requirement, one implementation.
 */
export async function preprocessPhoto(photoUri: string): Promise<string> {
  const ctx = ImageManipulator.ImageManipulator.manipulate(photoUri)
  ctx.resize({ width: 1024 })
  const image = await ctx.renderAsync()
  const saved = await image.saveAsync({
    compress: 0.8,
    format: ImageManipulator.SaveFormat.JPEG,
    base64: true,
  })
  if (!saved.base64) throw new Error('preprocess produced no base64')
  return saved.base64
}
