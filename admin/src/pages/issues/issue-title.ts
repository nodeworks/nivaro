/**
 * An issue title, read for people. Stored titles are machine-shaped:
 *
 *   [server] GET /api/items/:collection/aggregate: select SUM(...) from [workflows] … - Timeout: …
 *   [server] cron/watchdog: Cron "outside-write-watch" tick skipped — the previous tick …
 *   [server] deadlock-sweep: SQL deadlock at 2026-11-14T12:39:15Z — victim statement: Proc …
 *   [client] /collections/project_types/5: nn.find is not a function
 *   A server error on GET /api/items/:collection        (what a non-admin is sent)
 *   Rollup drift: units.total_unit_cost (1/500 rows stale)   (manual / other)
 *
 * The list shows the headline (what went wrong, in words), where it happened (route, job or
 * screen) and the source; SQL and other machine text move to `technical` for the detail panel.
 */

export type IssueSource = 'server' | 'client' | 'manual'

export interface IssueHeadline {
  /** The [server]/[client] prefix, when the title carried one. */
  source: IssueSource | null
  /** Route, job or screen the issue came from ("GET /api/items/:collection", "cron/watchdog"). */
  where: string | null
  /** What went wrong, in words — never SQL. */
  headline: string
  /** Machine text the headline left out (a SQL statement, a deadlock victim), for the detail. */
  technical: string | null
}

const PREFIX = /^\s*\[(server|client)\]\s+/i
// "GET /api/x: ", "/collections/a/5: ", "cron/watchdog: ", "deadlock-sweep: ", "database: "
const WHERE = /^((?:[A-Z]{3,7}\s+)?\/\S*|[a-z][\w.-]*(?:\/[\w.:-]+)*):\s+/
const VIEWER_SERVER = /^A server error on\s+(.+)$/
const SQL_START =
  /^\s*\(?\s*(select|insert|update|delete|merge|exec(?:ute)?|with|create|alter|drop|declare)\b/i
const MACHINE_TAIL = /(statement:|select\s|insert\s|update\s|delete\s|\(@p\d)/i

function sentence(text: string): string {
  const t = text.trim().replace(/\s+/g, ' ')
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t
}

/** The driver's own words after a SQL statement ("… - Timeout: Request failed …"). */
function sqlMessage(sql: string): string | null {
  const i = sql.lastIndexOf(' - ')
  if (i < 0) return null
  const msg = sql.slice(i + 3).trim()
  return msg && !SQL_START.test(msg) ? msg : null
}

export function parseIssueTitle(title: string | null | undefined): IssueHeadline {
  let rest = String(title ?? '').trim()
  let source: IssueSource | null = null
  const p = PREFIX.exec(rest)
  if (p) {
    source = p[1].toLowerCase() as IssueSource
    rest = rest.slice(p[0].length)
  }

  const viewer = VIEWER_SERVER.exec(rest)
  if (viewer)
    return { source: 'server', where: viewer[1], headline: 'A server error', technical: null }

  let where: string | null = null
  const w = WHERE.exec(rest)
  if (w && (source || w[1].startsWith('/') || /^[A-Z]{3,7}\s/.test(w[1]))) {
    where = w[1]
    rest = rest.slice(w[0].length)
  }

  // Only a machine-shaped title (a [server]/[client] prefix or a route/job in front) is read as
  // SQL or split at a statement: a person's title ("Update the Need by Date …", from GitLab or
  // raised by hand) starting with a SQL word stays as written.
  const machine = source != null || where != null

  if (machine && SQL_START.test(rest)) {
    const msg = sqlMessage(rest)
    return {
      source,
      where,
      headline: msg ? sentence(msg) : 'A database query failed',
      technical: rest
    }
  }

  const dash = rest.indexOf(' — ')
  if (machine && dash > 0 && MACHINE_TAIL.test(rest.slice(dash + 3))) {
    return {
      source,
      where,
      headline: sentence(rest.slice(0, dash)),
      technical: rest.slice(dash + 3).trim()
    }
  }

  return { source, where, headline: sentence(rest) || 'Untitled issue', technical: null }
}
