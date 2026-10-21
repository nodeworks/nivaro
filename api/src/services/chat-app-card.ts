import { db } from '../db/index.js'
import type { User } from '../types.js'
import type { RequestCard } from './chat-request-card.js'
import type { OpsProposalCard } from './ops-proposals.js'

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
  | {
      kind: 'queue'
      id: string
      name: string
      sources: number | null
      description: string | null
    }
  | { kind: 'report'; id: string; name: string; widgets: number; description: string | null }
  | { kind: 'dashboard'; id: string; name: string; widgets: number; description: string | null }
  | {
      kind: 'view'
      id: string
      name: string
      collection: string
      collection_label: string
      description: string | null
    }
  | {
      kind: 'custom-query'
      id: string
      name: string
      slug: string | null
      params: number
      description: string | null
    }
  | RequestCard
  | OpsProposalCard
  | {
      kind: 'ask'
      id: string
      name: string
      question: string
      answer: string | null
      answer_hidden: boolean
      turns: number
      owner_name: string
    }

function titleCase(s: string): string {
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase())
}

/** A page's own description, one line, trimmed — never its data. */
function describe(v: unknown): string | null {
  const s = typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''
  return s ? s.slice(0, 160) : null
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

  // #2015 — an ops assistant proposal: an approval card for administrators,
  // nothing (the plain link) for anyone else.
  if (parts[0] === 'ops-console' && url.searchParams.get('proposal')) {
    if (!isAdmin) return null
    const { proposalCardFor } = await import('./ops-proposals.js')
    return proposalCardFor(String(user.id), String(url.searchParams.get('proposal')))
  }

  // /ask?conversation=<id> — an Ask AI conversation posted to chat (#1851).
  // Built for the reader: no access → no card; the answer line only when the
  // sharing rule lets THIS reader read it.
  if (parts[0] === 'ask' && url.searchParams.get('conversation')) {
    const { askConversationCard } = await import('./ai-conversation-card.js')
    return askConversationCard(user, url.searchParams.get('conversation') as string)
  }

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

  // #2785 — page cards say WHAT the page is (title, kind, description), never
  // its data: the reader opens the page to see that. Each kind is gated by the
  // page's own access rule, so someone who cannot open it gets the plain link.

  // /collections/:c?view=<id>  — a saved view
  if (parts[0] === 'collections' && parts.length === 2 && url.searchParams.get('view')) {
    const viewId = url.searchParams.get('view') as string
    const v = (await db('nivaro_saved_views')
      .where({ id: viewId })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!v || !sharedToMe(v, user, 'user', isAdmin)) return null
    const collection = String(v.collection)
    if (!isAdmin) {
      const { can } = await import('./permissions.js')
      if (!(await can(user, 'read', collection).catch(() => false))) return null
    }
    const col = (await db('nivaro_collections')
      .where({ collection })
      .first('display_name')
      .catch(() => undefined)) as { display_name?: string } | undefined
    return {
      kind: 'view',
      id: String(v.id),
      name: String(v.name ?? 'Saved view'),
      collection,
      collection_label: col?.display_name || titleCase(collection),
      description: describe(v.description)
    }
  }

  if (parts[0] === 'queues' && parts[1]) {
    const q = (await db('nivaro_queues')
      .where({ id: parts[1] })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    const { canUserReadQueue } = await import('./queue-access.js')
    if (!q || !canUserReadQueue(q as never, user, isAdmin)) return null
    const sources = Number(
      (
        (await db('nivaro_queue_sources')
          .where({ queue_id: q.id })
          .count({ n: 'id' })
          .first()
          .catch(() => undefined)) as { n?: number } | undefined
      )?.n ?? 0
    )
    return {
      kind: 'queue',
      id: String(q.id),
      name: String(q.name ?? 'Queue'),
      sources: sources || null,
      description: describe(q.description)
    }
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
    return {
      kind: 'report',
      id: String(r.id),
      name: String(r.name ?? 'Report'),
      widgets: n,
      description: describe(r.description)
    }
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
    return {
      kind: 'dashboard',
      id: String(d.id),
      name: String(d.name ?? 'Dashboard'),
      widgets: n,
      description: describe(d.description)
    }
  }

  // /custom-queries/:id — the SQL editor, an administrator page: a card for
  // administrators, the plain link for everyone else.
  if (parts[0] === 'custom-queries' && parts[1] && /^\d+$/.test(parts[1])) {
    if (!isAdmin) return null
    const q = (await db('nivaro_custom_queries')
      .where({ id: Number(parts[1]) })
      .first()
      .catch(() => undefined)) as Record<string, unknown> | undefined
    if (!q) return null
    let params = 0
    try {
      const raw = typeof q.params === 'string' ? JSON.parse(q.params) : q.params
      params = Array.isArray(raw) ? raw.length : 0
    } catch {
      params = 0
    }
    return {
      kind: 'custom-query',
      id: String(q.id),
      name: String(q.name ?? 'Custom query'),
      slug: q.slug ? String(q.slug) : null,
      params,
      description: describe(q.description)
    }
  }

  // #2762 — a Traffic Map link to one request: its request card, for the
  // administrators who can open the map; the plain link for everyone else.
  if (parts[0] === 'traffic-map') {
    const m = /^(?:request|trace):([0-9a-f-]{32,36})$/i.exec(url.searchParams.get('inspect') ?? '')
    if (!m || !isAdmin) return null
    const { requestCardFor } = await import('./chat-request-card.js')
    return requestCardFor(user, isAdmin, m[1])
  }
  return null
}
