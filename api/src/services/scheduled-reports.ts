import { db } from '../db/index.js'
import type { User } from '../types.js'
import { sendRawMail } from './mail.js'
import { htmlToPdf } from './pdf-layout.js'

/**
 * Scheduled reports — render a PDF snapshot and email it.
 *
 * Runs AS THE REPORT'S CREATOR (same identity precedent as queue stat
 * snapshots and widget feeds): the creator configured the recipients knowing
 * what the report exposes.
 */

export interface ScheduledReport {
  id: number
  name: string
  report_type: 'collection' | 'queue'
  collection: string | null
  queue_id: string | null
  filters: string | null
  fields: string | null
  recipients: string
  cron_schedule: string
  orientation: string
  row_limit: number
  is_active: boolean
  created_by: string | null
}

function parseArr<T>(raw: string | null): T[] {
  if (!raw) return []
  try {
    const v = JSON.parse(raw)
    return Array.isArray(v) ? v : []
  } catch {
    return []
  }
}

function esc(v: unknown): string {
  return String(v ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function reportShell(title: string, generatedFor: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, 'Segoe UI', Roboto, sans-serif; color: #1e293b; padding: 40px; }
    h1 { font-size: 20px; letter-spacing: -0.01em; }
    .meta { color: #64748b; font-size: 11px; margin-top: 4px; margin-bottom: 24px; }
    table { width: 100%; border-collapse: collapse; font-size: 11px; }
    th { text-align: left; padding: 6px 8px; border-bottom: 2px solid #0f172a; font-size: 10px;
         text-transform: uppercase; letter-spacing: 0.04em; color: #475569; }
    td { padding: 6px 8px; border-bottom: 1px solid #e2e8f0; }
    tr:nth-child(even) td { background: #f8fafc; }
    .stats { display: flex; gap: 16px; margin-bottom: 24px; }
    .stat { border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px 16px; }
    .stat b { display: block; font-size: 22px; }
    .stat span { font-size: 10px; color: #64748b; text-transform: uppercase; letter-spacing: 0.04em; }
  </style></head><body>
    <h1>${esc(title)}</h1>
    <p class="meta">Generated ${new Date().toLocaleString('en-US')} · ${esc(generatedFor)}</p>
    ${body}
  </body></html>`
}

async function renderCollectionReport(report: ScheduledReport): Promise<string> {
  const collection = report.collection
  if (!collection || !/^[a-zA-Z0-9_]+$/.test(collection) || collection.startsWith('nivaro_')) {
    throw new Error('Invalid collection')
  }
  // Physical columns only — nivaro_fields also carries alias fields (O2M/M2M)
  // that have no real column and would break the SELECT.
  const physical = (await db.raw(
    `SELECT COLUMN_NAME AS name FROM information_schema.columns WHERE TABLE_NAME = ?`,
    [collection]
  )) as Array<{ name: string }>
  const validCols = new Set(physical.map((r) => r.name))
  const fields = parseArr<string>(report.fields).filter((f) => validCols.has(f))
  const cols = fields.length > 0 ? fields : [...validCols].slice(0, 8)

  let q = db(collection).select(cols).limit(Math.min(500, report.row_limit || 100))
  for (const f of parseArr<{ field: string; op: string; value?: unknown }>(report.filters)) {
    if (!validCols.has(f.field)) continue
    switch (f.op) {
      case 'eq': q = q.where(f.field, f.value as never); break
      case 'neq': q = q.whereNot(f.field, f.value as never); break
      case 'gt': q = q.where(f.field, '>', f.value as never); break
      case 'lt': q = q.where(f.field, '<', f.value as never); break
      case 'contains': q = q.where(f.field, 'like', `%${String(f.value)}%`); break
      case 'null': q = q.whereNull(f.field); break
      case 'nnull': q = q.whereNotNull(f.field); break
    }
  }
  const rows = (await q) as Array<Record<string, unknown>>

  const header = cols.map((c) => `<th>${esc(c)}</th>`).join('')
  const body = rows
    .map((r) => `<tr>${cols.map((c) => `<td>${esc(r[c])}</td>`).join('')}</tr>`)
    .join('')
  return reportShell(
    report.name,
    `${collection} · ${rows.length} row(s)`,
    `<table><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table>`
  )
}

async function renderQueueReport(report: ScheduledReport, runAs: User): Promise<string> {
  const { fetchQueueItems } = await import('./queues.js')
  if (!report.queue_id) throw new Error('queue_id missing')
  const queue = await db('nivaro_queues').where({ id: report.queue_id }).first()
  if (!queue) throw new Error('Queue no longer exists')
  const res = await fetchQueueItems(report.queue_id, runAs, 'all', {})
  const items = (res.items ?? []) as unknown as Array<Record<string, unknown>>
  const stats = (res.stats ?? {}) as unknown as Record<string, unknown>

  const statHtml = `<div class="stats">${[
    ['Total', stats.total],
    ['Unowned', stats.unowned],
    ['SLA warning', stats.sla_warning],
    ['SLA breached', stats.sla_breached],
    ['At risk', stats.at_risk]
  ]
    .filter(([, v]) => v != null)
    .map(([label, v]) => `<div class="stat"><b>${esc(v)}</b><span>${esc(label)}</span></div>`)
    .join('')}</div>`

  const top = items.slice(0, Math.min(200, report.row_limit || 100))
  const rows = top
    .map(
      (i) =>
        `<tr><td>${esc(i.label)}</td><td>${esc(i.state ?? '')}</td><td>${esc(i.owner_names ?? (Array.isArray(i.owners) ? (i.owners as Array<{ email?: string }>).map((o) => o.email).join(', ') : ''))}</td><td>${esc(i.sla_status ?? '')}</td></tr>`
    )
    .join('')
  return reportShell(
    report.name,
    `Queue '${String(queue.name)}' · ${items.length} item(s)`,
    `${statHtml}<table><thead><tr><th>Item</th><th>State</th><th>Owners</th><th>SLA</th></tr></thead><tbody>${rows}</tbody></table>`
  )
}

export async function runScheduledReport(
  report: ScheduledReport
): Promise<{ sent: number; error?: string }> {
  const recipients = parseArr<string>(report.recipients).filter((r) => /.+@.+\..+/.test(r))
  if (recipients.length === 0) return { sent: 0, error: 'No valid recipients' }

  const creator = report.created_by
    ? ((await db('nivaro_users').where({ id: report.created_by }).first()) as User | undefined)
    : undefined
  if (!creator) return { sent: 0, error: 'Report creator no longer exists' }

  const html =
    report.report_type === 'queue'
      ? await renderQueueReport(report, creator)
      : await renderCollectionReport(report)

  const pdf = await htmlToPdf(html, {
    format: 'A4',
    landscape: report.orientation === 'landscape'
  })
  const stamp = new Date().toISOString().slice(0, 10)
  const safeName = report.name.replace(/[^a-zA-Z0-9_-]/g, '_')

  await sendRawMail({
    to: recipients,
    subject: `${report.name} — ${stamp}`,
    html: `<p>Attached: <strong>${esc(report.name)}</strong>, generated ${new Date().toLocaleString('en-US')}.</p>`,
    attachments: [
      { filename: `${safeName}-${stamp}.pdf`, content: pdf, contentType: 'application/pdf' }
    ]
  })

  await db('nivaro_scheduled_reports').where({ id: report.id }).update({
    last_run_at: new Date(),
    last_run_status: `sent to ${recipients.length} recipient(s)`,
    updated_at: new Date()
  })
  return { sent: recipients.length }
}
