// api/src/services/traffic-inspect/entities-sources.ts
/**
 * Inspect sources `entity`, `query`, `widget` (#1200), `page` (#1203) and `down` — the detail of
 * one node of the map, read from what the map and its services already keep:
 *
 *  - entity: the map's own tap details (entity callers, error groups), its 1–24 h history from
 *    the API log, recent errors (with request ids when logged) and recent writes (activity ids);
 *  - query:  the saved custom query, live cache stats, freshness, the last slow plan, dependents;
 *  - widget: the record widget's definition (via the definition cache) and its bound query;
 *  - page:   a screen pattern from the screens tap — calls per load, who is on it, client builds;
 *  - down:   the map's down-node history; for `ext:<id>` the partner's config and submissions.
 */
import { db } from '../../db/index.js'
import { extensionRoutes } from '../../extensions/loader.js'
import { hasColumn } from '../../lib/column-probe.js'
import { usersOnPath } from '../../plugins/socketio.js'
import { capturedPlanFor } from '../../routes/custom-queries.js'
import { customQueryDependents } from '../custom-query-dependents.js'
import { cachedDefinition } from '../definition-cache.js'
import { cacheStats, lastQueryError } from '../query-cache-stats.js'
import { queryFreshness } from '../query-freshness.js'
import {
  applyHistoryNarrowing,
  downNodeHistory,
  entityHistory,
  entityTapDetails,
  HistoryUnavailableError
} from '../traffic-entity-history.js'
import { historyNarrowing } from '../traffic-history.js'
import type { InspectCtx, InspectPeek } from '../traffic-inspect.js'
import { currentTrafficSec } from '../traffic-map.js'
import { screensReport } from '../traffic-taps/screens.js'
import { trafficTaps } from '../traffic-taps.js'
import {
  historyHoursFor,
  jsonArray,
  jsonObject,
  mapWindowFor,
  parseEntityRef,
  parsePageRef,
  partnerIdOf,
  rangeFor,
  relatedRefOf,
  safeBaseUrl,
  screenKeyOf,
  validQuerySlug,
  validWidgetId,
  widgetConfigSummary
} from './entities-logic.js'

const RECENT = 15
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const NO_LOG_LANES = new Set(['socket'])

const personName = (u: Record<string, unknown>) =>
  `${String(u.first_name ?? '')} ${String(u.last_name ?? '')}`.trim() ||
  String(u.email ?? '').split('@')[0] ||
  null

async function userNames(ids: unknown[]): Promise<Map<string, string>> {
  const list = [
    ...new Set(ids.map((x) => String(x ?? '').toUpperCase()).filter((x) => UUID.test(x)))
  ]
  const out = new Map<string, string>()
  if (!list.length) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', list.slice(0, 500))
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Array<Record<string, unknown>>
  for (const r of rows) {
    const n = personName(r)
    if (n) out.set(String(r.id).toUpperCase(), n)
  }
  return out
}

/** Newest failed requests on an entity in the range, with their request ids when logged. */
async function recentErrors(lane: string, entity: string, from: Date, to: Date) {
  if (NO_LOG_LANES.has(lane)) return []
  const extUrls = lane === 'extension' ? (extensionRoutes.get(entity) ?? []).map((r) => r.url) : []
  const n = historyNarrowing(lane as never, entity, extUrls)
  if (lane === 'extension' && !n.like?.length) return []
  const withRid = await hasColumn('nivaro_api_logs', 'request_id').catch(() => false)
  const q = db('nivaro_api_logs')
    .where('created_at', '>=', from)
    .where('created_at', '<=', to)
    .where('status', '>=', 400)
    .orderBy('created_at', 'desc')
    .limit(RECENT)
    .select('method', 'path', 'status', 'latency_ms', 'created_at', 'api_key_id', 'user', 'auth')
  if (withRid) q.select('request_id')
  applyHistoryNarrowing(q, n)
  const rows = (await q.catch(() => [])) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    at: r.created_at,
    method: String(r.method ?? 'GET').toUpperCase(),
    path: String(r.path ?? ''),
    status: Number(r.status) || 0,
    ms: Number(r.latency_ms) || 0,
    caller:
      r.auth === 'api_key' && r.api_key_id != null
        ? `k${r.api_key_id}`
        : r.user
          ? `u${String(r.user).toUpperCase()}`
          : 'anon',
    request_id: r.request_id ? String(r.request_id) : null
  }))
}

/** Newest writes to a collection (activity rows — each a `write` level). */
async function recentWrites(collection: string, from: Date, to: Date) {
  const rows = (await db('nivaro_activity')
    .where('collection', collection)
    .whereIn('action', ['create', 'update', 'delete'])
    .where('timestamp', '>=', from)
    .where('timestamp', '<=', to)
    .orderBy('id', 'desc')
    .limit(RECENT)
    .select('id', 'action', 'item', 'user', 'timestamp', 'origin')
    .catch(() => [])) as Array<Record<string, unknown>>
  const names = await userNames(rows.map((r) => r.user))
  return rows.map((r) => ({
    id: Number(r.id),
    action: String(r.action),
    item: r.item == null ? null : String(r.item),
    user: r.user ? String(r.user).toUpperCase() : null,
    user_name: r.user ? (names.get(String(r.user).toUpperCase()) ?? null) : null,
    at: r.timestamp,
    origin: r.origin ? String(r.origin) : null
  }))
}

async function entityLabel(lane: string, entity: string): Promise<string | null> {
  try {
    if (lane === 'queries') {
      const r = await db('nivaro_custom_queries').where('slug', entity).first('name')
      return r?.name ? String(r.name) : null
    }
    if (lane === 'widgets' && validWidgetId(entity)) {
      const r = await db('nivaro_widgets').where('id', Number(entity)).first('name')
      return r?.name ? String(r.name) : null
    }
    if (lane === 'items' || lane === 'system') {
      const r = await db('nivaro_collections').where('collection', entity).first('display_name')
      return r?.display_name ? String(r.display_name) : null
    }
  } catch {
    /* a label is a nicety */
  }
  if (entity === '__other__') return 'other'
  if (entity === '__background__') return 'Background jobs'
  return null
}

// ── entity ────────────────────────────────────────────────────────────────────

export async function entityDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  const ref = parseEntityRef(id)
  if (!ref) return null
  const { lane, entity } = ref
  const key = `${lane}/${entity}`
  const range = rangeFor(ctx.at, ctx.windowSec)
  const from = new Date(range.from)
  const to = new Date(range.to)
  const hours = historyHoursFor(ctx.windowSec)
  let historyError: string | null = null
  const [label, taps, history, errors, writes] = await Promise.all([
    entityLabel(lane, entity),
    entityTapDetails(key, mapWindowFor(ctx.windowSec)).catch(() => ({}) as Record<string, unknown>),
    NO_LOG_LANES.has(lane)
      ? Promise.resolve(null)
      : entityHistory(lane, entity, hours).catch((err) => {
          historyError =
            err instanceof HistoryUnavailableError
              ? 'The API log could not be read right now.'
              : 'History could not be built.'
          return null
        }),
    recentErrors(lane, entity, from, to),
    lane === 'items' || lane === 'system' ? recentWrites(entity, from, to) : Promise.resolve(null)
  ])
  const callers = (taps['entity-callers'] as { callers?: unknown[] } | undefined)?.callers ?? []
  const groups = (taps['error-groups'] as { groups?: unknown[] } | undefined)?.groups ?? []
  return {
    key,
    lane,
    entity,
    label: label ?? entity,
    related: relatedRefOf(lane, entity),
    range,
    map_window: mapWindowFor(ctx.windowSec),
    history,
    history_hours: hours,
    history_error: historyError,
    history_note: NO_LOG_LANES.has(lane)
      ? 'Socket events are counted on the map only — the API log holds no rows for them.'
      : null,
    callers: callers.slice(0, 10),
    error_groups: groups.slice(0, 10),
    other_lenses: Object.keys(taps)
      .filter((k) => k !== 'entity-callers' && k !== 'error-groups')
      .sort(),
    recent_errors: errors,
    recent_writes: writes,
    request_ids_logged: await hasColumn('nivaro_api_logs', 'request_id').catch(() => false)
  }
}

export async function entityPeek(id: string): Promise<InspectPeek | null> {
  const ref = parseEntityRef(id)
  if (!ref) return null
  const label = await entityLabel(ref.lane, ref.entity)
  return { title: label ?? ref.entity, lines: [`${ref.lane} lane`] }
}

// ── query ─────────────────────────────────────────────────────────────────────

async function loadQuery(id: string): Promise<Record<string, unknown> | null> {
  const q = db('nivaro_custom_queries').select(
    'id',
    'name',
    'description',
    'slug',
    'sql_text',
    'params',
    'cache_ttl',
    'enabled',
    'access',
    'warm_daily',
    'updated_at',
    'freshness_sources'
  )
  if (/^\d{1,9}$/.test(id)) q.where('id', Number(id))
  else q.where('slug', id)
  return ((await q.first()) as Record<string, unknown> | undefined) ?? null
}

export async function queryDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  if (!validQuerySlug(id)) return null
  const row = await loadQuery(id)
  if (!row) return null
  const slug = String(row.slug)
  const qid = Number(row.id)
  const range = rangeFor(ctx.at, ctx.windowSec)
  const [freshness, dependents, errors] = await Promise.all([
    queryFreshness(
      row as { id: unknown; sql_text?: string | null; freshness_sources?: string | null }
    )
      .then((f) => ({ ok: true as const, ...f }))
      .catch(() => ({ ok: false as const })),
    customQueryDependents(qid, slug).catch(() => null),
    recentErrors('queries', slug, new Date(range.from), new Date(range.to))
  ])
  const stats = cacheStats()
  const plan = capturedPlanFor(qid)
  return {
    id: qid,
    slug,
    name: String(row.name ?? slug),
    description: row.description ? String(row.description) : null,
    sql_text: String(row.sql_text ?? ''),
    params: jsonArray(row.params) ?? [],
    cache_ttl: Number(row.cache_ttl ?? 0),
    enabled: row.enabled === true || row.enabled === 1,
    access: row.access ? String(row.access) : null,
    warm_daily: row.warm_daily === true || row.warm_daily === 1,
    updated_at: row.updated_at ?? null,
    entity: `queries/${slug}`,
    cache: {
      since: stats.since,
      row: stats.rows.find((r) => r.slug === slug) ?? null,
      last_error: lastQueryError(slug)
    },
    freshness,
    plan: plan
      ? {
          captured_at: new Date(plan.at).toISOString(),
          duration_ms: plan.duration_ms,
          params: plan.params,
          ...plan.plan
        }
      : null,
    dependents,
    recent_errors: errors
  }
}

export async function queryPeek(id: string): Promise<InspectPeek | null> {
  if (!validQuerySlug(id)) return null
  const row = await loadQuery(id)
  if (!row) return null
  const ttl = Number(row.cache_ttl ?? 0)
  return {
    title: String(row.name ?? row.slug),
    lines: [`/${String(row.slug)}`, ttl > 0 ? `Cached ${ttl}s` : 'Not cached']
  }
}

// ── widget ────────────────────────────────────────────────────────────────────

async function loadWidget(id: number): Promise<Record<string, unknown> | null> {
  const w = await cachedDefinition(`widget:${id}`, () =>
    db('nivaro_widgets').where({ id }).first()
  ).catch(() => null)
  return (w as Record<string, unknown> | undefined) ?? null
}

export async function widgetDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  if (!validWidgetId(id)) return null
  const w = await loadWidget(Number(id))
  if (!w) return null
  const config = jsonObject(w.config)
  const summary = widgetConfigSummary(config)
  let query: Record<string, unknown> | null = null
  if (summary.query_id != null) {
    const q = (await cachedDefinition(`custom-query:${summary.query_id}`, () =>
      db('nivaro_custom_queries').where({ id: summary.query_id }).first()
    ).catch(() => null)) as Record<string, unknown> | null | undefined
    if (q) {
      const slug = String(q.slug)
      query = {
        id: Number(q.id),
        slug,
        name: String(q.name ?? slug),
        cache_ttl: Number(q.cache_ttl ?? 0),
        cache: cacheStats().rows.find((r) => r.slug === slug) ?? null
      }
    } else {
      query = { id: summary.query_id, missing: true }
    }
  }
  const range = rangeFor(ctx.at, ctx.windowSec)
  const raw = typeof w.config === 'string' ? w.config : config ? JSON.stringify(config) : ''
  return {
    id: Number(w.id),
    name: String(w.name ?? `Widget ${id}`),
    description: w.description ? String(w.description) : null,
    type: String(w.widget_type ?? ''),
    active: w.is_active === true || w.is_active === 1 || w.is_active == null,
    inputs: jsonArray(w.inputs) ?? jsonObject(w.inputs),
    config_lines: summary.lines,
    config_raw: raw.length > 4000 ? `${raw.slice(0, 4000)}…` : raw,
    query,
    entity: `widgets/${id}`,
    recent_errors: await recentErrors('widgets', id, new Date(range.from), new Date(range.to))
  }
}

export async function widgetPeek(id: string): Promise<InspectPeek | null> {
  if (!validWidgetId(id)) return null
  const w = await loadWidget(Number(id))
  if (!w) return null
  return { title: String(w.name ?? `Widget ${id}`), lines: [String(w.widget_type ?? 'widget')] }
}

// ── page ──────────────────────────────────────────────────────────────────────

export async function pageDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  const page = parsePageRef(id)
  if (!page) return null
  const win = mapWindowFor(ctx.windowSec)
  const sec = currentTrafficSec()
  const report = screensReport(win, sec)
  const rows = report.screens
    .filter((r) => r.path === page.path && (!page.app || r.app === page.app))
    .map((r) => ({
      screen: r.screen,
      app: r.app,
      calls: r.calls,
      loads: r.loads,
      avg: r.avg,
      max: r.max,
      over_limit: r.over_limit,
      worst: r.worst,
      callers: r.callers
    }))
  // Presence knows real paths, not patterns: a pattern with no id segment is a real path.
  const literal = !page.path.includes(':')
  const present = literal ? usersOnPath(page.path) : []
  const tabsTap = trafficTaps().find((t) => t.id === 'stale-tabs')
  let builds: unknown = null
  try {
    const snap = tabsTap?.snapshot?.(win, sec) as
      | { apps?: Array<{ app: string; tabs: number; stale: number; builds: unknown[] }> }
      | undefined
    const apps = snap?.apps ?? []
    builds = page.app ? apps.filter((a) => a.app === page.app) : apps
  } catch {
    builds = null
  }
  return {
    id: screenKeyOf(page),
    app: page.app,
    path: page.path,
    window_s: win,
    fanout_limit: report.limit,
    screens: rows,
    present: present.map((p) => ({ id: p.id, name: p.name, since: p.since })),
    present_note: literal
      ? null
      : 'Who has this exact screen open is only known for screens without an id in the address; the people below made requests from it in the window.',
    builds
  }
}

export async function pagePeek(id: string, ctx: InspectCtx): Promise<InspectPeek | null> {
  const page = parsePageRef(id)
  if (!page) return null
  const rows = screensReport(mapWindowFor(ctx.windowSec)).screens.filter(
    (r) => r.path === page.path && (!page.app || r.app === page.app)
  )
  const calls = rows.reduce((s, r) => s + r.calls, 0)
  return {
    title: page.path,
    lines: [page.app ?? 'any app', rows.length ? `${calls} calls in the window` : 'No calls seen']
  }
}

// ── down ──────────────────────────────────────────────────────────────────────

async function partnerSummary(apiId: number) {
  const a = (await db('nivaro_external_apis')
    .where('id', apiId)
    .first(
      'id',
      'name',
      'base_url',
      'description',
      'auth_type',
      'enabled',
      'integration_type',
      'owner_user',
      'health_last_ok',
      'health_last_at',
      'health_last_detail',
      'mock_config'
    )
    .catch(() => null)) as Record<string, unknown> | null | undefined
  if (!a) return null
  const owner = a.owner_user
    ? (await userNames([a.owner_user])).get(String(a.owner_user).toUpperCase())
    : null
  const mock = jsonObject(a.mock_config)
  return {
    id: Number(a.id),
    name: String(a.name ?? `Partner ${apiId}`),
    base_url: safeBaseUrl(a.base_url),
    description: a.description ? String(a.description) : null,
    auth_type: a.auth_type ? String(a.auth_type) : null,
    enabled: a.enabled === true || a.enabled === 1,
    integration_type: a.integration_type ? String(a.integration_type) : null,
    owner_name: owner ?? null,
    health:
      a.health_last_at != null
        ? {
            ok: a.health_last_ok === true || a.health_last_ok === 1,
            at: a.health_last_at,
            detail: a.health_last_detail ? String(a.health_last_detail).slice(0, 200) : null
          }
        : null,
    mocked_instances: mock
      ? Object.entries(mock)
          .filter(([, v]) => (v as { enabled?: boolean } | null)?.enabled === true)
          .map(([k]) => k)
      : []
  }
}

async function partnerSubmissions(apiId: number) {
  const rows = (await db('nivaro_erp_submissions')
    .where('external_api', apiId)
    .orderBy('id', 'desc')
    .limit(RECENT)
    .select(
      'id',
      'status',
      'collection',
      'item',
      'attempts',
      'error_class',
      'last_error',
      'created_at',
      'updated_at'
    )
    .catch(() => [])) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    id: Number(r.id),
    status: String(r.status ?? ''),
    collection: r.collection ? String(r.collection) : null,
    item: r.item == null ? null : String(r.item),
    attempts: Number(r.attempts ?? 0),
    error_class: r.error_class ? String(r.error_class) : null,
    last_error: r.last_error ? String(r.last_error).slice(0, 200) : null,
    at: r.updated_at ?? r.created_at ?? null
  }))
}

const OWN_LABELS: Record<string, string> = {
  db: 'SQL Server',
  redis: 'Redis',
  store: 'File storage'
}

export async function downDetail(id: string, ctx: InspectCtx): Promise<unknown | null> {
  const hours = historyHoursFor(ctx.windowSec)
  const apiId = partnerIdOf(id)
  let historyError: string | null = null
  const [history, partner, submissions] = await Promise.all([
    downNodeHistory(id, hours).catch((err) => {
      historyError =
        err instanceof HistoryUnavailableError
          ? 'The history log could not be read right now.'
          : 'History could not be built.'
      return null
    }),
    apiId != null ? partnerSummary(apiId) : Promise.resolve(null),
    apiId != null ? partnerSubmissions(apiId) : Promise.resolve(null)
  ])
  return {
    id,
    label: OWN_LABELS[id] ?? partner?.name ?? null,
    history_hours: hours,
    history: history?.kind === 'ok' ? history.data : null,
    history_error: historyError,
    history_note:
      history?.kind === 'unknown'
        ? 'No log is kept for this node — only the live figures on the map.'
        : null,
    partner,
    partner_missing: apiId != null && !partner,
    submissions
  }
}

export async function downPeek(id: string): Promise<InspectPeek | null> {
  const apiId = partnerIdOf(id)
  if (apiId != null) {
    const p = await partnerSummary(apiId)
    return {
      title: p?.name ?? `Partner ${apiId}`,
      lines: [
        p ? (p.enabled ? 'Partner API · enabled' : 'Partner API · disabled') : 'No such partner'
      ]
    }
  }
  return { title: OWN_LABELS[id] ?? id, lines: ['Downstream dependency'] }
}
