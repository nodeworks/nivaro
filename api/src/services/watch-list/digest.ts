import { db } from '../../db/index.js'
import type { User } from '../../types.js'
import { peopleWith } from './flags.js'
import type { WatchRow } from './rows.js'
import { pinKey, type WatchListPrefs } from './store.js'
import { updateWatchList } from './user-store.js'

/**
 * The daily watch-list email (rt6 #9): what changed on a person's pinned records in the last
 * day, read AS THEM (the same rows reader as the dock: their record gate, their field list, a
 * change on a field they cannot read is no change). Opt-in (settings.digest), one email a day
 * (`digest_sent_on`), nothing on a day with no change by someone else, never to a machine
 * account or someone who cannot sign in. Cron `watch-list-digest`, 07:00 server time.
 */

export const DIGEST_WINDOW_MS = 24 * 3600_000

export interface DigestItem {
  key: string
  title: string
  collection_label: string
  step: string | null
  text: string
  by: string | null
  at: string
  url?: string
}

/** The person's list with "seen" moved to the window start: a change inside it lights. Pure. */
export function windowList(list: WatchListPrefs, now: Date): WatchListPrefs {
  const start = new Date(now.getTime() - DIGEST_WINDOW_MS).toISOString()
  const seen: Record<string, string> = {}
  for (const p of list.pins) seen[pinKey(p.c, p.id)] = start
  return { ...list, seen }
}

/** Rows that changed by someone else in the window → the email's lines, newest first. Pure. */
export function digestItems(rows: WatchRow[]): DigestItem[] {
  return rows
    .filter((r) => r.available && r.change?.changed && r.change.by?.self !== true)
    .map((r) => ({
      key: r.key,
      title: r.title ?? r.collection_label,
      collection_label: r.collection_label,
      step: r.state?.label ?? null,
      text: r.change?.text ?? 'Changed',
      by: r.change?.by && !r.change.by.self ? r.change.by.name : null,
      at: r.change?.at ?? ''
    }))
    .sort((a, z) => (a.at < z.at ? 1 : a.at > z.at ? -1 : 0))
}

/** "YYYY-MM-DD" in the server's own day. Pure. */
export function dayOf(now: Date): string {
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

/** Should this person get today's email at all (before any read)? Pure. */
export function digestDue(list: WatchListPrefs, now: Date): boolean {
  return list.settings.digest && list.pins.length > 0 && list.digest_sent_on !== dayOf(now)
}

async function sendOne(
  userId: string,
  list: WatchListPrefs,
  now: Date
): Promise<'sent' | 'empty' | 'skipped'> {
  const user = (await db('nivaro_users')
    .where({ id: userId })
    .first()
    .catch(() => undefined)) as (User & Record<string, unknown>) | undefined
  if (!user?.email) return 'skipped'
  if ((user.status && String(user.status) !== 'active') || user.is_redacted || user.account_kind)
    return 'skipped'
  const { isAdminRole } = await import('../user-scopes.js')
  const isAdmin = await isAdminRole(user.role as string | null).catch(() => false)
  const { readWatchRows } = await import('./rows.js')
  const { rows } = await readWatchRows(windowList(list, now), { user, isAdmin, now })
  const items = digestItems(rows)
  // Mark the day either way: an empty day is "done" too, never re-read.
  await updateWatchList(
    userId,
    (l) => (l.digest_sent_on === dayOf(now) ? null : { ...l, digest_sent_on: dayOf(now) }),
    { announce: false }
  ).catch(() => null)
  if (items.length === 0) return 'empty'
  const { recordLink, linkTo } = await import('../app-links.js')
  for (const it of items) {
    const [c, ...rest] = it.key.split(':')
    it.url = await recordLink(c, rest.join(':'), { recipientUserId: userId }).catch(() => undefined)
  }
  const { sendMail } = await import('../mail.js')
  const homeUrl = await linkTo('home', {}, { recipientUserId: userId }).catch(() => null)
  await sendMail({
    to: String(user.email),
    subject: `Your watch list: ${items.length} record${items.length === 1 ? '' : 's'} changed`,
    template: 'watch_list_digest',
    data: {
      first_name: user.first_name ?? '',
      count: items.length,
      items: items.map((i) => ({
        ...i,
        when: new Date(i.at).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
      })),
      home_url: homeUrl
    },
    category: 'watch_list' as never,
    cadence: 'sender',
    skipDigest: true,
    rolePicked: true,
    why: 'you turned on the daily email in your watch list settings'
  })
  return 'sent'
}

/** The daily pass. */
export async function runWatchDigest(
  now: Date = new Date()
): Promise<{ people: number; sent: number; empty: number }> {
  const people = await peopleWith('wl_digest')
  let sent = 0
  let empty = 0
  for (const [userId, list] of people) {
    if (!digestDue(list, now)) continue
    try {
      const r = await sendOne(userId, list, now)
      if (r === 'sent') sent++
      else if (r === 'empty') empty++
    } catch {
      /* one person's failure never stops the rest */
    }
  }
  return { people: people.size, sent, empty }
}
