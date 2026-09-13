import { ANTHROPIC_OAUTH_BETA } from './providers.js'
import type { ProviderId, ProviderRequest } from './providers.js'

/**
 * The shared shape behind every "one image in, one JSON object out" call: the
 * label scanner and the receipt scanner. No tools, no structured-output mode —
 * the instruction demands bare JSON and the caller validates with Zod.
 */
export interface VisionJsonInput {
  model: string
  imageBase64: string
  instruction: string
  maxTokens?: number
}

/**
 * Text-only sibling of buildVisionJsonRequest — same transport, no image.
 * Used by the exercise Describe path and text-only food logging.
 *
 * `jsonSchema` is optional and, when passed, turns on the same provider
 * structured-output dialect the photo scan path uses (see providers.ts's
 * buildAnthropicRequest/buildOpenAIRequest/buildGeminiRequest) instead of the
 * bare `json_object` mode below. Plain `json_object` mode asks the model to
 * produce SOME JSON but enforces nothing about its shape, leaning entirely on
 * prompt-following — which is exactly where providers diverge most: the same
 * "4 raw eggs and 10g of liver" description that Claude gets right every
 * time can come back from GPT missing a required enum field or in a shape
 * the client-side Zod validator rejects outright. Structured-output mode
 * makes the PROVIDER responsible for conforming to the schema, closing that
 * gap without changing the prompt at all.
 */
export function buildTextJsonRequest(
  provider: ProviderId,
  input: { model: string; instruction: string; maxTokens?: number; jsonSchema?: unknown },
  credential: { kind: 'api_key' | 'oauth'; value: string },
  promptVersion: string,
): ProviderRequest {
  const maxTokens = input.maxTokens ?? 512
  const jsonSchema = input.jsonSchema ?? null

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
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: input.instruction }],
        ...(jsonSchema == null ? {} : { output_config: { format: { type: 'json_schema', schema: jsonSchema } } }),
      },
      promptVersion,
    }
  }

  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' },
      body: {
        model: input.model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: input.instruction }],
        response_format:
          jsonSchema == null
            ? { type: 'json_object' }
            : { type: 'json_schema', json_schema: { name: 'TextFoodLog', strict: true, schema: jsonSchema } },
      },
      promptVersion,
    }
  }

  return {
    url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(input.model)}:generateContent`,
    headers: { 'x-goog-api-key': credential.value, 'content-type': 'application/json' },
    body: {
      contents: [{ role: 'user', parts: [{ text: input.instruction }] }],
      generationConfig: {
        responseMimeType: 'application/json',
        ...(jsonSchema == null ? {} : { responseSchema: jsonSchema }),
        maxOutputTokens: maxTokens,
      },
    },
    promptVersion,
  }
}

export const EXERCISE_ESTIMATE_PROMPT_VERSION = 'exercise-estimate-v1'

export function buildExerciseEstimateInstruction(description: string, weightKg: number | null): string {
  return [
    `Estimate the calories burned by this workout, described by the user: "${description.trim()}"`,
    weightKg ? `The user weighs about ${Math.round(weightKg)} kg.` : 'Body weight unknown — assume 80 kg.',
    '',
    'Rules:',
    '- Use standard MET values for the activity and intensity described. Be conservative: when the description is ambiguous, choose the LOWER plausible figure. People overestimate exercise burn, and an inflated number here corrupts their daily budget.',
    '- duration_min from the description; null if none was given (and reflect that uncertainty by staying conservative).',
    '- label: a short title for the log, e.g. "Leg strength training".',
    '',
    'Respond with ONLY this JSON object:',
    '{"label": string, "duration_min": number|null, "calories_kcal": number}',
  ].join('\n')
}

export function buildVisionJsonRequest(
  provider: ProviderId,
  input: VisionJsonInput,
  credential: { kind: 'api_key' | 'oauth'; value: string },
  promptVersion: string,
): ProviderRequest {
  const maxTokens = input.maxTokens ?? 1024

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
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: input.imageBase64 } },
              { type: 'text', text: input.instruction },
            ],
          },
        ],
      },
      promptVersion,
    }
  }

  if (provider === 'openai') {
    return {
      url: 'https://api.openai.com/v1/chat/completions',
      headers: { authorization: `Bearer ${credential.value}`, 'content-type': 'application/json' },
      body: {
        model: input.model,
        max_tokens: maxTokens,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${input.imageBase64}` } },
              { type: 'text', text: input.instruction },
            ],
          },
        ],
        response_format: { type: 'json_object' },
      },
      promptVersion,
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
            { text: input.instruction },
          ],
        },
      ],
      generationConfig: { responseMimeType: 'application/json', maxOutputTokens: maxTokens },
    },
    promptVersion,
  }
}
