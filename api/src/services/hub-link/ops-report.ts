import { createHash } from 'node:crypto'
import type { Knex } from 'knex'
import { db } from '../../db/index.js'
import { NIVARO_VERSION } from '../../version.js'
import { parseCrashMeta, scrubCrashText } from '../crash-signature.js'
import { selectInChunks, whereInList } from '../db-batch.js'
import { messageOfIssue } from '../error-clusters.js'

/**
 * Hub operations (enhancements 10 + 20), app side: the aggregates a Nivaro Hub may read about
 * this app over its link — routes/hub-ops-link.ts serves them on a dedicated app (hub link,
 * bearer = HUB_TOKEN) and, inside the app's tenant, on a Hub shared deployment (deployment link).
 *
 *  - `issueRollup`: issue-log and crash GROUPS (nivaro_issues rows of source server | client):
 *    a cross-app signature, a scrubbed title, severity, status, hit count, how MANY people hit it,
 *    the release, first / last seen and the row id (the Hub links to /issues/<id> here). Never a
 *    stack, a request context, a record value, a person's id or name, an email or a screenshot.
 *    Issues people file by hand (source manual) are left out: their titles are free text.
 *  - `filesUsage`: how many stored files this app has and their bytes (nivaro_files), per
 *    storage kind. Counts only, never a file name.
 *
 * Read with whatever knex the caller passes (the tenant's on a shared deployment).
 */

export const ISSUE_ROLLUP_CAP = 500
export const ISSUE_ROLLUP_DAYS_MAX = 90

export type IssueGroupKind = 'crash' | 'server'

export interface IssueGroup {
  /** Cross-app signature (40 hex): the same bug in two apps carries the same one. */
  sig: string
  kind: IssueGroupKind
  /** Scrubbed message, ≤ 200 characters. */
  title: string
  severity: string
  status: string
  count: number
  /** How many different people hit it (a count, never who). */
  people: number
  release: string | null
  /** The route pattern for a crash, null for a server issue. */
  screen: string | null
  first_seen: string | null
  last_seen: string | null
  /** The issue row here (the Hub links to /issues/<id>). */
  issue_id: number
}

export interface IssueRollup {
  version: string
  window_days: number
  generated_at: string
  truncated: boolean
  groups: IssueGroup[]
}

export interface FilesUsage {
  version: string
  generated_at: string
  files: number
  bytes: number
  /** Per storage kind (local, s3, azure …): counts and bytes only. */
  by_storage: Array<{ storage: string; files: number; bytes: number }>
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex')

function num(v: unknown): number {
  const n = Number(v)
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0
}

function iso(v: unknown): string | null {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/**
 * A title the Hub may show: secrets, emails, opaque strings and quoted values gone
 * (scrubCrashText; here also a quoted capitalised word), and digit runs of 4 or more (record
 * ids, amounts) replaced by `#`.
 */
export function hubSafeTitle(text: string | null | undefined): string {
  const scrubbed = scrubCrashText(text, 600)
    .replace(/\d{4,}/g, '#')
    // Stricter than the issue log: a quoted word that does not look like code ('find', "rows.x")
    // goes too — a capitalised one may be a name ("Jane").
    .replace(/(["'`])([^"'`\n]{0,300})\1/g, (m, q: string, inner: string) =>
      inner === '' || /^[a-z_$][\w$.-]{0,59}$/.test(inner) ? m : `${q}…${q}`
    )
  const one = scrubbed.replace(/\s+/g, ' ').trim()
  return (one || 'Untitled').slice(0, 200)
}

/** The cross-app signature of one issue row. */
export function issueSignature(row: {
  source: string
  fingerprint?: string | null
  title?: string | null
  details?: string | null
}): { sig: string; kind: IssueGroupKind } {
  if (row.source === 'client') {
    const meta = parseCrashMeta(row.details ?? null)
    const key = meta ? meta.family || meta.signature : ''
    if (meta && key) return { kind: 'crash', sig: sha(`crash|${meta.app}|${key}`).slice(0, 40) }
    return {
      kind: 'crash',
      sig: sha(`crash|title|${hubSafeTitle(row.title)}`).slice(0, 40)
    }
  }
  const fp = typeof row.fingerprint === 'string' ? row.fingerprint.trim() : ''
  if (/^[a-f0-9]{16,128}$/i.test(fp))
    return { kind: 'server', sig: sha(`server|${fp.toLowerCase()}`).slice(0, 40) }
  return { kind: 'server', sig: sha(`server|title|${hubSafeTitle(row.title)}`).slice(0, 40) }
}

/** Issue and crash groups seen in the last `days` days, newest first, at most ISSUE_ROLLUP_CAP. */
export async function issueRollup(
  opts: { days?: number } = {},
  k: Knex = db
): Promise<IssueRollup> {
  const days = Math.min(ISSUE_ROLLUP_DAYS_MAX, Math.max(1, Math.round(Number(opts.days) || 30)))
  const since = new Date(Date.now() - days * 86_400_000)
  const empty: IssueRollup = {
    version: NIVARO_VERSION,
    window_days: days,
    generated_at: new Date().toISOString(),
    truncated: false,
    groups: []
  }
  if (!(await k.schema.hasTable('nivaro_issues'))) return empty
  const rows = (await k('nivaro_issues')
    .whereIn('source', ['server', 'client'])
    .where((w) => {
      void w
        .where('last_seen_at', '>=', since)
        .orWhere((x) => void x.whereNull('last_seen_at').where('created_at', '>=', since))
    })
    .orderBy('last_seen_at', 'desc')
    .orderBy('id', 'desc')
    .limit(ISSUE_ROLLUP_CAP + 1)
    .select(
      'id',
      'title',
      'source',
      'status',
      'severity',
      'fingerprint',
      'occurrence_count',
      'created_at',
      'last_seen_at',
      'raised_by',
      // Only the header lines are read (Route / Crash); the stack never leaves this function.
      k.raw('SUBSTRING(details, 1, 600) as details')
    )) as Array<Record<string, unknown>>
  const truncated = rows.length > ISSUE_ROLLUP_CAP
  const issues = rows.slice(0, ISSUE_ROLLUP_CAP)
  const ids = issues.map((r) => Number(r.id))

  const people = new Map<number, Set<string>>()
  const builds = new Map<number, string>()
  if (ids.length && (await k.schema.hasTable('nivaro_issue_occurrences'))) {
    const occ = (await selectInChunks(ids, 500, (chunk) =>
      whereInList(k('nivaro_issue_occurrences'), 'issue', chunk).select('issue', 'user_id', 'build')
    ).catch(() => [])) as Array<{ issue: number; user_id: string | null; build: string | null }>
    for (const o of occ) {
      const id = Number(o.issue)
      const set = people.get(id) ?? new Set<string>()
      if (o.user_id) set.add(String(o.user_id).toLowerCase())
      people.set(id, set)
      if (o.build && !builds.has(id)) builds.set(id, String(o.build).slice(0, 64))
    }
  }
  for (const r of issues) {
    if (!r.raised_by) continue
    const id = Number(r.id)
    const set = people.get(id) ?? new Set<string>()
    set.add(String(r.raised_by).toLowerCase())
    people.set(id, set)
  }

  const groups: IssueGroup[] = issues.map((r) => {
    const id = Number(r.id)
    const source = String(r.source ?? 'server')
    const details = (r.details as string | null) ?? null
    const { sig, kind } = issueSignature({
      source,
      fingerprint: (r.fingerprint as string | null) ?? null,
      title: (r.title as string | null) ?? null,
      details
    })
    const meta = kind === 'crash' ? parseCrashMeta(details) : null
    const { route, message } = messageOfIssue({ title: String(r.title ?? ''), source })
    const release = meta?.release && meta.release !== 'unknown' ? meta.release : builds.get(id)
    return {
      sig,
      kind,
      title: hubSafeTitle(kind === 'crash' ? message : String(r.title ?? '')),
      severity: String(r.severity ?? 'medium').slice(0, 20),
      status: String(r.status ?? 'open').slice(0, 20),
      count: Math.max(1, num(r.occurrence_count)),
      people: people.get(id)?.size ?? 0,
      release: release ? String(release).slice(0, 64) : null,
      // A crash's route is a pattern (`/collections/:id`), never an id.
      screen: kind === 'crash' && route !== 'unknown' ? hubSafeTitle(route) : null,
      first_seen: iso(r.created_at),
      last_seen: iso(r.last_seen_at ?? r.created_at),
      issue_id: id
    }
  })
  return { ...empty, truncated, groups }
}

/** Stored files of this app: count and bytes, per storage kind. */
export async function filesUsage(k: Knex = db): Promise<FilesUsage> {
  const out: FilesUsage = {
    version: NIVARO_VERSION,
    generated_at: new Date().toISOString(),
    files: 0,
    bytes: 0,
    by_storage: []
  }
  if (!(await k.schema.hasTable('nivaro_files'))) return out
  const rows = (await k('nivaro_files')
    .groupBy('storage')
    .select('storage')
    .count({ n: '*' })
    .sum({ b: 'filesize' })) as Array<{ storage?: unknown; n?: unknown; b?: unknown }>
  for (const r of rows) {
    const storage = String(r.storage ?? 'local').slice(0, 40) || 'local'
    const files = num(r.n)
    const bytes = num(r.b)
    out.files += files
    out.bytes += bytes
    out.by_storage.push({ storage, files, bytes })
  }
  out.by_storage.sort((a, b) => b.bytes - a.bytes)
  return out
}
