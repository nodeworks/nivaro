import type { FastifyInstance } from 'fastify'
import { db } from '../../../db/index.js'
import { csvCell, csvRow } from '../../../lib/csv-cell.js'
import { chunkArray } from '../../db-batch.js'
import { hubModeEnabled } from '../mode.js'
import { contextFor, type OpenConnection, regionFor } from './engine/plan.js'
import { ensureCoreProviders } from './index.js'
import { PROVIDER_COSTS } from './pricing/index.js'
import { getProvider } from './registry.js'
import { listConnections, listResources, openConnectionSecrets } from './store.js'
import type { CostRow } from './types.js'

/**
 * Hub providers, Wave 3 framework (Task 34): the provider cost feed. Once a day
 * (`hub-provider-costs`, 06:10 UTC, Hub only, one leader through the cron plugin's Redis lease,
 * only where cronTicksEnabled()) every connection whose adapter has `costs()` is asked what it
 * billed per day; each row is mapped to an app — by the managed resource whose provider id the
 * row names first, then by the `nivaro-hub:app` tag, else it stays unassigned — and stored in
 * nivaro_hub_provider_costs. The Costs page shows it as **Outside spend** (per app, per provider,
 * month to date and the last 12 months) and the chargeback CSV carries it.
 *
 * Rules:
 *  - A re-read replaces the days the provider answered for (delete + insert in one transaction),
 *    never adds to them; days it did not answer for are kept.
 *  - The first read of a connection goes back FIRST_READ_DAYS; later ones re-read the last
 *    REREAD_DAYS (providers revise recent days and close the previous month late).
 *  - One connection's failure or slowness never stops the others; its scrubbed error is kept
 *    in the feed state (nivaro_extension_settings `nivaro-hub` / `cost_feed`).
 *  - Rows are figures and names only (service, record type) — never a provider body.
 */

export { PROVIDER_COSTS }
export const COST_FEED_JOB = 'hub-provider-costs'
export const COST_FEED_CRON = '10 6 * * *'
export const COSTS_KEEP_DAYS = 400
export const FIRST_READ_DAYS = 365
export const REREAD_DAYS = 35
export const CONNECTION_BUDGET_MS = 120_000
/** The most rows one connection's answer may carry (anything past it is ignored, and said). */
export const MAX_ROWS_PER_READ = 100_000
export const COST_FEED_STATE = { extension_id: 'nivaro-hub', key: 'cost_feed' } as const

const DAY = 86_400_000
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const CURRENCY_RE = /^[A-Z]{3}$/
const RECORD_TYPES = new Set(['usage', 'tax', 'credit', 'discount', 'refund'])

const ymd = (d: Date) => d.toISOString().slice(0, 10)
const validDate = (s: string) => {
  if (!DATE_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return Number.isFinite(d.getTime()) && ymd(d) === s
}

export type CostSource = 'resource' | 'tag' | 'none'

/** One stored row (nivaro_hub_provider_costs without id / fetched_at). */
export interface MappedCostRow {
  connection_id: number
  provider: string
  date: string
  app_id: number | null
  resource_id: number | null
  service: string
  record_type: string
  amount_cents: number
  currency: string
  source: CostSource
}

/** What a connection's rows are mapped with. */
export interface CostIndex {
  /** Managed resource provider id → its Hub row (resource + app). */
  byExternalId: Map<string, { resourceId: number; appId: number | null }>
  /** App key (`nivaro-hub:app` tag value) → app id. */
  appByKey: Map<string, number>
}

/**
 * Maps and sums one answer (pure): rows outside `range`, with a bad date, amount or currency are
 * skipped; the rest are grouped by the stored row's key so each key is one row.
 */
export function mapCostRows(
  connectionId: number,
  provider: string,
  rows: CostRow[],
  index: CostIndex,
  range: { from: string; to: string }
): { rows: MappedCostRow[]; dates: string[]; skipped: number } {
  const sums = new Map<string, MappedCostRow>()
  const dates = new Set<string>()
  let skipped = 0
  for (const r of rows.slice(0, MAX_ROWS_PER_READ)) {
    const date = typeof r?.date === 'string' ? r.date.slice(0, 10) : ''
    const amount = Number(r?.amountCents)
    const currency = String(r?.currency ?? '')
      .trim()
      .toUpperCase()
    if (
      !validDate(date) ||
      date < range.from ||
      date > range.to ||
      !Number.isFinite(amount) ||
      !CURRENCY_RE.test(currency)
    ) {
      skipped++
      continue
    }
    const kind = String(r.recordType ?? 'usage').toLowerCase()
    const record_type = RECORD_TYPES.has(kind) ? kind : 'usage'
    const service = String(r.service ?? '')
      .trim()
      .slice(0, 64)
    let app_id: number | null = null
    let resource_id: number | null = null
    let source: CostSource = 'none'
    const hit = r.externalId ? index.byExternalId.get(String(r.externalId)) : undefined
    if (hit) {
      resource_id = hit.resourceId
      app_id = hit.appId
      source = 'resource'
    } else if (r.appTag && index.appByKey.has(String(r.appTag))) {
      app_id = index.appByKey.get(String(r.appTag)) ?? null
      source = 'tag'
    }
    dates.add(date)
    const key = JSON.stringify([date, app_id, resource_id, service, record_type, currency])
    const prev = sums.get(key)
    if (prev) prev.amount_cents += amount
    else
      sums.set(key, {
        connection_id: connectionId,
        provider,
        date,
        app_id,
        resource_id,
        service,
        record_type,
        amount_cents: amount,
        currency,
        source
      })
  }
  skipped += Math.max(0, rows.length - MAX_ROWS_PER_READ)
  const out = [...sums.values()].map((r) => ({ ...r, amount_cents: Math.round(r.amount_cents) }))
  return { rows: out, dates: [...dates].sort(), skipped }
}

/** The mapping index of one connection: its managed resources (deleted ones too) and app keys. */
export async function costIndex(connectionId: number): Promise<CostIndex> {
  const byExternalId: CostIndex['byExternalId'] = new Map()
  // Deleted rows first, so a live resource with the same provider id wins.
  const rows = (await listResources({ connectionId, includeDeleted: true })).sort(
    (a, b) => Number(a.deleted_at == null) - Number(b.deleted_at == null)
  )
  for (const r of rows)
    if (r.external_id) byExternalId.set(r.external_id, { resourceId: r.id, appId: r.app_id })
  const apps = (await db('nivaro_hub_apps').select('id', 'key')) as Array<{
    id: unknown
    key: unknown
  }>
  const appByKey = new Map(apps.map((a) => [String(a.key), Number(a.id)]))
  return { byExternalId, appByKey }
}

/** Replaces the given days of one connection with `rows` (one transaction). */
export async function storeCostRows(
  connectionId: number,
  dates: string[],
  rows: MappedCostRow[],
  now: Date
): Promise<void> {
  if (!dates.length) return
  await db.transaction(async (trx) => {
    for (const part of chunkArray(dates, 200))
      await trx(PROVIDER_COSTS).where('connection_id', connectionId).whereIn('date', part).delete()
    for (const part of chunkArray(rows, 100))
      await trx(PROVIDER_COSTS).insert(part.map((r) => ({ ...r, fetched_at: now })))
  })
}

/** Which days to ask a connection for: back FIRST_READ_DAYS the first time, else REREAD_DAYS. */
export async function costRange(
  connectionId: number,
  now: Date
): Promise<{ from: string; to: string }> {
  const any = await db(PROVIDER_COSTS).where('connection_id', connectionId).first('id')
  const back = any ? REREAD_DAYS : FIRST_READ_DAYS
  return { from: ymd(new Date(now.getTime() - back * DAY)), to: ymd(now) }
}

export interface FeedState {
  at: string
  ok: boolean
  rows: number
  days: number
  skipped: number
  from: string | null
  to: string | null
  error: string | null
}

export async function readFeedState(): Promise<Record<string, FeedState>> {
  try {
    const row = (await db('nivaro_extension_settings').where(COST_FEED_STATE).first('value')) as
      | { value: string | null }
      | undefined
    const v = row?.value ? JSON.parse(row.value) : {}
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {}
  } catch {
    return {}
  }
}

async function writeFeedState(state: Record<string, FeedState>): Promise<void> {
  const value = JSON.stringify(state)
  const existing = (await db('nivaro_extension_settings').where(COST_FEED_STATE).first('id')) as
    | { id: number }
    | undefined
  if (existing)
    await db('nivaro_extension_settings')
      .where({ id: existing.id })
      .update({ value, updated_at: new Date() })
  else
    await db('nivaro_extension_settings').insert({
      ...COST_FEED_STATE,
      value,
      updated_at: new Date()
    })
}

export interface CostFeedDeps {
  now?: () => Date
  /** Per connection; default CONNECTION_BUDGET_MS. */
  timeoutMs?: number
}

export interface CostFeedResult {
  connections: number
  failed: number
  rows: number
  pruned: number
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

/** Reads one connection's costs for `range` and stores them. Throws the scrubbed failure. */
export async function readConnectionCosts(
  conn: OpenConnection,
  range: { from: string; to: string },
  opts: { now: Date; timeoutMs: number }
): Promise<{ rows: number; days: number; skipped: number }> {
  const costs = conn.adapter.costs
  if (!costs) return { rows: 0, days: 0, skipped: 0 }
  const ac = new AbortController()
  const ctx = contextFor(conn, regionFor(conn.row.config, null, null), { signal: ac.signal })
  let timer: NodeJS.Timeout | undefined
  try {
    const answer = await Promise.race([
      costs.call(conn.adapter, ctx, range),
      new Promise<never>((_r, reject) => {
        timer = setTimeout(() => {
          ac.abort()
          reject(
            Object.assign(new Error('The provider did not answer in time.'), { code: 'TIMEOUT' })
          )
        }, opts.timeoutMs)
      })
    ])
    const mapped = mapCostRows(
      conn.row.id,
      conn.row.provider,
      Array.isArray(answer) ? answer : [],
      await costIndex(conn.row.id),
      range
    )
    await storeCostRows(conn.row.id, mapped.dates, mapped.rows, opts.now)
    return { rows: mapped.rows.length, days: mapped.dates.length, skipped: mapped.skipped }
  } catch (e) {
    // Scrub first, then clip (a secret cut in half would survive the scrub otherwise).
    const code =
      e && typeof e === 'object' && typeof (e as { code?: unknown }).code === 'string'
        ? (e as { code: string }).code
        : 'PROVIDER_ERROR'
    const msg = clip(ctx.scrub(e instanceof Error ? e.message : String(e)))
    throw Object.assign(new Error(`${code}: ${msg}`), { code })
  } finally {
    clearTimeout(timer)
  }
}

/** The daily job: every connection with a cost feed, then the 400-day prune. Never throws. */
export async function costFeedTick(deps: CostFeedDeps = {}): Promise<CostFeedResult> {
  const now = (deps.now ?? (() => new Date()))()
  const timeoutMs = deps.timeoutMs ?? CONNECTION_BUDGET_MS
  const out: CostFeedResult = { connections: 0, failed: 0, rows: 0, pruned: 0 }
  ensureCoreProviders()
  const state = await readFeedState()
  const seen = new Set<string>()
  for (const row of await listConnections()) {
    const adapter = getProvider(row.provider)
    if (!adapter?.costs) continue
    seen.add(String(row.id))
    if (row.status === 'disabled') continue
    out.connections++
    let range: { from: string; to: string } | null = null
    try {
      range = await costRange(row.id, now)
      const conn: OpenConnection = { row, adapter, secrets: await openConnectionSecrets(row) }
      const r = await readConnectionCosts(conn, range, { now, timeoutMs })
      out.rows += r.rows
      state[String(row.id)] = {
        at: now.toISOString(),
        ok: true,
        ...r,
        from: range.from,
        to: range.to,
        error: null
      }
    } catch (e) {
      out.failed++
      state[String(row.id)] = {
        at: now.toISOString(),
        ok: false,
        rows: 0,
        days: 0,
        skipped: 0,
        from: range?.from ?? null,
        to: range?.to ?? null,
        // readConnectionCosts already scrubbed it; anything else is a Hub-side failure.
        error: clip(e instanceof Error ? e.message : 'The cost feed could not be read.')
      }
    }
  }
  // Connections removed (or no longer with a feed) leave the state; their billed rows stay.
  for (const k of Object.keys(state)) if (!seen.has(k)) delete state[k]
  await writeFeedState(state).catch(() => undefined)
  try {
    out.pruned = await db(PROVIDER_COSTS)
      .where('date', '<', ymd(new Date(now.getTime() - COSTS_KEEP_DAYS * DAY)))
      .delete()
  } catch {
    // the prune tries again tomorrow
  }
  return out
}

/**
 * Registers the daily job (06:10 UTC). The cron plugin holds the one-leader Redis lease and ticks
 * only where cronTicksEnabled(); this adds the Hub-mode check. Called from the provider routes.
 */
export function registerProviderCostsCron(app: FastifyInstance): void {
  if (!hubModeEnabled() || !app.cron) return
  app.cron.schedule(
    'hub-provider-costs', // a literal: cron-scope.guard reads the id from the source
    COST_FEED_CRON,
    async () => {
      if (!hubModeEnabled()) return
      const r = await costFeedTick()
      if (r.failed)
        app.log.info(
          `${COST_FEED_JOB}: ${r.connections} feeds read, ${r.failed} failed, ${r.rows} rows stored`
        )
    },
    {
      quiet: true,
      idempotent: 'safe',
      timezone: 'UTC',
      description:
        'Daily 06:10 UTC (Hub only) — asks every provider connection with a cost feed what it billed per day (the last 35 days; 365 the first time), maps each row to an app by managed resource, then by the nivaro-hub:app tag, stores it in nivaro_hub_provider_costs (a re-read replaces those days) and prunes rows older than 400 days.'
    }
  )
}

// ── Outside spend (the Costs page and the chargeback CSV) ──

export type SpendKind = 'app' | 'shared' | 'unassigned'

export interface SpendRow {
  kind: SpendKind
  app_id: number | null
  app_key: string | null
  app_name: string | null
  provider: string
  provider_label: string
  currency: string
  month_to_date_cents: number
  last_12_months_cents: number
  /** One amount per `months` entry (oldest first). */
  months_cents: number[]
}

export interface SpendFeed {
  connection_id: number
  name: string
  provider: string
  provider_label: string
  /** The newest day this connection's feed has a row for. */
  through: string | null
  last_read_at: string | null
  ok: boolean | null
  error: string | null
}

export interface OutsideSpend {
  generated_at: string
  /** The 12 calendar months the figures cover, oldest first (YYYY-MM); the last is this month. */
  months: string[]
  rows: SpendRow[]
  totals: Array<{ currency: string; month_to_date_cents: number; last_12_months_cents: number }>
  feeds: SpendFeed[]
}

const monthKey = (d: Date) => d.toISOString().slice(0, 7)

/** Outside spend per app (and shared / unassigned) and provider; admins only. */
export async function outsideSpend(now = new Date()): Promise<OutsideSpend> {
  ensureCoreProviders()
  const months: string[] = []
  for (let i = 11; i >= 0; i--)
    months.push(monthKey(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1))))
  const out: OutsideSpend = {
    generated_at: now.toISOString(),
    months,
    rows: [],
    totals: [],
    feeds: []
  }
  const label = (p: string) => getProvider(p)?.label ?? p
  if (!(await db.schema.hasTable(PROVIDER_COSTS))) return out
  const apps = new Map(
    (
      (await db('nivaro_hub_apps').select('id', 'key', 'name')) as Array<Record<string, unknown>>
    ).map((a) => [Number(a.id), { key: String(a.key), name: String(a.name ?? a.key) }])
  )
  const groups = new Map<string, SpendRow>()
  for (let i = 0; i < months.length; i++) {
    const from = `${months[i]}-01`
    const to = i + 1 < months.length ? `${months[i + 1]}-01` : '9999-12-31'
    const rows = (await db(PROVIDER_COSTS)
      .where('date', '>=', from)
      .where('date', '<', to)
      .groupBy('app_id', 'provider', 'source', 'currency')
      .select('app_id', 'provider', 'source', 'currency')
      .sum({ s: 'amount_cents' })) as Array<Record<string, unknown>>
    for (const r of rows) {
      const appId = r.app_id == null ? null : Number(r.app_id)
      const app = appId == null ? null : apps.get(appId)
      // An app that no longer exists counts as unassigned; a shared resource has no app.
      const kind: SpendKind = app
        ? 'app'
        : r.source === 'resource' && appId == null
          ? 'shared'
          : 'unassigned'
      const provider = String(r.provider)
      const currency = String(r.currency)
      const key = JSON.stringify([kind, app ? appId : null, provider, currency])
      let g = groups.get(key)
      if (!g) {
        g = {
          kind,
          app_id: app ? appId : null,
          app_key: app?.key ?? null,
          app_name: app?.name ?? null,
          provider,
          provider_label: label(provider),
          currency,
          month_to_date_cents: 0,
          last_12_months_cents: 0,
          months_cents: months.map(() => 0)
        }
        groups.set(key, g)
      }
      const s = Math.round(Number(r.s) || 0)
      g.months_cents[i] += s
      g.last_12_months_cents += s
      if (i === months.length - 1) g.month_to_date_cents += s
    }
  }
  const order: Record<SpendKind, number> = { app: 0, shared: 1, unassigned: 2 }
  out.rows = [...groups.values()].sort(
    (a, b) =>
      order[a.kind] - order[b.kind] ||
      (a.app_name ?? '').localeCompare(b.app_name ?? '') ||
      b.last_12_months_cents - a.last_12_months_cents ||
      a.provider.localeCompare(b.provider)
  )
  const totals = new Map<string, OutsideSpend['totals'][number]>()
  for (const r of out.rows) {
    const t = totals.get(r.currency) ?? {
      currency: r.currency,
      month_to_date_cents: 0,
      last_12_months_cents: 0
    }
    t.month_to_date_cents += r.month_to_date_cents
    t.last_12_months_cents += r.last_12_months_cents
    totals.set(r.currency, t)
  }
  out.totals = [...totals.values()]
  // Every connection with a feed: how far its bill goes and how its last read went.
  const state = await readFeedState()
  const through = new Map(
    (
      (await db(PROVIDER_COSTS)
        .groupBy('connection_id')
        .select('connection_id')
        .max({ d: 'date' })) as Array<Record<string, unknown>>
    ).map((r) => [Number(r.connection_id), r.d == null ? null : String(r.d).slice(0, 10)])
  )
  for (const c of await listConnections()) {
    if (!getProvider(c.provider)?.costs) continue
    const st = state[String(c.id)]
    out.feeds.push({
      connection_id: c.id,
      name: c.name,
      provider: c.provider,
      provider_label: label(c.provider),
      through: through.get(c.id) ?? null,
      last_read_at: st?.at ?? null,
      ok: st ? st.ok : null,
      error: st?.error ?? null
    })
  }
  return out
}

/** The Outside spend section the chargeback CSV ends with (formula-safe cells). */
export function outsideSpendCsv(s: OutsideSpend): string[] {
  if (!s.rows.length) return []
  const money = (c: number) => (c / 100).toFixed(2)
  const lines = [
    '',
    csvRow(['Outside spend (billed by providers)']),
    csvRow([
      'App',
      'App key',
      'Provider',
      'Kind',
      `Month to date (${s.months[s.months.length - 1]})`,
      `Last 12 months (${s.months[0]} to ${s.months[s.months.length - 1]})`,
      'Currency'
    ])
  ]
  // Amounts are our own figures: written as plain numbers (a credit stays a negative number
  // instead of the text the formula guard would make of "-3.00"); every text cell is guarded.
  for (const r of s.rows)
    lines.push(
      [
        csvCell(
          r.kind === 'app'
            ? (r.app_name ?? '')
            : r.kind === 'shared'
              ? 'Shared resources'
              : 'Unassigned'
        ),
        csvCell(r.app_key ?? ''),
        csvCell(r.provider_label),
        csvCell(r.kind),
        money(r.month_to_date_cents),
        money(r.last_12_months_cents),
        csvCell(r.currency)
      ].join(',')
    )
  return lines
}
