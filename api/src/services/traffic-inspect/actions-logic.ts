// api/src/services/traffic-inspect/actions-logic.ts
/**
 * Traffic Map drill-down, group "actions" (Task 8) — the pure parts: investigation input
 * cleaning, the edit permission rule and the "Explain" prompt. No database, no AI client.
 */

export const INVESTIGATION_ID_RE = /^[0-9a-f-]{36}$/i
export const TITLE_MAX = 200
export const NOTES_MAX = 20_000
export const STACK_MAX = 4000
export const CONTEXT_MAX = 64 * 1024
/** What the Explain call sends the model (the page caps at 24 KB; the server allows a little more). */
export const EXPLAIN_CONTEXT_MAX = 32 * 1024
const MAX_LEVELS = 8
/** Explain takes the whole stack (the page caps its JSON); the URL / saved form keeps 8. */
const EXPLAIN_MAX_LEVELS = 40

/** One stack segment: `kind:<uri-encoded id>` optionally `@<epoch ms>` (the page's URL form). */
const SEGMENT_RE = /^[a-z][a-z0-9_-]{0,31}:[^/\s@]{1,512}(@\d{1,15})?$/

/** The page's encoded stack (`kind:id@at/kind:id`) when well formed, else null. */
export function cleanStack(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim()
  if (!s || s.length > STACK_MAX) return null
  const segs = s.split('/')
  if (segs.length > MAX_LEVELS) return null
  return segs.every((seg) => SEGMENT_RE.test(seg)) ? s : null
}

/** A title: trimmed, one line, capped; '' when there is none. */
export function cleanTitle(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  return raw.replace(/\s+/g, ' ').trim().slice(0, TITLE_MAX)
}

/** Notes: capped; null when empty. */
export function cleanNotes(raw: unknown): string | null {
  if (raw == null) return null
  const s = String(raw).slice(0, NOTES_MAX)
  return s.trim() ? s : null
}

/**
 * The context JSON as stored text. undefined = absent (keep), null = cleared, or a JSON string
 * ≤ max. Throws `too_big` when it would not fit — the caller answers 413.
 */
export function cleanContext(raw: unknown, max = CONTEXT_MAX): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  let text: string
  try {
    text = typeof raw === 'string' ? raw : JSON.stringify(raw)
  } catch {
    throw new Error('invalid')
  }
  if (typeof raw === 'string') {
    try {
      JSON.parse(raw)
    } catch {
      throw new Error('invalid')
    }
  }
  if (text.length > max) throw new Error('too_big')
  return text
}

export interface InvestigationRow {
  id: string
  created_by: string | null
}

/** Who may change or delete an investigation: the admin who saved it, or any admin. */
export function canEditInvestigation(
  row: InvestigationRow,
  userId: string | null | undefined,
  isAdmin: boolean
): boolean {
  if (isAdmin) return true
  if (!userId || !row.created_by) return false
  return String(row.created_by).toLowerCase() === String(userId).toLowerCase()
}

// ── Explain (#1210) ──

export const EXPLAIN_SYSTEM = [
  "You help an administrator investigate API traffic in Nivaro's Traffic Map.",
  'You receive the investigation as JSON: levels L1 (where it started) to Ln (what is on screen',
  'now), each with its kind, title and the facts its panel showed. Some details may be trimmed.',
  'Answer in exactly three short sections, each starting on its own line with its title and a',
  'colon: "What happened:", "Likely cause:", "Where to look next:". Cite the level a statement',
  'rests on as [L2]. Plain sentences, no markdown, at most 220 words in total. When the data',
  'cannot tell, say what is missing instead of guessing. Never invent ids, numbers or names.'
].join(' ')

export interface ExplainContext {
  levels: Array<{ kind?: unknown; title?: unknown }>
  [k: string]: unknown
}

/** The context the page sent, when it has the shape Explain needs; else null. */
export function explainContextOf(raw: unknown): ExplainContext | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const levels = (raw as { levels?: unknown }).levels
  if (!Array.isArray(levels) || levels.length === 0 || levels.length > EXPLAIN_MAX_LEVELS)
    return null
  return raw as ExplainContext
}

/** The user message for the model: the context JSON, cut to `max` characters. */
export function explainUserMessage(ctx: ExplainContext, max = EXPLAIN_CONTEXT_MAX): string {
  let json = ''
  try {
    json = JSON.stringify(ctx)
  } catch {
    json = '{}'
  }
  const body = json.length > max ? `${json.slice(0, max)}… (cut)` : json
  return `Investigation (${ctx.levels.length} level${ctx.levels.length === 1 ? '' : 's'}):\n${body}`
}

/** The short activity label for an Explain call — kinds only, never the AI text or the data. */
export function explainActivityLabel(ctx: ExplainContext): string {
  const kinds = ctx.levels
    .map((l) => (typeof l.kind === 'string' ? l.kind : '?'))
    .join(' › ')
    .slice(0, 200)
  return `Explain: ${kinds}`
}
