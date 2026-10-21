import { cleanText } from './model.js'

/**
 * AI fill per field (#2692). A layout placement can carry, in its overrides
 * JSON, `ai_generate: { enabled, prompt }`: the record form then shows an AI
 * button on that field, and the server fills it from the admin's prompt
 * template, where `{{field}}` stands for another field's current value.
 *
 * The prompt is ALWAYS read from the stored layout — the client only names
 * the layout, field and record — and token values are read as the person
 * asking (fields they may read only). Nothing but the rendered prompt goes to
 * the model: no other record data.
 *
 * MIRROR: packages/shared/src/lib/ai-fill.ts
 * (AI_FILL_KEY, readAiFill, promptTokens) — keep the two in step.
 */

export const AI_FILL_KEY = 'ai_generate'
export const PROMPT_MAX = 2000
const VALUE_MAX = 600
const TOKEN_RE = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g

export interface AiFillConfig {
  enabled: boolean
  prompt: string | null
}

/** The placement's AI fill setting; null = not set (the layout-wide AI switch decides). */
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

/** A value as plain text for the prompt: HTML stripped, long text capped. */
export function tokenText(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'boolean') return v ? 'yes' : 'no'
  if (typeof v === 'object') {
    try {
      return (cleanText(JSON.stringify(v), VALUE_MAX) ?? '').slice(0, VALUE_MAX)
    } catch {
      return ''
    }
  }
  return cleanText(String(v).replace(/<[^>]+>/g, ' '), VALUE_MAX) ?? ''
}

/**
 * The template with each `{{field}}` replaced by its value. Fields outside
 * `readable` (the asker may not read them) or without a value become empty
 * and are listed in `missing`.
 */
export function renderPrompt(
  prompt: string,
  values: Record<string, unknown>,
  readable: (field: string) => boolean
): { text: string; missing: string[] } {
  const missing: string[] = []
  const text = prompt.replace(TOKEN_RE, (_all, name: string) => {
    const t = readable(name) ? tokenText(values[name]) : ''
    if (!t && !missing.includes(name)) missing.push(name)
    return t
  })
  return { text, missing }
}

export const FIELD_FILL_SYSTEM =
  'You write the value of ONE field on a record form, following the instructions you are given. Answer with the value only: no quotes, no label, no explanation. If the instructions cannot be followed with what you are given, answer with an empty line.'

export function buildFieldFillPrompt(input: {
  instructions: string
  label: string
  type: string | null
  maxLength: number | null
}): string {
  const limits = input.maxLength ? ` It must be at most ${input.maxLength} characters.` : ''
  return `Field: ${input.label}${input.type ? ` (${input.type})` : ''}.${limits}\n\nInstructions:\n${input.instructions}`
}

/** The model's answer as a field value: trimmed, unquoted, capped. */
export function cleanFieldValue(text: string, maxLength: number | null): string {
  let t = String(text ?? '').trim()
  const fence = t.match(/^```[a-z]*\s*([\s\S]*?)```$/)
  if (fence) t = fence[1].trim()
  if (/^(["'“]).*(["'”])$/s.test(t) && t.length > 1) t = t.slice(1, -1).trim()
  return maxLength && maxLength > 0 ? t.slice(0, maxLength) : t
}

/** In-process per-person limit: a button people click, never a loop. */
const WINDOW_MS = 5 * 60_000
export const FIELD_FILL_PER_WINDOW = 30
const calls = new Map<string, number[]>()

export function takeFieldFillSlot(userId: string, now = Date.now()): boolean {
  const recent = (calls.get(userId) ?? []).filter((t) => now - t < WINDOW_MS)
  if (recent.length >= FIELD_FILL_PER_WINDOW) {
    calls.set(userId, recent)
    return false
  }
  recent.push(now)
  calls.set(userId, recent)
  if (calls.size > 5000) for (const k of [...calls.keys()].slice(0, 1000)) calls.delete(k)
  return true
}
