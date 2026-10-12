import { randomUUID } from 'node:crypto'
import type Anthropic from '@anthropic-ai/sdk'
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

async function writeMemory(
  userId: string,
  prefs: Record<string, unknown>,
  notes: AiMemoryNote[]
): Promise<void> {
  const { ai_memory: _old, ...rest } = prefs
  await db('nivaro_users')
    .where({ id: userId })
    .update({ preferences: JSON.stringify(notes.length ? { ...rest, ai_memory: notes } : rest) })
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
  await writeMemory(userId, prefs, next)
  return { note, dropped, duplicate: false }
}

// ─── Suggestions (#1845) ──────────────────────────────────────────────────────
//
// The model may OFFER a note it inferred ("by 'my zone' you mean Zone 3").
// The offer rides the answer as `memory_suggestions`; nothing is written
// until the asker clicks "Remember this?", which POSTs /ai/memory and lands
// in `addSuggestedNote` — the same caps as every other self-write. The tool
// is never in CHAT_TOOLS (the chat-room bot shares that list): only POST
// /ai/chat opts the loop into it, and the loop answers it in place — no trace
// entry, so shared views, replays and exports never see the offer.

export const SUGGEST_MEMORY_TOOL_NAME = 'suggest_memory'
export const AI_MEMORY_MAX_SUGGESTIONS = 2

export interface AiMemorySuggestion {
  text: string
}

export const SUGGEST_MEMORY_TOOL: Anthropic.Tool = {
  name: SUGGEST_MEMORY_TOOL_NAME,
  description:
    'OFFER (never save) a standing note about the person asking, when their question reveals a lasting preference that would help future answers: what they mean by "my zone" or "my team", the units or format they want, the area they work in. The person sees a "Remember this?" button under your answer and nothing is kept unless they click it — never say it was saved. Write the note in their voice, short ("By my zone I mean Zone 3"). Never offer one-off facts, record values, figures from this answer, or anything about other people. At most one per answer; call it alongside your other tools or just before you answer.',
  input_schema: {
    type: 'object' as const,
    properties: {
      text: { type: 'string', description: `The note, under ${AI_MEMORY_MAX_CHARS} characters.` }
    },
    required: ['text']
  }
}

/**
 * Decide one suggest_memory call: the offer to show (or none) and what the
 * model is told. `offered` is this answer's offers so far.
 */
export function offerMemorySuggestion(
  input: Record<string, unknown>,
  existing: AiMemoryNote[],
  offered: AiMemorySuggestion[]
): { suggestion: AiMemorySuggestion | null; reply: string } {
  const text = cleanText(input.text).replace(/[.!]+$/, '')
  if (!text) return { suggestion: null, reply: 'Nothing to offer — the note was empty.' }
  if (text.length > AI_MEMORY_MAX_CHARS) {
    return {
      suggestion: null,
      reply: `Too long — a note is at most ${AI_MEMORY_MAX_CHARS} characters. Not offered.`
    }
  }
  const key = text.toLowerCase()
  if (existing.some((n) => n.text.toLowerCase() === key)) {
    return { suggestion: null, reply: 'They already have this note — nothing to offer.' }
  }
  if (offered.some((o) => o.text.toLowerCase() === key)) {
    return { suggestion: null, reply: 'Already offered in this answer.' }
  }
  if (offered.length >= AI_MEMORY_MAX_SUGGESTIONS) {
    return { suggestion: null, reply: 'Enough offers for one answer — not offered.' }
  }
  if (existing.length >= AI_MEMORY_MAX_NOTES) {
    return {
      suggestion: null,
      reply: `Their memory is full (${AI_MEMORY_MAX_NOTES} notes) — not offered.`
    }
  }
  return {
    suggestion: { text },
    reply:
      'Offered: a "Remember this?" button shows under your answer. Nothing is saved unless they click it — do not say it was remembered.'
  }
}

/** The offers on an answer body, cleaned (client and stored-meta input alike). */
export function suggestionsFrom(raw: unknown): AiMemorySuggestion[] {
  if (!Array.isArray(raw)) return []
  const out: AiMemorySuggestion[] = []
  for (const s of raw.slice(0, AI_MEMORY_MAX_SUGGESTIONS)) {
    const text = cleanText((s as { text?: unknown } | null)?.text)
    if (text && text.length <= AI_MEMORY_MAX_CHARS) out.push({ text })
  }
  return out
}

/**
 * The asker clicked "Remember this?" (#1845). Unlike "remember that …", a
 * full list is refused rather than dropping the oldest note — a click on a
 * suggestion should not quietly forget something they wrote themselves.
 */
export async function addSuggestedNote(
  userId: string,
  text: unknown
): Promise<{ note: AiMemoryNote; duplicate: boolean } | { error: string; status: number }> {
  const clean = cleanText(text)
  if (!clean) return { error: 'text is required', status: 400 }
  if (clean.length > AI_MEMORY_MAX_CHARS) {
    return { error: `A note is limited to ${AI_MEMORY_MAX_CHARS} characters`, status: 400 }
  }
  const prefs = await readPrefs(userId)
  const notes = memoryFromPreferences(prefs)
  const existing = notes.find((n) => n.text.toLowerCase() === clean.toLowerCase())
  if (existing) return { note: existing, duplicate: true }
  if (notes.length >= AI_MEMORY_MAX_NOTES) {
    return {
      error: `Ask AI memory holds ${AI_MEMORY_MAX_NOTES} notes — remove one under Profile → Ask AI memory first`,
      status: 409
    }
  }
  const note: AiMemoryNote = { id: randomUUID(), text: clean, at: new Date().toISOString() }
  await writeMemory(userId, prefs, [...notes, note])
  return { note, duplicate: false }
}

// ─── Administrator view / clear (#1897) ───────────────────────────────────────

/** Someone's notes for the admin route; null when there is no such account. */
export async function readMemoryOf(userId: string): Promise<AiMemoryNote[] | null> {
  const row = (await db('nivaro_users').where({ id: userId }).first('id', 'preferences')) as
    | { id: string; preferences?: unknown }
    | undefined
  if (!row) return null
  return memoryFromPreferences(row.preferences)
}

/**
 * Forget one note (`noteId`) or all of them. Removal only — the admin route
 * has no way to add or reword a note. Null when there is no such account.
 */
export async function forgetMemory(
  userId: string,
  noteId?: string
): Promise<{ removed: number; remaining: number } | null> {
  const row = (await db('nivaro_users').where({ id: userId }).first('id')) as
    | { id: string }
    | undefined
  if (!row) return null
  const prefs = await readPrefs(userId)
  const notes = memoryFromPreferences(prefs)
  const keep = noteId ? notes.filter((n) => n.id !== noteId) : []
  const removed = notes.length - keep.length
  if (removed > 0 || (!noteId && 'ai_memory' in prefs)) await writeMemory(userId, prefs, keep)
  return { removed, remaining: keep.length }
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
