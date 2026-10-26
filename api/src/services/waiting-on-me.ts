import { db } from '../db/index.js'
import type { SlaBatchEntry } from '../routes/sla.js'
import type { User } from '../types.js'
import type { SourceResult } from './queues.js'

/**
 * "Waiting on you" — the records whose CURRENT pipeline state resolves a person
 * as an owner (the owned_by_me queue resolver), with their SLA, most urgent
 * first, plus the approval-chain steps naming them. One source for My Work
 * (/api/my-work) and Ask AI's waiting_on_me tool, so the assistant can never
 * answer a different set than the page shows.
 */

export interface OwnedEntry {
  collection: string
  item: string
  label: string
  state: string | null
  state_color: string | null
  url: string
  sla: SlaBatchEntry | null
}

export interface ApprovalStepRow {
  id: unknown
  collection: string
  item: string
  chain_name: string
  current_step: number
}

const SLA_RANK: Record<string, number> = { breached: 0, warning: 1, ok: 2 }

export interface OwnedDeps {
  owned(userId: string): Promise<SourceResult>
  sla(collection: string, ids: string[]): Promise<Record<string, SlaBatchEntry>>
}

const ownedDefaults: OwnedDeps = {
  async owned(userId) {
    const { resolveOwnedByMeSource } = await import('./queues.js')
    return resolveOwnedByMeSource(userId)
  },
  async sla(collection, ids) {
    const { computeStatusBatch } = await import('../routes/sla.js')
    return computeStatusBatch(collection, ids)
  }
}

/** Owned records with SLA, breached → warning → ok → no rule. Never throws. */
export async function ownedWithSla(
  userId: string,
  deps: OwnedDeps = ownedDefaults
): Promise<{ owned: OwnedEntry[]; truncated: boolean }> {
  const result = await deps
    .owned(userId)
    .catch(() => ({ items: [], matchedCount: 0, truncated: false }) as SourceResult)
  const owned: OwnedEntry[] = result.items.map((i) => ({
    collection: i.collection,
    item: String(i.item_id),
    label: i.label,
    state: i.state,
    state_color: i.state_color,
    url: i.url,
    sla: null
  }))
  const byCollection = new Map<string, string[]>()
  for (const o of owned) {
    const list = byCollection.get(o.collection) ?? []
    list.push(o.item)
    byCollection.set(o.collection, list)
  }
  await Promise.all(
    [...byCollection.entries()].map(async ([collection, ids]) => {
      try {
        const statuses = await deps.sla(collection, ids)
        for (const o of owned) {
          if (o.collection === collection && statuses[o.item]) o.sla = statuses[o.item]
        }
      } catch {
        /* SLA is decoration — never fail the inbox */
      }
    })
  )
  owned.sort((a, b) => (SLA_RANK[a.sla?.status ?? ''] ?? 3) - (SLA_RANK[b.sla?.status ?? ''] ?? 3))
  return { owned, truncated: !!result.truncated }
}

/** Pending approval-chain instances whose CURRENT step names the person
 *  (directly, or via their role). */
export async function approvalStepsFor(userId: string): Promise<ApprovalStepRow[]> {
  return (await db('nivaro_approval_instances as ai')
    .join('nivaro_approval_chains as c', 'ai.chain', 'c.id')
    .join('nivaro_approval_steps as st', (j) => {
      j.on('st.chain', 'c.id').andOn('st.step_order', 'ai.current_step')
    })
    .where('ai.status', 'pending')
    .where((qb) => {
      void qb.where('st.approver_user', userId).orWhereIn('st.approver_role', (sub) => {
        void sub.from('nivaro_users').where('id', userId).select('role')
      })
    })
    .select('ai.id', 'ai.collection', 'ai.item', 'c.name as chain_name', 'ai.current_step')
    .limit(50)
    .catch(() => [])) as ApprovalStepRow[]
}

// ─── Ask AI: waiting_on_me ────────────────────────────────────────────────────

export interface WaitingRecord {
  /** Friendly id (human id when the collection declares one). */
  record: string
  collection: string
  id: string
  label: string | null
  state: string | null
  sla: 'ok' | 'warning' | 'breached' | null
  hours_in_state: number | null
  hours_over: number | null
  url: string
}

export interface WaitingOnMe {
  person: string
  total: number
  breached: number
  warning: number
  records: WaitingRecord[]
  approvals: Array<{ record: string; collection: string; id: string; chain: string; step: number }>
  truncated: boolean
  note?: string
}

export interface WaitingDeps extends OwnedDeps {
  approvals(userId: string): Promise<ApprovalStepRow[]>
  /** `collection:id` keys of the refs the asker may read (items service, as them). */
  visible(user: User, refs: Array<{ collection: string; item: string }>): Promise<Set<string>>
  labels(user: User, byTarget: Map<string, Set<string>>): Promise<Record<string, string>>
  friendlyIds(collection: string, ids: string[]): Promise<Map<string, string>>
}

const waitingDefaults: WaitingDeps = {
  ...ownedDefaults,
  approvals: approvalStepsFor,
  async visible(user, refs) {
    const { can } = await import('./permissions.js')
    const { readItems } = await import('./items.js')
    const allowed = new Set<string>()
    const byColl = new Map<string, Set<string>>()
    for (const r of refs) {
      const set = byColl.get(r.collection) ?? new Set<string>()
      set.add(String(r.item))
      byColl.set(r.collection, set)
    }
    for (const [collection, items] of byColl) {
      if (/^(nivaro|directus)_/i.test(collection)) continue
      if (!(await can(user, 'read', collection).catch(() => false))) continue
      try {
        const res = (await readItems(user, collection, {
          filter: { id: { _in: [...items] } },
          fields: ['id'],
          limit: items.size
        })) as { data?: Array<{ id?: unknown }> }
        for (const row of res.data ?? []) allowed.add(`${collection}:${String(row.id)}`)
      } catch {
        /* unreadable collection contributes nothing */
      }
    }
    return allowed
  },
  async labels(user, byTarget) {
    const { linkLabelsAsUser } = await import('./ai-link-labels.js')
    return linkLabelsAsUser(user, byTarget)
  },
  async friendlyIds(collection, ids) {
    const { resolveFriendlyIds } = await import('./workflow-transitions.js')
    return resolveFriendlyIds(collection, ids)
  }
}

const round1 = (n: number | null | undefined) =>
  n == null || !Number.isFinite(n) ? null : Math.round(n * 10) / 10

/**
 * What is waiting on the ASKER: the My Work "Waiting on you" set (never anyone
 * else's — there is no person parameter), narrowed to the records the asker may
 * read, labelled as the asker. An owner seat on a record they cannot read keeps
 * it out of the answer; nothing about it is returned.
 */
export async function waitingOnMe(
  user: User,
  opts: { limit?: number } = {},
  deps: WaitingDeps = waitingDefaults
): Promise<WaitingOnMe> {
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 25))
  const userId = String(user.id)
  const [{ owned, truncated }, steps] = await Promise.all([
    ownedWithSla(userId, deps),
    deps.approvals(userId).catch(() => [] as ApprovalStepRow[])
  ])
  const refs = [
    ...owned.map((o) => ({ collection: o.collection, item: o.item })),
    ...steps.map((s) => ({ collection: String(s.collection), item: String(s.item) }))
  ]
  const visible = refs.length ? await deps.visible(user, refs) : new Set<string>()
  const key = (c: string, id: string) => `${c}:${id}`
  const mine = owned.filter((o) => visible.has(key(o.collection, o.item)))
  const mySteps = steps.filter((s) => visible.has(key(String(s.collection), String(s.item))))

  const shown = mine.slice(0, limit)
  const byTarget = new Map<string, Set<string>>()
  for (const r of [
    ...shown.map((o) => ({ c: o.collection, id: o.item })),
    ...mySteps.map((s) => ({ c: String(s.collection), id: String(s.item) }))
  ]) {
    if (!byTarget.has(r.c)) byTarget.set(r.c, new Set())
    byTarget.get(r.c)!.add(r.id)
  }
  const friendly = new Map<string, string>()
  const [labels] = await Promise.all([
    byTarget.size
      ? deps.labels(user, byTarget).catch(() => ({}) as Record<string, string>)
      : Promise.resolve({} as Record<string, string>),
    Promise.all(
      [...byTarget].map(async ([c, ids]) => {
        const m = await deps.friendlyIds(c, [...ids]).catch(() => new Map<string, string>())
        for (const [id, f] of m) friendly.set(key(c, id), f)
      })
    )
  ])
  const nameOf = (c: string, id: string) => friendly.get(key(c, id)) ?? id

  const records: WaitingRecord[] = shown.map((o) => {
    const over =
      o.sla?.status === 'breached' && o.sla.remaining_hours != null ? -o.sla.remaining_hours : null
    return {
      record: nameOf(o.collection, o.item),
      collection: o.collection,
      id: o.item,
      label: (labels as Record<string, string>)[key(o.collection, o.item)] ?? null,
      state: o.state,
      sla: o.sla?.status ?? null,
      hours_in_state: round1(o.sla?.elapsed_hours),
      hours_over: round1(over),
      url: o.url
    }
  })
  const out: WaitingOnMe = {
    person: 'you',
    total: mine.length,
    breached: mine.filter((o) => o.sla?.status === 'breached').length,
    warning: mine.filter((o) => o.sla?.status === 'warning').length,
    records,
    approvals: mySteps.map((s) => ({
      record: nameOf(String(s.collection), String(s.item)),
      collection: String(s.collection),
      id: String(s.item),
      chain: s.chain_name,
      step: Number(s.current_step)
    })),
    truncated: truncated || mine.length > shown.length
  }
  if (out.total === 0 && out.approvals.length === 0) {
    out.note =
      'Nothing is waiting on the asker right now: no open record has its current step owned by them and no approval step names them. Say exactly that — do not list other people’s records or a general overdue list instead.'
  }
  return out
}
