import { asData, UNTRUSTED_DATA_RULE } from './ai-untrusted.js'

/**
 * POST /ai/brief — the system prompt is chosen from a server-side allowlist,
 * never written by the caller (review 2026-10-27: a caller-set system prompt
 * made the route an open model proxy for every signed-in person).
 *
 * Callers name a `template`. For the callers that shipped before this list
 * (report widget explain, the Traffic Map's explain-spike), the exact
 * `instructions` text they send still maps to its template; any other
 * instruction text is ignored and the daily template answers.
 */

export const BRIEF_TEMPLATES = {
  /** The portal / dashboard daily briefing (efp-new DailySummaryCard). */
  daily:
    'You write a short daily briefing for a business user from the data provided. Open with one summary sentence, then 3-5 concrete insights citing real numbers from the data, call out anything needing immediate attention, and end with one or two positives. Plain text only — no markdown, no headers. 150-220 words.',
  /** Report widget "explain" with a previous period (shared ReportView). */
  'report-compare':
    'Compare the current period against the previous one in 2-4 plain sentences: overall direction, the biggest movers up and down, and anything anomalous. No preamble.',
  /** Report widget "explain" without a previous period (shared ReportView). */
  'report-explain':
    'In 2-3 plain sentences, explain what this report metric shows and what stands out (biggest contributor, direction of change). No preamble.',
  /** Traffic Map node "explain this spike" (admin explain-spike.tsx). */
  'traffic-spike':
    'You are reading one node of a live API traffic map for an administrator. Using only the figures given, write exactly two plain sentences explaining what is happening (name the busiest route, caller or error code and the numbers that matter). Then, on its own line, write "Look next:" followed by one concrete place to look (a route, a caller, an error code, or a page such as API Analytics, Integrations, DB Health or Background jobs). No markdown, no lists.'
} as const

export type BriefTemplate = keyof typeof BRIEF_TEMPLATES

const norm = (s: string) => s.replace(/\s+/g, ' ').trim()
const BY_TEXT = new Map<string, BriefTemplate>(
  (Object.entries(BRIEF_TEMPLATES) as Array<[BriefTemplate, string]>).map(([k, v]) => [norm(v), k])
)

/** Which template answers: a named one, a legacy caller's exact text, else daily. */
export function pickBriefTemplate(body: { template?: unknown; instructions?: unknown }): {
  template: BriefTemplate
  /** true when the caller sent instructions that are not on the list (they were ignored). */
  ignored: boolean
} {
  if (typeof body.template === 'string' && body.template in BRIEF_TEMPLATES)
    return { template: body.template as BriefTemplate, ignored: false }
  if (typeof body.instructions === 'string' && body.instructions.trim()) {
    const hit = BY_TEXT.get(norm(body.instructions))
    return hit ? { template: hit, ignored: false } : { template: 'daily', ignored: true }
  }
  return { template: 'daily', ignored: false }
}

/** The fixed system prompt for a template: its instructions plus the data rule. */
export function briefSystemPrompt(template: BriefTemplate): string {
  return `${BRIEF_TEMPLATES[template]}\n\n${UNTRUSTED_DATA_RULE} Write only the briefing described above, from the figures in the data.`
}

/** The caller's context as the one user turn, framed as data. */
export function briefUserContent(context: string): string {
  return asData(context.slice(0, 16000), 'brief-context')
}

/** Briefs one person may ask for per minute (two may run at once). */
export const BRIEF_PER_MINUTE = 10
