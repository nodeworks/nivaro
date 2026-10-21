/**
 * Self-hosted GitLab health for the Infrastructure page (#2841).
 *
 * Reuses the GitLab base URL + token already stored on an Environments component (git_provider
 * 'gitlab'); the token is read here and never returned or logged. Every part degrades on its own:
 * readiness/liveness need the monitoring IP allowlist or GITLAB_HEALTH_TOKEN, runners and pending
 * jobs need an admin-scope token (project-level fallback otherwise).
 *
 *   GITLAB_HEALTH_TOKEN=     optional token for /-/readiness and /-/liveness (secret)
 *   GITLAB_CONTAINER=gitlab  regex that picks the GitLab container in the cAdvisor metrics
 */
import { db } from '../db/index.js'
import { type ContainerResource, loadContainerResources } from './container-resources.js'
import { lq, metricsQuery, storeConfig } from './telemetry-store.js'

export interface GitlabTarget {
  base: string
  token: string | null
  /** Projects mapped on Environments components, for the pending-jobs fallback. */
  projects: string[]
}

type GitlabFetch = (url: string, init: RequestInit) => Promise<Response>
let fetchImpl: GitlabFetch = (url, init) => fetch(url, init)
export function setGitlabFetchForTests(f: GitlabFetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
}

const TIMEOUT_MS = 6000
const DAY_MS = 24 * 3600_000

/** The first GitLab component (a token wins), or null when Environments has none. */
export async function gitlabTarget(): Promise<GitlabTarget | null> {
  if (process.env.CLOUD_META_DB_URL) return null
  const rows = (await db('nivaro_environment_components')
    .where('git_provider', 'gitlab')
    .whereNotNull('git_url')
    .select('git_url', 'git_token', 'git_project')
    .orderBy('id')) as Array<{
    git_url: string | null
    git_token: string | null
    git_project: string | null
  }>
  const clean = rows.filter((r) => r.git_url?.trim())
  if (!clean.length) return null
  const first = clean.find((r) => r.git_token) ?? clean[0]
  const base = (first.git_url as string).trim().replace(/\/+$/, '')
  const same = clean.filter((r) => (r.git_url as string).trim().replace(/\/+$/, '') === base)
  return {
    base,
    token: first.git_token || null,
    projects: [...new Set(same.map((r) => r.git_project).filter((p): p is string => !!p))]
  }
}

export interface Part<T> {
  ok: boolean
  /** Plain sentence for the page when not ok. */
  error: string | null
  data: T | null
}

const okPart = <T>(data: T): Part<T> => ({ ok: true, error: null, data })
const failPart = <T>(error: string): Part<T> => ({ ok: false, error, data: null })

async function get(
  target: GitlabTarget,
  path: string,
  opts: { auth?: boolean; query?: string } = {}
): Promise<{ status: number; body: unknown; headers: Headers }> {
  const headers: Record<string, string> = { accept: 'application/json' }
  if (opts.auth !== false && target.token) headers['PRIVATE-TOKEN'] = target.token
  const res = await fetchImpl(`${target.base}${path}${opts.query ? `?${opts.query}` : ''}`, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(TIMEOUT_MS)
  })
  const text = await res.text()
  let body: unknown = null
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 200)
  }
  return { status: res.status, body, headers: res.headers }
}

const unreachable = (err: unknown): string =>
  (err as Error)?.name === 'TimeoutError' ? 'GitLab timed out' : 'GitLab did not answer'

// ── Health endpoints ─────────────────────────────────────────────────────────

export interface HealthCheck {
  name: string
  status: string
}

export interface HealthData {
  readiness: { ok: boolean; checks: HealthCheck[] } | null
  liveness: boolean | null
}

const NOT_REACHABLE =
  'Not reachable from this server (GitLab only answers health checks to its monitoring IP allowlist; add this server there, or set GITLAB_HEALTH_TOKEN)'

export function parseReadiness(body: unknown): { ok: boolean; checks: HealthCheck[] } | null {
  if (!body || typeof body !== 'object') return null
  const b = body as Record<string, unknown>
  if (typeof b.status !== 'string') return null
  const checks: HealthCheck[] = []
  for (const [k, v] of Object.entries(b)) {
    if (!Array.isArray(v)) continue
    const bad = v.find(
      (x) => x && typeof x === 'object' && (x as { status?: string }).status !== 'ok'
    )
    checks.push({ name: k.replace(/_check$/, ''), status: bad ? 'failing' : 'ok' })
  }
  return { ok: b.status === 'ok' && checks.every((c) => c.status === 'ok'), checks }
}

async function health(target: GitlabTarget): Promise<Part<HealthData>> {
  const healthToken = process.env.GITLAB_HEALTH_TOKEN?.trim()
  const q = (extra = '') =>
    [extra, healthToken ? `token=${encodeURIComponent(healthToken)}` : ''].filter(Boolean).join('&')
  try {
    const [ready, live] = await Promise.all([
      get(target, '/-/readiness', { auth: false, query: q('all=1') }),
      get(target, '/-/liveness', { auth: false, query: q() })
    ])
    if ([ready.status, live.status].some((s) => s === 404 || s === 401 || s === 403))
      return failPart(NOT_REACHABLE)
    return okPart({
      readiness: ready.status < 500 ? parseReadiness(ready.body) : { ok: false, checks: [] },
      liveness: live.status === 200
    })
  } catch (err) {
    return failPart(unreachable(err))
  }
}

// ── Version ──────────────────────────────────────────────────────────────────

async function version(
  target: GitlabTarget
): Promise<Part<{ version: string; revision: string | null }>> {
  if (!target.token) return failPart('No token on the GitLab component')
  try {
    const r = await get(target, '/api/v4/version')
    if (r.status === 401 || r.status === 403) return failPart('The stored GitLab token was refused')
    if (r.status !== 200 || !r.body || typeof r.body !== 'object')
      return failPart(`GitLab answered ${r.status}`)
    const b = r.body as { version?: string; revision?: string }
    return okPart({ version: b.version ?? '?', revision: b.revision ?? null })
  } catch (err) {
    return failPart(unreachable(err))
  }
}

// ── Runners ──────────────────────────────────────────────────────────────────

export type RunnerState = 'online' | 'offline' | 'stale' | 'never_contacted' | 'paused'

export interface RunnerRow {
  id: number
  name: string
  type: string
  state: RunnerState
  flagged: boolean
  contacted_at: string | null
  ip: string | null
  version: string | null
}

interface RawRunner {
  id?: number
  description?: string
  name?: string
  runner_type?: string
  online?: boolean
  status?: string
  paused?: boolean
  active?: boolean
  contacted_at?: string | null
  ip_address?: string | null
  version?: string | null
}

export function classifyRunner(r: RawRunner, nowMs = Date.now()): RunnerRow {
  const contactedMs = r.contacted_at ? Date.parse(r.contacted_at) : Number.NaN
  const never = !r.contacted_at && (r.status === 'never_contacted' || r.status === undefined)
  let state: RunnerState
  if (r.status === 'never_contacted' || never) state = 'never_contacted'
  else if (r.status === 'stale') state = 'stale'
  else if (Number.isFinite(contactedMs) && nowMs - contactedMs > DAY_MS) state = 'stale'
  else if (r.paused === true || r.active === false || r.status === 'paused') state = 'paused'
  else state = r.online === false || r.status === 'offline' ? 'offline' : 'online'
  return {
    id: r.id ?? 0,
    name: r.description || r.name || `runner ${r.id ?? '?'}`,
    type: r.runner_type ?? '',
    state,
    flagged: state === 'stale' || state === 'never_contacted' || state === 'offline',
    contacted_at: r.contacted_at ?? null,
    ip: r.ip_address ?? null,
    version: r.version ?? null
  }
}

export interface RunnersData {
  runners: RunnerRow[]
  counts: Record<RunnerState, number>
  scope: 'all' | 'visible'
}

async function runners(target: GitlabTarget): Promise<Part<RunnersData>> {
  if (!target.token) return failPart('No token on the GitLab component')
  try {
    let scope: 'all' | 'visible' = 'all'
    let r = await get(target, '/api/v4/runners/all', { query: 'per_page=100' })
    if (r.status === 401 || r.status === 403) {
      scope = 'visible'
      r = await get(target, '/api/v4/runners', { query: 'per_page=100' })
    }
    if (r.status === 401 || r.status === 403) return failPart('The stored GitLab token was refused')
    if (r.status !== 200 || !Array.isArray(r.body)) return failPart(`GitLab answered ${r.status}`)
    const rows = (r.body as RawRunner[]).map((x) => classifyRunner(x))
    // List responses omit contacted_at on some versions; the status field still marks stale ones.
    const counts: Record<RunnerState, number> = {
      online: 0,
      offline: 0,
      stale: 0,
      never_contacted: 0,
      paused: 0
    }
    for (const x of rows) counts[x.state]++
    rows.sort((a, b) => Number(b.flagged) - Number(a.flagged) || a.name.localeCompare(b.name))
    return okPart({ runners: rows, counts, scope })
  } catch (err) {
    return failPart(unreachable(err))
  }
}

// ── Pending jobs ─────────────────────────────────────────────────────────────

export interface PendingData {
  count: number
  /** true when the page limit was hit, so count and age are lower bounds. */
  at_least: boolean
  oldest_age_s: number | null
  source: 'instance' | 'projects'
}

export function summarizePending(
  jobs: Array<{ created_at?: string }>,
  nowMs = Date.now()
): { count: number; oldest_age_s: number | null } {
  let oldest = Number.POSITIVE_INFINITY
  for (const j of jobs) {
    const t = j.created_at ? Date.parse(j.created_at) : Number.NaN
    if (Number.isFinite(t) && t < oldest) oldest = t
  }
  return {
    count: jobs.length,
    oldest_age_s: Number.isFinite(oldest) ? Math.max(0, Math.round((nowMs - oldest) / 1000)) : null
  }
}

async function pending(target: GitlabTarget): Promise<Part<PendingData>> {
  if (!target.token) return failPart('No token on the GitLab component')
  try {
    const inst = await get(target, '/api/v4/jobs', { query: 'scope=pending&per_page=100' })
    if (inst.status === 200 && Array.isArray(inst.body)) {
      const s = summarizePending(inst.body as Array<{ created_at?: string }>)
      return okPart({ ...s, at_least: inst.body.length >= 100, source: 'instance' })
    }
    // Instance-wide listing needs an admin token (or is missing): count the mapped projects.
    if (!target.projects.length)
      return failPart(
        'Needs an administrator token; no projects are mapped on Environments to fall back to'
      )
    const all: Array<{ created_at?: string }> = []
    let atLeast = false
    let anyOk = false
    for (const p of target.projects) {
      const r = await get(target, `/api/v4/projects/${encodeURIComponent(p)}/jobs`, {
        query: 'scope[]=pending&per_page=100'
      })
      if (r.status === 200 && Array.isArray(r.body)) {
        anyOk = true
        all.push(...(r.body as Array<{ created_at?: string }>))
        if (r.body.length >= 100) atLeast = true
      }
    }
    if (!anyOk) return failPart('The stored GitLab token could not list jobs')
    return okPart({ ...summarizePending(all), at_least: atLeast, source: 'projects' })
  } catch (err) {
    return failPart(unreachable(err))
  }
}

// ── Container + registry (telemetry store) ───────────────────────────────────

export function gitlabContainerPattern(raw = process.env.GITLAB_CONTAINER): string {
  let re = (raw ?? '').trim() || 'gitlab'
  const slashed = re.match(/^\/(.+)\/$/)
  if (slashed) re = slashed[1]
  // MetricsQL regexes are anchored; the operator pattern means "contains".
  return `(?i).*(${re}).*`
}

export interface ContainerData {
  containers: ContainerResource[]
  registry_bytes: number | null
}

async function container(): Promise<Part<ContainerData>> {
  if (!storeConfig()) return failPart('telemetry store not configured')
  try {
    const containers = await loadContainerResources('24h', gitlabContainerPattern(), false)
    let registry: number | null = null
    try {
      const env = storeConfig()?.env
      const sel = [env ? `env=${lq(env)}` : '', 'path=~".*registry.*"'].filter(Boolean).join(',')
      const rows = await metricsQuery(`max by (host, path) (nivaro_host_dir_bytes{${sel}})`)
      const best = rows.map((r) => r.value).filter((v) => Number.isFinite(v))
      registry = best.length ? Math.max(...best) : null
    } catch {
      registry = null
    }
    if (!containers.length && registry == null)
      return failPart('No container named like GitLab in the metrics store')
    return okPart({ containers, registry_bytes: registry })
  } catch (err) {
    return failPart((err as Error).message)
  }
}

// ── Whole view ───────────────────────────────────────────────────────────────

export interface GitlabView {
  configured: boolean
  base: string | null
  health: Part<HealthData> | null
  version: Part<{ version: string; revision: string | null }> | null
  runners: Part<RunnersData> | null
  pending: Part<PendingData> | null
  container: Part<ContainerData> | null
}

export async function loadGitlabHealth(target: GitlabTarget | null): Promise<GitlabView> {
  if (!target)
    return {
      configured: false,
      base: null,
      health: null,
      version: null,
      runners: null,
      pending: null,
      container: null
    }
  const [h, v, r, p, c] = await Promise.all([
    health(target),
    version(target),
    runners(target),
    pending(target),
    container()
  ])
  return {
    configured: true,
    base: target.base,
    health: h,
    version: v,
    runners: r,
    pending: p,
    container: c
  }
}
