import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { priceFor } from './ai-log.js'
import type { BudgetCap, QualityConfig } from './ai-quality.js'
import { getApp } from './io-holder.js'

/**
 * AI spend over time (#2473 forecast, #2764 reconciliation).
 *
 * `nivaro_ai_calls` is pruned after 30 days, so last month's figures come from
 * `nivaro_ai_spend_days` — a nightly (and lazy) roll-up of the log per day ×
 * model | feature | user (migration 470). Until that table exists everything
 * here reads the raw log only and says the history is partial.
 */

const DAY = 86_400_000

export type SpendDim = 'model' | 'feature' | 'user'
export const SPEND_DIMS: SpendDim[] = ['model', 'feature', 'user']

export interface Agg {
  calls: number
  cost: number
  input: number
  output: number
  cached: number
}
const zero = (): Agg => ({ calls: 0, cost: 0, input: 0, output: 0, cached: 0 })
const n = (v: unknown): number => Number(v) || 0

// ─── dates ───────────────────────────────────────────────────────────────────

export const dayKey = (d: Date) => d.toISOString().slice(0, 10)
export const monthKey = (d: Date) => d.toISOString().slice(0, 7)
export const monthStart = (month: string) => new Date(`${month}-01T00:00:00.000Z`)

export function nextMonth(month: string): string {
  const d = monthStart(month)
  d.setUTCMonth(d.getUTCMonth() + 1)
  return monthKey(d)
}
export function prevMonth(month: string): string {
  const d = monthStart(month)
  d.setUTCMonth(d.getUTCMonth() - 1)
  return monthKey(d)
}
export function daysInMonth(month: string): number {
  return Math.round((monthStart(nextMonth(month)).getTime() - monthStart(month).getTime()) / DAY)
}

// ─── storage probes ──────────────────────────────────────────────────────────

const probes = new Map<string, { ok: boolean; at: number }>()
async function tableOk(name: string): Promise<boolean> {
  const hit = probes.get(name)
  if (hit && (hit.ok || Date.now() - hit.at < 60_000)) return hit.ok
  const ok = await db.schema.hasTable(name).catch(() => false)
  probes.set(name, { ok, at: Date.now() })
  return ok
}
export const spendTableOk = () => tableOk('nivaro_ai_spend_days')

// ─── roll-up ─────────────────────────────────────────────────────────────────

const COLUMN: Record<SpendDim, string> = { model: 'model', feature: 'feature', user: 'user' }

/** The call log grouped by one dimension over [from, to). */
export async function aggregateRaw(from: Date, to: Date, dim: SpendDim): Promise<Map<string, Agg>> {
  const col = COLUMN[dim]
  const rows = (await db('nivaro_ai_calls')
    .where('created_at', '>=', from)
    .where('created_at', '<', to)
    .groupBy(col)
    .select({ k: col })
    .count({ calls: '*' })
    .sum({
      cost: 'cost_usd',
      input: 'input_tokens',
      output: 'output_tokens',
      cached: 'cache_read_tokens'
    })
    .catch(() => [])) as Array<Record<string, unknown>>
  const out = new Map<string, Agg>()
  for (const r of rows) {
    const key = r.k == null ? '' : String(r.k)
    out.set(key, {
      calls: n(r.calls),
      cost: n(r.cost),
      input: n(r.input),
      output: n(r.output),
      cached: n(r.cached)
    })
  }
  return out
}

async function writeDay(day: string): Promise<number> {
  const from = new Date(`${day}T00:00:00.000Z`)
  const to = new Date(from.getTime() + DAY)
  const rows: Array<Record<string, unknown>> = []
  for (const dim of SPEND_DIMS) {
    for (const [key, a] of await aggregateRaw(from, to, dim)) {
      rows.push({
        day,
        dim,
        key: (key || '(none)').slice(0, 120),
        calls: a.calls,
        cost_usd: a.cost,
        input_tokens: a.input,
        output_tokens: a.output,
        cached_tokens: a.cached
      })
    }
  }
  // a day with no calls leaves a marker so the next pass does not look at it again
  if (rows.length === 0)
    rows.push({
      day,
      dim: 'model',
      key: '',
      calls: 0,
      cost_usd: 0,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0
    })
  await db.transaction(async (trx) => {
    await trx('nivaro_ai_spend_days').where({ day }).del()
    for (let i = 0; i < rows.length; i += 100)
      await trx('nivaro_ai_spend_days').insert(rows.slice(i, i + 100))
  })
  return rows.length
}

/**
 * Roll the call log up per day: any day of the last 31 not yet rolled, plus
 * yesterday and today every time (calls land late; today is provisional).
 */
export async function rollupSpendDays(now = new Date()): Promise<{ days: number }> {
  if (!(await spendTableOk())) return { days: 0 }
  const start = dayKey(new Date(now.getTime() - 31 * DAY))
  const have = new Set(
    (
      (await db('nivaro_ai_spend_days')
        .where('day', '>=', start)
        .where('dim', 'model')
        .select('day')) as Array<{ day: string }>
    ).map((r) => String(r.day))
  )
  const today = dayKey(now)
  const yesterday = dayKey(new Date(now.getTime() - DAY))
  let days = 0
  for (let i = 31; i >= 0; i--) {
    const d = dayKey(new Date(now.getTime() - i * DAY))
    if (have.has(d) && d !== today && d !== yesterday) continue
    await writeDay(d)
    days++
  }
  // a year of history is plenty for month-on-month; older rows go
  await db('nivaro_ai_spend_days')
    .where('day', '<', dayKey(new Date(now.getTime() - 400 * DAY)))
    .del()
    .catch(() => 0)
  return { days }
}

let lastEnsure = 0
let ensuring: Promise<unknown> | null = null
/** Lazy catch-up for readers: at most one pass per process per ten minutes. */
export async function ensureRolledUp(): Promise<void> {
  if (Date.now() - lastEnsure < 600_000) return
  if (!ensuring)
    ensuring = rollupSpendDays()
      .catch(() => undefined)
      .finally(() => {
        lastEnsure = Date.now()
        ensuring = null
      })
  await ensuring
}

// ─── reading ─────────────────────────────────────────────────────────────────

/**
 * Spend per key over [fromDay, toDay) (UTC days): the roll-up for finished
 * days plus the live log for today. `rolled` says whether any roll-up row
 * backed the answer — without it only the 30 retained days can be seen.
 */
export async function readDays(
  fromDay: string,
  toDay: string,
  dim: SpendDim,
  now = new Date()
): Promise<{ rows: Map<string, Agg>; rolled: boolean }> {
  const rows = new Map<string, Agg>()
  const add = (key: string, a: Agg) => {
    const cur = rows.get(key) ?? zero()
    cur.calls += a.calls
    cur.cost += a.cost
    cur.input += a.input
    cur.output += a.output
    cur.cached += a.cached
    rows.set(key, cur)
  }
  const today = dayKey(now)
  let rolled = false
  if (await spendTableOk()) {
    await ensureRolledUp()
    const stored = (await db('nivaro_ai_spend_days')
      .where('dim', dim)
      .where('day', '>=', fromDay)
      .where('day', '<', toDay < today ? toDay : today)
      .where('calls', '>', 0)
      .groupBy('key')
      .select('key')
      .sum({
        calls: 'calls',
        cost: 'cost_usd',
        input: 'input_tokens',
        output: 'output_tokens',
        cached: 'cached_tokens'
      })
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const r of stored) {
      rolled = true
      add(String(r.key), {
        calls: n(r.calls),
        cost: n(r.cost),
        input: n(r.input),
        output: n(r.output),
        cached: n(r.cached)
      })
    }
    if (toDay > today && fromDay <= today) {
      const live = await aggregateRaw(
        new Date(`${today}T00:00:00.000Z`),
        new Date(now.getTime() + 1000),
        dim
      )
      for (const [k, a] of live) add(k || '(none)', a)
    }
    return { rows, rolled }
  }
  // no roll-up table yet: the retained log is all there is
  const from = new Date(`${fromDay}T00:00:00.000Z`)
  const to = new Date(Math.min(new Date(`${toDay}T00:00:00.000Z`).getTime(), now.getTime() + 1000))
  for (const [k, a] of await aggregateRaw(from, to, dim)) add(k || '(none)', a)
  return { rows, rolled: false }
}

async function readMonth(month: string, dim: SpendDim, now: Date) {
  return readDays(`${month}-01`, `${nextMonth(month)}-01`, dim, now)
}

const sumCost = (m: Map<string, Agg>) => [...m.values()].reduce((x, a) => x + a.cost, 0)

// ─── forecast (#2473) ────────────────────────────────────────────────────────

export interface ForecastRow {
  key: string
  label: string
  calls: number
  mtd_usd: number
  projected_usd: number
  last_month_usd: number
  change_pct: number | null
  /** model rows: tokens were used but no price is known, so the cost reads $0. */
  unpriced?: boolean
}

export interface ForecastAlert {
  /** Stable per month + subject, so an admin is told once. */
  key: string
  kind: 'budget' | 'last_month'
  message: string
  projected_usd: number
  limit_usd: number
}

export interface SpendForecast {
  month: string
  last_month: string
  days_in_month: number
  elapsed_days: number
  generated_at: string
  /** false = no roll-up rows: last month cannot be shown. */
  history: boolean
  totals: {
    mtd_usd: number
    projected_usd: number
    last_month_usd: number
    change_pct: number | null
  }
  by: Record<SpendDim, ForecastRow[]>
  alerts: ForecastAlert[]
}

export const pct = (now: number, then: number): number | null =>
  then > 0 ? Math.round(((now - then) / then) * 1000) / 10 : null

/** Month-end projection: spend so far plus the recent daily rate for the days left. */
export function project(
  mtd: number,
  recent: number,
  recentDays: number,
  elapsed: number,
  dim: number
): number {
  const remaining = Math.max(0, dim - elapsed)
  const rate = recentDays > 0 ? recent / recentDays : elapsed > 0 ? mtd / elapsed : 0
  return mtd + rate * remaining
}

function elapsedDays(now: Date, month: string): number {
  return Math.max(0.25, (now.getTime() - monthStart(month).getTime()) / DAY)
}

async function userLabels(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const real = ids.filter((i) => /^[0-9a-f-]{36}$/i.test(i))
  if (real.length === 0) return out
  const rows = (await db('nivaro_users')
    .whereIn('id', real)
    .select('id', 'first_name', 'last_name', 'email')
    .catch(() => [])) as Array<Record<string, string | null>>
  for (const r of rows)
    out.set(
      String(r.id).toUpperCase(),
      [r.first_name, r.last_name].filter(Boolean).join(' ') || r.email || String(r.id)
    )
  return out
}

export async function buildForecast(cfg: QualityConfig, now = new Date()): Promise<SpendForecast> {
  const month = monthKey(now)
  const last = prevMonth(month)
  const dim = daysInMonth(month)
  const elapsed = elapsedDays(now, month)
  const today = dayKey(now)
  // the rate looks at up to seven finished days, never reaching before the month began
  const recentDays = Math.min(
    7,
    Math.max(
      0,
      Math.floor((new Date(`${today}T00:00:00.000Z`).getTime() - monthStart(month).getTime()) / DAY)
    )
  )
  const recentFrom = dayKey(
    new Date(new Date(`${today}T00:00:00.000Z`).getTime() - recentDays * DAY)
  )
  let history = false
  const by = {} as Record<SpendDim, ForecastRow[]>
  let totals = {
    mtd_usd: 0,
    projected_usd: 0,
    last_month_usd: 0,
    change_pct: null as number | null
  }
  for (const d of SPEND_DIMS) {
    const [mtd, prev, recent] = await Promise.all([
      readMonth(month, d, now),
      readMonth(last, d, now),
      recentDays > 0
        ? readDays(recentFrom, today, d, now)
        : Promise.resolve({ rows: new Map<string, Agg>(), rolled: false })
    ])
    if (prev.rolled) history = true
    const keys = new Set([...mtd.rows.keys(), ...prev.rows.keys()])
    const labels = d === 'user' ? await userLabels([...keys]) : new Map<string, string>()
    const rows: ForecastRow[] = []
    for (const key of keys) {
      const a = mtd.rows.get(key) ?? zero()
      const p = prev.rows.get(key) ?? zero()
      const r = recent.rows.get(key) ?? zero()
      const projected = project(a.cost, r.cost, recentDays, elapsed, dim)
      rows.push({
        key,
        label:
          d === 'user'
            ? (labels.get(key.toUpperCase()) ?? (key === '(none)' ? 'No one (background)' : key))
            : key,
        calls: a.calls,
        mtd_usd: a.cost,
        projected_usd: projected,
        last_month_usd: p.cost,
        change_pct: pct(projected, p.cost),
        ...(d === 'model' && a.cost === 0 && a.input + a.output > 0 && !priceFor(key)
          ? { unpriced: true }
          : {})
      })
    }
    rows.sort((x, y) => y.projected_usd - x.projected_usd || y.mtd_usd - x.mtd_usd)
    by[d] = rows.slice(0, 25)
    if (d === 'model') {
      const mt = sumCost(mtd.rows)
      const lt = sumCost(prev.rows)
      const pr = project(mt, sumCost(recent.rows), recentDays, elapsed, dim)
      totals = { mtd_usd: mt, projected_usd: pr, last_month_usd: lt, change_pct: pct(pr, lt) }
    }
  }
  const alerts = await forecastAlerts(cfg, totals, month, dim, elapsed, now)
  return {
    month,
    last_month: last,
    days_in_month: dim,
    elapsed_days: Math.round(elapsed * 10) / 10,
    generated_at: now.toISOString(),
    history,
    totals,
    by,
    alerts
  }
}

// ─── alerts ──────────────────────────────────────────────────────────────────

const usd2 = (v: number) => `$${v.toFixed(2)}`

/** Cap → its month limit: the daily cap over every day of the month. */
export const monthlyLimit = (cap: BudgetCap, dim: number) => cap.daily_usd * dim

interface SpendCell {
  user: string | null
  feature: string
  role: string | null
  mtd: number
  recent: number
}

export function capAlerts(
  caps: BudgetCap[],
  cells: SpendCell[],
  month: string,
  dim: number,
  elapsed: number,
  recentDays: number,
  names: Map<string, string>
): ForecastAlert[] {
  const out: ForecastAlert[] = []
  const up = (s: string | null | undefined) => (s ?? '').toUpperCase()
  for (const cap of caps) {
    if (cap.daily_usd <= 0) continue
    const limit = monthlyLimit(cap, dim)
    const matched = cells.filter((c) => {
      if (cap.feature && c.feature !== cap.feature) return false
      if (cap.who === 'person') return up(c.user) === up(cap.who_id)
      if (cap.who === 'role') return up(c.role) === up(cap.who_id)
      return true
    })
    const scope =
      cap.who === 'person'
        ? 'that person'
        : cap.who === 'role'
          ? 'a member of the role'
          : 'each person'
    const feature = cap.feature ? ` on ${cap.feature}` : ''
    if (cap.pooled) {
      const mtd = matched.reduce((x, c) => x + c.mtd, 0)
      const recent = matched.reduce((x, c) => x + c.recent, 0)
      const proj = project(mtd, recent, recentDays, elapsed, dim)
      if (proj > limit)
        out.push({
          key: `${month}:budget:${cap.id}`,
          kind: 'budget',
          message: `The shared AI budget${feature} is on course for ${usd2(proj)} this month against ${usd2(limit)} (${usd2(cap.daily_usd)} a day).`,
          projected_usd: proj,
          limit_usd: limit
        })
      continue
    }
    const per = new Map<string, { mtd: number; recent: number }>()
    for (const c of matched) {
      const k = c.user ?? ''
      const cur = per.get(k) ?? { mtd: 0, recent: 0 }
      cur.mtd += c.mtd
      cur.recent += c.recent
      per.set(k, cur)
    }
    const over = [...per.entries()]
      .map(([user, v]) => ({ user, proj: project(v.mtd, v.recent, recentDays, elapsed, dim) }))
      .filter((p) => p.proj > limit)
      .sort((a, b) => b.proj - a.proj)
    if (over.length === 0) continue
    const first = over[0]
    const who = names.get(up(first.user)) ?? 'Someone'
    out.push({
      key: `${month}:budget:${cap.id}`,
      kind: 'budget',
      message: `${over.length === 1 ? who : `${who} and ${over.length - 1} more`} (${scope}) on course for ${usd2(first.proj)}${feature} this month against a limit of ${usd2(limit)} (${usd2(cap.daily_usd)} a day).`,
      projected_usd: first.proj,
      limit_usd: limit
    })
  }
  return out
}

async function forecastAlerts(
  cfg: QualityConfig,
  totals: { projected_usd: number; last_month_usd: number },
  month: string,
  dim: number,
  elapsed: number,
  now: Date
): Promise<ForecastAlert[]> {
  const out: ForecastAlert[] = []
  const threshold = cfg.forecast_alert_pct
  if (threshold != null && totals.last_month_usd > 0) {
    const limit = totals.last_month_usd * (1 + threshold / 100)
    if (totals.projected_usd > limit)
      out.push({
        key: `${month}:last_month`,
        kind: 'last_month',
        message: `AI spend is on course for ${usd2(totals.projected_usd)} this month, ${pct(totals.projected_usd, totals.last_month_usd)}% above last month (${usd2(totals.last_month_usd)}); the alert is set at ${threshold}%.`,
        projected_usd: totals.projected_usd,
        limit_usd: limit
      })
  }
  if (cfg.budgets.enabled && cfg.budgets.caps.length > 0) {
    // caps are per person / role / feature, so they are judged on the log itself
    const start = new Date(Math.max(monthStart(month).getTime(), now.getTime() - 30 * DAY))
    const today0 = new Date(`${dayKey(now)}T00:00:00.000Z`)
    const recentDays = Math.min(
      7,
      Math.max(0, Math.floor((today0.getTime() - monthStart(month).getTime()) / DAY))
    )
    const recentFrom = new Date(today0.getTime() - recentDays * DAY)
    const grouped = async (from: Date, to: Date) =>
      (await db('nivaro_ai_calls as c')
        .leftJoin('nivaro_users as u', 'u.id', 'c.user')
        .where('c.created_at', '>=', from)
        .where('c.created_at', '<', to)
        .groupBy('c.user', 'c.feature', 'u.role')
        .select('c.user', 'c.feature', 'u.role')
        .sum({ cost: 'c.cost_usd' })
        .catch(() => [])) as Array<{
        user: string | null
        feature: string
        role: string | null
        cost: unknown
      }>
    const [mtdRows, recentRows] = await Promise.all([
      grouped(start, new Date(now.getTime() + 1000)),
      recentDays > 0 ? grouped(recentFrom, today0) : Promise.resolve([])
    ])
    const cells = new Map<string, SpendCell>()
    const ck = (r: { user: string | null; feature: string }) => `${r.user ?? ''}|${r.feature}`
    for (const r of mtdRows)
      cells.set(ck(r), {
        user: r.user,
        feature: r.feature,
        role: r.role,
        mtd: n(r.cost),
        recent: 0
      })
    for (const r of recentRows) {
      const cur = cells.get(ck(r)) ?? {
        user: r.user,
        feature: r.feature,
        role: r.role,
        mtd: 0,
        recent: 0
      }
      cur.recent += n(r.cost)
      cells.set(ck(r), cur)
    }
    const names = await userLabels([...new Set([...cells.values()].map((c) => c.user ?? ''))])
    out.push(
      ...capAlerts(cfg.budgets.caps, [...cells.values()], month, dim, elapsed, recentDays, names)
    )
  }
  return out
}

/**
 * Tell active admins about something once. The "already told" memory is the
 * activity log (`ai-forecast-alert`, comment = key), so a restart or a second
 * replica does not repeat it. Returns how many admins were told.
 */
export async function notifyAdminsOnce(
  key: string,
  note: { subject: string; message: string; url: string; label: string; why: string }
): Promise<number> {
  const app = getApp()
  if (!app) return 0
  const told = await db('nivaro_activity')
    .where({ action: 'ai-forecast-alert', comment: key })
    .first('id')
    .catch(() => null)
  if (told) return 0
  const admins = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .limit(10)
    .select('u.id')
    .catch(() => [])) as Array<{ id: string }>
  await logActivity({ action: 'ai-forecast-alert', user: null, comment: key })
  const { notifyUser } = await import('./notification-channels.js')
  let sent = 0
  for (const admin of admins) {
    await notifyUser(app, String(admin.id), {
      subject: note.subject.slice(0, 255),
      message: note.message.slice(0, 500),
      category: 'system',
      target: { kind: 'external', url: note.url, action: 'review' },
      source: { kind: 'ai_quality', label: note.label },
      why: note.why
    }).catch(() => undefined)
    sent++
  }
  return sent
}

export async function notifyForecastAlerts(alerts: ForecastAlert[]): Promise<number> {
  let sent = 0
  for (const a of alerts)
    sent += await notifyAdminsOnce(a.key, {
      subject: a.kind === 'budget' ? 'AI spend is heading past a budget' : 'AI spend is climbing',
      message: a.message,
      url: '/ai-quality?tab=spend',
      label: 'AI spend forecast',
      why: 'You are an administrator and AI spend is projected past a limit you set.'
    })
  return sent
}

// ─── reconciliation (#2764) ──────────────────────────────────────────────────

export interface ReconcileModelRow {
  model: string
  logged_usd: number
  billed_usd: number | null
  gap_usd: number | null
  /** billed ÷ logged — near 1 means the log is right; a steady factor reads as price drift. */
  factor: number | null
  price_source: 'setting' | 'built-in' | 'none'
  calls: number
}
export interface ReconcileMonth {
  month: string
  logged_usd: number
  /** null when no bill was entered for the month. */
  billed_usd: number | null
  gap_usd: number | null
  gap_pct: number | null
  models: ReconcileModelRow[]
  note: string
  history: boolean
}

export function priceSource(model: string, cfg: QualityConfig): ReconcileModelRow['price_source'] {
  const base = model.replace(/-\d{8}$/, '')
  if (cfg.prices[model] || cfg.prices[base]) return 'setting'
  return priceFor(model) ? 'built-in' : 'none'
}

/** What a gap most likely means, in plain words. */
export function explainGap(m: Pick<ReconcileMonth, 'gap_pct' | 'models' | 'billed_usd'>): string {
  if (m.billed_usd == null) return 'Enter the provider or gateway bill for this month to compare.'
  if (m.gap_pct == null || Math.abs(m.gap_pct) < 3) return 'The log matches the bill.'
  const factors = m.models
    .filter((r) => r.factor != null && r.billed_usd != null)
    .map((r) => r.factor as number)
  const unpriced = m.models.filter((r) => r.price_source === 'none' && r.calls > 0)
  if (m.gap_pct > 0) {
    if (unpriced.length)
      return `The bill is higher. ${unpriced.map((r) => r.model).join(', ')} ${unpriced.length === 1 ? 'has' : 'have'} no price, so ${unpriced.length === 1 ? 'its' : 'their'} calls read as $0. Set a price below.`
    const steady = factors.length >= 2 && Math.max(...factors) - Math.min(...factors) < 0.15
    return steady
      ? 'The bill is higher by a similar share on every model: the prices are probably out of date. Set the billed prices below.'
      : 'The bill is higher on some models only: calls that never reached the log (an extension calling the client directly, a path that skips logging) are the likely cause.'
  }
  return 'The log is higher than the bill: the prices set are probably above what the provider charges (volume discount, cached-token rate).'
}

export async function buildReconciliation(
  cfg: QualityConfig,
  months = 3,
  now = new Date()
): Promise<ReconcileMonth[]> {
  const out: ReconcileMonth[] = []
  let month = monthKey(now)
  for (let i = 0; i < months; i++) {
    const { rows, rolled } = await readMonth(month, 'model', now)
    const bills = cfg.bills[month] ?? null
    const perModelBilled = bills ? Object.entries(bills).filter(([k]) => k !== '*') : []
    const billedTotal = bills
      ? bills['*'] != null && perModelBilled.length === 0
        ? bills['*']
        : perModelBilled.reduce((x, [, v]) => x + v, 0) + (bills['*'] ?? 0)
      : null
    const names = new Set([...rows.keys(), ...perModelBilled.map(([k]) => k)])
    const models: ReconcileModelRow[] = []
    for (const model of names) {
      if (!model) continue
      const a = rows.get(model) ?? zero()
      const billed = bills?.[model] ?? null
      models.push({
        model,
        logged_usd: a.cost,
        billed_usd: billed,
        gap_usd: billed == null ? null : billed - a.cost,
        factor: billed != null && a.cost > 0 ? Math.round((billed / a.cost) * 100) / 100 : null,
        price_source: priceSource(model, cfg),
        calls: a.calls
      })
    }
    models.sort((x, y) => y.logged_usd - x.logged_usd)
    const logged = sumCost(rows)
    const gap = billedTotal == null ? null : billedTotal - logged
    const row: ReconcileMonth = {
      month,
      logged_usd: logged,
      billed_usd: billedTotal,
      gap_usd: gap,
      gap_pct:
        billedTotal != null && billedTotal > 0
          ? Math.round(((billedTotal - logged) / billedTotal) * 1000) / 10
          : null,
      models,
      note: '',
      history: rolled || i === 0
    }
    row.note = explainGap(row)
    out.push(row)
    month = prevMonth(month)
  }
  return out
}

/** `month,model,usd` lines (header optional) → the bills map. */
export function parseBillsCsv(csv: string): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {}
  for (const line of csv.split(/\r?\n/)) {
    const cells = line.split(',').map((c) => c.trim().replace(/^"|"$/g, ''))
    if (cells.length < 2) continue
    const month = cells[0]
    const [model, amount] = cells.length >= 3 ? [cells[1], cells[2]] : ['*', cells[1]]
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) continue
    const usd = Number(amount.replace(/[$\s]/g, ''))
    if (!Number.isFinite(usd) || usd < 0) continue
    out[month] = { ...out[month], [model || '*']: usd }
  }
  return out
}

// ─── weekly operations summary hook ──────────────────────────────────────────

/** A few figures for the Monday operations summary; never throws. */
export async function weeklySpendFacts(
  cfg: QualityConfig
): Promise<Record<string, unknown> | null> {
  try {
    const f = await buildForecast(cfg)
    if (f.totals.mtd_usd <= 0 && f.totals.last_month_usd <= 0) return null
    return {
      month: f.month,
      spent_so_far_usd: Math.round(f.totals.mtd_usd * 100) / 100,
      projected_month_end_usd: Math.round(f.totals.projected_usd * 100) / 100,
      last_month_usd: Math.round(f.totals.last_month_usd * 100) / 100,
      change_vs_last_month_pct: f.totals.change_pct,
      biggest_models: f.by.model
        .slice(0, 3)
        .map((r) => ({ model: r.key, projected_usd: Math.round(r.projected_usd * 100) / 100 })),
      biggest_features: f.by.feature
        .slice(0, 3)
        .map((r) => ({ feature: r.key, projected_usd: Math.round(r.projected_usd * 100) / 100 })),
      alerts: f.alerts.map((a) => a.message)
    }
  } catch {
    return null
  }
}
