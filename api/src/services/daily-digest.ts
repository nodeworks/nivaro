import { config } from '../config.js'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { sendRawMail } from './mail.js'
import { resolveStateOwnersBatch } from './pipeline-engine.js'

/**
 * Daily action digest — one summary email per user who opted into
 * preferences.email_digest = 'daily' (Profile → Email delivery), replacing
 * the individual notification emails captured for them in
 * nivaro_deferred_emails (see applyDigestDeferral in mail.ts).
 *
 * Content = deferred updates + "assigned to you" open workflow items (core,
 * from live owner resolution) + any sections registered by extensions
 * (ctx.digest.registerSection — e.g. efp-ops' invoices-awaiting-review).
 */

export interface DigestLine {
  text: string
  sub?: string | null
  url?: string | null
}

export interface DigestSection {
  title: string
  lines: DigestLine[]
}

export type DigestSectionProvider = (
  userId: string,
  email: string
) => Promise<DigestSection | null>

const providers: DigestSectionProvider[] = []

/** Extensions add per-user digest sections here (via ctx.digest.registerSection). */
export function registerDigestSection(fn: DigestSectionProvider): void {
  providers.push(fn)
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

/** Open workflow-engine items where the user is a resolved current-state owner. */
async function buildOwnershipBuckets(): Promise<Map<string, DigestLine[]>> {
  const instances = (await db('nivaro_workflow_instances as wi')
    .join('nivaro_workflow_bindings as b', 'wi.collection', 'b.collection')
    .leftJoin('nivaro_workflow_states as s', 'wi.current_state', 's.id')
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
  const buckets = new Map<string, DigestLine[]>()
  if (instances.length === 0) return buckets

  // Collection labels from the registry (singular preferred), titleCase
  // fallback — never hardcode deployment collection names here.
  const collectionLabels = new Map<string, string>()
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
    /* fall back to titleCase below */
  }
  const labelFor = (c: string) =>
    collectionLabels.get(c) ??
    c.replace(/_/g, ' ').replace(/\b\w/g, (ch) => ch.toUpperCase()).replace(/s$/, '')

  const ownersByKey = await resolveStateOwnersBatch(
    instances.map((inst) => ({
      key: `${inst.collection}:${inst.item}`,
      stateId: inst.current_state,
      instanceId: inst.instance_id,
      collection: inst.collection,
      itemId: inst.item
    }))
  )
  for (const inst of instances) {
    const owners = ownersByKey.get(`${inst.collection}:${inst.item}`) ?? []
    for (const o of owners) {
      if (!buckets.has(o.id)) buckets.set(o.id, [])
      buckets.get(o.id)!.push({
        text: `${labelFor(inst.collection)} ${inst.item}`,
        sub: inst.state_label,
        url: `${config.ADMIN_URL}/collections/${inst.collection}/${inst.item}`
      })
    }
  }
  return buckets
}

export async function runDailyActionDigest(): Promise<{ sent: number }> {
  // Opt-in users + anyone holding deferred rows (covers a pref flipped back).
  const users = (await db('nivaro_users')
    .where('status', 'active')
    .where('is_redacted', 0)
    .whereNotNull('preferences')
    .select('id', 'email', 'preferences')) as Array<{
    id: string
    email: string
    preferences: unknown
  }>
  const digestUsers = new Map<string, string>() // id -> email
  for (const u of users) {
    const p = parsePrefs(u.preferences)
    if (p && p['email_digest'] === 'daily' && u.email) digestUsers.set(u.id, u.email)
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
  if (digestUsers.size === 0) return { sent: 0 }

  const ownership = await buildOwnershipBuckets()
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
        lines: mine.slice(0, 30).map((d) => ({ text: d.subject, sub: d.snippet?.slice(0, 120) }))
      })
    }

    const owned = ownership.get(userId) ?? []
    if (owned.length > 0) {
      sections.push({
        title: `Open items assigned to you (${owned.length})`,
        lines: owned.slice(0, 25)
      })
    }

    for (const provider of providers) {
      try {
        const section = await provider(userId, email)
        if (section && section.lines.length > 0) sections.push(section)
      } catch (err) {
        console.warn('[daily-digest] section provider failed:', err instanceof Error ? err.message : err)
      }
    }

    if (sections.length === 0) continue
    try {
      await sendRawMail({
        to: email,
        subject: 'Your daily action summary',
        title: 'Daily action summary',
        html: `
          <p style="margin:0 0 4px 0;font-size:13px;color:#334155;">
            Everything waiting on you, in one place. You're receiving this instead of
            individual notification emails — switch back any time from your profile.
          </p>
          ${sections.map(sectionHtml).join('')}`,
        skipDigest: true
      })
      sent++
      flushedIds.push(...mine.map((d) => d.id))
    } catch (err) {
      console.warn('[daily-digest] send failed for', email, err instanceof Error ? err.message : err)
    }
  }

  if (flushedIds.length > 0) {
    for (let i = 0; i < flushedIds.length; i += 1000) {
      await db('nivaro_deferred_emails')
        .whereIn('id', flushedIds.slice(i, i + 1000))
        .del()
    }
  }
  await logActivity({
    action: 'daily-action-digest',
    user: null,
    collection: 'nivaro_users',
    comment: `${sent} daily action summaries sent (${deferred.length} deferred updates flushed)`
  })
  return { sent }
}
