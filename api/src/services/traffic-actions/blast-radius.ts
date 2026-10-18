// api/src/services/traffic-actions/blast-radius.ts
/**
 * Blast radius (#2152): select a node and see what would break if it failed — the screens, flows,
 * scheduled jobs and partners that depend on it, from what was observed over the last 7 days,
 * with how many people used them. Read-only.
 *
 * Sources, per node kind:
 *  - an endpoint (`<lane>/<entity>`): its API log rows (people, API-key partners, the cron jobs
 *    and flow runs whose chains called it), its record writes made by jobs and flows (activity
 *    chain_parent), flows configured on its collection (event triggers, item read/write steps) with
 *    their runs, the partners its records were pushed to (ERP submissions), and the SCREENS people
 *    had open: each person's call is matched to the page they last opened (RUM route events) within
 *    SCREEN_MATCH_MS before it — the API log has no screen column, so this is an attribution, and
 *    the panel says so.
 *  - a partner (`ext:<id>`): its outbound calls by who triggered them, the flows with a step
 *    calling it, the collections whose records were pushed to it and the people using those.
 *
 * Every read is bounded (row caps, chunked IN lists) and the answer is kept for CACHE_MS per node,
 * so a panel left open does not re-run the week's reads.
 */
import { db } from '../../db/index.js'
import { extensionRoutes } from '../../extensions/loader.js'
import { hasColumn } from '../../lib/column-probe.js'
import { selectInChunks } from '../db-batch.js'
import type { TrafficLane } from '../traffic-entities.js'
import { applyHistoryNarrowing } from '../traffic-entity-history.js'
import { historyNarrowing } from '../traffic-history.js'
import { tapState } from '../traffic-taps.js'

export const BLAST_DAYS = 7
/** API log rows read for the screen attribution (newest first). */
export const CALL_SAMPLE = 5000
/** RUM route events read for the screen attribution. */
export const RUM_CAP = 50_000
/** A call belongs to the page its person opened at most this long before it. */
export const SCREEN_MATCH_MS = 30 * 60_000
const CACHE_MS = 5 * 60_000
const ENTITY_RE = /^([a-z]+)\/([A-Za-z0-9_][A-Za-z0-9_.-]{0,119})$/
const EXT_RE = /^ext:(\d{1,9})$/

export type BlastNode =
  | { kind: 'entity'; key: string; lane: TrafficLane; entity: string }
  | { kind: 'down'; key: string; apiId: number }

export function parseBlastNode(node: string): BlastNode | null {
  const e = node.match(ENTITY_RE)
  if (e) return { kind: 'entity', key: node, lane: e[1] as TrafficLane, entity: e[2] }
  const x = node.match(EXT_RE)
  if (x) return { kind: 'down', key: node, apiId: Number(x[1]) }
  return null
}

export interface ScreenUse {
  /** `<app> <route pattern>` (app omitted when unknown). */
  screen: string
  app: string | null
  route: string
  people: number
  calls: number
}

/** The screen key the map uses (`admin /collections/:c`). */
export function screenLabel(app: string | null | undefined, route: string): string {
  return app ? `${app} ${route}` : route
}

/**
 * Attribute calls to the page each person had open (pure). `rum` may be in any order; a call with
 * no page opened in the `windowMs` before it is not attributed.
 */
export function attributeScreens(
  calls: Array<{ user: string; at: number }>,
  rum: Array<{ user: string; at: number; route: string; app: string | null }>,
  windowMs = SCREEN_MATCH_MS
): { screens: ScreenUse[]; attributed: number } {
  const byUser = new Map<string, Array<{ at: number; route: string; app: string | null }>>()
  for (const r of rum) {
    const u = r.user.toUpperCase()
    const list = byUser.get(u) ?? []
    list.push(r)
    byUser.set(u, list)
  }
  for (const list of byUser.values()) list.sort((a, b) => a.at - b.at)
  const out = new Map<
    string,
    { app: string | null; route: string; people: Set<string>; calls: number }
  >()
  let attributed = 0
  for (const c of calls) {
    const u = c.user.toUpperCase()
    const list = byUser.get(u)
    if (!list?.length) continue
    // latest page opened at or before the call
    let lo = 0
    let hi = list.length - 1
    let idx = -1
    while (lo <= hi) {
      const mid = (lo + hi) >> 1
      if (list[mid].at <= c.at) {
        idx = mid
        lo = mid + 1
      } else hi = mid - 1
    }
    if (idx < 0 || c.at - list[idx].at > windowMs) continue
    const p = list[idx]
    const key = screenLabel(p.app, p.route)
    const s = out.get(key) ?? { app: p.app, route: p.route, people: new Set<string>(), calls: 0 }
    s.calls++
    s.people.add(u)
    out.set(key, s)
    attributed++
  }
  const screens = [...out]
    .map(([screen, s]) => ({
      screen,
      app: s.app,
      route: s.route,
      people: s.people.size,
      calls: s.calls
    }))
    .sort((a, b) => b.people - a.people || b.calls - a.calls)
    .slice(0, 25)
  return { screens, attributed }
}

/** `cron:<job>` / `flow_run:<id>` chain steps with their counts (pure). */
export function splitChainParents(
  rows: Array<{ chain_parent: string | null; n: number | string }>
): {
  jobs: Map<string, number>
  flowRuns: Map<string, number>
} {
  const jobs = new Map<string, number>()
  const flowRuns = new Map<string, number>()
  for (const r of rows) {
    const p = String(r.chain_parent ?? '')
    const n = Number(r.n) || 0
    if (p.startsWith('cron:')) jobs.set(p.slice(5), (jobs.get(p.slice(5)) ?? 0) + n)
    else if (p.startsWith('flow_run:'))
      flowRuns.set(p.slice(9), (flowRuns.get(p.slice(9)) ?? 0) + n)
  }
  return { jobs, flowRuns }
}

/** Flows whose configuration depends on `collection` (pure over the rows). */
export function flowsOnCollection(
  collection: string,
  flows: Array<{ id: string; trigger: string; trigger_options: string | null }>,
  ops: Array<{ flow: string; type: string; options: string | null }>
): Map<string, string> {
  const why = new Map<string, string>()
  const parse = (raw: string | null): Record<string, unknown> => {
    try {
      const v = raw ? JSON.parse(raw) : {}
      return v && typeof v === 'object' ? (v as Record<string, unknown>) : {}
    } catch {
      return {}
    }
  }
  for (const f of flows) {
    if (f.trigger !== 'event') continue
    const cols = parse(f.trigger_options).collections
    if (Array.isArray(cols) && cols.map(String).includes(collection))
      why.set(String(f.id), 'runs on its record events')
  }
  for (const o of ops) {
    if (o.type !== 'item-read' && o.type !== 'item-write') continue
    if (String(parse(o.options).collection ?? '') !== collection) continue
    if (!why.has(String(o.flow)))
      why.set(String(o.flow), o.type === 'item-read' ? 'reads its records' : 'writes its records')
  }
  return why
}

/** Flows with a step calling external API `apiId` (pure over the rows). */
export function flowsCallingApi(
  apiId: number,
  ops: Array<{ flow: string; type: string; options: string | null }>
): Set<string> {
  const out = new Set<string>()
  for (const o of ops) {
    if (o.type !== 'external-api') continue
    try {
      const v = o.options ? (JSON.parse(o.options) as { api_id?: unknown }) : {}
      if (Number(v.api_id) === apiId) out.add(String(o.flow))
    } catch {
      /* unreadable step */
    }
  }
  return out
}

export interface BlastRadius {
  node: string
  days: number
  /** Distinct signed-in people who used the node (endpoint) or the records feeding it (partner). */
  people: { total: number; top: Array<{ id: string; name: string; calls: number }> }
  screens: ScreenUse[]
  /** Share of sampled calls a screen could be found for (0–1); null with no sampled calls. */
  screens_coverage: number | null
  flows: Array<{
    id: string
    name: string
    active: boolean
    why: string
    runs: number
    failed: number
  }>
  jobs: Array<{ id: string; calls: number; runs: number; failed: number }>
  /** Inbound API keys calling the node. */
  callers: Array<{ id: string; label: string; calls: number }>
  /** Partners the node's records are pushed to (endpoint) — or, for a partner, who calls it. */
  partners: Array<{ id: string; label: string; n: number }>
  /** Partner node: collections whose records were pushed to it. */
  collections: Array<{ collection: string; pushes: number; people: number }>
  requests: number
  notes: string[]
  computed_at: string
}

type Row = Record<string, unknown>

async function safe<T>(
  notes: string[],
  what: string,
  fn: () => Promise<T>,
  fallback: T
): Promise<T> {
  try {
    return await fn()
  } catch {
    notes.push(`${what} could not be read.`)
    return fallback
  }
}

function nameOf(u: Row | undefined, id: string): string {
  if (!u) return 'Someone'
  return (
    `${String(u.first_name ?? '')} ${String(u.last_name ?? '')}`.trim() ||
    String(u.email ?? '') ||
    id
  )
}

async function peopleNames(ids: string[]): Promise<Map<string, Row>> {
  if (!ids.length) return new Map()
  const rows = (await selectInChunks(ids, 500, (chunk) =>
    db('nivaro_users').whereIn('id', chunk).select('id', 'first_name', 'last_name', 'email')
  )) as Row[]
  return new Map(rows.map((r) => [String(r.id).toUpperCase(), r]))
}

async function flowDetails(why: Map<string, string>, since: Date): Promise<BlastRadius['flows']> {
  const ids = [...why.keys()].slice(0, 100)
  if (!ids.length) return []
  const [flows, runs] = await Promise.all([
    selectInChunks(ids, 500, (c) =>
      db('nivaro_flows').whereIn('id', c).select('id', 'name', 'status')
    ) as Promise<Row[]>,
    selectInChunks(ids, 500, (c) =>
      db('nivaro_flow_runs')
        .whereIn('flow', c)
        .where('started_at', '>=', since)
        .groupBy('flow', 'status')
        .select('flow', 'status')
        .count({ n: '*' })
    ) as Promise<Row[]>
  ])
  const runBy = new Map<string, { runs: number; failed: number }>()
  for (const r of runs) {
    const k = String(r.flow).toLowerCase()
    const v = runBy.get(k) ?? { runs: 0, failed: 0 }
    const n = Number(r.n) || 0
    if (r.status !== 'skipped') v.runs += n
    if (r.status === 'error' || r.status === 'failed') v.failed += n
    runBy.set(k, v)
  }
  return flows
    .map((f) => {
      const id = String(f.id)
      const r = runBy.get(id.toLowerCase()) ?? { runs: 0, failed: 0 }
      const w = why.get(id) ?? why.get(id.toLowerCase()) ?? why.get(id.toUpperCase()) ?? 'called it'
      return { id, name: String(f.name ?? id), active: f.status === 'active', why: w, ...r }
    })
    .sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name))
}

async function jobDetails(calls: Map<string, number>, since: Date): Promise<BlastRadius['jobs']> {
  const ids = [...calls.keys()].slice(0, 100)
  if (!ids.length) return []
  const runs = (await selectInChunks(ids, 500, (c) =>
    db('nivaro_job_runs')
      .whereIn('job_id', c)
      .where('started_at', '>=', since)
      .groupBy('job_id', 'status')
      .select('job_id', 'status')
      .count({ n: '*' })
  )) as Row[]
  const by = new Map<string, { runs: number; failed: number }>()
  for (const r of runs) {
    const v = by.get(String(r.job_id)) ?? { runs: 0, failed: 0 }
    const n = Number(r.n) || 0
    v.runs += n
    if (r.status === 'error' || r.status === 'interrupted') v.failed += n
    by.set(String(r.job_id), v)
  }
  return ids
    .map((id) => ({ id, calls: calls.get(id) ?? 0, ...(by.get(id) ?? { runs: 0, failed: 0 }) }))
    .sort((a, b) => b.calls - a.calls)
}

/** Distinct people who called an endpoint since `since` (count only). */
async function distinctPeople(lane: TrafficLane, entity: string, since: Date): Promise<number> {
  const q = db('nivaro_api_logs').where('created_at', '>=', since).whereNotNull('user')
  applyHistoryNarrowing(q, historyNarrowing(lane, entity, extUrls(lane, entity)))
  const row = (await q.countDistinct({ n: 'user' }).first()) as { n?: number | string } | undefined
  return Number(row?.n) || 0
}

function extUrls(lane: TrafficLane, entity: string): string[] {
  return lane === 'extension' ? (extensionRoutes.get(entity) ?? []).map((r) => r.url) : []
}

async function entityBlast(n: Extract<BlastNode, { kind: 'entity' }>, since: Date) {
  const notes: string[] = []
  const urls = extUrls(n.lane, n.entity)
  const narrowing = historyNarrowing(n.lane, n.entity, urls)
  const base = () => {
    const q = db('nivaro_api_logs').where('created_at', '>=', since)
    applyHistoryNarrowing(q, narrowing)
    return q
  }
  const collectionLane = n.lane === 'items' || n.lane === 'system'
  if (n.lane === 'extension' && !urls.length)
    notes.push('This extension has no routes on this server.')
  const [hasChain, activityChain] = await Promise.all([
    hasColumn('nivaro_api_logs', 'chain_parent').catch(() => false),
    hasColumn('nivaro_activity', 'chain_parent').catch(() => false)
  ])
  const empty = n.lane === 'extension' && !urls.length
  const [total, peopleCount, byUser, byKey, chain, sample, actChain] = await Promise.all([
    empty
      ? 0
      : safe(
          notes,
          'Request totals',
          async () => Number(((await base().count({ n: '*' }).first()) as Row)?.n) || 0,
          0
        ),
    empty
      ? 0
      : safe(
          notes,
          'People',
          async () =>
            Number(
              ((await base().whereNotNull('user').countDistinct({ n: 'user' }).first()) as Row)?.n
            ) || 0,
          0
        ),
    empty
      ? []
      : safe(
          notes,
          'People',
          async () =>
            (await base()
              .whereNotNull('user')
              .groupBy('user')
              .select('user')
              .count({ n: '*' })
              .orderByRaw('count(*) desc')
              .limit(10)) as Row[],
          [] as Row[]
        ),
    empty
      ? []
      : safe(
          notes,
          'API-key callers',
          async () =>
            (await base()
              .whereNotNull('api_key_id')
              .groupBy('api_key_id')
              .select('api_key_id')
              .count({ n: '*' })
              .orderByRaw('count(*) desc')
              .limit(25)) as Row[],
          [] as Row[]
        ),
    empty || !hasChain
      ? []
      : safe(
          notes,
          'Jobs and flows',
          async () =>
            (await base()
              .where((b) =>
                b
                  .whereRaw("chain_parent LIKE 'cron:%'")
                  .orWhereRaw("chain_parent LIKE 'flow\\_run:%' ESCAPE '\\'")
              )
              .groupBy('chain_parent')
              .select('chain_parent')
              .count({ n: '*' })
              .limit(500)) as Row[],
          [] as Row[]
        ),
    empty
      ? []
      : safe(
          notes,
          'Screens',
          async () =>
            (await base()
              .whereNotNull('user')
              .orderBy('created_at', 'desc')
              .limit(CALL_SAMPLE)
              .select('user', 'created_at')) as Row[],
          [] as Row[]
        ),
    collectionLane && activityChain
      ? safe(
          notes,
          'Writes by jobs and flows',
          async () =>
            (await db('nivaro_activity')
              .where('collection', n.entity)
              .where('timestamp', '>=', since)
              .where((b) =>
                b
                  .whereRaw("chain_parent LIKE 'cron:%'")
                  .orWhereRaw("chain_parent LIKE 'flow\\_run:%' ESCAPE '\\'")
              )
              .groupBy('chain_parent')
              .select('chain_parent')
              .count({ n: '*' })
              .limit(500)) as Row[],
          [] as Row[]
        )
      : ([] as Row[])
  ])

  // Screens: each sampled call → the page its person last opened.
  const calls = (sample as Row[]).map((r) => ({
    user: String(r.user),
    at: new Date(r.created_at as Date).getTime()
  }))
  const users = [...new Set(calls.map((c) => c.user.toUpperCase()))].slice(0, 1000)
  const rum = users.length
    ? await safe(
        notes,
        'Screens',
        async () =>
          (await selectInChunks(users, 500, (chunk) =>
            db('nivaro_rum_events')
              .whereIn('user', chunk)
              .whereIn('kind', ['load', 'route'])
              .where('created_at', '>=', new Date(since.getTime() - SCREEN_MATCH_MS))
              .orderBy('created_at', 'desc')
              .limit(RUM_CAP)
              .select('user', 'route', 'app', 'created_at')
          )) as Row[],
        [] as Row[]
      )
    : []
  const { screens, attributed } = attributeScreens(
    calls,
    rum.map((r) => ({
      user: String(r.user),
      at: new Date(r.created_at as Date).getTime(),
      route: String(r.route),
      app: r.app == null ? null : String(r.app)
    }))
  )
  if (calls.length >= CALL_SAMPLE)
    notes.push(
      `Screens are matched from the newest ${CALL_SAMPLE.toLocaleString()} calls by people.`
    )

  // Jobs + flows: chain steps on the API log and the record writes.
  const fromLog = splitChainParents(chain as Array<{ chain_parent: string | null; n: number }>)
  const fromAct = splitChainParents(actChain as Array<{ chain_parent: string | null; n: number }>)
  const jobCalls = new Map(fromLog.jobs)
  for (const [k, v] of fromAct.jobs) jobCalls.set(k, (jobCalls.get(k) ?? 0) + v)
  const runIds = [...new Set([...fromLog.flowRuns.keys(), ...fromAct.flowRuns.keys()])].slice(
    0,
    2000
  )
  const why = new Map<string, string>()
  if (runIds.length) {
    const runFlows = await safe(
      notes,
      'Flow runs',
      async () =>
        (await selectInChunks(runIds, 500, (c) =>
          db('nivaro_flow_runs').whereIn('id', c).distinct('flow')
        )) as Row[],
      [] as Row[]
    )
    for (const r of runFlows) why.set(String(r.flow), 'its runs called or wrote it')
  }
  if (collectionLane) {
    const [flows, ops] = await Promise.all([
      safe(
        notes,
        'Flows',
        async () =>
          (await db('nivaro_flows')
            .where('trigger', 'event')
            .select('id', 'trigger', 'trigger_options')) as Row[],
        [] as Row[]
      ),
      safe(
        notes,
        'Flows',
        async () =>
          (await db('nivaro_flow_operations')
            .whereIn('type', ['item-read', 'item-write'])
            .select('flow', 'type', 'options')
            .limit(5000)) as Row[],
        [] as Row[]
      )
    ])
    for (const [id, w] of flowsOnCollection(
      n.entity,
      flows as Array<{ id: string; trigger: string; trigger_options: string | null }>,
      ops as Array<{ flow: string; type: string; options: string | null }>
    ))
      if (!why.has(id)) why.set(id, w)
  }
  const [flows, jobs, names, keys, pushes] = await Promise.all([
    safe(notes, 'Flows', () => flowDetails(why, since), [] as BlastRadius['flows']),
    safe(notes, 'Scheduled jobs', () => jobDetails(jobCalls, since), [] as BlastRadius['jobs']),
    safe(
      notes,
      'People',
      () => peopleNames((byUser as Row[]).map((r) => String(r.user))),
      new Map<string, Row>()
    ),
    (byKey as Row[]).length
      ? safe(
          notes,
          'API keys',
          async () =>
            (await db('nivaro_api_keys')
              .whereIn(
                'id',
                (byKey as Row[]).map((r) => Number(r.api_key_id))
              )
              .select('id', 'name')) as Row[],
          [] as Row[]
        )
      : ([] as Row[]),
    collectionLane
      ? safe(
          notes,
          'Partner pushes',
          async () =>
            (await db('nivaro_erp_submissions as s')
              .leftJoin('nivaro_external_apis as a', 'a.id', 's.external_api')
              .where('s.collection', n.entity)
              .where('s.created_at', '>=', since)
              .groupBy('s.external_api', 'a.name')
              .select('s.external_api', 'a.name')
              .count({ n: '*' })) as Row[],
          [] as Row[]
        )
      : ([] as Row[])
  ])
  const keyName = new Map(
    (keys as Row[]).map((k) => [Number(k.id), String(k.name ?? `Key ${k.id}`)])
  )
  const body: BlastRadius = {
    node: n.key,
    days: BLAST_DAYS,
    people: {
      total: peopleCount as number,
      top: (byUser as Row[]).map((r) => {
        const id = String(r.user).toUpperCase()
        return { id, name: nameOf(names.get(id), id), calls: Number(r.n) || 0 }
      })
    },
    screens,
    screens_coverage: calls.length ? attributed / calls.length : null,
    flows,
    jobs,
    callers: (byKey as Row[]).map((r) => ({
      id: `k${Number(r.api_key_id)}`,
      label: keyName.get(Number(r.api_key_id)) ?? `API key ${r.api_key_id}`,
      calls: Number(r.n) || 0
    })),
    partners: (pushes as Row[]).map((r) => ({
      id: `ext:${Number(r.external_api)}`,
      label: String(r.name ?? `External API ${r.external_api}`),
      n: Number(r.n) || 0
    })),
    collections: [],
    requests: total as number,
    notes: [...new Set(notes)],
    computed_at: new Date().toISOString()
  }
  return body
}

async function downBlast(n: Extract<BlastNode, { kind: 'down' }>, since: Date) {
  const notes: string[] = []
  const api = (await db('nivaro_external_apis').where({ id: n.apiId }).first('id', 'name')) as
    | Row
    | undefined
  if (!api) return null
  const hasTriggered = await hasColumn('nivaro_outbound_log', 'triggered_by').catch(() => false)
  const [total, byTrigger, ops, pushes] = await Promise.all([
    safe(
      notes,
      'Calls',
      async () =>
        Number(
          (
            (await db('nivaro_outbound_log')
              .where('api_id', n.apiId)
              .where('created_at', '>=', since)
              .count({ n: '*' })
              .first()) as Row
          )?.n
        ) || 0,
      0
    ),
    hasTriggered
      ? safe(
          notes,
          'Who calls it',
          async () =>
            (await db('nivaro_outbound_log')
              .where('api_id', n.apiId)
              .where('created_at', '>=', since)
              .groupBy('triggered_by')
              .select('triggered_by')
              .count({ n: '*' })
              .orderByRaw('count(*) desc')
              .limit(25)) as Row[],
          [] as Row[]
        )
      : ([] as Row[]),
    safe(
      notes,
      'Flows',
      async () =>
        (await db('nivaro_flow_operations')
          .where('type', 'external-api')
          .select('flow', 'type', 'options')
          .limit(5000)) as Row[],
      [] as Row[]
    ),
    safe(
      notes,
      'Pushes',
      async () =>
        (await db('nivaro_erp_submissions')
          .where('external_api', n.apiId)
          .where('created_at', '>=', since)
          .groupBy('collection')
          .select('collection')
          .count({ n: '*' })
          .orderByRaw('count(*) desc')
          .limit(10)) as Row[],
      [] as Row[]
    )
  ])
  const why = new Map<string, string>()
  for (const id of flowsCallingApi(
    n.apiId,
    ops as Array<{ flow: string; type: string; options: string | null }>
  ))
    why.set(id, 'has a step calling it')
  const flows = await safe(
    notes,
    'Flows',
    () => flowDetails(why, since),
    [] as BlastRadius['flows']
  )
  const jobCalls = new Map<string, number>()
  const partners: BlastRadius['partners'] = []
  for (const r of byTrigger as Row[]) {
    const t = String(r.triggered_by ?? '')
    const c = Number(r.n) || 0
    if (t.startsWith('cron:')) jobCalls.set(t.slice(5), (jobCalls.get(t.slice(5)) ?? 0) + c)
    else partners.push({ id: t || 'unknown', label: t || 'Not recorded', n: c })
  }
  const jobs = await safe(
    notes,
    'Scheduled jobs',
    () => jobDetails(jobCalls, since),
    [] as BlastRadius['jobs']
  )
  const collections: BlastRadius['collections'] = []
  for (const p of (pushes as Row[]).slice(0, 5)) {
    const c = String(p.collection)
    const people = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(c)
      ? await safe(notes, 'People', () => distinctPeople('items', c, since), 0)
      : 0
    collections.push({ collection: c, pushes: Number(p.n) || 0, people })
  }
  const body: BlastRadius = {
    node: n.key,
    days: BLAST_DAYS,
    people: { total: collections.reduce((m, c) => Math.max(m, c.people), 0), top: [] },
    screens: [],
    screens_coverage: null,
    flows,
    jobs,
    callers: [],
    partners,
    collections,
    requests: total as number,
    notes: [
      ...new Set([
        ...notes,
        'People are those using the collections whose records were pushed here (the largest one).'
      ])
    ],
    computed_at: new Date().toISOString()
  }
  return body
}

interface Cached {
  at: number
  value: Promise<BlastRadius | null>
}
function cache(): Map<string, Cached> {
  return tapState('blast-radius', () => new Map<string, Cached>())
}

/** The blast radius of a node (cached CACHE_MS; concurrent asks share one read). */
export async function blastRadius(node: BlastNode, fresh = false): Promise<BlastRadius | null> {
  const c = cache()
  const hit = c.get(node.key)
  if (hit && !fresh && Date.now() - hit.at < CACHE_MS) return hit.value
  const since = new Date(Date.now() - BLAST_DAYS * 86_400_000)
  const value = node.kind === 'entity' ? entityBlast(node, since) : downBlast(node, since)
  c.set(node.key, { at: Date.now(), value })
  if (c.size > 100) c.delete(c.keys().next().value as string)
  value.catch(() => c.delete(node.key))
  return value
}

// ── #2274: who to tell ───────────────────────────────────────────────────────
export const AFFECTED_WINDOW_MS = 3600_000
const ROUTE_RE = /^\/[\w\-:/.*]{0,299}$/

/** Screen labels as the blast radius shows them → (app, route) pairs (pure; bad ones dropped). */
export function parseScreens(raw: unknown): Array<{ app: string | null; route: string }> {
  const list = Array.isArray(raw) ? raw.slice(0, 30) : []
  const out: Array<{ app: string | null; route: string }> = []
  for (const s of list) {
    const str = String(s ?? '').trim()
    const cut = str.indexOf(' ')
    const app = cut > 0 ? str.slice(0, cut) : null
    const route = cut > 0 ? str.slice(cut + 1) : str
    if (!ROUTE_RE.test(route)) continue
    if (app && !/^[\w.-]{1,100}$/.test(app)) continue
    out.push({ app, route })
  }
  return out
}

/** The asked-for screens that the node's blast radius really lists (pure; the rest dropped). */
export function knownScreens(
  asked: Array<{ app: string | null; route: string }>,
  known: Array<{ app: string | null; route: string }>
): Array<{ app: string | null; route: string }> {
  const labels = new Set(known.map((k) => screenLabel(k.app, k.route)))
  return asked.filter((s) => labels.has(screenLabel(s.app, s.route)))
}

/**
 * People affected right now: who called the node in the last hour, plus who opened one of the
 * affected screens in the last hour. The screens come from the page, so only those the node's own
 * blast radius (worked out here, cached) lists count. Only active, unredacted accounts; never
 * `exclude` (the sender). Ids only — the caller resolves names.
 */
export async function affectedPeople(
  node: BlastNode,
  asked: Array<{ app: string | null; route: string }>,
  exclude: string | null
): Promise<string[]> {
  const screens = asked.length
    ? knownScreens(asked, (await blastRadius(node).catch(() => null))?.screens ?? [])
    : []
  const since = new Date(Date.now() - AFFECTED_WINDOW_MS)
  const ids = new Set<string>()
  if (node.kind === 'entity') {
    const q = db('nivaro_api_logs').where('created_at', '>=', since).whereNotNull('user')
    applyHistoryNarrowing(
      q,
      historyNarrowing(node.lane, node.entity, extUrls(node.lane, node.entity))
    )
    for (const r of (await q.distinct('user').limit(5000)) as Row[])
      ids.add(String(r.user).toUpperCase())
  }
  if (screens.length) {
    const rows = (await db('nivaro_rum_events')
      .where('created_at', '>=', since)
      .whereNotNull('user')
      .where((b) => {
        for (const s of screens)
          b.orWhere((g) => {
            g.where('route', s.route)
            if (s.app) g.where('app', s.app)
          })
      })
      .distinct('user')
      .limit(5000)) as Row[]
    for (const r of rows) ids.add(String(r.user).toUpperCase())
  }
  if (exclude) ids.delete(exclude.toUpperCase())
  if (!ids.size) return []
  const active = (await selectInChunks([...ids], 500, (chunk) =>
    db('nivaro_users')
      .whereIn('id', chunk)
      .where({ status: 'active' })
      .where((b) => b.where('is_redacted', false).orWhereNull('is_redacted'))
      .select('id')
  )) as Row[]
  return active.map((r) => String(r.id))
}

/** The prefilled message for telling people (pure; the admin edits it before sending). */
export function prefilledMessage(
  label: string,
  screens: ScreenUse[]
): { subject: string; message: string } {
  const where = screens.length
    ? ` You may see errors or slow pages on ${screens
        .slice(0, 3)
        .map((s) => s.route)
        .join(', ')}.`
    : ''
  return {
    subject: `We are looking into a problem with ${label}`,
    message: `We know about a problem affecting ${label} and are working on it.${where} There is no need to report it; we will post an update when it is fixed.`
  }
}
