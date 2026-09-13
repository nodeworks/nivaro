/**
 * Mail delivery board (#9): the outbound mail log rolled up per day, per
 * template and per recipient over a window. Pure aggregation over
 * `nivaro_mail_log` rows so the shape is unit-testable without a database;
 * the route feeds it rows and the mail-type registry's labels.
 *
 * "Bounces" here are addresses whose LATEST attempt in the window failed —
 * the log stores the SMTP error text, not a bounce classification, so the
 * board names the error rather than guessing at a hard/soft split.
 */

export type MailStatus = 'sent' | 'failed' | 'dropped' | 'deferred'

export interface MailLogRow {
  to: string
  status: MailStatus | string
  template: string | null
  error: string | null
  created_at: Date | string
}

export interface StatusCounts {
  sent: number
  failed: number
  dropped: number
  deferred: number
}

export interface MailStats {
  days: number
  totals: StatusCounts & { total: number; success_rate: number | null }
  series: Array<{ day: string } & StatusCounts>
  by_template: Array<
    {
      template: string
      label: string | null
      total: number
      failure_rate: number | null
      last_failure_at: string | null
      last_error: string | null
    } & StatusCounts
  >
  top_recipients: Array<{ email: string; total: number; failed: number }>
  failures: Array<{ error: string; count: number; last_at: string; recipients: string[] }>
  bounces: Array<{ email: string; failures: number; last_error: string | null; last_at: string }>
}

export const UNTEMPLATED = '(untemplated)'

const zero = (): StatusCounts => ({ sent: 0, failed: 0, dropped: 0, deferred: 0 })
const bump = (c: StatusCounts, status: string) => {
  if (status in c) c[status as MailStatus]++
}
const dayKey = (d: Date | string) => {
  const dt = new Date(d)
  return Number.isNaN(dt.getTime()) ? 'unknown' : dt.toISOString().slice(0, 10)
}
const iso = (d: Date | string) => {
  const dt = new Date(d)
  return Number.isNaN(dt.getTime()) ? String(d) : dt.toISOString()
}
const addresses = (to: string) => [
  ...new Set(
    String(to)
      .split(/[,;\s]+/)
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.includes('@'))
  )
]

/** Collapse an SMTP error to its stable head: strip addresses, ids, quoted
 *  bits and long numerics so "550 5.1.1 <a@x>: mailbox unavailable" and the
 *  same for b@y land in one bucket. */
export function normalizeError(error: string | null | undefined): string {
  if (!error) return '(no error text)'
  return (
    String(error)
      .replace(/<[^>]*@[^>]*>/g, '<address>')
      .replace(/[\w.+-]+@[\w.-]+\.\w+/g, '<address>')
      .replace(/https?:\/\/\S+/g, '<url>')
      // Gmail / Google Workspace session stamps ("… a1b2c3-20020a…sm123 - gsmtp").
      .replace(/\S+(?:\s*-\s*)?gsmtp\b/g, '<session> gsmtp')
      .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '<id>')
      .replace(/\b\d{6,}\b/g, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || '(no error text)'
  )
}

export function aggregateMailStats(
  rows: MailLogRow[],
  opts: { days: number; now?: Date; labelFor?: (template: string) => string | null }
): MailStats {
  const now = opts.now ?? new Date()
  const totals = zero()
  const byDay = new Map<string, StatusCounts>()
  // Every day of the window gets a bucket so the chart never skips quiet days.
  for (let i = opts.days - 1; i >= 0; i--) {
    byDay.set(dayKey(new Date(now.getTime() - i * 86_400_000)), zero())
  }
  const byTemplate = new Map<
    string,
    StatusCounts & { last_failure_at: string | null; last_error: string | null }
  >()
  const byRecipient = new Map<
    string,
    { total: number; failed: number; last: { status: string; at: string; error: string | null } }
  >()
  const byError = new Map<string, { count: number; last_at: string; recipients: Set<string> }>()

  for (const r of rows) {
    const status = String(r.status)
    bump(totals, status)
    const day = byDay.get(dayKey(r.created_at))
    if (day) bump(day, status)

    const tpl = r.template?.trim() || UNTEMPLATED
    let t = byTemplate.get(tpl)
    if (!t) {
      t = { ...zero(), last_failure_at: null, last_error: null }
      byTemplate.set(tpl, t)
    }
    bump(t, status)
    const at = iso(r.created_at)
    if (status === 'failed' && (!t.last_failure_at || at > t.last_failure_at)) {
      t.last_failure_at = at
      t.last_error = r.error ? String(r.error).slice(0, 300) : null
    }

    const addrs = addresses(r.to)
    for (const email of addrs) {
      let rec = byRecipient.get(email)
      if (!rec) {
        rec = { total: 0, failed: 0, last: { status, at, error: r.error ?? null } }
        byRecipient.set(email, rec)
      }
      rec.total++
      if (status === 'failed') rec.failed++
      if (at >= rec.last.at) rec.last = { status, at, error: r.error ?? null }
    }

    if (status === 'failed') {
      const key = normalizeError(r.error)
      let e = byError.get(key)
      if (!e) {
        e = { count: 0, last_at: at, recipients: new Set() }
        byError.set(key, e)
      }
      e.count++
      if (at > e.last_at) e.last_at = at
      for (const a of addrs) if (e.recipients.size < 8) e.recipients.add(a)
    }
  }

  const attempted = totals.sent + totals.failed
  const rate = (sent: number, failed: number) =>
    sent + failed > 0 ? Math.round((sent / (sent + failed)) * 1000) / 10 : null

  return {
    days: opts.days,
    totals: {
      ...totals,
      total: totals.sent + totals.failed + totals.dropped + totals.deferred,
      success_rate: attempted > 0 ? rate(totals.sent, totals.failed) : null
    },
    series: [...byDay.entries()].map(([day, c]) => ({ day, ...c })),
    by_template: [...byTemplate.entries()]
      .map(([template, c]) => ({
        template,
        label: template === UNTEMPLATED ? null : (opts.labelFor?.(template) ?? null),
        sent: c.sent,
        failed: c.failed,
        dropped: c.dropped,
        deferred: c.deferred,
        total: c.sent + c.failed + c.dropped + c.deferred,
        failure_rate:
          c.sent + c.failed > 0 ? Math.round((c.failed / (c.sent + c.failed)) * 1000) / 10 : null,
        last_failure_at: c.last_failure_at,
        last_error: c.last_error
      }))
      .sort((a, b) => b.total - a.total),
    top_recipients: [...byRecipient.entries()]
      .map(([email, r]) => ({ email, total: r.total, failed: r.failed }))
      .sort((a, b) => b.total - a.total || a.email.localeCompare(b.email))
      .slice(0, 15),
    failures: [...byError.entries()]
      .map(([error, e]) => ({
        error,
        count: e.count,
        last_at: e.last_at,
        recipients: [...e.recipients]
      }))
      .sort((a, b) => b.count - a.count || (a.last_at < b.last_at ? 1 : -1))
      .slice(0, 20),
    bounces: [...byRecipient.entries()]
      .filter(([, r]) => r.last.status === 'failed')
      .map(([email, r]) => ({
        email,
        failures: r.failed,
        last_error: r.last.error ? String(r.last.error).slice(0, 200) : null,
        last_at: r.last.at
      }))
      .sort((a, b) => b.failures - a.failures || (a.last_at < b.last_at ? 1 : -1))
      .slice(0, 25)
  }
}
