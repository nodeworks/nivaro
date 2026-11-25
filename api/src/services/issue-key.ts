/**
 * Issue grouping keys with no imports beyond node:crypto (the cron plugin imports this at load
 * time; services/error-tracking.ts re-exports it next to issueFingerprint).
 */
import { createHash } from 'node:crypto'

/**
 * The ONE rule for a system issue whose message carries volatile text — times, counts, ids,
 * durations (a missed cron run names its due time, a deadlock its time, a rollup drift its stale
 * count). Grouping those by `source|route|message` opened a new issue on every occurrence; the
 * writer passes `fingerprint: stableIssueKey(kind, ...what stays the same)` instead (the job id,
 * the normalised statement, `collection.field` …) with `refreshDetails: true`, so a repeat
 * bumps the open issue's count and its details show the LATEST occurrence.
 *
 * sha256 of `kind|part|part…` (null/undefined parts read as ''). That is exactly the key rollup
 * drift always used (`rollup-drift|<collection>|<field>`), so its open issues keep grouping.
 * `kind` is a name of its own ('cron-miss', 'deadlock' …), never 'server' / 'client', so a
 * stable key never meets an issueFingerprint.
 */
export function stableIssueKey(
  kind: string,
  ...parts: Array<string | number | null | undefined>
): string {
  return createHash('sha256')
    .update([kind, ...parts.map((p) => (p == null ? '' : String(p)))].join('|'))
    .digest('hex')
}

const XML_ENTITIES: Record<string, string> = {
  apos: "'",
  quot: '"',
  lt: '<',
  gt: '>',
  amp: '&'
}

/**
 * Text with what changes between occurrences taken out, for a stable key: XML entities read
 * back, quoted literals (`'…'`, `N'…'`), GUIDs, ISO times, hex and numbers become `?`, runs of
 * whitespace one space, lower case, first `max` characters. Two runs of the same statement or
 * the same error with other values read the same.
 */
export function normalizeIssueText(text: string | null | undefined, max = 300): string {
  return String(text ?? '')
    .replace(/&(apos|quot|lt|gt|amp);/gi, (_, e: string) => XML_ENTITIES[e.toLowerCase()] ?? ' ')
    .replace(/&#x?[0-9a-f]+;/gi, ' ')
    .replace(/(?:\bN)?'(?:[^']|'')*'/g, '?')
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '?')
    .replace(/\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '?')
    .replace(/\b0x[0-9a-f]+\b/gi, '?')
    .replace(/\b\d+(?:\.\d+)?\b/g, '?')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
    .slice(0, max)
}

const DB_TIMEOUT_RE = /^([\s\S]+?) - Timeout: Request failed to complete in (\d+)ms/

/**
 * A server error that is the database driver's request timeout on one statement
 * (`<sql> - Timeout: Request failed to complete in 15000ms`): the statement as written and
 * its normalised form (the grouping key), else null. Every route that runs the same statement
 * while the database cannot answer is ONE problem — EFP production's daily replication snapshot
 * timed out the sign-in read on 35 routes in one second and filed 35 issues (2026-11-25).
 */
export function dbTimeoutStatement(
  message: string | null | undefined
): { sql: string; key: string; ms: number } | null {
  const m = DB_TIMEOUT_RE.exec(String(message ?? '').trim())
  if (!m) return null
  const sql = m[1].trim()
  const key = normalizeIssueText(sql)
  return key ? { sql, key, ms: Number(m[2]) } : null
}
