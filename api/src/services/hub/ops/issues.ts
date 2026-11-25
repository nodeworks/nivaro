import { db } from '../../../db/index.js'
import { chunkArray } from '../../db-batch.js'
import { hubSafeTitle, ISSUE_ROLLUP_CAP, safeRoute } from '../../hub-link/ops-report.js'
import { writeOpsHealth } from './health-row.js'
import { type LinkReadDeps, type OpsEnvTarget, opsTargets, readOps } from './link-read.js'

/**
 * Hub enhancement 10: the cross-app issue rollup.
 *
 * `collectIssues` reads every environment's issue / crash groups over its link
 * (hub-link/ops-report.ts on the app; link-read.ts) and REPLACES that environment's rows in
 * nivaro_hub_issue_groups. An environment that cannot be read keeps its last rows; its state is
 * on nivaro_hub_ops_health (`issues_state`, `issues_at`). The answer is re-checked here (shape,
 * lengths, the signature format) and the title scrubbed again — an app's answer is data.
 *
 * `listIssueGroups` folds rows by signature across environments: the same bug in 3 apps is one
 * line that says "3 apps". Admins see every environment; an app owner only the apps they own.
 */

export const ISSUE_GROUPS = 'nivaro_hub_issue_groups'
const SIG_RE = /^[a-f0-9]{40}$/
const SEVERITIES = new Set(['info', 'low', 'medium', 'warning', 'high', 'error', 'critical'])
const STATUSES = new Set(['open', 'acknowledged', 'resolved', 'closed', 'ignored'])
const SEV_RANK: Record<string, number> = {
  info: 0,
  low: 0,
  medium: 1,
  warning: 1,
  high: 2,
  error: 2,
  critical: 3
}

export interface StoredIssueGroup {
  environment_id: number
  kind: 'crash' | 'server'
  sig: string
  title: string
  severity: string | null
  status: string | null
  occurrences: number
  people: number
  release: string | null
  screen: string | null
  first_seen: Date | null
  last_seen: Date | null
  app_issue_id: number | null
}

const int = (v: unknown, max = 2_000_000_000): number => {
  const x = Number(v)
  return Number.isFinite(x) && x > 0 ? Math.min(max, Math.floor(x)) : 0
}
const date = (v: unknown): Date | null => {
  if (typeof v !== 'string') return null
  const d = new Date(v)
  return Number.isNaN(d.getTime()) ? null : d
}
const short = (v: unknown, max: number): string | null =>
  typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null

/** The groups of one app's answer that pass the checks; anything else is dropped. */
export function parseRollup(
  envId: number,
  body: unknown
): { groups: StoredIssueGroup[]; truncated: boolean } | null {
  const b = body as { groups?: unknown; truncated?: unknown } | null
  if (!b || typeof b !== 'object' || !Array.isArray(b.groups)) return null
  // One row per signature (the unique index): an older app may send a signature twice — fold.
  const bySig = new Map<string, StoredIssueGroup>()
  for (const raw of b.groups.slice(0, ISSUE_ROLLUP_CAP)) {
    const g = raw as Record<string, unknown> | null
    if (!g || typeof g !== 'object') continue
    const sig = typeof g.sig === 'string' ? g.sig.toLowerCase() : ''
    if (!SIG_RE.test(sig)) continue
    const kind = g.kind === 'crash' ? 'crash' : g.kind === 'server' ? 'server' : null
    if (!kind) continue
    const severity = short(g.severity, 20)?.toLowerCase() ?? null
    const status = short(g.status, 20)?.toLowerCase() ?? null
    const row: StoredIssueGroup = {
      environment_id: envId,
      kind,
      sig,
      title: hubSafeTitle(typeof g.title === 'string' ? g.title : ''),
      severity: severity && SEVERITIES.has(severity) ? severity : null,
      status: status && STATUSES.has(status) ? status : null,
      occurrences: int(g.count),
      people: int(g.people, 1_000_000),
      release: short(g.release, 64),
      screen: kind === 'crash' ? (short(g.screen, 200) ? safeRoute(String(g.screen)) : null) : null,
      first_seen: date(g.first_seen),
      last_seen: date(g.last_seen),
      app_issue_id: int(g.issue_id) || null
    }
    const had = bySig.get(sig)
    if (!had) {
      bySig.set(sig, row)
      continue
    }
    had.occurrences += row.occurrences
    // People of two rows may overlap: the larger count is the floor, never a sum.
    had.people = Math.max(had.people, row.people)
    if ((SEV_RANK[row.severity ?? ''] ?? -1) > (SEV_RANK[had.severity ?? ''] ?? -1))
      had.severity = row.severity
    if (row.first_seen && (!had.first_seen || row.first_seen < had.first_seen))
      had.first_seen = row.first_seen
    if (row.last_seen && (!had.last_seen || row.last_seen > had.last_seen)) {
      had.last_seen = row.last_seen
      had.title = row.title
      had.app_issue_id = row.app_issue_id
      had.status = row.status
    }
  }
  return { groups: [...bySig.values()], truncated: b.truncated === true }
}

/** Replace one environment's groups (one transaction; chunks keep under the parameter cap). */
export async function storeIssueGroups(envId: number, groups: StoredIssueGroup[]): Promise<void> {
  const at = new Date()
  await db.transaction(async (trx) => {
    await trx(ISSUE_GROUPS).where({ environment_id: envId }).del()
    for (const part of chunkArray(groups, 100))
      await trx(ISSUE_GROUPS).insert(part.map((g) => ({ ...g, collected_at: at })))
  })
}

export interface CollectSummary {
  environments: number
  read: number
  failed: number
}

async function eachLimited<T>(items: T[], width: number, fn: (t: T) => Promise<void>) {
  let i = 0
  const worker = async () => {
    while (i < items.length) {
      const item = items[i++]
      await fn(item)
    }
  }
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, worker))
}

/** Read every (or the named) environment's issue groups and store them. Never throws per env. */
export async function collectIssues(
  opts: { envIds?: number[]; targets?: OpsEnvTarget[]; deps?: LinkReadDeps } = {}
): Promise<CollectSummary> {
  const targets = opts.targets ?? (await opsTargets(opts.envIds))
  const out: CollectSummary = { environments: targets.length, read: 0, failed: 0 }
  await eachLimited(targets, 4, async (env) => {
    const r = await readOps(env, 'issues', { days: '30' }, opts.deps)
    const at = new Date()
    if (r.state === 'ok') {
      const parsed = parseRollup(env.id, r.body)
      if (parsed) {
        try {
          await storeIssueGroups(env.id, parsed.groups)
          await writeOpsHealth('environment', env.id, {
            issues_state: 'ok',
            issues_at: at,
            issues_truncated: parsed.truncated
          })
          out.read++
          return
        } catch {
          // Fall through: recorded as failed below.
        }
      }
      out.failed++
      await writeOpsHealth('environment', env.id, { issues_state: 'failed', issues_at: at }).catch(
        () => undefined
      )
      return
    }
    if (r.state !== 'no_link') out.failed++
    await writeOpsHealth('environment', env.id, { issues_state: r.state, issues_at: at }).catch(
      () => undefined
    )
  })
  return out
}

// ─── reads for the page ─────────────────────────────────────────────────────────────────────

export interface IssueGroupFilters {
  app_id?: number | null
  environment_id?: number | null
  kind?: 'crash' | 'server' | null
  severity?: string | null
  /** open = open or acknowledged somewhere. */
  status?: 'open' | 'resolved' | null
  /** Only signatures seen in 2 or more apps. */
  multi?: boolean
  q?: string | null
}

export interface IssueGroupSummary {
  sig: string
  kind: 'crash' | 'server'
  title: string
  severity: string | null
  open: boolean
  apps: number
  environments: number
  occurrences: number
  people: number
  releases: string[]
  app_keys: string[]
  first_seen: string | null
  last_seen: string | null
}

export interface IssueGroupEnvRow {
  environment_id: number
  app_id: number
  app_key: string
  app_name: string
  environment_key: string
  title: string
  severity: string | null
  status: string | null
  occurrences: number
  people: number
  release: string | null
  screen: string | null
  first_seen: string | null
  last_seen: string | null
  /** The issue in that app (its admin /issues/<id>), or null. */
  link: string | null
}

const isoOf = (v: unknown): string | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

/** Environment ids the viewer may read: all for an admin, the owned apps' otherwise. */
export async function visibleEnvIds(viewer: {
  userId: string
  isAdmin: boolean
}): Promise<number[] | null> {
  if (viewer.isAdmin) return null
  const rows = (await db('nivaro_hub_environments')
    .whereIn(
      'app_id',
      db('nivaro_hub_app_owners').where({ user_id: viewer.userId }).select('app_id')
    )
    .select('id')) as Array<{ id: number }>
  return rows.map((r) => Number(r.id))
}

function baseQuery(visible: number[] | null) {
  const q = db(`${ISSUE_GROUPS} as g`)
    .join('nivaro_hub_environments as e', 'e.id', 'g.environment_id')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
  if (visible) q.whereIn('g.environment_id', visible.length ? visible : [-1])
  return q
}

export const ISSUE_GROUP_LIST_CAP = 300

export async function listIssueGroups(
  viewer: { userId: string; isAdmin: boolean },
  f: IssueGroupFilters = {}
): Promise<{ groups: IssueGroupSummary[]; truncated: boolean }> {
  const visible = await visibleEnvIds(viewer)
  const q = baseQuery(visible).select(
    'g.sig',
    'g.kind',
    'g.title',
    'g.severity',
    'g.status',
    'g.occurrences',
    'g.people',
    'g.release',
    'g.first_seen',
    'g.last_seen',
    'g.environment_id',
    'a.id as app_id',
    'a.key as app_key'
  )
  if (f.app_id) q.where('a.id', f.app_id)
  if (f.environment_id) q.where('g.environment_id', f.environment_id)
  if (f.kind) q.where('g.kind', f.kind)
  const rows = (await q) as Array<Record<string, unknown>>

  const by = new Map<
    string,
    IssueGroupSummary & { _apps: Set<number>; _envs: Set<number>; _sev: number }
  >()
  for (const r of rows) {
    const sig = String(r.sig)
    let g = by.get(sig)
    if (!g) {
      g = {
        sig,
        kind: r.kind === 'crash' ? 'crash' : 'server',
        title: String(r.title ?? ''),
        severity: null,
        open: false,
        apps: 0,
        environments: 0,
        occurrences: 0,
        people: 0,
        releases: [],
        app_keys: [],
        first_seen: null,
        last_seen: null,
        _apps: new Set<number>(),
        _envs: new Set<number>(),
        _sev: -1
      }
      by.set(sig, g)
    }
    g._envs.add(Number(r.environment_id))
    g._apps.add(Number(r.app_id))
    if (!g.app_keys.includes(String(r.app_key))) g.app_keys.push(String(r.app_key))
    g.occurrences += Number(r.occurrences) || 0
    g.people += Number(r.people) || 0
    const sev = r.severity == null ? null : String(r.severity)
    const rank = sev ? (SEV_RANK[sev] ?? 1) : -1
    if (rank > g._sev) {
      g._sev = rank
      g.severity = sev
    }
    const st = r.status == null ? 'open' : String(r.status)
    if (st === 'open' || st === 'acknowledged') g.open = true
    const rel = r.release == null ? null : String(r.release)
    if (rel && !g.releases.includes(rel)) g.releases.push(rel)
    const first = isoOf(r.first_seen)
    const last = isoOf(r.last_seen)
    if (first && (!g.first_seen || first < g.first_seen)) g.first_seen = first
    if (last && (!g.last_seen || last > g.last_seen)) {
      g.last_seen = last
      g.title = String(r.title ?? g.title)
    }
  }

  const needle = (f.q ?? '').trim().toLowerCase()
  let list = [...by.values()].map(({ _apps, _envs, _sev, ...g }) => ({
    ...g,
    apps: _apps.size,
    environments: _envs.size,
    app_keys: g.app_keys.sort(),
    releases: g.releases.sort().reverse().slice(0, 12)
  }))
  if (f.multi) list = list.filter((g) => g.apps >= 2)
  if (f.severity) list = list.filter((g) => g.severity === f.severity)
  if (f.status === 'open') list = list.filter((g) => g.open)
  if (f.status === 'resolved') list = list.filter((g) => !g.open)
  if (needle)
    list = list.filter(
      (g) =>
        g.title.toLowerCase().includes(needle) ||
        g.app_keys.some((k) => k.includes(needle)) ||
        g.sig.startsWith(needle)
    )
  list.sort(
    (a, b) =>
      b.apps - a.apps ||
      String(b.last_seen ?? '').localeCompare(String(a.last_seen ?? '')) ||
      b.occurrences - a.occurrences
  )
  return {
    groups: list.slice(0, ISSUE_GROUP_LIST_CAP),
    truncated: list.length > ISSUE_GROUP_LIST_CAP
  }
}

function issueLink(baseUrl: string, issueId: number | null): string | null {
  if (!issueId) return null
  try {
    const u = new URL(String(baseUrl ?? '').trim())
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null
    return `${u.origin}${u.pathname.replace(/\/+$/, '')}/issues/${issueId}`
  } catch {
    return null
  }
}

/** One signature across the environments the viewer may read. */
export async function issueGroupDetail(
  viewer: { userId: string; isAdmin: boolean },
  sig: string
): Promise<IssueGroupEnvRow[]> {
  if (!SIG_RE.test(sig)) return []
  const visible = await visibleEnvIds(viewer)
  const rows = (await baseQuery(visible)
    .where('g.sig', sig)
    .orderBy('g.last_seen', 'desc')
    .select(
      'g.*',
      'a.id as app_id',
      'a.key as app_key',
      'a.name as app_name',
      'e.key as environment_key',
      'e.base_url'
    )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    environment_id: Number(r.environment_id),
    app_id: Number(r.app_id),
    app_key: String(r.app_key),
    app_name: String(r.app_name ?? r.app_key),
    environment_key: String(r.environment_key),
    title: String(r.title ?? ''),
    severity: (r.severity as string | null) ?? null,
    status: (r.status as string | null) ?? null,
    occurrences: Number(r.occurrences) || 0,
    people: Number(r.people) || 0,
    release: (r.release as string | null) ?? null,
    screen: (r.screen as string | null) ?? null,
    first_seen: isoOf(r.first_seen),
    last_seen: isoOf(r.last_seen),
    link: issueLink(
      String(r.base_url ?? ''),
      r.app_issue_id == null ? null : Number(r.app_issue_id)
    )
  }))
}

/** Per environment: when its issues were last read and how (for the page's "not read" notes). */
export async function issueReadStates(viewer: { userId: string; isAdmin: boolean }): Promise<
  Array<{
    environment_id: number
    app_key: string
    environment_key: string
    state: string | null
    at: string | null
    truncated: boolean
  }>
> {
  const visible = await visibleEnvIds(viewer)
  const q = db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .leftJoin('nivaro_hub_ops_health as h', function () {
      this.on('h.ref_id', '=', 'e.id').andOnVal('h.scope', '=', 'environment')
    })
    .orderBy('a.key')
    .orderBy('e.position')
    .select(
      'e.id',
      'a.key as app_key',
      'e.key as environment_key',
      'h.issues_state',
      'h.issues_at',
      'h.issues_truncated'
    )
  if (visible) q.whereIn('e.id', visible.length ? visible : [-1])
  const rows = (await q) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    environment_id: Number(r.id),
    app_key: String(r.app_key),
    environment_key: String(r.environment_key),
    state: (r.issues_state as string | null) ?? null,
    at: isoOf(r.issues_at),
    truncated: r.issues_truncated === true || r.issues_truncated === 1 || r.issues_truncated === '1'
  }))
}
