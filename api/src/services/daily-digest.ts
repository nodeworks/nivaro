import type { DigestLine, DigestSection, DigestSectionProvider } from '@nivaro/extension-kit'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { logActivity } from './activity.js'
import { linkTo, recordLink } from './app-links.js'
import { chunkArray } from './db-batch.js'
import { type DeferredSnippet, decodeDeferredSnippet } from './deferred-snippet.js'
import { sendRawMail } from './mail.js'
import { classifyNotification, emailModeFor, type NotifyPrefs } from './notification-channels.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'
import {
  ADDENDUM_COLLECTION,
  type AddendumInfo,
  addendumLabel,
  loadAddendums
} from './pipeline-subject.js'
import { fetchQueueItems } from './queues.js'

export type { DigestLine, DigestSection, DigestSectionProvider } from '@nivaro/extension-kit'

/**
 * Daily action summary — ONE morning email per user, at their chosen hour:
 *
 *  - notification emails deferred for them (category email mode 'daily' or
 *    quiet hours — applyDigestDeferral in mail.ts, nivaro_deferred_emails)
 *  - the notification digest: in-app notifications since last_digest_at for
 *    users with subscriptions on the Daily / Weekly cadence (weekly rides the
 *    Monday summary), filtered by the category email matrix — a category on
 *    "No email" drops its items — plus a stat line per queue subscription
 *  - "assigned to you" open workflow items (live owner resolution)
 *  - sections registered by extensions (ctx.digest.registerSection)
 *
 * The separate "Your daily Nivaro digest" email + digest-daily/weekly crons
 * were folded in here (2026-09-10): two digests with different names and
 * hours were a reported collision.
 */

const DIGEST_WHY = 'you asked for a daily summary instead of individual emails'

const providers: DigestSectionProvider[] = []

/** Extensions add per-user digest sections here (via ctx.digest.registerSection). */
export function registerDigestSection(fn: DigestSectionProvider): void {
  providers.push(fn)
}

/** Returns user ids who should get a summary even when nothing else would
 *  send them one (an opt-in section's subscribers). */
export type DigestAudienceProvider = () => Promise<string[]>
const audiences: DigestAudienceProvider[] = []

export function registerDigestAudience(fn: DigestAudienceProvider): void {
  audiences.push(fn)
}

function parsePrefs(raw: unknown): Record<string, unknown> | null {
  if (raw == null) return null
  if (typeof raw === 'object') return raw as Record<string, unknown>
  try {
    return JSON.parse(String(raw)) as Record<string, unknown>
  } catch {
    return null
  }
}

const esc = (s: unknown): string =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string
  )

function sectionHtml(section: DigestSection): string {
  const items = section.lines
    .map((l) => {
      const label = l.url
        ? `<a href="${esc(l.url)}" style="color:#04516b;text-decoration:underline;">${esc(l.text)}</a>`
        : esc(l.text)
      const sub = l.sub ? ` <span style="color:#64748b;">— ${esc(l.sub)}</span>` : ''
      return `<li style="margin:0 0 6px 0;">${label}${sub}</li>`
    })
    .join('')
  return `
    <h3 style="margin:18px 0 8px 0;font-size:14px;color:#0f172a;">${esc(section.title)}</h3>
    <ul style="margin:0;padding-left:18px;font-size:13px;color:#334155;">${items}</ul>`
}

const MAX_DIGEST_NOTIFICATIONS = 50
const DAY_MS = 24 * 60 * 60 * 1000

/** In-app notifications since the user's last digest watermark, minus the
 *  categories whose email mode is "No email" — the matrix and the
 *  subscription cadence agree instead of fighting. */
async function buildNotificationDigestSection(
  userId: string,
  cadence: 'daily' | 'weekly',
  since: Date | null,
  prefs: Record<string, unknown> | null
): Promise<DigestSection | null> {
  const window = since ?? new Date(Date.now() - (cadence === 'weekly' ? 7 : 1) * DAY_MS)
  const rows = (await db('nivaro_notifications')
    .where({ recipient: userId })
    .where('timestamp', '>', window)
    .orderBy('timestamp', 'desc')
    .limit(MAX_DIGEST_NOTIFICATIONS)
    .select('id', 'subject', 'message', 'collection', 'item', 'timestamp')) as Array<{
    id: number
    subject: string | null
    message: string | null
    collection: string | null
    item: string | null
    timestamp: Date | string
  }>
  const np = (prefs?.['notification_prefs'] ?? null) as NotifyPrefs | null
  const legacy = prefs?.['email_digest']
  const kept = rows.filter(
    (n) => emailModeFor(np, classifyNotification(n.subject ?? ''), legacy) !== 'off'
  )
  if (kept.length === 0) return null
  const lines: DigestLine[] = []
  for (const n of kept) {
    lines.push({
      text: n.subject ?? 'Notification',
      sub: (n.message ?? '').slice(0, 120) || null,
      url: n.collection && n.item ? await recordLinkFor(n.collection, n.item, userId) : null
    })
  }
  return {
    title: `${cadence === 'weekly' ? 'This week' : 'Since your last summary'} — ${kept.length} notification${kept.length === 1 ? '' : 's'}`,
    lines
  }
}

/** One stat line per queue subscription on the digest cadence. */
async function buildQueueSubscriptionSection(
  userId: string,
  cadences: Set<'daily' | 'weekly'>
): Promise<DigestSection | null> {
  const subs = (await db('nivaro_notification_subscriptions as ns')
    .join('nivaro_queues as q', 'ns.queue_id', 'q.id')
    .where({ 'ns.user': userId, 'ns.is_active': true })
    .whereIn('ns.digest_frequency', [...cadences])
    .whereNotNull('ns.queue_id')
    .select('q.id as queue_id', 'q.name as queue_name')) as Array<{
    queue_id: string
    queue_name: string
  }>
  if (subs.length === 0) return null
  const fullUser = (await db('nivaro_users').where({ id: userId }).first()) as User | undefined
  if (!fullUser) return null
  const lines: DigestLine[] = []
  for (const sub of subs) {
    try {
      const { stats } = await fetchQueueItems(sub.queue_id, fullUser, 'all')
      const parts = [`${stats.total} item${stats.total === 1 ? '' : 's'}`]
      if (stats.unowned) parts.push(`${stats.unowned} unowned`)
      if (stats.sla_breached) parts.push(`${stats.sla_breached} past SLA`)
      else if (stats.sla_warning) parts.push(`${stats.sla_warning} nearing SLA`)
      if (stats.at_risk) parts.push(`${stats.at_risk} at risk`)
      lines.push({
        text: sub.queue_name,
        sub: parts.join(' · '),
        url: await linkTo('queue', { id: sub.queue_id }, { recipientUserId: userId }).catch(
          () => null
        )
      })
    } catch (err) {
      console.warn('[daily-digest] queue summary failed for', sub.queue_id, err)
    }
  }
  return lines.length > 0 ? { title: `Your queues (${lines.length})`, lines } : null
}

/** One open item a person owns — labelled and linked per recipient at send time. */
export interface OwnedRef {
  collection: string
  item: string
  stateLabel: string | null
  addendum: AddendumInfo | null
}

/** Open items shown per person before "+N more"; the rest are on My Work. */
export const MAX_OWNED_LINES = 25

/** A record link in the RECIPIENT's app (portal for portal people, admin for
 *  admins) — never raw ADMIN_URL (army 4, 2026-11-05). Null when no link
 *  can be built. */
async function recordLinkFor(
  collection: string,
  item: string,
  userId: string,
  query?: string
): Promise<string | null> {
  return recordLink(collection, item, { recipientUserId: userId, query }).catch(() => null)
}

/**
 * The held mails as summary lines (army 11): newest first, ONE line per record (the latest
 * thing that happened, "+N earlier updates"), each linked to its record for this reader, with
 * the mail's own summary sentence — never the stripped page.
 */
export async function deferredLines(
  rows: Array<{ subject: string; snippet: string | null; created_at: Date | string }>,
  userId: string,
  link: (collection: string, item: string) => Promise<string | null> = (c, i) =>
    recordLinkFor(c, i, userId)
): Promise<DigestLine[]> {
  const newest = [...rows].sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
  const groups = new Map<string, { row: (typeof rows)[number]; snip: DeferredSnippet; n: number }>()
  const order: string[] = []
  newest.forEach((row, idx) => {
    const snip = decodeDeferredSnippet(row.snippet)
    const key = snip.collection && snip.item ? `${snip.collection}:${snip.item}` : `#${idx}`
    const g = groups.get(key)
    if (g) g.n++
    else {
      groups.set(key, { row, snip, n: 1 })
      order.push(key)
    }
  })
  const out: DigestLine[] = []
  for (const key of order.slice(0, 30)) {
    const { row, snip, n } = groups.get(key)!
    const more = n > 1 ? `+${n - 1} earlier ${n === 2 ? 'update' : 'updates'}` : ''
    const sub = [snip.text, more].filter(Boolean).join(' · ')
    out.push({
      text: row.subject,
      sub: sub || null,
      url: snip.collection && snip.item ? await link(snip.collection, snip.item) : null
    })
  }
  return out
}

/** Open workflow-engine items where the user is a resolved current-state owner. */
async function buildOwnershipBuckets(): Promise<{
  buckets: Map<string, OwnedRef[]>
  labelFor: (collection: string) => string
}> {
  // Bound collections' instances PLUS addendum instances (never bound —
  // pipeline-subject.ts); an addendum awaiting your approval is an action.
  const instances = (await db('nivaro_workflow_instances as wi')
    .leftJoin('nivaro_workflow_bindings as b', 'wi.collection', 'b.collection')
    .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
    .where((qb) => qb.whereNotNull('b.collection').orWhere('wi.collection', ADDENDUM_COLLECTION))
    .whereNotNull('wi.current_state')
    .whereNull('wi.completed_at')
    .where((qb) => qb.where('s.is_terminal', false).orWhereNull('s.is_terminal'))
    .select(
      'wi.id as instance_id',
      'wi.collection',
      'wi.item',
      'wi.current_state',
      's.label as state_label'
    )) as Array<{
    instance_id: string
    collection: string
    item: string
    current_state: string
    state_label: string | null
  }>
  const buckets = new Map<string, OwnedRef[]>()

  // Collection labels from the registry (singular preferred), titleCase
  // fallback — never hardcode deployment collection names here.
  const collectionLabels = new Map<string, string>()
  const labelFor = (c: string) =>
    collectionLabels.get(c) ??
    c
      .replace(/_/g, ' ')
      .replace(/\b\w/g, (ch) => ch.toUpperCase())
      .replace(/s$/, '')
  if (instances.length === 0) return { buckets, labelFor }
  try {
    const distinct = [...new Set(instances.map((i) => i.collection))]
    const metas = (await db('nivaro_collections')
      .whereIn('collection', distinct)
      .select('collection', 'display_name', 'singular')) as Array<{
      collection: string
      display_name: string | null
      singular: string | null
    }>
    for (const m of metas) {
      if (m.singular || m.display_name) {
        collectionLabels.set(m.collection, (m.singular || m.display_name) as string)
      }
    }
  } catch {
    /* fall back to titleCase */
  }

  const ownersByKey = await resolveStateOwnersBatch(
    instances.map((inst) => ({
      key: `${inst.collection}:${inst.item}`,
      stateId: inst.current_state,
      instanceId: inst.instance_id,
      collection: inst.collection,
      itemId: inst.item
    }))
  )
  const addendumInfos = await loadAddendums(
    instances.filter((i) => i.collection === ADDENDUM_COLLECTION).map((i) => String(i.item))
  )
  for (const inst of instances) {
    const owners = ownersByKey.get(`${inst.collection}:${inst.item}`) ?? []
    const info =
      inst.collection === ADDENDUM_COLLECTION
        ? (addendumInfos.get(String(inst.item)) ?? null)
        : null
    for (const o of owners) {
      if (!buckets.has(o.id)) buckets.set(o.id, [])
      buckets.get(o.id)!.push({
        collection: inst.collection,
        item: String(inst.item),
        stateLabel: inst.state_label,
        addendum: info
      })
    }
  }
  return { buckets, labelFor }
}

/** Friendly labels (the collection's display template — "CR26-81383", not the
 *  internal id) for every ref that will actually be shown, one batched read
 *  per collection. Addendums label by their PARENT record. */
async function labelOwnedRefs(refs: OwnedRef[]): Promise<Record<string, string>> {
  const byCollection = new Map<string, Set<string>>()
  for (const r of refs) {
    const c = r.addendum ? r.addendum.parentCollection : r.collection
    const id = r.addendum ? r.addendum.parentId : r.item
    if (!c || !id) continue
    if (!byCollection.has(c)) byCollection.set(c, new Set())
    byCollection.get(c)!.add(String(id))
  }
  if (byCollection.size === 0) return {}
  try {
    const { getLabels } = await import('./queues.js')
    return await getLabels(byCollection)
  } catch {
    return {}
  }
}

/** The digest lines for one person's owned items: the first MAX_OWNED_LINES,
 *  labelled + linked for THEM, then a "+N more" line to My Work. */
export async function ownedLines(
  owned: OwnedRef[],
  labels: Record<string, string>,
  labelFor: (collection: string) => string,
  links: {
    record(collection: string, item: string, query?: string): Promise<string | null>
    myWork(): Promise<string | null>
  }
): Promise<DigestLine[]> {
  const lines: DigestLine[] = []
  for (const r of owned.slice(0, MAX_OWNED_LINES)) {
    if (r.addendum) {
      const pc = r.addendum.parentCollection
      const pid = r.addendum.parentId
      const parentLabel =
        pc && pid ? `${labelFor(pc)} ${labels[`${pc}:${pid}`]?.trim() || pid}` : null
      lines.push({
        text: addendumLabel(r.addendum, parentLabel),
        sub: r.stateLabel,
        url:
          pc && pid
            ? await links.record(pc, pid, `addendum=${encodeURIComponent(r.addendum.id)}`)
            : null
      })
      continue
    }
    const friendly = labels[`${r.collection}:${r.item}`]?.trim()
    lines.push({
      text: `${labelFor(r.collection)} ${friendly || r.item}`,
      sub: r.stateLabel,
      url: await links.record(r.collection, r.item)
    })
  }
  const more = owned.length - lines.length
  if (more > 0) {
    lines.push({
      text: `+${more} more — see them all on My Work`,
      sub: null,
      url: await links.myWork()
    })
  }
  return lines
}

/**
 * `hour` (0-23, America/New_York) is the current ET hour the hourly cron
 * passes; a manual run passes nothing and sends to everyone due (#75). A
 * recipient is kept when preferences.digest_hour matches the current hour in
 * their preferences.timezone (#117), or `hour` itself when that is unset or
 * not a zone Intl knows. Users without the pref default to 7 (the historic
 * 07:45 send).
 */
export async function runDailyActionDigest(
  hour?: number,
  opts?: {
    /** Test-send (#96): build + send for ONLY this user, regardless of their
     *  pref or delivery hour, and DON'T flush their deferred rows — the real
     *  digest must still carry them. */
    onlyUserId?: string
    preserveDeferred?: boolean
    /** Harness preview: hand the rendered mail back instead of sending it. */
    capture?: (mail: { to: string; subject: string; html: string }) => void
  }
): Promise<{ sent: number }> {
  // Opt-in users + anyone holding deferred rows (covers a pref flipped back).
  const users = (await db('nivaro_users')
    .where('status', 'active')
    .where('is_redacted', 0)
    .whereNotNull('preferences')
    .select('id', 'email', 'preferences', 'role')) as Array<{
    id: string
    email: string
    preferences: unknown
    role?: string | null
  }>
  // #3077 — a role whose defaults send a category to the daily summary opts its people in.
  const { rolesWithDailyEmail } = await import('./notification-role-defaults.js')
  const dailyRoles = await rolesWithDailyEmail().catch(() => new Set<string>())
  const digestUsers = new Map<string, string>() // id -> email
  const prefHour = new Map<string, number>()
  const prefTz = new Map<string, string>()
  const prefLayout = new Map<string, string>()
  for (const u of users) {
    const p = parsePrefs(u.preferences)
    const h = Number(p?.['digest_hour'])
    prefHour.set(u.id, Number.isInteger(h) && h >= 0 && h <= 23 ? h : 7)
    const tz = typeof p?.['timezone'] === 'string' ? (p['timezone'] as string) : ''
    if (tz) prefTz.set(u.id, tz)
    if (p?.['digest_layout'] === 'compact') prefLayout.set(u.id, 'compact')
    const matrix = ((
      p?.['notification_prefs'] as { matrix?: Record<string, { email?: string }> } | undefined
    )?.matrix ?? {}) as Record<string, { email?: string }>
    const anyDaily =
      Object.values(matrix).some((r) => r?.email === 'daily') ||
      (u.role != null && dailyRoles.has(String(u.role).toUpperCase()))
    if (p && (p['email_digest'] === 'daily' || anyDaily) && u.email) digestUsers.set(u.id, u.email)
  }
  // Subscription cadence: anyone with an active Daily subscription gets the
  // notification digest every day; Weekly subscriptions ride Monday's summary.
  const isMonday = new Date().getDay() === 1
  const subCadence = new Map<string, Set<'daily' | 'weekly'>>()
  try {
    const rows = (await db('nivaro_notification_subscriptions as ns')
      .join('nivaro_users as u', 'ns.user', 'u.id')
      .where({ 'ns.is_active': true })
      .whereIn('ns.digest_frequency', ['daily', 'weekly'])
      .where((qb) => {
        qb.whereNull('ns.notify_email').orWhere('ns.notify_email', true)
      })
      .where('u.status', 'active')
      .select('u.id', 'u.email', 'ns.digest_frequency')) as Array<{
      id: string
      email: string | null
      digest_frequency: 'daily' | 'weekly'
    }>
    for (const r of rows) {
      if (!r.email) continue
      if (r.digest_frequency === 'weekly' && !isMonday && !opts?.onlyUserId) continue
      const set = subCadence.get(r.id) ?? new Set<'daily' | 'weekly'>()
      set.add(r.digest_frequency)
      subCadence.set(r.id, set)
      if (!digestUsers.has(r.id)) digestUsers.set(r.id, r.email)
    }
  } catch (err) {
    console.warn('[daily-digest] subscription cadence lookup failed:', err)
  }
  // Opt-in section audiences (integration alert digests, …): active,
  // unredacted users with an email join the run; their section provider
  // decides what, if anything, they see.
  for (const audience of audiences) {
    try {
      const ids = [...new Set((await audience()).map((id) => String(id)))]
      for (const chunk of chunkArray(ids, 1000)) {
        const rows = (await db('nivaro_users')
          .whereIn('id', chunk)
          .where('status', 'active')
          .where('is_redacted', 0)
          .whereNotNull('email')
          .select('id', 'email')) as Array<{ id: string; email: string }>
        for (const r of rows) if (!digestUsers.has(r.id)) digestUsers.set(r.id, r.email)
      }
    } catch (err) {
      console.warn(
        '[daily-digest] audience lookup failed:',
        err instanceof Error ? err.message : err
      )
    }
  }
  const prefsById = new Map<string, Record<string, unknown> | null>()
  for (const u of users) prefsById.set(u.id, parsePrefs(u.preferences))
  const lastDigestAt = new Map<string, Date | null>()
  try {
    const rows = (await db('nivaro_users')
      .whereIn('id', [...subCadence.keys()])
      .select('id', 'last_digest_at')) as Array<{ id: string; last_digest_at: Date | null }>
    for (const r of rows)
      lastDigestAt.set(r.id, r.last_digest_at ? new Date(r.last_digest_at) : null)
  } catch {
    /* watermark lookup failed — default windows below */
  }

  const deferred = (await db('nivaro_deferred_emails').select(
    'id',
    'user',
    'email',
    'subject',
    'snippet',
    'created_at'
  )) as Array<{
    id: number
    user: string
    email: string
    subject: string
    snippet: string | null
    created_at: Date
  }>
  for (const d of deferred) if (!digestUsers.has(d.user)) digestUsers.set(d.user, d.email)
  if (opts?.onlyUserId) {
    const target = users.find((u) => u.id === opts.onlyUserId)
    digestUsers.clear()
    if (target?.email) digestUsers.set(target.id, target.email)
  } else if (hour != null) {
    // Digest hour in the USER's timezone (#117): a preference of 7 means 7am
    // where they are, not 7am Eastern. Users without a timezone keep the
    // historic Eastern interpretation (the cron's `hour` argument).
    for (const id of [...digestUsers.keys()]) {
      const tz = prefTz.get(id)
      let localHour = hour
      if (tz) {
        try {
          localHour = Number(
            new Intl.DateTimeFormat('en-US', {
              timeZone: tz,
              hour: 'numeric',
              hour12: false
            }).format(new Date())
          )
          if (!Number.isInteger(localHour)) localHour = hour
        } catch {
          localHour = hour
        }
      }
      if ((prefHour.get(id) ?? 7) !== localHour) digestUsers.delete(id)
    }
  }
  if (digestUsers.size === 0) return { sent: 0 }

  const { buckets: ownership, labelFor } = await buildOwnershipBuckets()
  // Labels only for the items that will be shown (the first MAX_OWNED_LINES
  // of each person due a summary) — one batched read per collection.
  const ownedLabels = await labelOwnedRefs(
    [...digestUsers.keys()].flatMap((id) => (ownership.get(id) ?? []).slice(0, MAX_OWNED_LINES))
  )
  const deferredByUser = new Map<string, typeof deferred>()
  for (const d of deferred) {
    if (!deferredByUser.has(d.user)) deferredByUser.set(d.user, [])
    deferredByUser.get(d.user)!.push(d)
  }

  let sent = 0
  const flushedIds: number[] = []
  for (const [userId, email] of digestUsers) {
    const sections: DigestSection[] = []

    const mine = deferredByUser.get(userId) ?? []
    if (mine.length > 0) {
      sections.push({
        title: `Updates since your last summary (${mine.length})`,
        lines: await deferredLines(mine, userId)
      })
    }

    // Notification digest for Daily/Weekly subscriptions — same rows the
    // bell shows, minus categories the user set to "No email".
    let digestedNotifications = false
    const cadences = subCadence.get(userId)
    if (cadences && cadences.size > 0) {
      try {
        const section = await buildNotificationDigestSection(
          userId,
          cadences.has('weekly') ? 'weekly' : 'daily',
          lastDigestAt.get(userId) ?? null,
          prefsById.get(userId) ?? null
        )
        if (section) {
          sections.push(section)
          digestedNotifications = true
        }
        const queueSection = await buildQueueSubscriptionSection(userId, cadences)
        if (queueSection) sections.push(queueSection)
      } catch (err) {
        console.warn('[daily-digest] notification digest failed for', userId, err)
      }
    }

    const owned = ownership.get(userId) ?? []
    if (owned.length > 0) {
      sections.push({
        title: `Open items assigned to you (${owned.length})`,
        lines: await ownedLines(owned, ownedLabels, labelFor, {
          record: (collection, item, query) => recordLinkFor(collection, item, userId, query),
          myWork: () => linkTo('my_work', {}, { recipientUserId: userId }).catch(() => null)
        })
      })
    }

    for (const provider of providers) {
      try {
        const section = await provider(userId, email)
        if (section && section.lines.length > 0) sections.push(section)
      } catch (err) {
        console.warn(
          '[daily-digest] section provider failed:',
          err instanceof Error ? err.message : err
        )
      }
    }

    if (sections.length === 0) continue
    // Digest layout choice (#366): 'compact' sends section counts only — one
    // glance, click through for detail; 'detailed' (default) keeps the lines.
    const compact = prefLayout.get(userId) === 'compact'
    const bodyHtml = compact
      ? `<ul style="margin:8px 0;padding-left:18px;font-size:13px;color:#334155;">${sections
          .map((sec) => `<li style="margin:2px 0;">${sec.title}</li>`)
          .join('')}</ul>`
      : sections.map(sectionHtml).join('')
    try {
      const digestHtml = `
          <p style="margin:0 0 4px 0;font-size:13px;color:#334155;">
            Everything waiting on you, in one place. You're receiving this instead of
            individual notification emails — switch back any time from your profile.
          </p>
          ${bodyHtml}`
      if (opts?.capture) {
        const { wrapMailFragment } = await import('./mail.js')
        opts.capture({
          to: email,
          subject: 'Your daily action summary',
          html: await wrapMailFragment(digestHtml, 'Daily action summary', {
            why: DIGEST_WHY
          })
        })
        sent++
        continue
      }
      await sendRawMail({
        to: email,
        subject: 'Your daily action summary',
        title: 'Daily action summary',
        html: digestHtml,
        template: 'daily_digest',
        why: DIGEST_WHY,
        skipDigest: true,
        rolePicked: true
      })
      sent++
      if (!opts?.preserveDeferred) flushedIds.push(...mine.map((d) => d.id))
      // Advance the notification-digest watermark only when a digest section
      // actually went out (a test send never moves it).
      if (digestedNotifications && !opts?.onlyUserId) {
        await db('nivaro_users')
          .where({ id: userId })
          .update({ last_digest_at: new Date() })
          .catch(() => undefined)
      }
    } catch (err) {
      console.warn(
        '[daily-digest] send failed for',
        email,
        err instanceof Error ? err.message : err
      )
    }
  }

  if (flushedIds.length > 0) {
    for (let i = 0; i < flushedIds.length; i += 1000) {
      await db('nivaro_deferred_emails')
        .whereIn('id', flushedIds.slice(i, i + 1000))
        .del()
    }
  }
  if (opts?.onlyUserId) return { sent } // test-sends don't log the daily run
  await logActivity({
    action: 'daily-action-digest',
    user: null,
    collection: 'nivaro_users',
    comment: `${sent} daily action summaries sent (${deferred.length} deferred updates flushed)`
  })
  return { sent }
}
