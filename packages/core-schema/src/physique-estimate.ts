import { z } from 'zod'

/**
 * A visual body-fat estimate from one photo.
 *
 * Same honesty rule as everything else in this app: never a bare point number.
 * The model reports a RANGE and a confidence, and the app must render the
 * range, not just `body_fat_pct_estimate`. This is a rough visual read, not a
 * DEXA scan or a caliper measurement, and `caveats` exists so the model states
 * that itself rather than the app bolting a disclaimer onto a number that reads
 * as precise.
 */
export const PhysiqueEstimateZ = z.object({
  /** False if the photo does not show a person clearly enough to assess. */
  is_person: z.boolean(),
  /** Short, polite, specific. Null when is_person is true. */
  refusal_reason: z.string().nullable(),
  body_fat_pct_low: z.number().min(3).max(60).nullable(),
  body_fat_pct_high: z.number().min(3).max(60).nullable(),
  /** Midpoint of the range, for a single headline number. Never shown alone. */
  body_fat_pct_estimate: z.number().min(3).max(60).nullable(),
  confidence: z.enum(['low', 'medium', 'high']),
  /** What visually informed the estimate, e.g. "visible abdominal definition". */
  visual_markers: z.array(z.string()),
  /** Must always include that this is a rough visual estimate, not a measurement. */
  caveats: z.array(z.string()).min(1),
})
export type PhysiqueEstimate = z.infer<typeof PhysiqueEstimateZ>
