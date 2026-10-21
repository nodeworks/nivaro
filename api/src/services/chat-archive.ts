import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { logActivity } from './activity.js'
import { channels, clearChatCaches } from './chat.js'

/**
 * Dead channel archive suggestions (#2485). A daily sweep finds channels with
 * no posts for N days (`nivaro_settings.chat_archive_idle_days`, blank = 90,
 * 0 = off) and sends their owner one notification. The owner answers in the
 * channel (a one-click Archive or Keep) — Keep restarts the idle clock, Archive
 * is the existing manual archive. Admins read the suggested and archived lists
 * on the chat administration screen. Archived channels stay searchable and can
 * be reopened by flipping is_archived back (which also restarts the clock).
 */

export const DEFAULT_IDLE_DAYS = 90
const DAY = 86_400_000

export async function archiveReady(): Promise<boolean> {
  return hasColumn('nivaro_chat_channels', 'archive_suggested_at')
}

/** Idle days from settings; 0 = suggestions off. */
export async function getIdleDays(): Promise<number> {
  if (!(await hasColumn('nivaro_settings', 'chat_archive_idle_days'))) return DEFAULT_IDLE_DAYS
  const row = (await db('nivaro_settings').where('id', 1).first('chat_archive_idle_days')) as
    | { chat_archive_idle_days?: number | null }
    | undefined
  const v = row?.chat_archive_idle_days
  if (v === null || v === undefined) return DEFAULT_IDLE_DAYS
  return Math.max(0, Math.floor(Number(v)) || 0)
}

export async function setIdleDays(days: number | null): Promise<void> {
  if (!(await hasColumn('nivaro_settings', 'chat_archive_idle_days'))) return
  await db('nivaro_settings').where('id', 1).update({ chat_archive_idle_days: days })
}

export interface IdleCandidate {
  isArchived: boolean
  isDirect: boolean
  createdBy: string | null
  createdAt: Date | string | null
  lastPostAt: Date | string | null
  keptAt: Date | string | null
  suggestedAt: Date | string | null
}

/** When the channel's idle clock started: its last post (or creation), pushed back by a Keep. */
export function idleSince(c: Pick<IdleCandidate, 'createdAt' | 'lastPostAt' | 'keptAt'>): number {
  const t = (v: Date | string | null) => (v ? new Date(v).getTime() : 0)
  return Math.max(t(c.lastPostAt) || t(c.createdAt), t(c.keptAt))
}

/** Pure decision: should this channel get an archive suggestion now? */
export function shouldSuggestArchive(c: IdleCandidate, idleDays: number, now: Date): boolean {
  if (idleDays <= 0) return false
  if (c.isArchived || c.isDirect || c.suggestedAt) return false
  const since = idleSince(c)
  if (!since) return false
  return now.getTime() - since >= idleDays * DAY
}

async function lastPosts(): Promise<Map<string, Date>> {
  const rows = (await db('chat_messages')
    .where('room', 'like', 'ch:%')
    .whereNull('deleted_at')
    .groupBy('room')
    .select('room')
    .max({ last: 'date_created' })) as Array<{ room: string; last: Date | string | null }>
  return new Map(
    rows.filter((r) => r.last).map((r) => [String(r.room), new Date(r.last as string)])
  )
}

/** Run the sweep. Returns the channels that got a suggestion. */
export async function suggestIdleChannels(
  app: FastifyInstance,
  now = new Date()
): Promise<Array<{ key: string; owner: string | null }>> {
  if (!(await archiveReady())) return []
  const idleDays = await getIdleDays()
  if (idleDays <= 0) return []
  const rows = (await db('nivaro_chat_channels')
    .where({ is_archived: false, is_direct: false })
    .whereNull('archive_suggested_at')) as Array<Record<string, unknown>>
  const posts = await lastPosts()
  const out: Array<{ key: string; owner: string | null }> = []
  for (const r of rows) {
    const key = String(r.key)
    if (key.startsWith('grp-')) continue
    const cand: IdleCandidate = {
      isArchived: false,
      isDirect: false,
      createdBy: r.created_by ? String(r.created_by) : null,
      createdAt: (r.created_at as Date | null) ?? null,
      lastPostAt: posts.get(`ch:${key}`) ?? null,
      keptAt: (r.archive_kept_at as Date | null) ?? null,
      suggestedAt: null
    }
    if (!shouldSuggestArchive(cand, idleDays, now)) continue
    await db('nivaro_chat_channels').where({ id: r.id }).update({ archive_suggested_at: now })
    out.push({ key, owner: cand.createdBy })
    if (cand.createdBy) {
      try {
        const owner = (await db('nivaro_users').where({ id: cand.createdBy }).first('status')) as
          | { status?: string | null }
          | undefined
        if (owner && owner.status !== 'suspended') {
          const { notifyUser } = await import('./notification-channels.js')
          await notifyUser(app, cand.createdBy, {
            subject: `#${r.name ?? key} has been quiet for ${idleDays} days`,
            message:
              'Archive it to tidy the channel list, or keep it open. Archived channels stay searchable and can be reopened.',
            category: 'system',
            collection: '__chat__',
            item: `ch:${key}`
          })
        }
      } catch {
        /* best-effort — the channel still shows the suggestion */
      }
    }
  }
  if (out.length) clearChatCaches()
  return out
}

/** The owner's (or an admin's) answer to a suggestion. */
export async function answerArchiveSuggestion(
  channelId: number,
  action: 'archive' | 'keep',
  actorId: string
): Promise<boolean> {
  if (!(await archiveReady())) return false
  const row = (await db('nivaro_chat_channels').where({ id: channelId }).first('id', 'key')) as
    | { id: number; key: string }
    | undefined
  if (!row) return false
  const now = new Date()
  await db('nivaro_chat_channels')
    .where({ id: row.id })
    .update(
      action === 'archive'
        ? { is_archived: true, archive_suggested_at: null }
        : { archive_kept_at: now, archive_suggested_at: null }
    )
  clearChatCaches()
  await logActivity({
    action: 'chat-channel-update',
    user: actorId,
    collection: 'nivaro_chat_channels',
    item: row.key,
    comment:
      action === 'archive' ? 'archived (idle suggestion accepted)' : 'kept open (idle suggestion)'
  })
  return true
}

export interface ArchiveOverviewRow {
  id: number
  key: string
  name: string
  owner_id: string | null
  owner_name: string | null
  last_post_at: string | null
  suggested_at: string | null
  kept_at: string | null
  archived: boolean
}

/** Suggested and archived channels, for administrators. */
export async function archiveOverview(): Promise<{
  idle_days: number
  suggested: ArchiveOverviewRow[]
  archived: ArchiveOverviewRow[]
}> {
  const idle_days = await getIdleDays()
  const ready = await archiveReady()
  const all = [...(await channels()).values()].filter((c) => !c.is_direct)
  const wanted = all.filter((c) => c.is_archived || (ready && c.archive_suggested_at))
  if (wanted.length === 0) return { idle_days, suggested: [], archived: [] }
  const posts = await lastPosts()
  const ownerIds = [...new Set(wanted.map((c) => c.created_by).filter(Boolean))] as string[]
  const owners = ownerIds.length
    ? ((await db('nivaro_users')
        .whereIn('id', ownerIds)
        .select('id', 'first_name', 'last_name', 'email')) as Array<Record<string, string | null>>)
    : []
  const ownerName = new Map(
    owners.map((u) => [
      String(u.id).toUpperCase(),
      [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null
    ])
  )
  const iso = (v: Date | string | null | undefined) => (v ? new Date(v).toISOString() : null)
  const rows = wanted.map<ArchiveOverviewRow>((c) => ({
    id: c.id,
    key: c.key,
    name: c.name,
    owner_id: c.created_by,
    owner_name: c.created_by ? (ownerName.get(c.created_by.toUpperCase()) ?? null) : null,
    last_post_at: iso(posts.get(`ch:${c.key}`)),
    suggested_at: iso(c.archive_suggested_at),
    kept_at: iso(c.archive_kept_at),
    archived: c.is_archived
  }))
  return {
    idle_days,
    suggested: rows.filter((r) => !r.archived && r.suggested_at),
    archived: rows.filter((r) => r.archived)
  }
}
