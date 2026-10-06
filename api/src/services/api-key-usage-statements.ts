import { adminBaseUrl } from '../admin-base.js'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'
import { type KeyUsageReport, keyUsage, previousMonth } from './api-key-usage.js'
import { sendMail } from './mail.js'

/**
 * Monthly API usage statements (#1462) — cron `api-key-usage-statements` on the
 * 1st at 07:10. Every active key with `usage_statement` on gets last month's
 * usage, mailed to `usage_contact` (else the key owner). One per key per month:
 * `usage_statement_sent_for` remembers the month already covered, so run-now
 * or a catch-up tick sends nothing twice. Mail test mode applies (sendMail).
 */

interface KeyRow {
  id: number
  name: string
  user: string | null
  usage_contact: string | null
  usage_statement_sent_for: string | null
}

const fmt = (n: number) => n.toLocaleString('en-US')

export function monthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString('en-US', {
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC'
  })
}

export function buildUsageStatementMail(r: KeyUsageReport): {
  template: string
  subject: string
  data: Record<string, unknown>
} {
  const label = monthLabel(r.month)
  const errPct = `${(r.totals.error_rate * 100).toFixed(1)}%`
  const busiest = r.by_family
    .slice(0, 3)
    .map((f) => `${f.family} (${fmt(f.calls)})`)
    .join(', ')
  const ops = r.graphql
    .slice(0, 3)
    .map((g) => `${g.operation} (${fmt(g.calls)})`)
    .join(', ')
  return {
    template: 'notice',
    subject: `API usage for ${r.key.name} — ${label}`,
    data: {
      eyebrow: 'API usage statement',
      eyebrow_tone: r.totals.error_rate > 0.05 ? 'warn' : 'ok',
      heading: `${r.key.name}: ${fmt(r.totals.calls)} calls in ${label}`,
      lead:
        r.totals.calls === 0
          ? 'This key made no calls that the request log still holds for the month.'
          : `Here is how the key ${r.key.name} was used in ${label}.`,
      facts: [
        { label: 'Calls', value: fmt(r.totals.calls) },
        {
          label: 'Error rate',
          value: `${errPct} (${fmt(r.totals.errors)} calls)`,
          tone: r.totals.error_rate > 0.05 ? 'warn' : undefined
        },
        {
          label: 'Rate-limited',
          value: fmt(r.totals.rate_limited),
          tone: r.totals.rate_limited > 0 ? 'warn' : undefined
        },
        { label: 'Refused (401 / 403)', value: fmt(r.totals.refused) },
        { label: 'Successful reads', value: fmt(r.totals.reads_ok) },
        { label: 'Successful writes', value: fmt(r.totals.writes_ok) },
        { label: 'Busiest routes', value: busiest || null },
        { label: 'GraphQL operations', value: ops || null },
        {
          label: 'Average response',
          value: r.totals.avg_ms == null ? null : `${fmt(r.totals.avg_ms)} ms`
        }
      ],
      action_url: `${(adminBaseUrl() ?? config.PUBLIC_URL).replace(/\/$/, '')}/api-keys`,
      action_label: 'Open API keys',
      footnote: r.retention.note ?? undefined,
      why: 'this API key is set to send its monthly usage statement to this address'
    }
  }
}

export interface StatementRun {
  month: string
  sent: number
  skipped: number
  would_send?: Array<{ key: string; to: string | null; calls: number; note: string | null }>
  failures: Array<{ key: string; error: string }>
}

export async function runUsageStatements(
  opts: { dryRun?: boolean; now?: Date; month?: string } = {}
): Promise<StatementRun> {
  const month = opts.month ?? previousMonth(opts.now)
  const run: StatementRun = { month, sent: 0, skipped: 0, failures: [] }
  if (opts.dryRun) run.would_send = []
  if (!(await hasColumn('nivaro_api_keys', 'usage_statement'))) return run

  const keys = (await db('nivaro_api_keys')
    .where({ usage_statement: true, is_active: true })
    .select('id', 'name', 'user', 'usage_contact', 'usage_statement_sent_for')) as KeyRow[]

  for (const k of keys) {
    if (k.usage_statement_sent_for === month) {
      run.skipped++
      continue
    }
    let to = k.usage_contact?.trim() || null
    if (!to && k.user) {
      const owner = (await db('nivaro_users').where({ id: k.user }).first('email', 'status')) as
        | { email: string | null; status: string | null }
        | undefined
      if (owner?.email && owner.status !== 'suspended') to = owner.email
    }
    const report = await keyUsage(Number(k.id), month)
    if (!report) {
      run.skipped++
      continue
    }
    if (opts.dryRun) {
      run.would_send?.push({
        key: k.name,
        to,
        calls: report.totals.calls,
        note: to ? report.retention.note : 'No contact — set a usage contact or an owner email'
      })
      continue
    }
    if (!to) {
      run.failures.push({ key: k.name, error: 'No usage contact and the owner has no email' })
      continue
    }
    try {
      const mail = buildUsageStatementMail(report)
      const res = await sendMail({
        to,
        subject: mail.subject,
        template: mail.template,
        data: mail.data,
        category: 'integrations',
        cadence: 'sender',
        collection: 'nivaro_api_keys',
        item: String(k.id),
        why: mail.data.why as string
      })
      if (res.status !== 'sent' && res.status !== 'deferred')
        throw new Error(
          res.status === 'unconfigured'
            ? 'mail is not configured on this instance'
            : res.status === 'dropped'
              ? 'mail test mode dropped the message'
              : 'the mail server refused the message'
        )
      await db('nivaro_api_keys').where({ id: k.id }).update({ usage_statement_sent_for: month })
      run.sent++
    } catch (err) {
      run.failures.push({ key: k.name, error: (err as Error).message })
    }
  }
  return run
}
