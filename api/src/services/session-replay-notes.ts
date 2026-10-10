/**
 * Timestamped notes on a session recording (#1363) — reads and writes of
 * nivaro_replay_notes (migration 423), and the copy of a note onto the issue
 * the recording is linked to or onto an investigation notebook (#1212).
 *
 * A note is plain text pinned to an offset (ms from the recording's first
 * event, the player's clock). Copies carry a deep link back to that second:
 * /session-replays?recording=<id>&t=<at_ms>, the same link the issue log's
 * "Watch replay" uses — the player opens a few seconds before it.
 */
import { randomUUID } from 'node:crypto'
import { db } from '../db/index.js'
import { getTenantId } from '../db/tenant-context.js'

export const NOTES_TABLE = 'nivaro_replay_notes'
export const NOTE_TEXT_MAX = 2000
/** A recording is never a day long; anything past this is a bad offset. */
const AT_MS_MAX = 24 * 60 * 60_000
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** SQL Server compares a string to a uniqueidentifier after truncating it, so
 *  ids are checked to be exactly a uuid before any query. */
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID_RE.test(v)

const ready = new Map<string, { ok: boolean; at: number }>()

/** True once migration 423 has run here (re-probed after a minute, either way). */
export async function notesReady(): Promise<boolean> {
  const scope = getTenantId() ?? ''
  const hit = ready.get(scope)
  if (hit && Date.now() - hit.at < 60_000) return hit.ok
  let ok = false
  try {
    ok = await db.schema.hasTable(NOTES_TABLE)
  } catch {
    ok = false
  }
  ready.set(scope, { ok, at: Date.now() })
  return ok
}

export interface ReplayNote {
  id: string
  recording: string
  at_ms: number
  text: string
  user: string | null
  user_name: string | null
  created_at: string
  updated_at: string
}

function iso(v: unknown): string {
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? String(v ?? '') : d.toISOString()
}

/** m:ss, or h:mm:ss past the hour — the player's own clock format. */
export function fmtOffset(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = String(total % 60).padStart(2, '0')
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`
}

/** The in-app link that opens this recording at this second. */
export function noteDeepLink(recordingId: string, atMs: number): string {
  return `/session-replays?recording=${recordingId.toLowerCase()}&t=${Math.max(0, Math.floor(atMs))}`
}

/** The note's text, trimmed and capped; null when there is nothing to keep. */
export function cleanNoteText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const s = raw.trim().slice(0, NOTE_TEXT_MAX)
  return s ? s : null
}

/** A whole, in-range offset; null for anything else. */
export function cleanAtMs(raw: unknown): number | null {
  const n = Number(raw)
  if (raw === null || raw === '' || !Number.isFinite(n) || n < 0 || n > AT_MS_MAX) return null
  return Math.floor(n)
}

/** What lands on the issue as a comment. */
export function issueCommentText(note: Pick<ReplayNote, 'at_ms' | 'text' | 'recording'>): string {
  return `Replay note at ${fmtOffset(note.at_ms)}: ${note.text}\nWatch: ${noteDeepLink(note.recording, note.at_ms)}`
}

/** What is appended to an investigation's notes. */
export function notebookEntryText(note: Pick<ReplayNote, 'at_ms' | 'text' | 'recording'>): string {
  return `[Replay ${fmtOffset(note.at_ms)}] ${note.text}\n${noteDeepLink(note.recording, note.at_ms)}`
}

/** Append an entry to a notebook's notes; null when the result passes `max`. */
export function appendNotebookEntry(
  existing: string | null,
  entry: string,
  max: number
): string | null {
  const before = (existing ?? '').replace(/\s+$/, '')
  const next = before ? `${before}\n\n${entry}` : entry
  return next.length > max ? null : next
}

async function names(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const unique = [...new Set(ids.filter(Boolean))]
  if (unique.length === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', unique)
    .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, unknown>>
  for (const r of rows) {
    const full = `${r.first_name ?? ''} ${r.last_name ?? ''}`.trim()
    const name = full || (typeof r.email === 'string' ? r.email.split('@')[0] : '')
    if (name) out.set(String(r.id).toLowerCase(), name)
  }
  return out
}

function toNote(r: Record<string, unknown>, who: Map<string, string>): ReplayNote {
  const user = r.user ? String(r.user) : null
  return {
    id: String(r.id),
    recording: String(r.recording),
    at_ms: Number(r.at_ms) || 0,
    text: String(r.text ?? ''),
    user,
    user_name: user ? (who.get(user.toLowerCase()) ?? null) : null,
    created_at: iso(r.created_at),
    updated_at: iso(r.updated_at)
  }
}

export async function recordingExists(id: string): Promise<boolean> {
  const row = await db('nivaro_session_recordings').where({ id }).first('id')
  return !!row
}

/** Every note on a recording, earliest moment first. */
export async function listNotes(recordingId: string): Promise<ReplayNote[]> {
  const rows = (await db(NOTES_TABLE)
    .where({ recording: recordingId })
    .orderBy([
      { column: 'at_ms', order: 'asc' },
      { column: 'created_at', order: 'asc' }
    ])
    .select('id', 'recording', 'at_ms', 'text', 'user', 'created_at', 'updated_at')) as Array<
    Record<string, unknown>
  >
  const who = await names(rows.map((r) => String(r.user ?? '')))
  return rows.map((r) => toNote(r, who))
}

/** One note of one recording, or null. Both ids must be validated first. */
export async function getNote(recordingId: string, noteId: string): Promise<ReplayNote | null> {
  const r = (await db(NOTES_TABLE).where({ id: noteId, recording: recordingId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  return toNote(r, await names([String(r.user ?? '')]))
}

export async function insertNote(row: {
  recording: string
  at_ms: number
  text: string
  user: string | null
}): Promise<ReplayNote> {
  const id = randomUUID()
  const now = new Date()
  await db(NOTES_TABLE).insert({ id, ...row, created_at: now, updated_at: now })
  return (await getNote(row.recording, id)) as ReplayNote
}

export async function updateNote(
  recordingId: string,
  noteId: string,
  patch: Partial<{ at_ms: number; text: string }>
): Promise<void> {
  await db(NOTES_TABLE)
    .where({ id: noteId, recording: recordingId })
    .update({ ...patch, updated_at: new Date() })
}

export async function deleteNote(recordingId: string, noteId: string): Promise<void> {
  await db(NOTES_TABLE).where({ id: noteId, recording: recordingId }).del()
}

export interface LinkedIssue {
  id: number
  title: string
  status: string
}

/**
 * Issues that point at this recording (nivaro_issues.recording_id, migration
 * 210). That column is a plain string written from the client, so both cases
 * of the id are matched: SQL Server hands uniqueidentifiers back upper-case.
 */
export async function linkedIssues(recordingId: string): Promise<LinkedIssue[]> {
  const rows = (await db('nivaro_issues')
    .whereIn('recording_id', [...new Set([recordingId.toLowerCase(), recordingId.toUpperCase()])])
    .orderBy('created_at', 'desc')
    .limit(20)
    .select('id', 'title', 'status')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    title: String(r.title ?? ''),
    status: String(r.status ?? '')
  }))
}

/** Put the note on a linked issue as a comment by `userId`. Answers the comment id. */
export async function copyNoteToIssue(
  note: ReplayNote,
  issueId: number,
  userId: string
): Promise<string> {
  const id = randomUUID()
  const now = new Date()
  await db('nivaro_comments').insert({
    id,
    collection: 'nivaro_issues',
    item: String(issueId),
    user: userId,
    text: issueCommentText(note),
    created_at: now,
    updated_at: now
  })
  return id
}
