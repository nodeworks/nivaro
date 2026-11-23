import { db } from '../db/index.js'
import { appDate } from './chaos/clock.js'
import { whereInList } from './db-batch.js'
import { isNivaroCloud } from './deployment-mode.js'
import { tenantState } from './ai-tenant-state.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Time-based SLA flips (realtime round 2). An SLA clock turns amber and then red with no write
 * at all — nothing announces it, so an open list or record kept the old colour until a reload.
 * This light pass (cron `sla-live-flips`, every minute, quiet) finds the records whose warning
 * or breach instant passed since it last looked and announces the `$sla` aspect on each
 * (announceRecordAspect: ids + aspect name only). Open pages re-read their own SLA status as
 * the viewer; pages that count down client-side (services/sla-deadline.ts instants) have
 * usually recoloured already, and the notice keeps the rest (stat strips, counts) honest.
 *
 * Cheap by construction:
 * - only collections someone has open right now (socket rooms + the realtime board,
 *   getLiveCollectionNames); every SLA collection when this process cannot tell;
 * - each collection's deadlines are read at most every REFRESH_MS (one indexed read of its
 *   open instances in ruled states + the SLA batch), and in between a pass is pure arithmetic
 *   over the instants it already holds — no database read per minute;
 * - a crossing is announced once (keyed by record + kind + instant); a deadline that passed up
 *   to LOOKBACK_MS ago still counts, so a record that entered a ruled state between two reads
 *   is not missed when the next read finds it already past its line.
 *
 * At-risk rules (routes/at-risk.ts) compare fields with fixed values or other fields — no
 * condition is relative to "now" — so they never flip by time alone and are not swept here.
 * Off in cloud mode (module state is per process, not per tenant).
 */

export const REFRESH_MS = 5 * 60_000
export const LOOKBACK_MS = 15 * 60_000

export interface FlipRow {
  collection: string
  item: string
  /** Epoch ms; null = no such line. */
  warning_at: number | null
  due_at: number | null
}

export interface FlipCrossing {
  collection: string
  item: string
  kind: 'warning' | 'due'
  at: number
}

/**
 * The crossings among `rows` that happened in (now - lookbackMs, now] and were not announced
 * yet. Records each one in `announced` (key → instant) and forgets keys older than twice the
 * lookback. Pure apart from `announced` — exported for tests.
 */
export function slaCrossings(
  rows: readonly FlipRow[],
  now: number,
  announced: Map<string, number>,
  lookbackMs = LOOKBACK_MS
): FlipCrossing[] {
  const out: FlipCrossing[] = []
  for (const r of rows) {
    for (const kind of ['warning', 'due'] as const) {
      const at = kind === 'warning' ? r.warning_at : r.due_at
      if (at == null || at > now || at <= now - lookbackMs) continue
      const key = `${r.collection}\u0001${r.item}\u0001${kind}\u0001${at}`
      if (announced.has(key)) continue
      announced.set(key, at)
      out.push({ collection: r.collection, item: r.item, kind, at })
    }
  }
  for (const [k, at] of announced) if (at <= now - 2 * lookbackMs) announced.delete(k)
  return out
}

export interface SlaFlipDeps {
  /** Collections someone has open now; null = cannot tell (treat all as open). */
  liveCollections: () => Set<string> | null
  /** Collections that have an active SLA rule (through a pipeline binding). */
  slaCollections: () => Promise<string[]>
  /** Every open record in a ruled state of `collection`, with its two instants. */
  loadDeadlines: (collection: string) => Promise<FlipRow[]>
  announce: (collection: string, item: string) => void
  now: () => number
}

export interface SlaFlipPass {
  run(): Promise<{ collections: number; announced: number }>
  reset(): void
}

export function createSlaFlipPass(
  deps: SlaFlipDeps,
  opts: { refreshMs?: number; lookbackMs?: number } = {}
): SlaFlipPass {
  const refreshMs = opts.refreshMs ?? REFRESH_MS
  const lookbackMs = opts.lookbackMs ?? LOOKBACK_MS
  const held = new Map<string, { at: number; rows: FlipRow[] }>()
  const announced = new Map<string, number>()
  let ruled: { at: number; list: string[] } | null = null
  return {
    async run() {
      const now = deps.now()
      if (!ruled || now - ruled.at >= refreshMs)
        ruled = { at: now, list: await deps.slaCollections().catch(() => ruled?.list ?? []) }
      const live = deps.liveCollections()
      const watched = ruled.list.filter((c) => !live || live.has(c))
      // A collection nobody watches any more is forgotten; it is read fresh when opened again.
      for (const c of [...held.keys()]) if (!watched.includes(c)) held.delete(c)
      let count = 0
      for (const c of watched) {
        let entry = held.get(c)
        if (!entry || now - entry.at >= refreshMs) {
          const rows = await deps.loadDeadlines(c).catch(() => entry?.rows ?? [])
          entry = { at: now, rows }
          held.set(c, entry)
        }
        for (const x of slaCrossings(entry.rows, now, announced, lookbackMs)) {
          deps.announce(x.collection, x.item)
          count++
        }
      }
      return { collections: watched.length, announced: count }
    },
    reset() {
      held.clear()
      announced.clear()
      ruled = null
    }
  }
}

// ── The real dependencies ────────────────────────────────────────────────────

async function ruledStates(): Promise<Array<{ template: string; stateId: string }>> {
  const rules = (await db('nivaro_sla_rules')
    .where({ is_active: true })
    .select('workflow_template', 'state_key')) as Array<{
    workflow_template: string
    state_key: string
  }>
  if (rules.length === 0) return []
  const templates = [...new Set(rules.map((r) => String(r.workflow_template)))]
  const states = (await db('nivaro_workflow_states')
    .whereIn('template', templates)
    .select('id', 'template', 'key')) as Array<{ id: string; template: string; key: string }>
  const wanted = new Set(rules.map((r) => `${String(r.workflow_template)}\u0001${r.state_key}`))
  return states
    .filter((s) => wanted.has(`${String(s.template)}\u0001${s.key}`))
    .map((s) => ({ template: String(s.template), stateId: String(s.id) }))
}

async function slaCollectionsFromDb(): Promise<string[]> {
  const states = await ruledStates()
  if (states.length === 0) return []
  const templates = [...new Set(states.map((s) => s.template))]
  const rows = (await db('nivaro_workflow_bindings')
    .whereIn('template', templates)
    .distinct('collection')) as Array<{ collection: string | null }>
  return [...new Set(rows.map((r) => r.collection).filter((c): c is string => !!c))]
}

async function loadDeadlinesFromDb(collection: string): Promise<FlipRow[]> {
  const states = await ruledStates()
  if (states.length === 0) return []
  const stateIds = [...new Set(states.map((s) => s.stateId))]
  const instances = (await whereInList(
    db('nivaro_workflow_instances').where({ collection }).whereNull('completed_at'),
    'current_state',
    stateIds
  )
    .orderBy('started_at', 'desc')
    .select('id', 'item', 'current_state', 'template', 'started_at')) as Array<{
    id: string
    item: string
    current_state: string | null
    template: string
    started_at: Date | string
  }>
  if (instances.length === 0) return []
  const { computeStatusBatch } = await import('../routes/sla.js')
  const ids = [...new Set(instances.map((i) => String(i.item)))]
  const batch = await computeStatusBatch(collection, ids, instances)
  const ms = (v: string | null | undefined) => {
    if (!v) return null
    const t = new Date(v).getTime()
    return Number.isFinite(t) ? t : null
  }
  const out: FlipRow[] = []
  for (const [item, e] of Object.entries(batch)) {
    if (e.duration_hours == null) continue
    out.push({ collection, item, warning_at: ms(e.warning_at), due_at: ms(e.due_at) })
  }
  return out
}

/** One pass per app: a shared deployment's apps hold copies (same collection, same record id). */
const passHolder = tenantState(() => ({ pass: null as SlaFlipPass | null }))

/** One tick of the cron, in the current app. Never in Nivaro Cloud. `overrides` is for tests. */
export async function runSlaFlipPass(
  overrides: Partial<SlaFlipDeps> = {}
): Promise<{ collections: number; announced: number }> {
  if (isNivaroCloud()) return { collections: 0, announced: 0 }
  const held = passHolder()
  if (!held.pass) {
    const [{ getLiveCollectionNames }, { announceRecordAspect }] = await Promise.all([
      import('../plugins/socketio.js'),
      import('./record-events.js')
    ])
    held.pass = createSlaFlipPass({
      liveCollections: () => getLiveCollectionNames(currentTenantKey() || undefined),
      slaCollections: slaCollectionsFromDb,
      loadDeadlines: loadDeadlinesFromDb,
      announce: (c, item) => announceRecordAspect(c, item, '$sla'),
      now: () => appDate().getTime(),
      ...overrides
    })
  }
  return held.pass.run()
}
