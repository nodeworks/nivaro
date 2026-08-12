import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { getAiClient, getAiModelSettings } from './ai-client.js'
import { runCustomQueryBySlug } from './custom-query-exec.js'
import { sendMail } from './mail.js'
import { parseJsonSafe } from './metric-alerts.js'
import { notifyUser } from './notification-channels.js'

/**
 * Statistical anomaly detection (EFP AnomalyChecks port, generalized).
 *
 * A definition names a DETECTOR (key) + a row source: a custom query returning
 * one row per transaction with subject / group / value / date columns. Rules
 * pick sensitivity + scope values (mapped to query params) + delivery. Each
 * detection dedupes on an OPEN (new/acknowledged) log row per rule + subject,
 * gets an optional Claude explanation, and notifies the rule creator.
 *
 * Detectors:
 *  - amount_outlier    : z-score of the latest value vs the group's history
 *  - period_spike      : row count last 30d vs the same window one year prior
 *  - duplicate_pattern : near-identical values within a rolling window
 */

export interface AnomalyConfig {
  source_query: string
  /** Maps a rule scope key to a query param name; values comma-join. */
  param_map?: Record<string, string>
  params?: Record<string, unknown>
  columns: {
    subject_id: string
    subject_label?: string
    /** Extra grouping columns beyond the subject (e.g. division). */
    group?: string[]
    value: string
    date: string
  }
  subject_type?: string
}

const Z_SCORE_THRESHOLD: Record<string, number> = { low: 3.0, medium: 2.5, high: 2.0 }
const SPIKE_THRESHOLD: Record<string, number> = { low: 1.0, medium: 0.5, high: 0.25 }
const DUP_TOLERANCE_PCT: Record<string, number> = { low: 0.02, medium: 0.05, high: 0.1 }
const DUP_WINDOW_DAYS: Record<string, number> = { low: 7, medium: 14, high: 30 }

export const SENSITIVITY_DESCRIPTIONS: Record<string, Record<string, string>> = {
  amount_outlier: {
    low: 'Z-score ≥ 3.0 — flags only extreme statistical outliers',
    medium: 'Z-score ≥ 2.5 — standard statistical threshold',
    high: 'Z-score ≥ 2.0 — more sensitive, will flag moderate deviations'
  },
  period_spike: {
    low: 'Volume doubled vs. same period last year',
    medium: 'Volume increased 50%+ vs. same period last year',
    high: 'Volume increased 25%+ vs. same period last year'
  },
  duplicate_pattern: {
    low: 'Same amount (±2%) within 7 days',
    medium: 'Same amount (±5%) within 14 days',
    high: 'Same amount (±10%) within 30 days'
  }
}

function mean(values: number[]): number {
  if (!values.length) return 0
  return values.reduce((a, b) => a + b, 0) / values.length
}

function stddev(values: number[]): number {
  if (values.length < 2) return 0
  const m = mean(values)
  return Math.sqrt(values.reduce((s, v) => s + (v - m) ** 2, 0) / (values.length - 1))
}

interface SourceRow {
  subject_id: string
  subject_label: string
  group: Record<string, unknown>
  groupKey: string
  value: number
  date: Date
}

async function fetchRows(
  cfg: AnomalyConfig,
  scopes: Record<string, unknown> | null
): Promise<SourceRow[]> {
  const params: Record<string, unknown> = { ...(cfg.params ?? {}) }
  const map = cfg.param_map ?? {}
  for (const [key, raw] of Object.entries(scopes ?? {})) {
    const paramName = map[key] ?? key
    const arr = Array.isArray(raw) ? raw : raw != null ? [raw] : []
    if (arr.length) params[paramName] = arr.join(',')
  }
  const rows = await runCustomQueryBySlug(cfg.source_query, params)
  const c = cfg.columns
  const out: SourceRow[] = []
  for (const r of rows) {
    const value = Number(r[c.value])
    const dateRaw = r[c.date]
    const date = dateRaw instanceof Date ? dateRaw : new Date(String(dateRaw))
    if (!Number.isFinite(value) || Number.isNaN(date.getTime())) continue
    const group: Record<string, unknown> = {}
    for (const g of c.group ?? []) group[g] = r[g]
    const subjectId = String(r[c.subject_id] ?? '')
    if (!subjectId) continue
    out.push({
      subject_id: subjectId,
      subject_label: String(r[c.subject_label ?? c.subject_id] ?? subjectId),
      group,
      groupKey: [subjectId, ...(c.group ?? []).map((g) => String(r[g] ?? ''))].join('||'),
      value,
      date
    })
  }
  return out
}

type Detection = {
  subject_id: string
  subject_label: string
  group: Record<string, unknown>
  [k: string]: unknown
}

function detectAmountOutliers(rows: SourceRow[], sensitivity: string): Detection[] {
  const threshold = Z_SCORE_THRESHOLD[sensitivity] ?? 2.5
  if (rows.length < 10) return []
  const groups = new Map<string, SourceRow[]>()
  for (const row of rows) {
    if (!groups.has(row.groupKey)) groups.set(row.groupKey, [])
    groups.get(row.groupKey)!.push(row)
  }
  const detections: Detection[] = []
  for (const list of groups.values()) {
    if (list.length < 5) continue
    list.sort((a, b) => a.date.getTime() - b.date.getTime())
    const values = list.map((r) => r.value)
    const m = mean(values)
    const sd = stddev(values)
    if (sd === 0) continue
    const latest = list[list.length - 1]
    const z = Math.abs(latest.value - m) / sd
    if (z >= threshold) {
      detections.push({
        subject_id: latest.subject_id,
        subject_label: latest.subject_label,
        group: latest.group,
        amount: latest.value,
        mean: m,
        stddev: sd,
        z_score: z
      })
    }
  }
  return detections
}

function detectPeriodSpike(rows: SourceRow[], sensitivity: string): Detection[] {
  const threshold = SPIKE_THRESHOLD[sensitivity] ?? 0.5
  const now = Date.now()
  const d30 = now - 30 * 86400_000
  const priorStart = now - 395 * 86400_000
  const priorEnd = now - 365 * 86400_000

  const current = new Map<string, { count: number; sample: SourceRow }>()
  const prior = new Map<string, number>()
  for (const row of rows) {
    const t = row.date.getTime()
    if (t >= d30) {
      const cur = current.get(row.groupKey)
      if (cur) cur.count++
      else current.set(row.groupKey, { count: 1, sample: row })
    } else if (t >= priorStart && t < priorEnd) {
      prior.set(row.groupKey, (prior.get(row.groupKey) ?? 0) + 1)
    }
  }

  const detections: Detection[] = []
  for (const [key, cur] of current) {
    if (cur.count < 3) continue
    const prev = prior.get(key) ?? 0
    if (prev === 0) continue
    const pct = (cur.count - prev) / prev
    if (pct >= threshold) {
      detections.push({
        subject_id: cur.sample.subject_id,
        subject_label: cur.sample.subject_label,
        group: cur.sample.group,
        current_count: cur.count,
        prior_count: prev,
        pct_increase: pct * 100
      })
    }
  }
  return detections
}

function detectDuplicatePatterns(rows: SourceRow[], sensitivity: string): Detection[] {
  const tolerancePct = DUP_TOLERANCE_PCT[sensitivity] ?? 0.05
  const windowDays = DUP_WINDOW_DAYS[sensitivity] ?? 14
  const cutoff = Date.now() - windowDays * 86400_000

  const groups = new Map<string, SourceRow[]>()
  for (const row of rows) {
    if (row.date.getTime() < cutoff || row.value <= 0) continue
    if (!groups.has(row.groupKey)) groups.set(row.groupKey, [])
    groups.get(row.groupKey)!.push(row)
  }

  const detections: Detection[] = []
  for (const list of groups.values()) {
    if (list.length < 2) continue
    list.sort((a, b) => a.value - b.value)
    const matched = new Set<number>()
    for (let i = 0; i < list.length; i++) {
      if (matched.has(i)) continue
      const cluster = [i]
      const base = list[i].value
      for (let j = i + 1; j < list.length; j++) {
        if (Math.abs(list[j].value - base) / base <= tolerancePct) cluster.push(j)
      }
      if (cluster.length >= 2) {
        cluster.forEach((idx) => matched.add(idx))
        const amounts = cluster.map((idx) => list[idx].value)
        detections.push({
          subject_id: list[i].subject_id,
          subject_label: list[i].subject_label,
          group: list[i].group,
          match_count: cluster.length,
          window_days: windowDays,
          min_amount: Math.min(...amounts),
          max_amount: Math.max(...amounts)
        })
      }
    }
  }
  return detections
}

// ─── AI explanation ───────────────────────────────────────────────────────────

function buildPrompt(key: string, d: Detection): string {
  const groupLine = Object.entries(d.group)
    .map(([k, v]) => `- ${k}: ${v}`)
    .join('\n')
  switch (key) {
    case 'amount_outlier':
      return `You are a data analyst reviewing operational records. A statistical anomaly was detected:
- Subject: ${d.subject_label}
${groupLine}
- Amount: ${Number(d.amount ?? 0).toLocaleString()}
- Historical average: ${Number(d.mean ?? 0).toLocaleString()} (std dev: ${Number(d.stddev ?? 0).toLocaleString()})
- Z-score: ${Number(d.z_score ?? 0).toFixed(2)} standard deviations from the mean

Write a 2-sentence plain-English explanation of this anomaly and its potential business significance. Be concise and actionable.`
    case 'period_spike':
      return `You are a data analyst reviewing operational records. An unusual activity spike was detected:
- Subject: ${d.subject_label}
${groupLine}
- Records this 30-day period: ${d.current_count}
- Records same period last year: ${d.prior_count}
- Percentage increase: ${Number(d.pct_increase ?? 0).toFixed(1)}%

Write a 2-sentence plain-English explanation of this spike and its potential business significance. Be concise and actionable.`
    case 'duplicate_pattern':
      return `You are a data analyst reviewing operational records. A potential duplicate pattern was detected:
- Subject: ${d.subject_label}
${groupLine}
- Similar records: ${d.match_count} within the last ${d.window_days} days
- Amount range: ${Number(d.min_amount ?? 0).toLocaleString()} – ${Number(d.max_amount ?? 0).toLocaleString()}

Write a 2-sentence plain-English explanation of this pattern and why it may require review. Be concise and actionable.`
    default:
      return `A data anomaly was detected: ${JSON.stringify(d)}. Write a 1-sentence plain-English summary.`
  }
}

async function generateExplanation(key: string, d: Detection): Promise<string> {
  try {
    const client = await getAiClient()
    if (!client) return ''
    const { model } = await getAiModelSettings()
    const res = await client.messages.create({
      model,
      max_tokens: 300,
      messages: [{ role: 'user', content: buildPrompt(key, d) }]
    })
    const first = res.content[0]
    return first?.type === 'text' ? first.text.trim() : ''
  } catch (err) {
    console.warn('[anomaly] AI explanation failed:', (err as Error).message)
    return ''
  }
}

// ─── Runner ───────────────────────────────────────────────────────────────────

export async function runAnomalyChecks(
  app: FastifyInstance,
  frequency: 'daily' | 'weekly' | 'all' = 'all'
): Promise<{ evaluated: number; detected: number; skipped: number }> {
  const q = db('nivaro_anomaly_rules as r')
    .join('nivaro_anomaly_definitions as d', 'd.id', 'r.definition_id')
    .leftJoin('nivaro_users as u', 'u.id', 'r.created_by')
    .where('r.status', 'active')
    .where('d.status', 'active')
    .select(
      'r.id',
      'r.name',
      'r.sensitivity',
      'r.scopes',
      'r.delivery_in_app',
      'r.delivery_email',
      'r.created_by',
      'd.key as def_key',
      'd.name as def_name',
      'd.config',
      'u.email as creator_email'
    )
  if (frequency !== 'all') q.where('r.check_frequency', frequency)
  const rules = (await q) as Array<{
    id: number
    name: string
    sensitivity: string | null
    scopes: string | null
    delivery_in_app: boolean
    delivery_email: boolean
    created_by: string | null
    def_key: string
    def_name: string
    config: string
    creator_email: string | null
  }>

  const results = { evaluated: 0, detected: 0, skipped: 0 }

  for (const rule of rules) {
    const cfg = parseJsonSafe<AnomalyConfig>(rule.config)
    if (!cfg?.source_query || !cfg.columns) {
      results.skipped++
      continue
    }
    const scopes = parseJsonSafe<Record<string, unknown>>(rule.scopes)
    const sensitivity = rule.sensitivity ?? 'medium'

    let rows: SourceRow[]
    try {
      rows = await fetchRows(cfg, scopes)
    } catch (err) {
      console.warn(`[anomaly] source query failed for rule ${rule.id}:`, (err as Error).message)
      results.skipped++
      continue
    }

    let detections: Detection[]
    switch (rule.def_key) {
      case 'amount_outlier':
        detections = detectAmountOutliers(rows, sensitivity)
        break
      case 'period_spike':
        detections = detectPeriodSpike(rows, sensitivity)
        break
      case 'duplicate_pattern':
        detections = detectDuplicatePatterns(rows, sensitivity)
        break
      default:
        results.skipped++
        continue
    }
    results.evaluated++

    for (const detection of detections) {
      // Dedup: one OPEN (new/acknowledged) entry per rule + subject
      const open = await db('nivaro_anomaly_log')
        .where({ rule_id: rule.id, subject_id: detection.subject_id })
        .whereIn('status', ['new', 'acknowledged'])
        .first('id')
      if (open) continue

      const explanation = await generateExplanation(rule.def_key, detection)
      const inserted = (await db('nivaro_anomaly_log')
        .insert({
          rule_id: rule.id,
          detected_at: new Date(),
          subject_type: cfg.subject_type ?? 'record',
          subject_id: detection.subject_id,
          stats_snapshot: JSON.stringify(detection),
          ai_explanation: explanation || null,
          status: 'new'
        })
        .returning('id')) as Array<{ id: number } | number>
      const logId =
        typeof inserted[0] === 'object' ? (inserted[0] as { id: number }).id : (inserted[0] as number)
      results.detected++

      const subject = `Anomaly Detected: ${rule.name}`
      const message =
        explanation ||
        `${rule.def_name} anomaly detected for ${detection.subject_label}` +
          (Object.values(detection.group).length
            ? ` (${Object.values(detection.group).filter(Boolean).join(', ')})`
            : '')

      if (rule.delivery_in_app && rule.created_by) {
        await notifyUser(app, rule.created_by, {
          subject,
          message,
          collection: 'nivaro_anomaly_log',
          item: String(logId)
        }).catch(() => undefined)
      }
      if (rule.delivery_email && rule.creator_email) {
        await sendMail({
          to: rule.creator_email,
          subject,
          template: 'alert_notification',
          data: {
            rule_name: rule.name,
            metric_name: rule.def_name,
            metric_value: message,
            threshold_value: '',
            operator: ''
          }
        }).catch((e) => console.warn('[anomaly] email failed:', (e as Error).message))
      }
    }
  }

  return results
}
