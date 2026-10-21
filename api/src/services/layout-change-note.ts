import type { Knex } from 'knex'

/**
 * Required change note (#2654, migration 462). A layout whose `change_note`
 * is set refuses an ops batch that changes it without a reason ('note') or
 * without a reason and a ticket link ('note_ticket'). The reason (and ticket)
 * become the History version's note, ahead of the step labels.
 */

export const CHANGE_NOTE_POLICIES = ['note', 'note_ticket'] as const
export type ChangeNotePolicy = (typeof CHANGE_NOTE_POLICIES)[number]

export const CHANGE_NOTE_REQUIRED = 'CHANGE_NOTE_REQUIRED'
const REASON_MAX = 200
const TICKET_MAX = 300
const NOTE_MAX = 255

/** The stored setting as a policy; anything else (NULL, '', unknown) = off. */
export function changeNotePolicy(layout: Record<string, unknown> | null | undefined) {
  const v = layout?.change_note
  return (CHANGE_NOTE_POLICIES as readonly unknown[]).includes(v) ? (v as ChangeNotePolicy) : null
}

/** A patch value → the column value, or an error for anything not a policy. */
export function normalizeChangeNote(
  v: unknown
): { value: ChangeNotePolicy | null } | { error: string } {
  if (v == null || v === '' || v === 'off') return { value: null }
  if ((CHANGE_NOTE_POLICIES as readonly unknown[]).includes(v))
    return { value: v as ChangeNotePolicy }
  return { error: `change_note must be one of ${CHANGE_NOTE_POLICIES.join(', ')} or null` }
}

const clean = (v: unknown, max: number) =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : ''

/** What a save under `policy` still lacks, in words; null when it may go. */
export function missingChangeNote(
  policy: ChangeNotePolicy | null,
  reason: unknown,
  ticket: unknown
): string | null {
  if (!policy) return null
  if (clean(reason, REASON_MAX).length < 3) return 'This layout asks for a reason with every save'
  if (policy === 'note_ticket' && !clean(ticket, TICKET_MAX))
    return 'This layout asks for a reason and a ticket link with every save'
  return null
}

/** The version note: "reason · ticket — step labels", within the note column. */
export function changeNoteVersionNote(
  reason: unknown,
  ticket: unknown,
  labels: string | null | undefined
): string | null {
  const r = clean(reason, REASON_MAX)
  if (!r) return null
  const t = clean(ticket, TICKET_MAX)
  const head = t ? `${r} · ${t}` : r
  const tail = labels?.trim() ? ` — ${labels.trim()}` : ''
  const note = `${head}${tail}`
  return note.length > NOTE_MAX ? `${note.slice(0, NOTE_MAX - 1)}…` : note
}

// The column arrives with migration 462; until it ran, the setting cannot be stored.
let columnReady: boolean | null = null
let checkedAt = 0
export async function changeNoteColumnReady(q: Knex | Knex.Transaction): Promise<boolean> {
  if (columnReady || (columnReady === false && Date.now() - checkedAt < 60_000)) return columnReady
  checkedAt = Date.now()
  try {
    columnReady = await q.schema.hasColumn('nivaro_collection_layouts', 'change_note')
  } catch {
    columnReady = false
  }
  return columnReady
}
