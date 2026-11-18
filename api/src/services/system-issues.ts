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
  return {
    source: 'server',
    route: 'deadlock-sweep',
    severity: 'high',
    message: `SQL deadlock at ${new Date(occurredAt).toISOString()}${stmt ? ` — victim statement: ${stmt}` : ''}`,
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
