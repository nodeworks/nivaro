import { db } from '../db/index.js'
import type { User } from '../types.js'

/**
 * Cards for links to this app pasted into chat (#930 record links, #947
 * queues / reports / dashboards / saved views), read AS THE VIEWER — someone
 * who cannot open the thing gets no card, only the plain link.
 */

export type AppCard =
  | {
      kind: 'record'
      collection: string
      collection_label: string
      id: string
      label: string
      state: { label: string; color: string | null } | null
    }
  | { kind: 'queue'; id: string; name: string; total: number | null; breached: number | null }
  | { kind: 'report'; id: string; name: string; widgets: number }
  | { kind: 'dashboard'; id: string; name: string; widgets: number }
  | { kind: 'view'; id: string; name: string; collection: string; total: number | null }

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

function sharedToMe(row: Record<string, unknown>, user: User, ownerCol: string, isAdmin: boolean) {
  if (isAdmin) return true
  if (String(row[ownerCol] ?? '').toUpperCase() === String(user.id).toUpperCase()) return true
  if (!row.is_shared) return false
  const role = row.role_id ?? row.role ?? null
  return !role || String(role).toUpperCase() === String(user.role ?? '').toUpperCase()
}

export async function appCardFor(
  user: User,
  isAdmin: boolean,
  rawPath: string
): Promise<AppCard | null> {
  let url: URL
  try {
    url = new URL(rawPath, 'http://app.local')
  } catch {
    return null
  }
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent)

  // /collections/:c/:id  |  /records/:c/:id
  if ((parts[0] === 'collections' || parts[0] === 'records') && parts.length >= 3) {
    const [, collection, id] = parts
    if (!/^[A-Za-z0-9_]+$/.test(collection) || /^(nivaro|directus)_/i.test(collection)) return null
    const { readItems } = await import('./items.js')
    const res = (await readItems(user, collection, {
      filter: { id: { _eq: id } },
      fields: ['id'],
      limit: 1
    }).catch(() => ({ data: [] }))) as { data?: Array<{ id: unknown }> }
    if (!res.data?.length) return null
    const { getLabels } = await import('./queues.js')
    const labels = await getLabels(new Map([[collection, new Set([id])]])).catch(
      () => ({}) as Record<string, string>
    )
    const col = (await db('nivaro_collections')
      .where({ collection })
      .first('display_name', 'singular')
      .catch(() => undefined)) as { display_name?: string; singular?: string } | undefined
    let state: { label: string; color: string | null } | null = null
    const inst = (await db('nivaro_workflow_instances as i')
      .join('nivaro_workflow_states as s', 's.id', 'i.current_state')
      .where({ 'i.collection': collection, 'i.item': id })
      .orderByRaw('CASE WHEN i.completed_at IS NULL THEN 0 ELSE 1 END, i.id DESC')
      .first('s.label', 's.key', 's.color')
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (inst)
      state = { label: String(inst.label ?? inst.key), color: (inst.color as string) ?? null }
    return {
      kind: 'record',
      collection,
      collection_label: col?.singular || col?.display_name || titleCase(collection),
      id: String(id),
      label: labels[`${collection}:${id}`] ?? `#${id}`,
      state
    }
  }

  // /collections/:c?view=<id>  — a saved view
  if (parts[0] === 'collections' && parts.length === 2 && url.searchParams.get('view')) {
    const viewId = url.searchParams.get('view') as string
    const v = (await db('nivaro_saved_views')
      .where({ id: viewId })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!v || !sharedToMe(v, user, 'user', isAdmin)) return null
    let total: number | null = null
    try {
      const { compileViewConditions } = await import('./view-subscriptions.js')
      const { readItems } = await import('./items.js')
      let filters: unknown = v.filters
      if (typeof filters === 'string') filters = JSON.parse(filters)
      const conds = compileViewConditions(Array.isArray(filters) ? (filters as never[]) : [])
      const res = await readItems(
        user,
        String(v.collection),
        { fields: ['id'], limit: 1 },
        conds.length ? ({ query: { conditions: JSON.stringify(conds) } } as never) : undefined
      )
      total = res.total ?? null
    } catch {
      total = null
    }
    return {
      kind: 'view',
      id: String(v.id),
      name: String(v.name ?? 'Saved view'),
      collection: String(v.collection),
      total
    }
  }

  if (parts[0] === 'queues' && parts[1]) {
    const q = (await db('nivaro_queues')
      .where({ id: parts[1] })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!q || !sharedToMe(q, user, 'owner', isAdmin)) return null
    let total: number | null = null
    let breached: number | null = null
    try {
      const { fetchQueueItems } = await import('./queues.js')
      const r = await fetchQueueItems(String(q.id), user, 'all', { page: 1, limit: 1 })
      total = r.stats.total
      breached = r.stats.sla_breached
    } catch {
      /* counts are decoration */
    }
    return { kind: 'queue', id: String(q.id), name: String(q.name ?? 'Queue'), total, breached }
  }

  if ((parts[0] === 'reports' || parts[0] === 'report-studio') && parts[1]) {
    const r = (await db('nivaro_report_defs')
      .where({ id: parts[1] })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!r || !sharedToMe(r, user, 'owner', isAdmin)) return null
    const n = Number(
      (
        (await db('nivaro_report_widgets').where({ report: r.id }).count({ n: 'id' }).first()) as
          | { n?: number }
          | undefined
      )?.n ?? 0
    )
    return { kind: 'report', id: String(r.id), name: String(r.name ?? 'Report'), widgets: n }
  }

  if (parts[0] === 'dashboards' && parts[1]) {
    const d = (await db('nivaro_dashboards')
      .where({ id: parts[1] })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!d || !sharedToMe(d, user, 'user', isAdmin)) return null
    const n = Number(
      (
        (await db('nivaro_dashboard_widgets')
          .where({ dashboard: d.id })
          .count({ n: 'id' })
          .first()
          .catch(() => undefined)) as { n?: number } | undefined
      )?.n ?? 0
    )
    return { kind: 'dashboard', id: String(d.id), name: String(d.name ?? 'Dashboard'), widgets: n }
  }
  return null
}
