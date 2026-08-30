import { ANTHROPIC_OAUTH_BETA } from './providers.js'
import type { ProviderId, ProviderRequest } from './providers.js'

/**
 * Visual body-fat estimation from one photo.
 *
 * The instruction is explicit that this is a rough visual read, not a
 * measurement — the same "perception device, not a calculator" discipline the
 * food-scan prompt uses, applied to a domain where overclaiming precision is a
 * much bigger deal: a confidently-stated body-fat number that is wrong is not
 * just an inconvenience the way a miscounted calorie is.
 */
export const PHYSIQUE_ESTIMATE_PROMPT_VERSION = 'physique-estimate-v1'

export const PHYSIQUE_ESTIMATE_INSTRUCTION = [
  'You are looking at one photo someone took of their own body to track their physique',
  'over time. Give a ROUGH visual estimate of body-fat percentage. This is not a',
  'medical or diagnostic measurement — you cannot see subcutaneous fat directly, only',
  'infer it from visible markers like muscle definition, vascularity, and fat',
  'distribution — so you must report a RANGE, never a single confident number, and you',
  'must say so in caveats.',
  '',
  'Rules:',
  '- is_person: false if the photo does not clearly show enough of a human body to',
  '  assess (no person, face-only photo, too dark, too obscured by clothing). Give a',
  '  brief refusal_reason and leave every numeric field null in that case.',
  '- body_fat_pct_low / body_fat_pct_high: a plausible range, not a hedge so wide it is',
  '  useless. A clear, well-lit, minimal-clothing photo might support an 8-point range;',
  '  a partially clothed or poorly lit one deserves a wider range instead of false',
  '  precision.',
  '- body_fat_pct_estimate: the midpoint of that range.',
  '- confidence: "low" | "medium" | "high", based on photo quality, lighting, pose and',
  '  how much of the body is visible — NOT based on how lean the person appears.',
  '- visual_markers: specific things you actually see that informed the range, e.g.',
  '  "visible upper abdominal definition, less definition lower abdomen" or "limited',
  '  visible musculature, moderate fat distribution through midsection". Never vague',
  '  filler like "normal build".',
  '- caveats: at least one entry, and it MUST include that this is a rough visual',
  '  estimate, not a body-composition measurement (DEXA, BIA, calipers), and can be',
  '  off by several points either way. Add more if lighting, pose or clothing limited',
  '  what you could actually assess.',
  '',
  'Respond with ONLY this JSON object:',
  '{"is_person": boolean, "refusal_reason": string|null, "body_fat_pct_low": number|null, "body_fat_pct_high": number|null, "body_fat_pct_estimate": number|null, "confidence": "low"|"medium"|"high", "visual_markers": string[], "caveats": string[]}',
].join('\n')

export interface PhysiqueEstimateInput {
  model: string
  imageBase64: string
}

export function buildPhysiqueEstimateRequest(
  provider: ProviderId,
  input: PhysiqueEstimateInput,
  credential: { kind: 'api_key' | 'oauth'; value: string },
): ProviderRequest {
  if (provider === 'anthropic') {
    const headers: Record<string, string> =
      credential.kind === 'api_key'
        ? { 'x-api-key': credential.value, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }
        : {
            authorization: `Bearer ${credential.value}`,
            'anthropic-version': '2023-06-01',
            'anthropic-beta': ANTHROPIC_OAUTH_BETA,
            'content-type': 'application/json',
          }
    return {
      url: 'https://api.anthropic.com/v1/messages',
      headers,
      body: {
        model: input.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.imageBase64 } },
              { type: 'text', text: PHYSIQUE_ESTIMATE_INSTRUCTION },
            ],
          },
        ],
      },
      promptVersion: PHYSIQUE_ESTIMATE_PROMPT_VERSION,
    }
  }

  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' },
      body: {
        model: input.model,
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.imageBase64}` } },
              { type: 'text', text: PHYSIQUE_ESTIMATE_INSTRUCTION },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      },
      promptVersion: PHYSIQUE_ESTIMATE_PROMPT_VERSION,
    }
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
    headers: { 'x-goog-api-key': credential.value, 'content-type': 'application/json' },
    body: {
      contents: [
        {
          role: 'user',
          parts: [
            { inline_data: { mime_type: 'image/jpeg', data: input.imageBase64 } },
            { text: PHYSIQUE_ESTIMATE_INSTRUCTION },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: 1024 },
    },
    promptVersion: PHYSIQUE_ESTIMATE_PROMPT_VERSION,
  }
}
