import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runCustomQueryBySlug } from './custom-query-exec.js'
import { sendMail } from './mail.js'
import { notifyUser } from './notification-channels.js'

/**
 * Metric alert engine (EFP Alert Manager port, generalized).
 *
 * Definitions are an admin-authored metric CATALOG — each backed by a custom
 * query (slug + value column) or a collection row count. Users create RULES
 * (operator + threshold + check frequency + optional filter scope), SUBSCRIBE
 * to rules (in-app / email, immediate or digest delivery), and the check crons
 * maintain a firing/resolved state machine in nivaro_metric_alert_log — one
 * open firing row per rule IS the state (same pattern as report alerts).
 */

export type MetricSource =
  | {
      type: 'custom_query'
      slug: string
      value_field?: string
      /** Maps a rule filter key to a query param name; values comma-join (STRING_SPLIT convention). */
      param_map?: Record<string, string>
      /** Literal params always passed. */
      params?: Record<string, unknown>
    }
  | {
      type: 'collection'
      collection: string
      /** Plain-column equality / in-list filters applied to the count. */
      filter?: Record<string, unknown>
    }

export function parseJsonSafe<T>(v: unknown): T | null {
  if (v == null) return null
  if (typeof v === 'object') return v as T
  try {
    return JSON.parse(String(v)) as T
  } catch {
    return null
  }
}

export function evaluateOperator(operator: string, value: number, threshold: number): boolean {
  switch (operator) {
    case 'gt':
      return value > threshold
    case 'gte':
      return value >= threshold
    case 'lt':
      return value < threshold
    case 'lte':
      return value <= threshold
    case 'eq':
      return value === threshold
    case 'change_pct':
      // EFP semantics: the metric itself returns a % change; fire on |Δ| ≥ threshold
      return Math.abs(value) >= threshold
    default:
      return false
  }
}

const COLLECTION_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export async function resolveMetricValue(
  source: MetricSource,
  filters: Record<string, unknown> | null
): Promise<number | null> {
  try {
    if (source.type === 'custom_query') {
      const params: Record<string, unknown> = { ...(source.params ?? {}) }
      const f = filters ?? {}
      const map = source.param_map ?? {}
      for (const [key, raw] of Object.entries(f)) {
        const paramName = map[key] ?? key
        const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : []
        if (arr.length) params[paramName] = arr.join(',')
      }
      const rows = await runCustomQueryBySlug(source.slug, params)
      if (!rows.length) return null
      const first = rows[0]
      if (source.value_field && source.value_field in first) {
        const v = Number(first[source.value_field])
        return Number.isFinite(v) ? v : null
      }
      for (const v of Object.values(first)) {
        const n = Number(v)
        if (Number.isFinite(n)) return n
      }
      return null
    }

    // collection row count — plain columns only (admin-authored config)
    if (!COLLECTION_NAME_RE.test(source.collection) || /^nivaro_/i.test(source.collection)) {
      return null
    }
    const q = db(source.collection).count('* as val')
    const combined = { ...(source.filter ?? {}), ...(filters ?? {}) }
    for (const [col, raw] of Object.entries(combined)) {
      if (!COLLECTION_NAME_RE.test(col)) continue
      if (Array.isArray(raw)) {
        if (raw.length) q.whereIn(col, raw as (string | number)[])
      } else if (raw === null) {
        q.whereNull(col)
      } else {
        q.where(col, raw as string | number)
      }
    }
    const row = (await q.first()) as { val?: number | string } | undefined
    return Number(row?.val ?? 0)
  } catch (err) {
    console.warn('[metric-alerts] metric resolution failed:', (err as Error).message)
    return null
  }
}

// ─── Rule checks ──────────────────────────────────────────────────────────────

interface RuleRow {
  id: number
  name: string
  operator: string
  threshold_value: number
  filters: string | null
  status: string
  definition_id: number
  def_name: string
  def_unit: string
  metric_source: string
}

export async function runMetricAlertChecks(
  app: FastifyInstance,
  frequency: 'hourly' | 'daily' | 'weekly' | 'all' = 'all'
): Promise<{ evaluated: number; fired: number; resolved: number; skipped: number }> {
  const q = db('nivaro_metric_alert_rules as r')
    .join('nivaro_metric_definitions as d', 'd.id', 'r.definition_id')
    .where('r.status', 'active')
    .where('d.status', 'active')
    .select(
      'r.id',
      'r.name',
      'r.operator',
      'r.threshold_value',
      'r.filters',
      'r.status',
      'r.definition_id',
      'd.name as def_name',
      'd.unit as def_unit',
      'd.metric_source'
    )
  if (frequency !== 'all') q.where('r.check_frequency', frequency)
  const rules = (await q) as RuleRow[]

  const results = { evaluated: 0, fired: 0, resolved: 0, skipped: 0 }

  for (const rule of rules) {
    const source = parseJsonSafe<MetricSource>(rule.metric_source)
    if (!source) {
      results.skipped++
      continue
    }
    const filters = parseJsonSafe<Record<string, unknown>>(rule.filters)
    const value = await resolveMetricValue(source, filters)
    if (value === null) {
      results.skipped++
      continue
    }

    results.evaluated++
    const threshold = Number(rule.threshold_value)
    const isFiring = evaluateOperator(rule.operator, value, threshold)

    const openLog = (await db('nivaro_metric_alert_log')
      .where({ rule_id: rule.id, status: 'firing' })
      .first('id')) as { id: number } | undefined

    if (isFiring && !openLog) {
      const inserted = (await db('nivaro_metric_alert_log')
        .insert({
          rule_id: rule.id,
          fired_at: new Date(),
          metric_value: value,
          threshold_value: threshold,
          filters_snapshot: rule.filters ?? null,
          status: 'firing'
        })
        .returning('id')) as Array<{ id: number } | number>
      const logId =
        typeof inserted[0] === 'object' ? (inserted[0] as { id: number }).id : (inserted[0] as number)
      results.fired++
      await notifyImmediateSubscribers(app, rule, value, threshold, logId)
    } else if (!isFiring && openLog) {
      await db('nivaro_metric_alert_log')
        .where({ id: openLog.id })
        .update({ resolved_at: new Date(), status: 'resolved' })
      results.resolved++
    }
  }

  return results
}

const OPERATOR_LABELS: Record<string, string> = {
  gt: '>',
  gte: '≥',
  lt: '<',
  lte: '≤',
  eq: '=',
  change_pct: '% Δ'
}

function fmtValue(value: number, unit: string): string {
  const n = Number(value)
  const num = Number.isInteger(n) ? n.toLocaleString() : n.toLocaleString(undefined, { maximumFractionDigits: 2 })
  if (unit === 'dollar') return `$${num}`
  if (unit === 'percent') return `${num}%`
  if (unit === 'days') return `${num}d`
  return num
}

async function notifyImmediateSubscribers(
  app: FastifyInstance,
  rule: RuleRow,
  value: number,
  threshold: number,
  logId: number
) {
  const subs = (await db('nivaro_metric_alert_subscriptions as s')
    .join('nivaro_users as u', 'u.id', 's.user')
    .where({ 's.rule_id': rule.id, 's.digest_frequency': 'immediate', 's.status': 'active' })
    .select('s.id', 's.user', 's.delivery_in_app', 's.delivery_email', 'u.email')) as Array<{
    id: number
    user: string
    delivery_in_app: boolean
    delivery_email: boolean
    email: string | null
  }>
  if (!subs.length) return

  const subject = `Alert: ${rule.name}`
  const message = `${rule.def_name} is now ${fmtValue(value, rule.def_unit)} (threshold: ${
    OPERATOR_LABELS[rule.operator] ?? rule.operator
  } ${fmtValue(threshold, rule.def_unit)})`
  const now = new Date()

  for (const sub of subs) {
    if (sub.delivery_in_app) {
      await notifyUser(app, sub.user, {
        subject,
        message,
        collection: 'nivaro_metric_alert_log',
        item: String(logId)
      }).catch(() => undefined)
    }
    if (sub.delivery_email && sub.email) {
      await sendMail({
        to: sub.email,
        subject,
        template: 'alert_notification',
        data: {
          rule_name: rule.name,
          metric_name: rule.def_name,
          metric_value: fmtValue(value, rule.def_unit),
          threshold_value: fmtValue(threshold, rule.def_unit),
          operator: OPERATOR_LABELS[rule.operator] ?? rule.operator
        }
      }).catch((e) => console.warn('[metric-alerts] email failed:', (e as Error).message))
    }
    await db('nivaro_metric_alert_subscriptions').where({ id: sub.id }).update({ last_notified: now })
  }
}

// ─── Digest ───────────────────────────────────────────────────────────────────

export async function runMetricAlertDigest(
  app: FastifyInstance,
  frequency: 'daily' | 'weekly'
): Promise<{ notified: number }> {
  const windowHours = frequency === 'weekly' ? 168 : 24
  const windowStart = new Date(Date.now() - windowHours * 3600 * 1000)

  const subs = (await db('nivaro_metric_alert_subscriptions as s')
    .join('nivaro_users as u', 'u.id', 's.user')
    .where({ 's.digest_frequency': frequency, 's.status': 'active' })
    .select(
      's.id',
      's.user',
      's.rule_id',
      's.delivery_in_app',
      's.delivery_email',
      's.last_notified',
      'u.email'
    )) as Array<{
    id: number
    user: string
    rule_id: number
    delivery_in_app: boolean
    delivery_email: boolean
    last_notified: string | Date | null
    email: string | null
  }>
  if (!subs.length) return { notified: 0 }

  const subsByUser = new Map<string, typeof subs>()
  for (const sub of subs) {
    if (!subsByUser.has(sub.user)) subsByUser.set(sub.user, [])
    subsByUser.get(sub.user)!.push(sub)
  }

  let notified = 0
  for (const [userId, userSubs] of subsByUser) {
    const ruleIds = userSubs.map((s) => s.rule_id)
    // Oldest last_notified across the user's subscriptions, floored at the window
    const oldest = userSubs.reduce((acc: Date, s) => {
      if (!s.last_notified) return acc
      const d = new Date(s.last_notified)
      return d < acc ? d : acc
    }, windowStart)

    const firing = (await db('nivaro_metric_alert_log as l')
      .join('nivaro_metric_alert_rules as r', 'r.id', 'l.rule_id')
      .join('nivaro_metric_definitions as d', 'd.id', 'r.definition_id')
      .whereIn('l.rule_id', ruleIds)
      .where('l.status', 'firing')
      .where('l.fired_at', '>', oldest)
      .orderBy('l.fired_at', 'desc')
      .select(
        'l.id',
        'l.fired_at',
        'l.metric_value',
        'l.threshold_value',
        'r.name as rule_name',
        'r.operator',
        'd.name as def_name',
        'd.unit as def_unit'
      )) as Array<{
      id: number
      fired_at: string | Date
      metric_value: number
      threshold_value: number
      rule_name: string
      operator: string
      def_name: string
      def_unit: string
    }>
    if (!firing.length) continue

    const subject = `Alert Digest (${frequency}): ${firing.length} active alert${firing.length !== 1 ? 's' : ''}`
    const lines = firing.map(
      (e) =>
        `• ${e.rule_name}: ${e.def_name} = ${fmtValue(Number(e.metric_value), e.def_unit)} (threshold: ${
          OPERATOR_LABELS[e.operator] ?? e.operator
        } ${fmtValue(Number(e.threshold_value), e.def_unit)})`
    )

    const wantsInApp = userSubs.some((s) => s.delivery_in_app)
    const wantsEmail = userSubs.some((s) => s.delivery_email)

    if (wantsInApp) {
      await notifyUser(app, userId, {
        subject,
        message: lines.join('\n'),
        collection: 'nivaro_metric_alert_log',
        item: String(firing[0].id)
      }).catch(() => undefined)
    }
    const email = userSubs.find((s) => s.email)?.email
    if (wantsEmail && email) {
      await sendMail({
        to: email,
        subject,
        template: 'alert_digest',
        data: {
          frequency,
          alert_count: firing.length,
          alerts: firing.map((e) => ({
            rule_name: e.rule_name,
            metric_name: e.def_name,
            metric_value: fmtValue(Number(e.metric_value), e.def_unit),
            threshold_value: fmtValue(Number(e.threshold_value), e.def_unit),
            operator: OPERATOR_LABELS[e.operator] ?? e.operator,
            fired_at: e.fired_at
          }))
        }
      }).catch((e) => console.warn('[metric-alerts] digest email failed:', (e as Error).message))
    }

    const now = new Date()
    await db('nivaro_metric_alert_subscriptions')
      .whereIn(
        'id',
        userSubs.map((s) => s.id)
      )
      .update({ last_notified: now })
    notified++
  }

  return { notified }
}
