import { createHash } from 'node:crypto'

/**
 * Ask AI's answer cache keys (#723 per person, #2455 shared).
 *
 * Answers are cached per person because they are permission-scoped. An
 * answer written ONLY from the in-app docs (the trace holds search_docs
 * calls and nothing else — no data tool, no page context, no memory, no
 * attachments) reads the same for everyone with the same docs audience, so
 * it is also kept under a shared key: the normalized question + the
 * docs-index version + admin/non-admin (admins see more sections) + locale +
 * tenant + time zone. Any data tool in the trace keeps the answer private.
 *
 * The prompt is per person too (readable collections, saved queries, queues,
 * saved views, playbooks drawn from other people's questions), and a docs
 * answer could quote any of it. So a question that may be shared is ANSWERED
 * from a catalogue-free prompt (`catalogues: false`, no playbooks — the room
 * bot's prompt), decided BEFORE the answer: `sharedDocsCandidate`. Only those
 * answers are ever written under the shared key; every other answer keeps
 * the full prompt and stays per person.
 */

export function normalizeAskQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ')
}

/** What a personal answer's access depends on, beyond the person (review 2026-10-27). */
export interface AnswerScope {
  tenant?: string | null
  /** The workspace the question was asked in (x-workspace). */
  workspace?: string | null
  /** accessSignature(user): role + API-key scopes + sandbox. */
  access?: string | null
  /** The configuration epoch (moves on role / policy writes); null = unknown. */
  epoch?: number | null
}

/** Role, API-key scopes and sandbox flag — a change to any gives a new key. */
export function accessSignature(user: {
  role?: unknown
  api_key_scopes?: unknown
  api_key_scope_restrictions?: unknown
  api_key_sandbox?: unknown
}): string {
  return createHash('sha1')
    .update(
      JSON.stringify([
        user.role ?? null,
        user.api_key_scopes ?? null,
        user.api_key_scope_restrictions ?? null,
        user.api_key_sandbox ? 1 : 0
      ])
    )
    .digest('hex')
    .slice(0, 16)
}

export function personalAnswerKey(
  userId: string,
  command: string | null,
  question: string,
  scope: AnswerScope = {}
) {
  const where = [
    scope.tenant ?? '',
    scope.workspace ?? '',
    scope.access ?? '',
    scope.epoch == null ? '' : String(scope.epoch)
  ].join('|')
  return `nvr:aichat:${userId}:${createHash('sha1')
    .update(`${command ?? ''}|${normalizeAskQuestion(question)}|${where}`)
    .digest('hex')}`
}

// "How do I…", "what does … mean", "where can I…", "is there a way…" — the
// questions the docs answer. Anything else keeps the full per-person prompt
// (a data question answered without its catalogue costs an extra round).
const DOCS_QUESTION =
  /^(?:how (?:do|can|should|would|does|to)\b|where (?:do|can|is|are|does)\b|is (?:it|there) (?:possible|a way)\b|can (?:i|we|you)\b|what (?:does|do) .{1,80}\b(?:mean|do)\b|what happens (?:when|if)\b|what (?:is|are) (?:an? |the )?[\w-]+(?: [\w-]+){0,3}\??$|why (?:does|do|can['’]?t|cannot|is|are)\b|help\b)/i

export function looksLikeDocsQuestion(question: string): boolean {
  return DOCS_QUESTION.test(normalizeAskQuestion(question))
}

/**
 * Whether this question may be answered for everyone: a standalone docs-style
 * question with no page context and no remembered notes, while the answer
 * cache is on. Decided before the prompt is built (see the module comment).
 */
export function sharedDocsCandidate(opts: {
  standalone: boolean
  pageContext: boolean
  memoryNotes: number
  cacheOn: boolean
  question: string
}): boolean {
  return (
    opts.cacheOn &&
    opts.standalone &&
    !opts.pageContext &&
    opts.memoryNotes === 0 &&
    looksLikeDocsQuestion(opts.question)
  )
}

export function sharedAnswerKey(opts: {
  tenant: string
  docsVersion: string
  admin: boolean
  locale: string
  /** "Today is …" and the time instructions in the prompt follow the asker's zone. */
  timeZone: string
  command: string | null
  question: string
}): string {
  const h = createHash('sha1')
    .update(
      [
        opts.docsVersion,
        opts.admin ? 'admin' : 'user',
        opts.locale,
        opts.timeZone,
        opts.command ?? '',
        normalizeAskQuestion(opts.question)
      ].join('|')
    )
    .digest('hex')
  return `nvr:aichat:shared:${opts.tenant || '-'}:${h}`
}

/** The answer used the docs tool and nothing else (and every call succeeded). */
export function isDocsOnlyTrace(trace: Array<{ tool: string; summary?: string }>): boolean {
  return (
    trace.length > 0 &&
    trace.every((t) => t.tool === 'search_docs' && !String(t.summary ?? '').startsWith('error:'))
  )
}

/** The asker's language: their saved preference, else the browser's, else English. */
export function askLocale(
  preferences: Record<string, unknown> | string | null | undefined,
  acceptLanguage: string | string[] | undefined
): string {
  let prefs: Record<string, unknown> = {}
  if (typeof preferences === 'string') {
    try {
      const p = JSON.parse(preferences)
      if (p && typeof p === 'object') prefs = p as Record<string, unknown>
    } catch {
      prefs = {}
    }
  } else if (preferences && typeof preferences === 'object') prefs = preferences
  const saved = [prefs.locale, prefs.language, prefs.lang].find(
    (v): v is string => typeof v === 'string' && !!v.trim()
  )
  const header = Array.isArray(acceptLanguage) ? acceptLanguage[0] : acceptLanguage
  const raw = saved ?? header?.split(',')[0] ?? 'en'
  const primary = raw.trim().toLowerCase().split(/[-_;]/)[0]
  return /^[a-z]{2,3}$/.test(primary) ? primary : 'en'
}
