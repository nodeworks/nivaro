import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { emitToUser } from './live-progress.js'

/**
 * Draft sync across devices (#2474). Unsent composer text per person per room
 * lives in nivaro_chat_drafts (one row per user + room) so another browser,
 * device or tab restores it. Writes are debounced by the client (~1.5 s);
 * every change is announced over the person's OWN socket room as
 * `chat:draft` { room, cleared, device } — no text on the wire, the other
 * tab re-reads through the permission-checked route. Sending a message or
 * clearing the box deletes the row; rows untouched for 30 days are pruned.
 * Attachments are not synced (v1).
 */

export const DRAFT_TTL_DAYS = 30
export const DRAFT_MAX_CHARS = 20_000

/** Does this database have the drafts table yet (migration 466)? */
export function draftsReady(): Promise<boolean> {
  return hasColumn('nivaro_chat_drafts', 'body')
}

function cutoff(): Date {
  return new Date(Date.now() - DRAFT_TTL_DAYS * 86_400_000)
}

export interface DraftRow {
  room: string
  body: string
  updated_at: string
}

export async function listDrafts(
  userId: string
): Promise<Array<{ room: string; updated_at: string }>> {
  if (!(await draftsReady())) return []
  const rows = (await db('nivaro_chat_drafts')
    .where({ user: userId })
    .where('updated_at', '>=', cutoff())
    .whereNotNull('body')
    .where('body', '<>', '')
    .select('room', 'updated_at')) as Array<{ room: string; updated_at: Date | string }>
  return rows.map((r) => ({
    room: String(r.room),
    updated_at: new Date(r.updated_at).toISOString()
  }))
}

export async function getDraft(userId: string, room: string): Promise<DraftRow | null> {
  if (!(await draftsReady())) return null
  const row = (await db('nivaro_chat_drafts')
    .where({ user: userId, room })
    .where('updated_at', '>=', cutoff())
    .first()) as { room: string; body: string | null; updated_at: Date | string } | undefined
  if (!row?.body) return null
  return {
    room: String(row.room),
    body: String(row.body),
    updated_at: new Date(row.updated_at).toISOString()
  }
}

/** Save (non-empty) or clear (empty) a draft. Returns the stored state. */
export async function saveDraft(
  userId: string,
  room: string,
  body: string,
  device?: string | null
): Promise<{ cleared: boolean; updated_at: string | null }> {
  if (!(await draftsReady())) return { cleared: true, updated_at: null }
  const text = body.slice(0, DRAFT_MAX_CHARS)
  if (!text.trim()) {
    await clearDraft(userId, room, device)
    return { cleared: true, updated_at: null }
  }
  const now = new Date()
  const n = Number(
    await db('nivaro_chat_drafts')
      .where({ user: userId, room })
      .update({ body: text, updated_at: now })
  )
  if (!n) {
    await db('nivaro_chat_drafts')
      .insert({ user: userId, room, body: text, updated_at: now })
      .catch(async () => {
        // UNIQUE race with another tab — the row exists now, so update it.
        await db('nivaro_chat_drafts')
          .where({ user: userId, room })
          .update({ body: text, updated_at: now })
      })
  }
  emitToUser(userId, 'chat:draft', { room, cleared: false, device: device ?? null })
  return { cleared: false, updated_at: now.toISOString() }
}

/** Delete a draft (send, or the box was emptied) and tell the person's other tabs. */
export async function clearDraft(
  userId: string,
  room: string,
  device?: string | null
): Promise<void> {
  if (!(await draftsReady())) return
  const n = Number(await db('nivaro_chat_drafts').where({ user: userId, room }).del())
  if (n) emitToUser(userId, 'chat:draft', { room, cleared: true, device: device ?? null })
}

/** Drop drafts untouched for 30 days. Returns how many went. */
export async function pruneDrafts(): Promise<number> {
  if (!(await draftsReady())) return 0
  return Number(await db('nivaro_chat_drafts').where('updated_at', '<', cutoff()).del())
}
