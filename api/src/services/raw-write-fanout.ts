import { runInBackgroundPool } from '../db/pool-context.js'
import { liveModeNow } from './collection-live-mode.js'
import { publishItemEvent } from './item-events.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Announced raw writes feed everything that listens (realtime round 3, item 6).
 *
 * A procedure, import or script that announces its writes (services/raw-write-announcer.ts)
 * already reaches open pages, the SSE event stream and GraphQL subscriptions when it names an
 * action. This module adds the rest of what an items-service write would set off for "something
 * changed":
 *
 *  - GraphQL subscriptions and @live queries hear an announcement that named NO action too
 *    (as an `update`) — before, those only reached sockets;
 *  - outbound webhooks and event flows fire on `update` — OPT-IN per webhook / flow ("also fire
 *    on changes made outside the app", default off) because an outside change carries no
 *    previousData and no person: a webhook opts in with `outside` in its events list, a flow with
 *    `outside_changes: true` in its event trigger options (after-timing only — nothing can shape
 *    a write that already happened);
 *  - alert definitions on the collection are re-evaluated for the announced rows (thresholds
 *    read the current value, so they work without previousData).
 *
 * Not fired: field watches (they tell a person "X changed from A to B" and need the old value
 * to know anything changed at all), before-flows, and anything for a collection-wide
 * announcement ("many rows changed", item '*') — that never fires per-row webhooks or flows.
 *
 * Loop guard: every announcement carries an origin marker — `flow:<id>` when a flow run made the
 * write (the flow executor's traffic source), or a drained inbox row whose `source` is
 * `flow:<id>` / `webhook:<id>`. A flow or webhook never fires for an announcement of its own
 * write.
 *
 * Rows are read once per batch (only when something opted in or an alert watches the
 * collection), raw, the same way the items service hands its result to webhooks and flows.
 * Capped per process per minute; anything over the cap is dropped and counted.
 */

export const OUTSIDE_EVENT = 'outside'
/** Past this many ids in one announcement the batch is collection-wide: no per-row fan-out. */
export const FANOUT_ROW_CAP = 100
const CACHE_MS = 15_000
const MAX_FIRES_PER_MIN = 2_000
const CONCURRENCY = 4
const ORIGIN_RE = /^(flow|webhook):[A-Za-z0-9_-]{1,64}$/
const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]{0,254}$/

export interface FanoutAnnouncement {
  collection: string
  ids?: Array<string | number> | null
  action?: 'create' | 'update' | 'delete'
  changed_fields?: string[]
  source?: string
  /** Loop-guard marker: `flow:<id>` / `webhook:<id>` that made the write. */
  origin?: string | null
}

export interface FanoutBroadcast {
  collection: string
  item: string | number
  action?: 'create' | 'update' | 'delete'
  changed_fields?: string[]
}

export interface OutsideRowGroup {
  collection: string
  action: 'create' | 'update'
  ids: string[]
  changed_fields: string[]
  origin: string | null
}

export interface OutsideWebhook {
  id: number | string
  url: string
  method: string | null
  headers: string | null
  secret: string | null
  signing_secret?: string | null
  collections?: string | null
  events?: string | null
  conditions?: string | null
}

export interface OutsideFlow {
  id: string
  name: string
  collections: string[]
}

/** The loop-guard marker of an announcement (null = a person, a procedure, a script). */
export function originOf(a: Pick<FanoutAnnouncement, 'origin' | 'source'>): string | null {
  if (a.origin && ORIGIN_RE.test(a.origin)) return a.origin
  if (a.source && ORIGIN_RE.test(a.source)) return a.source
  return null
}

function parseList(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String)
  if (typeof raw !== 'string' || !raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v.map(String) : []
  } catch {
    return []
  }
}

/**
 * Per-row groups an announcement batch may fan out to. Pure — exported for tests.
 * One group per (collection, action, origin). Deletes, unknown collections and
 * collection-wide announcements (no ids, or more than `cap`) are left out.
 */
export function planOutsideRows(
  list: FanoutAnnouncement[],
  cap = FANOUT_ROW_CAP
): OutsideRowGroup[] {
  const groups = new Map<string, OutsideRowGroup & { whole: boolean; idSet: Set<string> }>()
  for (const a of list) {
    if (!a || typeof a.collection !== 'string' || !IDENT_RE.test(a.collection)) continue
    if (/^nivaro_/i.test(a.collection)) continue
    if (a.action === 'delete') continue
    const action = a.action === 'create' ? 'create' : 'update'
    const origin = originOf(a)
    const key = `${a.collection}|${action}|${origin ?? ''}`
    const g = groups.get(key) ?? {
      collection: a.collection,
      action,
      ids: [],
      changed_fields: [],
      origin,
      whole: false,
      idSet: new Set<string>()
    }
    const ids = (a.ids ?? []).filter((i) => i != null && String(i).trim() !== '')
    if (ids.length === 0 || ids.length > cap) g.whole = true
    for (const i of ids) g.idSet.add(String(i).trim().slice(0, 255))
    for (const f of a.changed_fields ?? []) {
      const name = String(f).trim()
      if (IDENT_RE.test(name) && !g.changed_fields.includes(name) && g.changed_fields.length < 50)
        g.changed_fields.push(name)
    }
    groups.set(key, g)
  }
  const out: OutsideRowGroup[] = []
  for (const g of groups.values()) {
    if (g.whole || g.idSet.size === 0 || g.idSet.size > cap) continue
    out.push({
      collection: g.collection,
      action: g.action,
      ids: [...g.idSet],
      changed_fields: g.changed_fields,
      origin: g.origin
    })
  }
  return out
}

/** Whether a webhook asked for outside changes of this collection. Pure — exported for tests. */
export function webhookHearsOutside(
  wh: Pick<OutsideWebhook, 'id' | 'events' | 'collections'>,
  collection: string,
  origin: string | null
): boolean {
  const events = parseList(wh.events)
  if (!events.includes(OUTSIDE_EVENT) || !events.includes('update')) return false
  const collections = parseList(wh.collections)
  if (collections.length > 0 && !collections.includes(collection)) return false
  return origin !== `webhook:${wh.id}`
}

/** Whether an opted-in flow fires for this group. Pure — exported for tests. */
export function flowHearsOutside(
  flow: OutsideFlow,
  collection: string,
  origin: string | null
): boolean {
  if (flow.collections.length > 0 && !flow.collections.includes(collection)) return false
  return origin !== `flow:${flow.id}`
}

/**
 * The flows that opted in, from their stored trigger rows. Pure — exported for tests:
 * event trigger, active, after-timing, `update` among its types (or none named), and
 * `outside_changes: true`.
 */
export function outsideFlowsFrom(
  rows: Array<{ id: string; name?: string | null; trigger_options?: string | null }>
): OutsideFlow[] {
  const out: OutsideFlow[] = []
  for (const r of rows) {
    let o: Record<string, unknown> = {}
    try {
      o = r.trigger_options ? (JSON.parse(r.trigger_options) as Record<string, unknown>) : {}
    } catch {
      continue
    }
    if (o.outside_changes !== true) continue
    if ((o.timing ?? 'after') !== 'after') continue
    const types = Array.isArray(o.types) ? o.types.map(String) : []
    const itemTypes = types.filter((t) => t === 'create' || t === 'update' || t === 'delete')
    if (itemTypes.length > 0 && !itemTypes.includes('update')) continue
    const collections = Array.isArray(o.collections) ? o.collections.map(String) : []
    out.push({ id: String(r.id), name: String(r.name ?? r.id), collections })
  }
  return out
}

// ── Dependencies (injectable for tests) ─────────────────────────────────────

export interface FanoutDeps {
  liveModeOff(collection: string): boolean
  publishItemEvent(ev: {
    collection: string
    item: string
    action: 'create' | 'update' | 'delete'
    changed_fields: string[]
  }): void
  outsideWebhooks(): Promise<OutsideWebhook[]>
  outsideFlows(): Promise<OutsideFlow[]>
  hasAlerts(collection: string): Promise<boolean>
  readRows(collection: string, ids: string[]): Promise<Array<Record<string, unknown>>>
  fireWebhooks(
    collection: string,
    row: Record<string, unknown>,
    meta: { changed_fields: string[]; origin: string | null }
  ): Promise<void>
  runFlow(flow: OutsideFlow, payload: Record<string, unknown>): Promise<void>
  evaluateAlerts(collection: string, row: Record<string, unknown>, id: string): Promise<void>
}

const tenantCache = new Map<
  string,
  {
    webhooks?: { at: number; v: Promise<OutsideWebhook[]> }
    flows?: { at: number; v: Promise<OutsideFlow[]> }
    alerts: Map<string, { at: number; v: Promise<boolean> }>
  }
>()

function cacheFor(tenant: string) {
  let c = tenantCache.get(tenant)
  if (!c) {
    c = { alerts: new Map() }
    tenantCache.set(tenant, c)
    if (tenantCache.size > 500) tenantCache.delete(tenantCache.keys().next().value as string)
  }
  return c
}

/** Drop the opt-in caches (a webhook or flow was saved). */
export function forgetOutsideFanoutCache(): void {
  tenantCache.clear()
}

const defaultDeps: FanoutDeps = {
  // A collection whose mode is not read yet in this process counts as "on" (like realtime.ts).
  liveModeOff: (collection) => liveModeNow(collection) === 'off',
  publishItemEvent: (ev) => publishItemEvent(ev),
  async outsideWebhooks() {
    const c = cacheFor(currentTenantKey())
    if (c.webhooks && Date.now() - c.webhooks.at < CACHE_MS) return c.webhooks.v
    const v = (async () => {
      const { db } = await import('../db/index.js')
      const rows = (await db('nivaro_webhooks')
        .where({ enabled: true })
        .select('*')) as OutsideWebhook[]
      return rows.filter((w) => parseList(w.events).includes(OUTSIDE_EVENT))
    })().catch(() => [] as OutsideWebhook[])
    c.webhooks = { at: Date.now(), v }
    return v
  },
  async outsideFlows() {
    const c = cacheFor(currentTenantKey())
    if (c.flows && Date.now() - c.flows.at < CACHE_MS) return c.flows.v
    const v = (async () => {
      const { db } = await import('../db/index.js')
      const rows = (await db('nivaro_flows')
        .where({ trigger: 'event', status: 'active' })
        .select('id', 'name', 'trigger_options')) as Array<{
        id: string
        name: string | null
        trigger_options: string | null
      }>
      return outsideFlowsFrom(rows)
    })().catch(() => [] as OutsideFlow[])
    c.flows = { at: Date.now(), v }
    return v
  },
  async hasAlerts(collection) {
    const c = cacheFor(currentTenantKey())
    const hit = c.alerts.get(collection)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.v
    const v = (async () => {
      const { db } = await import('../db/index.js')
      const row = await db('nivaro_alert_definitions')
        .where({ collection, is_active: true })
        .first('id')
      return !!row
    })().catch(() => false)
    c.alerts.set(collection, { at: Date.now(), v })
    return v
  },
  async readRows(collection, ids) {
    const { db } = await import('../db/index.js')
    const { selectInChunks, whereInList } = await import('./db-batch.js')
    return selectInChunks(
      ids,
      500,
      async (chunk) =>
        (await whereInList(db(collection).select('*'), 'id', chunk)) as Array<
          Record<string, unknown>
        >
    )
  },
  async fireWebhooks(collection, row, meta) {
    const { fireWebhooks } = await import('./webhook-dispatch.js')
    await fireWebhooks(collection, 'update', row, {
      origin: 'outside',
      changed_fields: meta.changed_fields,
      outside: { skipOrigin: meta.origin }
    })
  },
  async runFlow(flow, payload) {
    const { executeFlow } = await import('./flow-executor.js')
    const log = console as unknown as Parameters<typeof executeFlow>[0]['log']
    await executeFlow({
      flowId: flow.id,
      flowName: flow.name,
      trigger: 'after:update',
      payload,
      log
    }).catch((err: unknown) =>
      console.warn('[raw-write-fanout] flow failed', flow.id, err instanceof Error ? err.message : err)
    )
  },
  async evaluateAlerts(collection, row, id) {
    const { evaluateAlertsForCollection } = await import('../hooks/alerts.js')
    await evaluateAlertsForCollection(collection, row, id)
  }
}

const budget = { windowStart: 0, used: 0, dropped: 0 }
const stats = { itemEvents: 0, webhookRows: 0, flowRuns: 0, alertRows: 0, dropped: 0 }

function takeFire(): boolean {
  const now = Date.now()
  if (now - budget.windowStart >= 60_000) {
    budget.windowStart = now
    budget.used = 0
  }
  if (budget.used >= MAX_FIRES_PER_MIN) {
    stats.dropped++
    return false
  }
  budget.used++
  return true
}

async function runLimited(tasks: Array<() => Promise<void>>): Promise<void> {
  let next = 0
  const worker = async () => {
    while (next < tasks.length) {
      const t = tasks[next++]
      try {
        await t()
      } catch {
        /* one failed fire never stops the rest */
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, worker))
}

function pick(row: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of fields) if (Object.hasOwn(row, f)) out[f] = row[f]
  return out
}

/**
 * Fan an announced batch out. `planned` = what the announcer broadcast (for the GraphQL event of
 * an action-less announcement), `list` = the announcements themselves (for per-row fan-out).
 * Never throws; runs on the background pool.
 */
export async function fanOutRawWrites(
  list: FanoutAnnouncement[],
  planned: FanoutBroadcast[],
  deps: FanoutDeps = defaultDeps
): Promise<void> {
  // 1. GraphQL subscriptions / @live queries for announcements that named no action. (With an
  //    action, broadcastCollectionUpdate already published the itemMutated event.)
  for (const p of planned) {
    if (p.action) continue
    try {
      if (deps.liveModeOff(p.collection)) continue
      deps.publishItemEvent({
        collection: p.collection,
        item: String(p.item),
        action: 'update',
        changed_fields: (p.changed_fields ?? []).slice(0, 50)
      })
      stats.itemEvents++
    } catch {
      /* best effort */
    }
  }

  // 2. Per-row webhooks, flows and alerts — never for collection-wide announcements.
  const groups = planOutsideRows(list)
  if (groups.length === 0) return
  await runInBackgroundPool(async () => {
    let webhooks: OutsideWebhook[] = []
    let flows: OutsideFlow[] = []
    try {
      ;[webhooks, flows] = await Promise.all([deps.outsideWebhooks(), deps.outsideFlows()])
    } catch {
      webhooks = []
      flows = []
    }
    for (const g of groups) {
      const hooks = g.action === 'update'
        ? webhooks.filter((w) => webhookHearsOutside(w, g.collection, g.origin))
        : []
      const runs = g.action === 'update'
        ? flows.filter((f) => flowHearsOutside(f, g.collection, g.origin))
        : []
      const alerts = await deps.hasAlerts(g.collection).catch(() => false)
      if (hooks.length === 0 && runs.length === 0 && !alerts) continue
      let rows: Array<Record<string, unknown>> = []
      try {
        rows = await deps.readRows(g.collection, g.ids)
      } catch {
        continue
      }
      const tasks: Array<() => Promise<void>> = []
      for (const row of rows) {
        const id = row.id == null ? null : String(row.id)
        if (id == null) continue
        if (hooks.length > 0 && takeFire()) {
          stats.webhookRows++
          tasks.push(() =>
            deps.fireWebhooks(g.collection, row, {
              changed_fields: g.changed_fields,
              origin: g.origin
            })
          )
        }
        for (const flow of runs) {
          if (!takeFire()) break
          stats.flowRuns++
          tasks.push(() =>
            deps.runFlow(flow, {
              collection: g.collection,
              action: 'update',
              keys: [id],
              payload: pick(row, g.changed_fields),
              previousData: {},
              changed_fields: g.changed_fields,
              outside: true
            })
          )
        }
        if (alerts && takeFire()) {
          stats.alertRows++
          tasks.push(() => deps.evaluateAlerts(g.collection, row, id))
        }
      }
      await runLimited(tasks)
    }
  }).catch(() => {})
}

export function rawWriteFanoutStats() {
  return { ...stats, usedThisMinute: budget.used }
}

/** Tests. */
export function __resetRawWriteFanout(): void {
  budget.windowStart = 0
  budget.used = 0
  for (const k of Object.keys(stats) as Array<keyof typeof stats>) stats[k] = 0
  tenantCache.clear()
}
