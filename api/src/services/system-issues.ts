/**
 * The system issues whose message carries a time, count or id list, built in one place so the
 * message (which services/issue-readable.ts parses into a readable title) and the stable key it
 * groups by (`stableIssueKey`) stay together. Each repeat bumps the open issue and refreshes its
 * details to the latest occurrence (trackError `refreshDetails`). The messages are unchanged from
 * what these writers always stored.
 */
import { normalizeIssueText, stableIssueKey, type trackError } from './error-tracking.js'

type IssueOpts = Parameters<typeof trackError>[0]

/** A scheduled job that missed its run: one issue per job, whatever time it was due. */
export function cronMissIssue(m: {
  id: string
  expected_at: string
  last_run_at: string | null
}): IssueOpts {
  return {
    source: 'server',
    route: 'cron/miss',
    message: `Cron "${m.id}" missed its expected run at ${m.expected_at}${m.last_run_at ? ` (last ran ${m.last_run_at})` : ' (never recorded)'}`,
    severity: 'medium',
    fingerprint: stableIssueKey('cron-miss', m.id),
    refreshDetails: true
  }
}

/** The first `<inputbuf>` of a deadlock graph (the statement the message names). */
function inputBuffer(xml: string): string | null {
  return xml.match(/<inputbuf>([\s\S]*?)<\/inputbuf>/)?.[1]?.trim() || null
}

interface DeadlockProcess {
  id: string
  trancount: number
  clientapp: string
  transaction: string
  inputbuf: string
}

function deadlockProcesses(xml: string): DeadlockProcess[] {
  const out: DeadlockProcess[] = []
  const re = /<process\s+id="([^"]+)"([^>]*)>([\s\S]*?)<\/process>/g
  for (let m = re.exec(xml); m; m = re.exec(xml)) {
    const attrs = m[2]
    out.push({
      id: m[1],
      trancount: Number(/\btrancount="(\d+)"/.exec(attrs)?.[1] ?? '1'),
      clientapp: /\bclientapp="([^"]*)"/.exec(attrs)?.[1]?.replace(/\u200b/g, '') ?? '',
      transaction: /\btransactionname="([^"]*)"/.exec(attrs)?.[1] ?? '',
      inputbuf: (/<inputbuf>([\s\S]*?)<\/inputbuf>/.exec(m[3])?.[1] ?? '').trim()
    })
  }
  return out
}

/** True when every victim was a plain read outside a transaction (SELECT / WITH, trancount 0). */
export function victimsOnlyRead(xml: string): boolean {
  const victims = [...xml.matchAll(/<victimProcess\s+id="([^"]+)"/g)].map((m) => m[1])
  if (victims.length === 0) return false
  const byId = new Map(deadlockProcesses(xml).map((p) => [p.id, p]))
  return victims.every((id) => {
    const p = byId.get(id)
    if (!p || p.trancount > 0) return false
    return /^(select|with)\b/i.test(p.inputbuf.replace(/^[\s;(]+/, ''))
  })
}

/** Who the victims lost to (the non-victim's client app, e.g. a SQL Agent job), or null. */
function otherParty(xml: string): string | null {
  const victims = new Set([...xml.matchAll(/<victimProcess\s+id="([^"]+)"/g)].map((m) => m[1]))
  const other = deadlockProcesses(xml).find((p) => !victims.has(p.id))
  if (!other?.clientapp) return null
  const app = /^SQLAgent\b/i.test(other.clientapp)
    ? 'a SQL Server Agent job'
    : other.clientapp.replace(/@[\w.-]+$/, '').slice(0, 60)
  // The other side's transaction says what it was doing (ALTER INDEX = index maintenance).
  const what = /^(ALTER INDEX|UPDATE STATISTICS|DBCC\b.*)$/i.test(other.transaction)
    ? ` (${other.transaction})`
    : ''
  return `${app}${what}`
}

/**
 * A deadlock from the hourly sweep: one issue per statement shape (literals, numbers, times and
 * whitespace taken out of the whole input buffer), whenever it happened. A graph with no
 * statement groups with the others that have none.
 */
export function deadlockIssue(
  occurredAt: Date | string,
  graph: string | null | undefined
): IssueOpts {
  const xml = String(graph ?? '')
  const buf = inputBuffer(xml)
  const stmt = buf?.slice(0, 200)
  const reads = victimsOnlyRead(xml)
  const other = reads ? otherParty(xml) : null
  return {
    source: 'server',
    route: 'deadlock-sweep',
    // Only a read lost (a background check, a list) and it is simply asked again: nobody's
    // save was cancelled. A write that lost stays high.
    severity: reads ? 'low' : 'high',
    message: `SQL deadlock at ${new Date(occurredAt).toISOString()}${reads ? ' (only reads lost)' : ''}${stmt ? ` — victim statement: ${stmt}` : ''}${other ? ` — other side: ${other}` : ''}`,
    stack: xml.slice(0, 8000),
    fingerprint: stableIssueKey('deadlock', normalizeIssueText(buf, 1000)),
    refreshDetails: true
  }
}

/**
 * Runs a restart left `running`. ONE open issue for the kind, not one per job set: each restart
 * interrupts whatever happened to be running, so a key per set would almost never repeat (and so
 * never group), while the thing to do is the same every time — re-run what matters. The count is
 * how many restarts interrupted work; the details name the latest restart's jobs, and every run
 * stays `interrupted` in the job runs log.
 */
export function restartImpactIssue(jobIds: string[], interrupted: number): IssueOpts {
  return {
    source: 'server',
    route: 'restart-impact',
    severity: 'medium',
    message: `Restart interrupted ${interrupted} running job(s): ${[...new Set(jobIds)].slice(0, 10).join(', ')} — re-run the ones that matter from /background-jobs`,
    fingerprint: stableIssueKey('restart-impact'),
    refreshDetails: true
  }
}
