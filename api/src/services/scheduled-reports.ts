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
  report_type: 'collection' | 'queue' | 'ops_brief'
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


// ─── AI ops brief ─────────────────────────────────────────────────────────────

/** Simple markdown → HTML for the brief body (headings, lists, bold, paras). */
function miniMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inList = false
  for (const raw of lines) {
    const line = raw.trimEnd()
    const inline = (t: string) =>
      esc(t).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    if (/^#{1,3} /.test(line)) {
      if (inList) { out.push('</ul>'); inList = false }
      out.push(`<h2>${inline(line.replace(/^#{1,3} /, ''))}</h2>`)
    } else if (/^[-*] /.test(line)) {
      if (!inList) { out.push('<ul>'); inList = true }
      out.push(`<li>${inline(line.slice(2))}</li>`)
    } else if (line.trim() === '') {
      if (inList) { out.push('</ul>'); inList = false }
    } else {
      if (inList) { out.push('</ul>'); inList = false }
      out.push(`<p>${inline(line)}</p>`)
    }
  }
  if (inList) out.push('</ul>')
  return out.join('\n')
}

async function gatherOpsFacts(): Promise<Record<string, unknown>> {
  const now = Date.now()
  const weekAgo = new Date(now - 7 * 86_400_000)
  const twoWeeksAgo = new Date(now - 14 * 86_400_000)

  const [thisWeek, lastWeek] = await Promise.all([
    db('nivaro_workflow_history').where('timestamp', '>=', weekAgo).count({ n: '*' }),
    db('nivaro_workflow_history')
      .where('timestamp', '>=', twoWeeksAgo)
      .where('timestamp', '<', weekAgo)
      .count({ n: '*' })
  ])

  // Latest queue snapshots vs 7 days ago
  const snapshots = (await db('nivaro_queue_stat_snapshots as s')
    .join('nivaro_queues as q', 'q.id', 's.queue_id')
    .where('s.snapshot_date', '>=', twoWeeksAgo)
    .orderBy('s.snapshot_date', 'desc')
    .select('q.name', 's.snapshot_date', 's.total', 's.unowned', 's.sla_warning', 's.sla_breached', 's.at_risk')
    .catch(() => [])) as Array<Record<string, unknown>>
  const latestByQueue = new Map<string, Record<string, unknown>>()
  const weekAgoByQueue = new Map<string, Record<string, unknown>>()
  for (const s of snapshots) {
    const name = String(s.name)
    if (!latestByQueue.has(name)) latestByQueue.set(name, s)
    const d = new Date(s.snapshot_date as string).getTime()
    if (!weekAgoByQueue.has(name) && d <= now - 6.5 * 86_400_000) weekAgoByQueue.set(name, s)
  }
  const queues = [...latestByQueue.entries()].map(([name, cur]) => ({
    name,
    now: {
      total: Number(cur.total),
      unowned: Number(cur.unowned),
      sla_breached: Number(cur.sla_breached),
      at_risk: Number(cur.at_risk)
    },
    week_ago: weekAgoByQueue.has(name)
      ? {
          total: Number(weekAgoByQueue.get(name)?.total),
          sla_breached: Number(weekAgoByQueue.get(name)?.sla_breached)
        }
      : null
  }))

  // Predictively stuck: non-terminal instances whose age > P80 for their state
  let stuck: Array<Record<string, unknown>> = []
  try {
    const { getStateDurationStats } = await import('./predictive-sla.js')
    const stats = await getStateDurationStats()
    const rows = (await db.raw(`
      SELECT TOP 200 wi.collection, wi.item, wi.current_state, s.label AS state_label,
             DATEDIFF(hour, h.entered_at, GETDATE()) AS age_hours
      FROM nivaro_workflow_instances wi
      JOIN nivaro_workflow_states s ON s.id = wi.current_state
      CROSS APPLY (
        SELECT MAX(timestamp) AS entered_at FROM nivaro_workflow_history
        WHERE instance = wi.id AND to_state = wi.current_state
      ) h
      WHERE s.is_terminal = 0 AND h.entered_at IS NOT NULL
      ORDER BY age_hours DESC
    `)) as Array<Record<string, unknown>>
    stuck = rows
      .filter((r) => {
        const st = stats.get(String(r.current_state))
        return st && st.n >= 30 && Number(r.age_hours) > st.p80
      })
      .slice(0, 8)
      .map((r) => ({
        record: `${String(r.collection)}/${String(r.item)}`,
        state: String(r.state_label),
        age_hours: Number(r.age_hours)
      }))
  } catch {
    stuck = []
  }

  const [issuesRow] = await db('nivaro_issues')
    .where('created_at', '>=', weekAgo)
    .count({ n: '*' })
    .catch(() => [{ n: 0 }])

  return {
    period: 'last 7 days',
    workflow_transitions: { this_week: Number(thisWeek[0]?.n ?? 0), prior_week: Number(lastWeek[0]?.n ?? 0) },
    queues,
    predictively_stuck_records: stuck,
    new_issues: Number((issuesRow as { n?: number })?.n ?? 0)
  }
}

async function renderOpsBrief(report: ScheduledReport): Promise<string> {
  const { getAiClient, getAiModelSettings } = await import('./ai-client.js')
  const client = await getAiClient()
  const facts = await gatherOpsFacts()

  let body: string
  if (client) {
    const { model } = await getAiModelSettings()
    const response = await client.messages.create({
      model,
      max_tokens: 900,
      messages: [
        {
          role: 'user',
          content: `You are writing the weekly operations brief for a work-management platform. Using ONLY these facts, write a concise executive brief in markdown (## headings, - bullets, **bold** for numbers). Lead with the headline trend, then queue health, then the stuck records that need attention (name them), then issues. No preamble, no invented numbers.\n\nFACTS:\n${JSON.stringify(facts, null, 2)}`
        }
      ]
    })
    body = response.content
      .map((b) => (b.type === 'text' ? b.text : ''))
      .filter(Boolean)
      .join('\n')
  } else {
    body = `## Ops summary (AI not configured — raw facts)\n\n${'```'}\n${JSON.stringify(facts, null, 2)}\n${'```'}`
  }

  return reportShell(report.name, 'AI weekly operations brief', miniMarkdown(body))
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
      : report.report_type === 'ops_brief'
        ? await renderOpsBrief(report)
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
