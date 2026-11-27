/**
 * Registry scans the vulnerability answer carries in `repositories` (Task 33: one entry per
 * managed Amazon ECR repository, `source: 'ecr'`). The screen never hard-codes a source: every
 * entry there with a `source` key becomes one row, grouped by source, with whatever severity
 * counts it carries (under `counts` or at the top level). Snyk is NOT read here: the answer's
 * `snyk` list (Task 43, per connection) has its own card, HubSnykFindings. Pure, tested without
 * a page.
 */

export interface SourceCount {
  severity: string
  n: number
}

export interface SourceRow {
  /** Stable React key. */
  key: string
  source: string
  name: string
  app_id: number | null
  environment_id: number | null
  /** A short image reference or "N projects", when the entry says. */
  detail: string | null
  /** The name is a code-like identifier (a repository), shown in monospace. */
  mono: boolean
  /** When the scanned thing was pushed or read. */
  at: string | null
  /** What `at` is: 'pushed' (an image) or 'read' (a scan read). */
  atWord: 'pushed' | 'read'
  status: string | null
  /** Severity counts above zero, worst first; null = the source gave no counts. */
  counts: SourceCount[] | null
  fixable: number | null
  error: string | null
}

const SEVERITY_ORDER = [
  'critical',
  'high',
  'medium',
  'low',
  'informational',
  'undefined',
  'unknown'
]
const SEVERITY_KEYS = new Set(SEVERITY_ORDER)

export const SOURCE_LABEL: Record<string, string> = {
  ecr: 'Amazon ECR',
  snyk: 'Snyk'
}

export const sourceLabel = (s: string) =>
  SOURCE_LABEL[s] ?? s.replace(/[-_]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase())

export const SEVERITY_WORD: Record<string, string> = {
  critical: 'critical',
  high: 'high',
  medium: 'medium',
  low: 'low',
  informational: 'info',
  undefined: 'unrated',
  unknown: 'unknown'
}

export const severityTone = (s: string): 'bad' | 'warn' | 'neutral' =>
  s === 'critical' || s === 'high' ? 'bad' : s === 'medium' ? 'warn' : 'neutral'

/** ECR's scan states in words; any other value is shown as it comes, lower-cased. */
const STATUS_WORD: Record<string, string> = {
  COMPLETE: 'Scanned',
  ACTIVE: 'Scanned',
  IN_PROGRESS: 'Scanning',
  PENDING: 'Waiting to scan',
  FAILED: 'Scan failed',
  UNSUPPORTED_IMAGE: 'Image type not scanned',
  FINDINGS_UNAVAILABLE: 'Findings not available',
  SCAN_ELIGIBILITY_EXPIRED: 'No longer scanned',
  LIMIT_EXCEEDED: 'Scan limit reached'
}

export const statusWords = (s: string | null) =>
  s ? (STATUS_WORD[s] ?? s.replace(/_/g, ' ').toLowerCase()) : null

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null)
const int = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : null)

function countsOf(e: Record<string, unknown>): SourceCount[] | null {
  const from = isRecord(e.counts) ? e.counts : e
  let any = isRecord(e.counts)
  const out: SourceCount[] = []
  for (const [k, v] of Object.entries(from)) {
    // At the top level only severity names count (an entry also holds ids and names).
    if (!isRecord(e.counts) && !SEVERITY_KEYS.has(k)) continue
    const n = int(v)
    if (n == null) continue
    any = true
    if (n > 0) out.push({ severity: k, n })
  }
  const rank = (s: string) => {
    const i = SEVERITY_ORDER.indexOf(s)
    return i < 0 ? SEVERITY_ORDER.length : i
  }
  out.sort((a, b) => rank(a.severity) - rank(b.severity) || a.severity.localeCompare(b.severity))
  return any ? out : null
}

function detailOf(e: Record<string, unknown>): string | null {
  const image = str(e.image)
  const digest = str(e.digest)
  if (image) return digest && !image.includes('@') ? `${image}@${digest.slice(0, 19)}` : image
  if (digest) return digest.slice(0, 19)
  const projects = int(e.projects)
  if (projects != null) return `${projects} project${projects === 1 ? '' : 's'}`
  return null
}

/** Every source entry of a vulnerability answer, as rows. */
export function sourceRows(answer: unknown): SourceRow[] {
  if (!isRecord(answer)) return []
  const list = Array.isArray(answer.repositories) ? (answer.repositories as unknown[]) : []
  const rows: SourceRow[] = []
  for (const raw of list) {
    if (!isRecord(raw)) continue
    const source = str(raw.source)
    if (!source) continue
    const id = int(raw.resource_id) ?? int(raw.id) ?? int(raw.connection_id)
    const name =
      str(raw.name) ?? str(raw.label) ?? str(raw.connection_name) ?? (id ? `#${id}` : source)
    rows.push({
      key: `${source}:${id ?? name}:${rows.length}`,
      source,
      name,
      app_id: int(raw.app_id),
      environment_id: int(raw.environment_id),
      detail: detailOf(raw),
      mono: !!str(raw.image) || !!str(raw.digest) || raw.source === 'ecr',
      at: str(raw.pushed_at) ?? str(raw.checked_at) ?? str(raw.read_at),
      atWord: str(raw.pushed_at) ? 'pushed' : 'read',
      status: str(raw.scan_status) ?? str(raw.status),
      counts: countsOf(raw),
      fixable: int(raw.fixable),
      error: str(raw.error)
    })
  }
  return rows
}

/** Rows grouped by source, in the order sources first appear. */
export function bySource(rows: SourceRow[]): Array<{ source: string; rows: SourceRow[] }> {
  const out: Array<{ source: string; rows: SourceRow[] }> = []
  for (const r of rows) {
    const g = out.find((x) => x.source === r.source)
    if (g) g.rows.push(r)
    else out.push({ source: r.source, rows: [r] })
  }
  return out
}

/** Rows whose counts hold a critical or high finding. */
export const urgentRows = (rows: SourceRow[]) =>
  rows.filter((r) => r.counts?.some((c) => c.severity === 'critical' || c.severity === 'high'))

/** The card's one-line summary: what is urgent, what could not be read, where it came from. */
export function scanSummary(rows: SourceRow[]): string {
  const read = rows.filter((r) => !r.error && r.counts != null)
  const urgent = urgentRows(rows).length
  const unread = rows.filter((r) => r.error).length
  const names = bySource(rows)
    .map((g) => sourceLabel(g.source))
    .join(' and ')
  return [
    urgent
      ? `${urgent} of ${rows.length} with critical or high findings.`
      : read.length
        ? `Nothing critical or high in the ${read.length} read.`
        : '',
    unread === rows.length
      ? 'None could be read: see why below.'
      : unread
        ? `${unread} could not be read.`
        : '',
    `Read live from ${names} through their connections.`
  ]
    .filter(Boolean)
    .join(' ')
}
