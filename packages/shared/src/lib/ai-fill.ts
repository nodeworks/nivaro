/**
 * AI fill per field (#2692): the placement override `ai_generate` —
 * `{ enabled, prompt }` — that puts an AI button on one field of one form.
 * Absent = the form-wide "AI generate buttons" switch decides as before.
 *
 * MIRROR: api/src/services/ai-design/field-fill.ts (AI_FILL_KEY, readAiFill,
 * promptTokens) — the server reads the prompt from the stored layout, never
 * from the client.
 */

export const AI_FILL_KEY = 'ai_generate'
export const PROMPT_MAX = 2000
const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export interface AiFillConfig {
  enabled: boolean
  prompt: string | null
}

export function readAiFill(overrides: unknown): AiFillConfig | null {
  let v: unknown = overrides
  for (let i = 0; i < 4 && typeof v === 'string'; i++) {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  const raw = (v as Record<string, unknown> | null)?.[AI_FILL_KEY]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const o = raw as Record<string, unknown>
  const prompt =
    typeof o.prompt === 'string' && o.prompt.trim() ? o.prompt.slice(0, PROMPT_MAX) : null
  return { enabled: o.enabled === true, prompt }
}

/** Field names a template names, in order, once each. */
export function promptTokens(prompt: string): string[] {
  const out: string[] = []
  for (const m of prompt.matchAll(TOKEN_RE)) if (!out.includes(m[1])) out.push(m[1])
  return out
}

/**
 * Does the record form show the AI button on this field? The field's own
 * setting wins; without one, the form-wide switch decides (eligible text
 * fields only, as before).
 */
/** Placement override `autofill_check` (#2691): ring the field when the form
 *  was filled from a document proposal. */
export const AUTOFILL_CHECK_KEY = 'autofill_check'

export function showsAiButton(
  overrides: unknown,
  layoutAiEnabled: boolean | undefined,
  eligible: boolean
): { show: boolean; perField: boolean } {
  const cfg = readAiFill(overrides)
  if (cfg) return { show: cfg.enabled && !!cfg.prompt, perField: true }
  return { show: eligible && !!layoutAiEnabled, perField: false }
}
