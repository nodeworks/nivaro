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
 * tenant. Any data tool in the trace keeps the answer private.
 */

export function normalizeAskQuestion(question: string): string {
  return question.trim().toLowerCase().replace(/\s+/g, ' ')
}

export function personalAnswerKey(userId: string, command: string | null, question: string) {
  return `nvr:aichat:${userId}:${createHash('sha1')
    .update(`${command ?? ''}|${normalizeAskQuestion(question)}`)
    .digest('hex')}`
}

export function sharedAnswerKey(opts: {
  tenant: string
  docsVersion: string
  admin: boolean
  locale: string
  command: string | null
  question: string
}): string {
  const h = createHash('sha1')
    .update(
      [
        opts.docsVersion,
        opts.admin ? 'admin' : 'user',
        opts.locale,
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
