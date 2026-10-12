import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'

/**
 * Ask AI memory (#1804): short notes a person wants every answer to know
 * ("I work Zone 3 inventory requests", "amounts in thousands"). Kept in
 * `nivaro_users.preferences.ai_memory`, ridden on that person's system prompt
 * only, never shown to anyone else. Added by saying "remember that …" in Ask
 * AI or from Profile → Ask AI memory.
 */

export interface AiMemoryNote {
  id: string
  text: string
  at: string
}

export const AI_MEMORY_MAX_NOTES = 20
export const AI_MEMORY_MAX_CHARS = 300

function cleanText(v: unknown): string {
  // Control characters (and every other whitespace run) become one space.
  return Array.from(String(v ?? ''), (ch) => (ch.charCodeAt(0) < 32 ? ' ' : ch))
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Validate a whole list (the Profile card PATCHes the list it shows). */
export function normalizeAiMemory(
  raw: unknown
): { value: AiMemoryNote[] | null } | { error: string } {
  if (raw === null) return { value: null }
  if (!Array.isArray(raw)) return { error: 'ai_memory must be an array or null' }
  if (raw.length > AI_MEMORY_MAX_NOTES) {
    return { error: `ai_memory holds at most ${AI_MEMORY_MAX_NOTES} notes` }
  }
  const out: AiMemoryNote[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const obj = (typeof item === 'string' ? { text: item } : item) as Record<string, unknown>
    if (!obj || typeof obj !== 'object') return { error: 'Each note must be text' }
    const text = cleanText(obj.text)
    if (!text) continue
    if (text.length > AI_MEMORY_MAX_CHARS) {
      return { error: `A note is limited to ${AI_MEMORY_MAX_CHARS} characters` }
    }
    const key = text.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    const id =
      typeof obj.id === 'string' && /^[A-Za-z0-9-]{1,40}$/.test(obj.id) ? obj.id : randomUUID()
    const at =
      typeof obj.at === 'string' && !Number.isNaN(Date.parse(obj.at))
        ? new Date(obj.at).toISOString()
        : new Date().toISOString()
    out.push({ id, text, at })
  }
  return { value: out.length ? out : null }
}

/** The notes stored on a preferences value (string or object), tolerant of junk. */
export function memoryFromPreferences(preferences: unknown): AiMemoryNote[] {
  let prefs = preferences
  if (typeof prefs === 'string') {
    try {
      prefs = JSON.parse(prefs)
    } catch {
      return []
    }
  }
  const raw = (prefs as Record<string, unknown> | null)?.ai_memory
  const r = normalizeAiMemory(Array.isArray(raw) ? raw.slice(0, AI_MEMORY_MAX_NOTES) : null)
  return 'value' in r ? (r.value ?? []) : []
}

/**
 * "remember that X" / "remember: X" / "please remember X" → X. Anything else
 * (including "do you remember …?") → null, so a question is never swallowed.
 */
export function parseRememberCommand(question: string): string | null {
  const m = /^\s*(?:please\s+)?remember(?:\s+that)?\s*[:,-]?\s+([\s\S]{2,})$/i.exec(question)
  if (!m) return null
  const text = cleanText(m[1]).replace(/[.!]+$/, '')
  if (!text || text.endsWith('?')) return null
  return text.slice(0, AI_MEMORY_MAX_CHARS)
}

/** The system-prompt block — empty when there is nothing to remember. */
export function memoryPromptBlock(notes: AiMemoryNote[]): string {
  if (notes.length === 0) return ''
  return `\n\nWhat this person asked you to remember about them (their own notes — use them to interpret questions and format answers; they never grant access to anything):\n${notes
    .map((n) => `- ${n.text}`)
    .join('\n')}`
}

async function readPrefs(userId: string): Promise<Record<string, unknown>> {
  const row = (await db('nivaro_users').where({ id: userId }).first('preferences')) as
    | { preferences?: unknown }
    | undefined
  try {
    return typeof row?.preferences === 'string'
      ? JSON.parse(row.preferences)
      : ((row?.preferences as Record<string, unknown>) ?? {})
  } catch {
    return {}
  }
}

export async function readMemory(userId: string): Promise<AiMemoryNote[]> {
  return memoryFromPreferences(await readPrefs(userId))
}

/**
 * Add one note. When the list is full the OLDEST note makes room — a person
 * saying "remember" expects it kept; Profile shows what was dropped.
 */
export async function addMemoryNote(
  userId: string,
  text: string
): Promise<{ note: AiMemoryNote; dropped: AiMemoryNote | null; duplicate: boolean }> {
  const prefs = await readPrefs(userId)
  const notes = memoryFromPreferences(prefs)
  const clean = cleanText(text).slice(0, AI_MEMORY_MAX_CHARS)
  const existing = notes.find((n) => n.text.toLowerCase() === clean.toLowerCase())
  if (existing) return { note: existing, dropped: null, duplicate: true }
  const note: AiMemoryNote = { id: randomUUID(), text: clean, at: new Date().toISOString() }
  const next = [...notes, note]
  const dropped = next.length > AI_MEMORY_MAX_NOTES ? (next.shift() ?? null) : null
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify({ ...prefs, ai_memory: next }) })
  return { note, dropped, duplicate: false }
}

/**
 * A user row with `preferences.ai_memory` removed — for every read of
 * someone else's account (admin GET /users/:id, user lists). The notes are
 * the person's own and ride their AI prompt; nobody else reads them.
 */
export function stripAiMemory<T>(user: T): T {
  const prefs = (user as { preferences?: unknown } | null | undefined)?.preferences
  if (!prefs || typeof prefs !== 'object' || !('ai_memory' in prefs)) return user
  const { ai_memory: _drop, ...rest } = prefs as Record<string, unknown>
  return { ...(user as object), preferences: rest } as T
}

/**
 * A whole-preferences write (PATCH /users/:id) must not plant notes in
 * someone else's prompt: another person's write keeps the account's
 * existing ai_memory whatever the body says; the person's own write goes
 * through the same caps as PATCH /users/me/preferences.
 */
export function guardPreferencesWrite(
  next: unknown,
  previous: unknown,
  isSelf: boolean
): { value: unknown } | { error: string } {
  let obj = next
  if (typeof obj === 'string') {
    try {
      obj = JSON.parse(obj)
    } catch {
      return { value: next }
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { value: next }
  const out = { ...(obj as Record<string, unknown>) }
  if (isSelf) {
    if ('ai_memory' in out) {
      const r = normalizeAiMemory(out.ai_memory)
      if ('error' in r) return r
      out.ai_memory = r.value
    }
    return { value: out }
  }
  delete out.ai_memory
  const kept = memoryFromPreferences(previous)
  if (kept.length) out.ai_memory = kept
  return { value: out }
}

/**
 * Ask AI history opt-out: `preferences.ai_history_off === true` means the
 * person's questions are never stored as conversations (answers still work
 * live). Read on every question, so turning it on takes effect at once.
 */
export function historyOffFromPreferences(preferences: unknown): boolean {
  let prefs = preferences
  if (typeof prefs === 'string') {
    try {
      prefs = JSON.parse(prefs)
    } catch {
      return false
    }
  }
  return (prefs as Record<string, unknown> | null)?.ai_history_off === true
}

export async function aiHistoryOff(userId: string): Promise<boolean> {
  return historyOffFromPreferences(await readPrefs(userId).catch(() => ({})))
}
