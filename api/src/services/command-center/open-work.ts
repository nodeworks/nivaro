import { db } from '../../db/index.js'
import { selectInChunks } from '../db-batch.js'
import { sharedGatedRead, withReadGate } from '../read-gate.js'
import { tenantMemo } from './work-access.js'
import { DAY_MS } from './work-math.js'

/**
 * The open-work index every Command Center work read starts from: per workflow binding, the open
 * pipeline instances with the time each entered its current state and its SLA verdict, plus the
 * instances that started or finished in the 7 days before the index's instant.
 *
 * It is viewer-INDEPENDENT (raw instance rows, no record content beyond ids) and built at most
 * once per tenant per TTL through the heavy-read gate; every reader then narrows it AS THE CALLER
 * (work-access.ts Viewer: collection read permission, row filter, User Scopes, region).
 *
 * Live: open = completed_at IS NULL (the snapshot's rule), entered = the SLA batch evaluator's
 * entered_at (latest history row into the current state, else the instance start), SLA = the same
 * evaluator the queues show. Rewind (`asOf` in the past): rebuilt from nivaro_workflow_history —
 * an instance was open at T when it started by T and had not completed by T, its state is the
 * latest history row at or before T; SLA is not reconstructed (null). Reads only — these tables
 * carry triggers, nothing here writes them.
 */

export interface StateMeta {
  id: string
  template: string
  key: string
  label: string
  color: string | null
  sort: number
  is_terminal: boolean
}

export interface OpenInstance {
  instance_id: string
  collection: string
  template: string
  item: string
  state_id: string
  started_at: number
  entered_at: number
  sla: 'ok' | 'warning' | 'breached' | null
  /** Hours left on the SLA clock (negative = overdue). */
  sla_remaining_h: number | null
}

export interface RecentInstance {
  collection: string
  template: string
  item: string
  started_at: number
  completed_at: number | null
}

export interface Binding {
  collection: string
  template: string
  template_name: string
}

export interface OpenWorkIndex {
  as_of: number
  live: boolean
  truncated: boolean
  bindings: Binding[]
  states: Map<string, StateMeta>
  open: OpenInstance[]
  /** Started or completed in (as_of − 7 days, as_of]. */
  recent: RecentInstance[]
}

/** Past this many open instances the index keeps the newest and says truncated. */
export const OPEN_CAP = 20_000
const LIVE_TTL_MS = 90_000

const ms = (v: Date | string | null | undefined): number | null => {
  if (v == null) return null
  const t = new Date(v).getTime()
  return Number.isFinite(t) ? t : null
}
const U = (v: unknown) => String(v ?? '').toUpperCase()

async function loadBindingsAndStates(): Promise<{
  bindings: Binding[]
  states: Map<string, StateMeta>
}> {
  const bindings = (await db('nivaro_workflow_bindings as b')
    .join('nivaro_workflow_templates as t', 't.id', 'b.template')
    .select('b.collection', 'b.template', 't.name as template_name')) as Binding[]
  const templates = [...new Set(bindings.map((b) => String(b.template)))]
  const states = new Map<string, StateMeta>()
  if (templates.length > 0) {
    const rows = (await db('nivaro_workflow_states')
      .whereIn('template', templates)
      .select('id', 'template', 'key', 'label', 'color', 'sort', 'is_terminal')) as Array<
      Record<string, unknown>
    >
    for (const r of rows)
      states.set(U(r.id), {
        id: String(r.id),
        template: String(r.template),
        key: String(r.key),
        label: String(r.label ?? r.key),
        color: (r.color as string | null) ?? null,
        sort: Number(r.sort ?? 0),
        is_terminal: r.is_terminal === true || r.is_terminal === 1
      })
  }
  return {
    bindings: bindings.map((b) => ({ ...b, template: String(b.template) })),
    states
  }
}

const bindingKey = (collection: string, template: string) => `${collection}|${U(template)}`

async function buildLive(): Promise<OpenWorkIndex> {
  const now = Date.now()
  const { bindings, states } = await loadBindingsAndStates()
  const bound = new Set(bindings.map((b) => bindingKey(b.collection, b.template)))
  const empty: OpenWorkIndex = {
    as_of: now,
    live: true,
    truncated: false,
    bindings,
    states,
    open: [],
    recent: []
  }
  if (bindings.length === 0) return empty
  const collections = [...new Set(bindings.map((b) => b.collection))]
  const since = new Date(now - 7 * DAY_MS)

  const [openRows, recentRows] = await Promise.all([
    db('nivaro_workflow_instances')
      .whereIn('collection', collections)
      .whereNull('completed_at')
      .orderBy('started_at', 'desc')
      .limit(OPEN_CAP + 1)
      .select('id', 'collection', 'template', 'item', 'current_state', 'started_at') as Promise<
      Array<Record<string, unknown>>
    >,
    db('nivaro_workflow_instances')
      .whereIn('collection', collections)
      .where((w) => w.where('started_at', '>', since).orWhere('completed_at', '>', since))
      .limit(OPEN_CAP)
      .select('collection', 'template', 'item', 'started_at', 'completed_at') as Promise<
      Array<Record<string, unknown>>
    >
  ])
  const truncated = openRows.length > OPEN_CAP
  const rows = openRows
    .slice(0, OPEN_CAP)
    .filter(
      (r) => r.current_state && bound.has(bindingKey(String(r.collection), String(r.template)))
    )

  // Entered-at + SLA from the batch evaluator, one call per collection (instances passed in so
  // it does not read them again).
  const sla = new Map<
    string,
    { entered: number | null; status: OpenInstance['sla']; rem: number | null }
  >()
  const byCollection = new Map<string, Array<Record<string, unknown>>>()
  for (const r of rows)
    byCollection.set(String(r.collection), [...(byCollection.get(String(r.collection)) ?? []), r])
  const { computeStatusBatch } = await import('../../routes/sla.js')
  for (const [collection, list] of byCollection) {
    try {
      const res = await computeStatusBatch(
        collection,
        list.map((r) => String(r.item)),
        list.map((r) => ({
          id: String(r.id),
          item: String(r.item),
          current_state: String(r.current_state),
          template: String(r.template),
          started_at: r.started_at as Date
        }))
      )
      for (const [item, e] of Object.entries(res))
        sla.set(`${collection}|${U(item)}`, {
          entered: ms(e.entered_at as Date | string | null),
          status: (e.status as OpenInstance['sla']) ?? null,
          rem: e.remaining_hours ?? null
        })
    } catch {
      /* SLA rules unreadable — ages fall back to the instance start */
    }
  }

  const open: OpenInstance[] = rows.map((r) => {
    const s = sla.get(`${String(r.collection)}|${U(r.item)}`)
    const started = ms(r.started_at as Date) ?? now
    return {
      instance_id: String(r.id),
      collection: String(r.collection),
      template: String(r.template),
      item: String(r.item),
      state_id: String(r.current_state),
      started_at: started,
      entered_at: s?.entered ?? started,
      sla: s?.status ?? null,
      sla_remaining_h: s?.rem ?? null
    }
  })
  const recent: RecentInstance[] = recentRows
    .filter((r) => bound.has(bindingKey(String(r.collection), String(r.template))))
    .map((r) => ({
      collection: String(r.collection),
      template: String(r.template),
      item: String(r.item),
      started_at: ms(r.started_at as Date) ?? now,
      completed_at: ms(r.completed_at as Date | null)
    }))
  return { ...empty, truncated, open, recent }
}

/**
 * The index as of a past instant, rebuilt from history. Throws REWIND_TOO_LARGE when more than
 * OPEN_CAP instances were in play (callers then answer live with live_only).
 */
async function buildAt(asOf: number): Promise<OpenWorkIndex> {
  const { bindings, states } = await loadBindingsAndStates()
  const bound = new Set(bindings.map((b) => bindingKey(b.collection, b.template)))
  const base: OpenWorkIndex = {
    as_of: asOf,
    live: false,
    truncated: false,
    bindings,
    states,
    open: [],
    recent: []
  }
  if (bindings.length === 0) return base
  const collections = [...new Set(bindings.map((b) => b.collection))]
  const T = new Date(asOf)
  const weekBefore = new Date(asOf - 7 * DAY_MS)
  const rows = (await db('nivaro_workflow_instances')
    .whereIn('collection', collections)
    .where('started_at', '<=', T)
    .where((w) => w.whereNull('completed_at').orWhere('completed_at', '>', weekBefore))
    .limit(OPEN_CAP * 2 + 1)
    .select(
      'id',
      'collection',
      'template',
      'item',
      'current_state',
      'started_at',
      'completed_at'
    )) as Array<Record<string, unknown>>
  if (rows.length > OPEN_CAP * 2)
    throw Object.assign(new Error('Too many records to rewind'), { code: 'REWIND_TOO_LARGE' })
  const inBinding = rows.filter((r) =>
    bound.has(bindingKey(String(r.collection), String(r.template)))
  )
  const openAtT = inBinding.filter((r) => {
    const done = ms(r.completed_at as Date | null)
    return done == null || done > asOf
  })
  // Latest history row at or before T, per open-at-T instance.
  const latest = new Map<string, { to_state: string; at: number }>()
  const ids = openAtT.map((r) => String(r.id))
  if (ids.length > 0) {
    const hist = (await selectInChunks(
      ids,
      1000,
      (chunk) =>
        db.raw(
          `SELECT x.instance, x.to_state, x.timestamp FROM (
           SELECT h.instance, h.to_state, h.timestamp,
                  ROW_NUMBER() OVER (PARTITION BY h.instance ORDER BY h.timestamp DESC, h.id DESC) AS rn
           FROM nivaro_workflow_history h
           WHERE h.instance IN (${chunk.map(() => '?').join(',')}) AND h.timestamp <= ?
         ) x WHERE x.rn = 1`,
          [...chunk, T]
        ) as unknown as Promise<Array<Record<string, unknown>>>
    )) as Array<Record<string, unknown>>
    for (const h of hist)
      latest.set(U(h.instance), {
        to_state: String(h.to_state),
        at: ms(h.timestamp as Date) ?? asOf
      })
  }
  const open: OpenInstance[] = []
  for (const r of openAtT) {
    const h = latest.get(U(r.id))
    const started = ms(r.started_at as Date) ?? asOf
    // No history at T: an instance started in its state (addendum-style) — its current state is
    // the best answer only while it is still open now.
    const stateId = h?.to_state ?? (r.completed_at == null ? String(r.current_state ?? '') : '')
    if (!stateId) continue
    open.push({
      instance_id: String(r.id),
      collection: String(r.collection),
      template: String(r.template),
      item: String(r.item),
      state_id: stateId,
      started_at: started,
      entered_at: h?.at ?? started,
      sla: null,
      sla_remaining_h: null
    })
  }
  const recent: RecentInstance[] = inBinding
    .map((r) => ({
      collection: String(r.collection),
      template: String(r.template),
      item: String(r.item),
      started_at: ms(r.started_at as Date) ?? asOf,
      completed_at: ms(r.completed_at as Date | null)
    }))
    .filter(
      (r) =>
        r.started_at > asOf - 7 * DAY_MS ||
        (r.completed_at != null && r.completed_at > asOf - 7 * DAY_MS && r.completed_at <= asOf)
    )
    .map((r) =>
      r.completed_at != null && r.completed_at > asOf ? { ...r, completed_at: null } : r
    )
  return { ...base, open, recent }
}

/**
 * The live index (shared, cached ~90 s). `waitMs` bounds how long a caller waits for a rebuild —
 * past it they get the previous copy (or undefined on a cold start).
 */
export async function liveOpenWork(waitMs?: number): Promise<OpenWorkIndex | undefined> {
  return tenantMemo(
    'cc:open-work',
    LIVE_TTL_MS,
    async () =>
      (
        await sharedGatedRead('cc:open-work', 'command-center', buildLive, {
          label: 'cc:open-work'
        })
      ).value,
    { waitMs }
  )
}

/**
 * The index for a lens: live, or rebuilt as of `at` (memoised per minute). A rewind that is too
 * large or fails answers live with `liveOnly: true`.
 */
export async function openWorkFor(
  at: Date | null,
  who: string,
  waitMs?: number
): Promise<{ index: OpenWorkIndex | undefined; liveOnly: boolean }> {
  if (!at) return { index: await liveOpenWork(waitMs), liveOnly: false }
  const minute = Math.floor(at.getTime() / 60_000) * 60_000
  try {
    const index = await tenantMemo(`cc:open-work@${minute}`, 5 * 60_000, () =>
      withReadGate(who, () => buildAt(minute), { label: 'cc:open-work-rewind' })
    )
    if (index) return { index, liveOnly: false }
  } catch {
    /* fall through to live */
  }
  return { index: await liveOpenWork(), liveOnly: true }
}
