import { randomUUID } from 'node:crypto'
import { db } from './src/db/index.js'

const USER = '7A0411F3-C687-40E5-ADF5-614157CF88EC' // Robert Lee
const J = (v: unknown) => JSON.stringify(v)
const ago = (days: number, hour = 9) => {
  const d = new Date()
  d.setDate(d.getDate() - days)
  d.setHours(hour, 0, 0, 0)
  return d
}

// ─── Metric alert rules ──────────────────────────────────────────────────────
// Thresholds sit near the real values so the demo shows both firing and
// resolved states rather than a wall of one or the other.
const RULES = [
  { name: 'Workflows on hold — Zone 1', key: 'workflows.on_hold_count', op: 'gte', threshold: 3,
    filters: [{ key: 'divisions', values: ['MM'] }], freq: 'hourly', shared: true,
    history: [{ d: 26, v: 7 }, { d: 19, v: 5 }, { d: 9, v: 4 }], open: { v: 6 } },
  { name: 'Open workflows above 200', key: 'workflows.open_count', op: 'gte', threshold: 200,
    filters: [], freq: 'daily', shared: true,
    history: [{ d: 24, v: 231 }, { d: 12, v: 214 }], open: null },
  { name: 'Overdue workflows climbing', key: 'workflows.overdue_count', op: 'gte', threshold: 10,
    filters: [{ key: 'funding_years', values: [2026] }], freq: 'daily', shared: false,
    history: [{ d: 21, v: 14 }, { d: 15, v: 11 }, { d: 6, v: 12 }], open: { v: 17 } },
  { name: 'Invoices past due', key: 'invoices.past_due_count', op: 'gte', threshold: 5,
    filters: [], freq: 'hourly', shared: true,
    history: [{ d: 28, v: 9 }, { d: 17, v: 6 }], open: null },
  { name: 'Unbilled spend over $500k', key: 'invoices.open_unbilled_amount', op: 'gte', threshold: 500000,
    filters: [{ key: 'divisions', values: ['MM'] }], freq: 'weekly', shared: false,
    history: [{ d: 22, v: 743210.55 }], open: { v: 918442.1 } },
  { name: 'Inventory requests on hold', key: 'inventory.on_hold_count', op: 'gte', threshold: 1,
    filters: [], freq: 'daily', shared: false,
    history: [{ d: 13, v: 3 }, { d: 4, v: 2 }], open: null }
]

const ANOMALIES = [
  { key: 'amount_outlier', name: 'Vendor amount outliers — Zone 1', sensitivity: 'medium', freq: 'daily',
    scopes: { divisions: ['MM'] }, email: true,
    hits: [
      { d: 5, status: 'new', mult: 4.2, amount: 412500, mean: 98200,
        why: 'This PO is 4.2x the vendor’s 90-day average of $98,200 and the largest single amount recorded for them this funding year. Worth confirming it is not a duplicate of the $410,000 order raised the previous week.' },
      { d: 12, status: 'acknowledged', mult: 3.1, amount: 268000, mean: 86400,
        why: 'Amount sits 3.1x above the vendor’s trailing average. Reviewed with procurement — a genuine bulk equipment purchase covering two quarters.' },
      { d: 23, status: 'resolved', mult: 2.8, amount: 175900, mean: 62800,
        why: 'Elevated versus history but consistent with the scope change approved on the parent workflow. Closed as expected.' }
    ] },
  { key: 'period_spike', name: 'Vendor activity spikes', sensitivity: 'high', freq: 'daily',
    scopes: {}, email: false,
    hits: [
      { d: 3, status: 'new', mult: 3.6, amount: 96400, mean: 26800,
        why: 'Vendor raised 11 purchase orders in the last 7 days against a baseline of 3 per week. Volume, not amount, is the outlier here.' },
      { d: 16, status: 'resolved', mult: 2.4, amount: 54100, mean: 22500,
        why: 'Short burst of activity aligned to the fiscal-year-end ordering window. No action needed.' }
    ] },
  { key: 'duplicate_pattern', name: 'Possible duplicate payments', sensitivity: 'low', freq: 'weekly',
    scopes: { divisions: ['MM'] }, email: true,
    hits: [
      { d: 8, status: 'acknowledged', mult: 2.0, amount: 88750, mean: 44375,
        why: 'Two purchase orders to the same vendor for an identical $88,750 within 48 hours. Confirmed as a split delivery under one contract, not a duplicate.' }
    ] }
]

const inserted: string[] = []

// ─── Metric rules + subscriptions + firing history ───────────────────────────
for (const r of RULES) {
  const def = await db('nivaro_metric_definitions').where({ metric_key: r.key }).first()
  if (!def) { console.log(`  skip (no definition): ${r.key}`); continue }
  const existing = await db('nivaro_metric_alert_rules').where({ name: r.name }).first()
  if (existing) { console.log(`  exists: ${r.name}`); continue }

  await db('nivaro_metric_alert_rules').insert({
    name: r.name, definition_id: def.id, operator: r.op, threshold_value: r.threshold,
    filters: J(r.filters), check_frequency: r.freq, is_shared: r.shared ? 1 : 0,
    status: 'active', created_by: USER, created_at: ago(30), updated_at: ago(30)
  })
  const rule = await db('nivaro_metric_alert_rules').where({ name: r.name }).orderBy('id', 'desc').first()

  await db('nivaro_metric_alert_subscriptions').insert({
    rule_id: rule.id, user: USER, delivery_in_app: 1,
    delivery_email: r.freq === 'hourly' ? 0 : 1,
    digest_frequency: r.freq === 'hourly' ? 'immediate' : r.freq === 'weekly' ? 'weekly' : 'daily',
    last_notified: r.open ? ago(1) : ago(6), status: 'active', created_at: ago(30)
  })

  // Closed episodes: fired, then came back into range.
  for (const h of r.history) {
    await db('nivaro_metric_alert_log').insert({
      rule_id: rule.id, fired_at: ago(h.d), resolved_at: ago(h.d - 1, 14),
      metric_value: h.v, threshold_value: r.threshold,
      filters_snapshot: J(r.filters), status: 'resolved'
    })
  }
  // One OPEN firing row IS the cooldown — at most one per rule, by design.
  if (r.open) {
    await db('nivaro_metric_alert_log').insert({
      rule_id: rule.id, fired_at: ago(1, 7), resolved_at: null,
      metric_value: r.open.v, threshold_value: r.threshold,
      filters_snapshot: J(r.filters), status: 'firing'
    })
  }
  inserted.push(`metric rule "${r.name}" (${r.history.length} resolved${r.open ? ' + 1 FIRING' : ''})`)
}

// ─── Anomaly rules + detections ──────────────────────────────────────────────
const vendors = await db('vendors').whereNotNull('name').orderBy('id').limit(8).select('id', 'name')
let vi = 0
for (const a of ANOMALIES) {
  const def = await db('nivaro_anomaly_definitions').where({ key: a.key }).first()
  if (!def) { console.log(`  skip (no anomaly definition): ${a.key}`); continue }
  if (await db('nivaro_anomaly_rules').where({ name: a.name }).first()) { console.log(`  exists: ${a.name}`); continue }

  await db('nivaro_anomaly_rules').insert({
    name: a.name, definition_id: def.id, sensitivity: a.sensitivity, scopes: J(a.scopes),
    check_frequency: a.freq, delivery_in_app: 1, delivery_email: a.email ? 1 : 0,
    status: 'active', created_by: USER, created_at: ago(30), updated_at: ago(30)
  })
  const rule = await db('nivaro_anomaly_rules').where({ name: a.name }).orderBy('id', 'desc').first()

  for (const h of a.hits) {
    const v = vendors[vi++ % vendors.length]
    await db('nivaro_anomaly_log').insert({
      rule_id: rule.id, detected_at: ago(h.d), resolved_at: h.status === 'resolved' ? ago(h.d - 2, 16) : null,
      subject_type: 'vendor', subject_id: String(v.id),
      stats_snapshot: J({
        subject_label: v.name, value: h.amount, mean: h.mean,
        stddev: Math.round(h.mean * 0.28), multiplier: h.mult,
        sample_size: 34, window_days: 90
      }),
      ai_explanation: h.why, status: h.status, created_at: ago(h.d)
    })
  }
  inserted.push(`anomaly rule "${a.name}" (${a.hits.length} detections)`)
}

// ─── Report widget alerts ────────────────────────────────────────────────────
const WIDGET_ALERTS = [
  { report: 'Executive Dashboard', name: 'Requisition total below plan',
    conditions: [{ field: 'value', op: 'lt', value: 100_000_000 }],
    filters: [{ field: 'funding_years', values: [2026], labels: ['2026'] }],
    history: [{ d: 20, snap: { value: 96_521_860 } }], open: { value: 94_180_400 } },
  { report: 'Financial Operations', name: 'Invoice backlog over 250 rows',
    conditions: [{ field: 'row_count', op: 'gt', value: 250 }],
    filters: [], history: [{ d: 18, snap: { row_count: 288 } }, { d: 7, snap: { row_count: 263 } }], open: null },
  { report: 'Workflow Executive Dashboard', name: 'Open workflow count spike',
    conditions: [{ field: 'row_count', op: 'gte', value: 40 }, { field: 'value', op: 'gte', value: 1_000_000 }],
    filters: [{ field: 'divisions', values: ['MM'], labels: ['Zone 1'] }],
    history: [{ d: 11, snap: { row_count: 47, value: 1_320_500 } }], open: { row_count: 52, value: 1_508_900 } }
]

for (const w of WIDGET_ALERTS) {
  const report = await db('nivaro_report_defs').where({ name: w.report }).first()
  if (!report) { console.log(`  skip (no report): ${w.report}`); continue }
  const widget = await db('nivaro_report_widgets').where({ report: report.id, type: 'query' })
    .orderBy('sort').first()
  if (!widget) { console.log(`  skip (no query widget): ${w.report}`); continue }
  if (await db('nivaro_report_alerts').where({ name: w.name }).first()) { console.log(`  exists: ${w.name}`); continue }

  const id = randomUUID()
  await db('nivaro_report_alerts').insert({
    id, report: report.id, widget: widget.id, name: w.name,
    conditions: J(w.conditions), filters: J(w.filters),
    delivery_email: 1, delivery_inapp: 1, is_active: 1,
    created_by: USER, last_checked_at: ago(0, 8), created_at: ago(30)
  })
  for (const h of w.history) {
    await db('nivaro_report_alert_log').insert({
      alert: id, status: 'resolved', metric_snapshot: J(h.snap),
      fired_at: ago(h.d), resolved_at: ago(h.d - 2, 15)
    })
  }
  if (w.open) {
    await db('nivaro_report_alert_log').insert({
      alert: id, status: 'firing', metric_snapshot: J(w.open),
      fired_at: ago(2, 8), resolved_at: null
    })
  }
  inserted.push(`widget alert "${w.name}" on ${w.report}${w.open ? ' (FIRING)' : ''}`)
}

console.log('\n─── seeded ───')
for (const i of inserted) console.log('  ' + i)
process.exit(0)
