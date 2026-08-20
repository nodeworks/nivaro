import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Environment registry + live probes.
 *
 * Environments are tiers (Local/Staging/Production); components are the
 * deployable units inside them (API, frontends, services), each with its own
 * URL, probe and Git project. All admin-only.
 *
 * Status/pipeline/deployment calls run SERVER-side: the browser can't reach
 * a staging host's admin probes cross-origin, and the tokens must never ship
 * to the client. Every remote call is best-effort with a short timeout — an
 * unreachable component is a REPORTED state, not a 500. The URLs and tokens
 * are operator-authored infrastructure config, same trust posture as
 * external APIs.
 */

const MASK = '••••••'

interface ComponentRow {
  id: number
  environment: number
  name: string
  kind: string
  base_url: string | null
  probe_path: string | null
  api_token: string | null
  db_config: string | null
  git_provider: string | null
  git_url: string | null
  git_project: string | null
  git_token: string | null
  git_ref: string | null
  notes: string | null
  sort: number
}

function parseDbConfig(raw: unknown): Record<string, unknown> | null {
  if (!raw) return null
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function serializeComponent(row: ComponentRow) {
  const dbCfg = parseDbConfig(row.db_config)
  return {
    ...row,
    api_token: row.api_token ? MASK : null,
    git_token: row.git_token ? MASK : null,
    db_config: dbCfg ? { ...dbCfg, ...(dbCfg.password ? { password: MASK } : {}) } : null
  }
}

/** Masked values in a PATCH mean "keep what's stored". */
function resolveSecret(incoming: unknown, stored: string | null): string | null {
  if (incoming === undefined) return stored
  if (incoming === null || incoming === '') return null
  const v = String(incoming)
  return v === MASK ? stored : v
}

async function fetchJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = 8000
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { headers, signal: ctl.signal })
    const text = await res.text()
    let body: unknown = null
    try {
      body = JSON.parse(text)
    } catch {
      body = text.slice(0, 300)
    }
    return { ok: res.ok, status: res.status, body }
  } finally {
    clearTimeout(timer)
  }
}

// ─── Git providers ───────────────────────────────────────────────────────────

interface GitCtx {
  provider: string
  base: string
  project: string
  token: string | null
  ref: string | null
}

function gitCtx(row: ComponentRow): GitCtx | null {
  if (!row.git_provider || !row.git_project) return null
  return {
    provider: row.git_provider,
    base:
      row.git_provider === 'github'
        ? 'https://api.github.com'
        : (row.git_url || 'https://gitlab.com').replace(/\/+$/, ''),
    project: row.git_project,
    token: row.git_token,
    ref: row.git_ref
  }
}

function gitHeaders(ctx: GitCtx): Record<string, string> {
  if (ctx.provider === 'github') {
    return {
      accept: 'application/vnd.github+json',
      ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {})
    }
  }
  return ctx.token ? { 'PRIVATE-TOKEN': ctx.token } : {}
}

function gitlabApi(ctx: GitCtx, path: string): string {
  return `${ctx.base}/api/v4/projects/${encodeURIComponent(ctx.project)}${path}`
}

/** Commit titles are immutable per sha — cache them for the life of the
 *  process so live polling doesn't re-fetch the same commits every tick. */
const commitCache = new Map<string, { title: string; author: string }>()

async function gitlabCommit(
  ctx: GitCtx,
  sha: string
): Promise<{ title: string; author: string } | null> {
  const key = `${ctx.base}|${ctx.project}|${sha}`
  const hit = commitCache.get(key)
  if (hit) return hit
  try {
    const res = await fetchJson(gitlabApi(ctx, `/repository/commits/${sha}`), gitHeaders(ctx), 6000)
    if (!res.ok || !res.body || typeof res.body !== 'object') return null
    const b = res.body as { title?: string; author_name?: string }
    const out = { title: String(b.title ?? ''), author: String(b.author_name ?? '') }
    commitCache.set(key, out)
    return out
  } catch {
    return null
  }
}

interface NormalizedPipeline {
  id: number
  status: string
  ref?: string
  sha?: string
  full_sha?: string
  title?: string
  author?: string
  duration?: number | null
  web_url?: string
  created_at?: string
  updated_at?: string
}

const GITLAB_ACTIVE = new Set(['created', 'waiting_for_resource', 'preparing', 'pending', 'running'])

async function gitlabPipelines(ctx: GitCtx): Promise<NormalizedPipeline[]> {
  const ref = ctx.ref ? `&ref=${encodeURIComponent(ctx.ref)}` : ''
  const res = await fetchJson(gitlabApi(ctx, `/pipelines?per_page=12${ref}`), gitHeaders(ctx))
  if (!res.ok) throw new Error(`GitLab answered ${res.status}`)
  const list = (Array.isArray(res.body) ? res.body : []) as Array<Record<string, unknown>>
  // Enrich the visible window: commit title/author (sha-cached forever) and
  // per-pipeline duration/user. Parallel, each best-effort.
  const enriched = await Promise.all(
    list.slice(0, 10).map(async (p) => {
      const sha = String(p.sha ?? '')
      const [commit, detail] = await Promise.all([
        sha ? gitlabCommit(ctx, sha) : null,
        fetchJson(gitlabApi(ctx, `/pipelines/${p.id}`), gitHeaders(ctx), 6000).catch(() => null)
      ])
      const d =
        detail?.ok && detail.body && typeof detail.body === 'object'
          ? (detail.body as { duration?: number; user?: { name?: string } })
          : null
      return {
        id: Number(p.id),
        status: String(p.status ?? ''),
        ref: String(p.ref ?? ''),
        sha: sha.slice(0, 8),
        full_sha: sha,
        title: commit?.title,
        author: commit?.author || d?.user?.name,
        duration: d?.duration ?? null,
        web_url: String(p.web_url ?? ''),
        created_at: String(p.created_at ?? ''),
        updated_at: String(p.updated_at ?? '')
      }
    })
  )
  return enriched
}

async function githubPipelines(ctx: GitCtx): Promise<NormalizedPipeline[]> {
  const ref = ctx.ref ? `&branch=${encodeURIComponent(ctx.ref)}` : ''
  const res = await fetchJson(
    `${ctx.base}/repos/${ctx.project}/actions/runs?per_page=12${ref}`,
    gitHeaders(ctx)
  )
  if (!res.ok) throw new Error(`GitHub answered ${res.status}`)
  const runs = (res.body as { workflow_runs?: Array<Record<string, unknown>> })?.workflow_runs ?? []
  return runs.map((r) => {
    const started = r.run_started_at ? Date.parse(String(r.run_started_at)) : null
    const updated = r.updated_at ? Date.parse(String(r.updated_at)) : null
    return {
      id: Number(r.id),
      // GitHub splits queued/completed from success/failure — fold to one status.
      status: String(r.status === 'completed' ? r.conclusion : r.status),
      ref: String(r.head_branch ?? ''),
      sha: String(r.head_sha ?? '').slice(0, 8),
      full_sha: String(r.head_sha ?? ''),
      title: String(r.display_title ?? ''),
      author: String((r.actor as { login?: string } | undefined)?.login ?? ''),
      duration:
        started && updated && updated > started ? Math.round((updated - started) / 1000) : null,
      web_url: String(r.html_url ?? ''),
      created_at: String(r.created_at ?? ''),
      updated_at: String(r.updated_at ?? '')
    }
  })
}

// ─── Routes ──────────────────────────────────────────────────────────────────

export async function environmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  const loadComponent = async (id: string): Promise<ComponentRow | undefined> =>
    (await db('nivaro_environment_components').where('id', id).first()) as ComponentRow | undefined

  app.get('/', async () => {
    const envs = await db('nivaro_environments').orderBy('sort').orderBy('id')
    const components = (await db('nivaro_environment_components')
      .orderBy('sort')
      .orderBy('id')) as ComponentRow[]
    return {
      data: envs.map((e: Record<string, unknown>) => ({
        ...e,
        components: components.filter((c) => c.environment === e.id).map(serializeComponent)
      }))
    }
  })

  app.post('/', async (req, reply) => {
    const b = req.body as Record<string, unknown>
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const [inserted] = await db('nivaro_environments')
      .insert({
        name,
        color: (b.color as string) || null,
        notes: (b.notes as string) || null,
        sort: Number(b.sort ?? 0) || 0,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'environment-create',
      user: req.user?.id,
      collection: 'nivaro_environments',
      item: String(id),
      comment: name,
      req
    })
    return reply.code(201).send({ data: { id } })
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_environments').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = { updated_at: new Date() }
    for (const f of ['name', 'color', 'notes', 'sort']) {
      if (b[f] !== undefined) patch[f] = b[f] === '' ? null : b[f]
    }
    await db('nivaro_environments').where('id', row.id).update(patch)
    await logActivity({
      action: 'environment-update',
      user: req.user?.id,
      collection: 'nivaro_environments',
      item: String(row.id),
      comment: String(row.name),
      req
    })
    return { data: { id: row.id } }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = await db('nivaro_environments').where('id', req.params.id).first()
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_environments').where('id', row.id).del()
    await logActivity({
      action: 'environment-delete',
      user: req.user?.id,
      collection: 'nivaro_environments',
      item: String(row.id),
      comment: String(row.name),
      req
    })
    return { data: { deleted: true } }
  })

  // ── Components ────────────────────────────────────────────────────────────

  const COMPONENT_FIELDS = [
    'name',
    'kind',
    'base_url',
    'probe_path',
    'git_provider',
    'git_url',
    'git_project',
    'git_ref',
    'notes',
    'sort'
  ]

  app.post<{ Params: { id: string } }>('/:id/components', async (req, reply) => {
    const env = await db('nivaro_environments').where('id', req.params.id).first()
    if (!env) return reply.code(404).send({ error: 'Environment not found' })
    const b = req.body as Record<string, unknown>
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const [inserted] = await db('nivaro_environment_components')
      .insert({
        environment: env.id,
        name,
        kind: ['api', 'frontend', 'service'].includes(String(b.kind)) ? b.kind : 'api',
        base_url: (b.base_url as string) || null,
        probe_path: (b.probe_path as string) || null,
        api_token: (b.api_token as string) || null,
        db_config: b.db_config ? JSON.stringify(b.db_config) : null,
        git_provider: (b.git_provider as string) || null,
        git_url: (b.git_url as string) || null,
        git_project: (b.git_project as string) || null,
        git_token: (b.git_token as string) || null,
        git_ref: (b.git_ref as string) || null,
        notes: (b.notes as string) || null,
        sort: Number(b.sort ?? 0) || 0,
        created_at: new Date(),
        updated_at: new Date()
      })
      .returning('id')
    const id = typeof inserted === 'object' ? (inserted as { id: number }).id : inserted
    await logActivity({
      action: 'environment-component-create',
      user: req.user?.id,
      collection: 'nivaro_environment_components',
      item: String(id),
      comment: `${env.name} · ${name}`,
      req
    })
    const fresh = await loadComponent(String(id))
    return reply.code(201).send({ data: fresh ? serializeComponent(fresh) : { id } })
  })

  app.patch<{ Params: { cid: string } }>('/components/:cid', async (req, reply) => {
    const row = await loadComponent(req.params.cid)
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = { updated_at: new Date() }
    for (const f of COMPONENT_FIELDS) {
      if (b[f] !== undefined) patch[f] = b[f] === '' ? null : b[f]
    }
    if (b.api_token !== undefined) patch.api_token = resolveSecret(b.api_token, row.api_token)
    if (b.git_token !== undefined) patch.git_token = resolveSecret(b.git_token, row.git_token)
    if (b.db_config !== undefined) {
      if (!b.db_config) {
        patch.db_config = null
      } else {
        const incoming = parseDbConfig(b.db_config) ?? {}
        const stored = parseDbConfig(row.db_config) ?? {}
        if (incoming.password === MASK) incoming.password = stored.password
        patch.db_config = JSON.stringify(incoming)
      }
    }
    await db('nivaro_environment_components').where('id', row.id).update(patch)
    await logActivity({
      action: 'environment-component-update',
      user: req.user?.id,
      collection: 'nivaro_environment_components',
      item: String(row.id),
      comment: row.name,
      req
    })
    const fresh = await loadComponent(String(row.id))
    return { data: fresh ? serializeComponent(fresh) : null }
  })

  app.delete<{ Params: { cid: string } }>('/components/:cid', async (req, reply) => {
    const row = await loadComponent(req.params.cid)
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_environment_components').where('id', row.id).del()
    await logActivity({
      action: 'environment-component-delete',
      user: req.user?.id,
      collection: 'nivaro_environment_components',
      item: String(row.id),
      comment: row.name,
      req
    })
    return { data: { deleted: true } }
  })

  // ── Live status (kind-aware) ──────────────────────────────────────────────

  app.get<{ Params: { cid: string } }>('/components/:cid/status', async (req, reply) => {
    const row = await loadComponent(req.params.cid)
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!row.base_url) return { data: { reachable: false, reason: 'No base URL configured' } }
    const base = row.base_url.replace(/\/+$/, '')
    const out: Record<string, unknown> = { reachable: false, kind: row.kind }

    if (row.kind === 'api') {
      try {
        const version = await fetchJson(`${base}${row.probe_path || '/api/version'}`, {})
        if (version.ok && version.body && typeof version.body === 'object') {
          out.reachable = true
          Object.assign(out, version.body)
        } else {
          out.reason = `version probe answered ${version.status}`
          return { data: out }
        }
      } catch (err) {
        out.reason = err instanceof Error ? err.message : String(err)
        return { data: out }
      }
      try {
        const health = await fetchJson(`${base}/api/health`, {})
        if (health.body && typeof health.body === 'object') out.health = health.body
      } catch {
        /* absent */
      }
      if (row.api_token) {
        try {
          const preflight = await fetchJson(`${base}/api/preflight`, {
            authorization: `Bearer ${row.api_token}`
          })
          if (preflight.body && typeof preflight.body === 'object') out.preflight = preflight.body
        } catch {
          /* absent */
        }
      }
      return { data: out }
    }

    // frontend / service: probe the version file (or configured path), fall
    // back to a bare reachability check on the root.
    const probePath = row.probe_path || (row.kind === 'frontend' ? '/version.json' : '/')
    try {
      const res = await fetchJson(`${base}${probePath}`, {})
      if (res.ok) {
        out.reachable = true
        if (res.body && typeof res.body === 'object') {
          const v = (res.body as { version?: unknown }).version
          if (typeof v === 'string') out.version = v
        }
        return { data: out }
      }
      // Version file missing is not the same as the app being down.
      const root = await fetchJson(base, {})
      out.reachable = root.status > 0 && root.status < 500
      out.reason = out.reachable ? `no ${probePath} (${res.status})` : `answered ${root.status}`
    } catch (err) {
      out.reason = err instanceof Error ? err.message : String(err)
    }
    return { data: out }
  })

  // ── CI: pipelines, jobs, deployments ──────────────────────────────────────

  app.get<{ Params: { cid: string } }>('/components/:cid/pipelines', async (req, reply) => {
    const row = await loadComponent(req.params.cid)
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const ctx = gitCtx(row)
    if (!ctx) return { data: { configured: false, pipelines: [] } }
    try {
      const pipelines =
        ctx.provider === 'github' ? await githubPipelines(ctx) : await gitlabPipelines(ctx)
      const active = pipelines.some((p) => GITLAB_ACTIVE.has(p.status) || p.status === 'in_progress')
      return { data: { configured: true, active, pipelines } }
    } catch (err) {
      return {
        data: {
          configured: true,
          error: err instanceof Error ? err.message : String(err),
          pipelines: []
        }
      }
    }
  })

  /** Per-pipeline job breakdown, fetched on expand (and re-fetched while the
   *  pipeline runs). */
  app.get<{ Params: { cid: string; pid: string } }>(
    '/components/:cid/pipelines/:pid/jobs',
    async (req, reply) => {
      const row = await loadComponent(req.params.cid)
      if (!row) return reply.code(404).send({ error: 'Not found' })
      const ctx = gitCtx(row)
      if (!ctx) return { data: { jobs: [] } }
      try {
        if (ctx.provider === 'github') {
          const res = await fetchJson(
            `${ctx.base}/repos/${ctx.project}/actions/runs/${req.params.pid}/jobs?per_page=50`,
            gitHeaders(ctx)
          )
          if (!res.ok) return { data: { error: `GitHub answered ${res.status}`, jobs: [] } }
          const jobs = (res.body as { jobs?: Array<Record<string, unknown>> })?.jobs ?? []
          return {
            data: {
              jobs: jobs.map((j) => ({
                id: j.id,
                name: j.name,
                stage: null,
                status: j.status === 'completed' ? j.conclusion : j.status,
                duration:
                  j.started_at && j.completed_at
                    ? Math.round(
                        (Date.parse(String(j.completed_at)) - Date.parse(String(j.started_at))) /
                          1000
                      )
                    : null,
                web_url: j.html_url,
                failure_reason: null
              }))
            }
          }
        }
        const res = await fetchJson(
          gitlabApi(ctx, `/pipelines/${req.params.pid}/jobs?per_page=50&include_retried=false`),
          gitHeaders(ctx)
        )
        if (!res.ok) return { data: { error: `GitLab answered ${res.status}`, jobs: [] } }
        const jobs = (Array.isArray(res.body) ? res.body : []) as Array<Record<string, unknown>>
        return {
          data: {
            jobs: jobs.map((j) => ({
              id: j.id,
              name: j.name,
              stage: j.stage,
              status: j.status,
              duration: typeof j.duration === 'number' ? Math.round(j.duration) : null,
              web_url: j.web_url,
              failure_reason: j.failure_reason ?? null
            }))
          }
        }
      } catch (err) {
        return { data: { error: err instanceof Error ? err.message : String(err), jobs: [] } }
      }
    }
  )

  /** GitLab deployments (environments API) — which sha is live where. */
  app.get<{ Params: { cid: string } }>('/components/:cid/deployments', async (req, reply) => {
    const row = await loadComponent(req.params.cid)
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const ctx = gitCtx(row)
    if (!ctx || ctx.provider !== 'gitlab') return { data: { deployments: [] } }
    try {
      const res = await fetchJson(
        gitlabApi(ctx, '/deployments?order_by=id&sort=desc&per_page=10'),
        gitHeaders(ctx)
      )
      if (!res.ok) return { data: { error: `GitLab answered ${res.status}`, deployments: [] } }
      const list = (Array.isArray(res.body) ? res.body : []) as Array<Record<string, unknown>>
      return {
        data: {
          deployments: list.map((d) => {
            const deployable = d.deployable as
              | { name?: string; status?: string; web_url?: string; commit?: { title?: string } }
              | undefined
            return {
              id: d.id,
              status: d.status,
              environment: (d.environment as { name?: string } | undefined)?.name,
              sha: String(d.sha ?? '').slice(0, 8),
              ref: d.ref,
              title: deployable?.commit?.title,
              job: deployable?.name,
              web_url: deployable?.web_url,
              created_at: d.created_at,
              user: (d.user as { name?: string } | undefined)?.name
            }
          })
        }
      }
    } catch (err) {
      return { data: { error: err instanceof Error ? err.message : String(err), deployments: [] } }
    }
  })
}
