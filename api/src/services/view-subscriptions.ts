import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import type { User } from '../types.js'
import { readItems } from './items.js'
import { sendRawMail } from './mail.js'
import { notifyUser } from './notification-channels.js'
import { getLabels } from './queues.js'

/**
 * Saved-view subscription digests — the set diff behind "7 workflows entered
 * 'Zone 1 over $500k' since yesterday".
 *
 * Each run materializes the view's matched ids AS THE SUBSCRIBER — the same
 * `readItems` path the browser uses, so RBAC, row filters and User Scopes
 * apply and a subscriber can never be told about records the view would not
 * have shown them. The previous run's snapshot is the baseline; new ids are
 * "entered", missing ids are "left".
 *
 * The view's stored filters are the browser dialect (ActiveFilter[]); the
 * compilation to the items `conditions` param mirrors CollectionBrowserView's
 * `conditionsParam` memo — the two must not drift, or the digest reports a
 * different set than the page shows.
 *
 * First run for a subscription only establishes the baseline and reports
 * nothing: everything currently matching is not "new", it is the view.
 */

interface ViewFilter {
  path?: string[]
  op?: string
  value?: unknown
  fieldType?: string
}

/** Mirror of CollectionBrowserView's ActiveFilter → conditions compilation. */
export function compileViewConditions(
  filters: ViewFilter[]
): Array<{ path: string[]; op: string; value: unknown }> {
  const conds: Array<{ path: string[]; op: string; value: unknown }> = []
  for (const f of filters) {
    if (!Array.isArray(f.path) || f.path.length === 0 || typeof f.op !== 'string') continue
    const isDateType =
      f.fieldType === 'date' || f.fieldType === 'datetime' || f.fieldType === 'timestamp'
    if (f.op === '_between') {
      const [a, b] = String(f.value ?? '').split('..')
      if (a) conds.push({ path: f.path, op: '_gte', value: a })
      if (b) conds.push({ path: f.path, op: '_lte', value: isDateType ? `${b}T23:59:59` : b })
      continue
    }
    // Compound ops encode the value after a colon (`_eq:true`).
    const op = f.op.includes(':') ? f.op.split(':')[0] : f.op
    let value: unknown = f.op.includes(':') ? f.op.split(':')[1] : (f.value ?? null)
    if (f.fieldType === 'boolean' && (value === 'true' || value === 'false')) {
      value = value === 'true'
    }
    conds.push({ path: f.path, op, value })
  }
  return conds
}

/** Snapshot ceiling — a view bigger than this diffs by count only. */
const SNAPSHOT_CAP = 5000
const PAGE = 1000

interface Materialized {
  ids: string[] | null // null = over cap
  total: number
}

async function materializeViewIds(
  user: User,
  collection: string,
  conditions: Array<{ path: string[]; op: string; value: unknown }>
): Promise<Materialized> {
  const fakeReq =
    conditions.length > 0
      ? ({ query: { conditions: JSON.stringify(conditions) } } as never)
      : undefined

  const ids: string[] = []
  let total = 0
  for (let page = 1; page <= SNAPSHOT_CAP / PAGE; page++) {
    const res = await readItems(
      user,
      collection,
      { fields: ['id'], limit: PAGE, page, sort: ['id'] },
      fakeReq
    )
    total = res.total
    for (const row of res.data as Array<{ id: unknown }>) ids.push(String(row.id))
    if (res.data.length < PAGE) break
  }
  if (total > SNAPSHOT_CAP) return { ids: null, total }
  return { ids, total }
}

interface SubscriptionRow {
  id: number
  view_id: number
  user: string
  digest: string
  is_active: boolean | number
  last_ids: string | null
  last_run_at: Date | null
}

interface ViewRow {
  id: number
  collection: string
  name: string
  filters: string | null
}

export interface ViewDigestEntry {
  view: string
  collection: string
  entered: string[]
  left_count: number
  entered_labels: Record<string, string>
  count_only: boolean
  total: number
  prev_total: number
}


// Every interpolated value below is model data — the view NAME is typed by
// whoever saved the view, and record labels render business fields. A view
// named `<img onerror=…>` must arrive in the digest as text, not markup.
function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export async function runViewSubscriptionDigests(
  cadence: 'daily' | 'weekly',
  app?: FastifyInstance
): Promise<{ subscriptions: number; notified: number }> {
  const subs = (await db('nivaro_view_subscriptions')
    .where({ digest: cadence })
    .where((b) => b.where('is_active', true).orWhere('is_active', 1))) as SubscriptionRow[]
  if (subs.length === 0) return { subscriptions: 0, notified: 0 }

  const viewIds = [...new Set(subs.map((s) => s.view_id))]
  const views = (await db('nivaro_saved_views')
    .whereIn('id', viewIds)
    .select('id', 'collection', 'name', 'filters')) as ViewRow[]
  const viewById = new Map(views.map((v) => [v.id, v]))

  // One digest per user, however many views they watch.
  const perUser = new Map<string, ViewDigestEntry[]>()

  for (const sub of subs) {
    const view = viewById.get(sub.view_id)
    if (!view) continue
    const user = (await db<User>('nivaro_users')
      .where({ id: sub.user, status: 'active' })
      .first()) as User | undefined
    if (!user) continue

    let filters: ViewFilter[] = []
    try {
      const parsed = JSON.parse(view.filters ?? '[]')
      if (Array.isArray(parsed)) filters = parsed
    } catch {
      /* unparseable filters = unfiltered view */
    }

    let current: Materialized
    try {
      current = await materializeViewIds(user, view.collection, compileViewConditions(filters))
    } catch {
      continue // a broken view (renamed field, revoked access) skips, never crashes the run
    }

    const prevRaw = sub.last_ids
    let prevIds: string[] | null = null
    let prevTotal = 0
    if (prevRaw) {
      try {
        const parsed = JSON.parse(prevRaw)
        if (Array.isArray(parsed)) {
          prevIds = parsed.map(String)
          prevTotal = parsed.length
        } else if (parsed && typeof parsed === 'object') {
          prevTotal = Number((parsed as { count?: unknown }).count ?? 0)
        }
      } catch {
        /* corrupt snapshot = re-baseline */
      }
    }

    // Persist the new snapshot regardless of whether anything is reported.
    await db('nivaro_view_subscriptions')
      .where({ id: sub.id })
      .update({
        last_ids: current.ids ? JSON.stringify(current.ids) : JSON.stringify({ count: current.total }),
        last_run_at: new Date()
      })

    // First run = baseline only.
    if (prevRaw == null) continue

    if (current.ids && prevIds) {
      const prevSet = new Set(prevIds)
      const curSet = new Set(current.ids)
      const entered = current.ids.filter((id) => !prevSet.has(id))
      const leftCount = prevIds.filter((id) => !curSet.has(id)).length
      if (entered.length === 0 && leftCount === 0) continue

      let labels: Record<string, string> = {}
      try {
        const raw = await getLabels(new Map([[view.collection, new Set(entered.slice(0, 10))]]))
        for (const id of entered.slice(0, 10)) {
          labels[id] = raw[`${view.collection}:${id}`] ?? id
        }
      } catch {
        labels = {}
      }

      const list = perUser.get(sub.user) ?? []
      list.push({
        view: view.name,
        collection: view.collection,
        entered,
        left_count: leftCount,
        entered_labels: labels,
        count_only: false,
        total: current.total,
        prev_total: prevTotal
      })
      perUser.set(sub.user, list)
    } else {
      // Over-cap on either side: only the count delta is honest.
      if (current.total === prevTotal) continue
      const list = perUser.get(sub.user) ?? []
      list.push({
        view: view.name,
        collection: view.collection,
        entered: [],
        left_count: 0,
        entered_labels: {},
        count_only: true,
        total: current.total,
        prev_total: prevTotal
      })
      perUser.set(sub.user, list)
    }
  }

  let notified = 0
  for (const [userId, entries] of perUser) {
    const user = (await db<User>('nivaro_users').where({ id: userId }).first()) as
      | User
      | undefined
    if (!user?.email) continue

    const subject = `Your watched views: ${entries.reduce((n, e) => n + (e.count_only ? 0 : e.entered.length), 0) || 'changes'} new record(s)`
    const sections = entries
      .map((e) => {
        if (e.count_only) {
          return `<p><strong>${esc(e.view)}</strong> (${esc(e.collection)}): ${e.prev_total.toLocaleString()} → ${e.total.toLocaleString()} records (too large to list individually).</p>`
        }
        const items = e.entered
          .slice(0, 10)
          .map(
            (id) =>
              `<li>${esc(e.entered_labels[id] ?? id)} <span style="color:#64748b">(#${esc(id)})</span></li>`
          )
          .join('')
        const more = e.entered.length > 10 ? `<p>+${e.entered.length - 10} more</p>` : ''
        const left = e.left_count > 0 ? `<p>${e.left_count} record(s) left the view.</p>` : ''
        return `<p><strong>${esc(e.view)}</strong> (${esc(e.collection)}): ${e.entered.length} entered</p><ul>${items}</ul>${more}${left}`
      })
      .join('')

    await sendRawMail({
      to: user.email,
      subject,
      html: `<h2>Watched views — ${cadence} digest</h2>${sections}`
    }).catch(() => {})

    if (app) {
      for (const e of entries) {
        await notifyUser(app, userId, {
          subject: e.count_only
            ? `View "${e.view}": ${e.prev_total.toLocaleString()} → ${e.total.toLocaleString()} records`
            : `View "${e.view}": ${e.entered.length} new record(s)`,
          message: e.count_only
            ? 'View changed — too large to list individual records.'
            : e.entered
                .slice(0, 5)
                .map((id) => e.entered_labels[id] ?? id)
                .join(', '),
          collection: e.collection
        }).catch(() => {})
      }
    }
    notified++
  }

  return { subscriptions: subs.length, notified }
}
