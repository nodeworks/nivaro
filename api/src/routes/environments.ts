import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

/**
 * Environment registry + live probes. All admin-only.
 *
 * Status and pipeline calls run SERVER-side: the browser can't reach a
 * staging host's admin probes cross-origin, and the tokens must never ship
 * to the client. Every remote call is best-effort with a short timeout —
 * an unreachable environment is a REPORTED state, not a 500.
 *
 * The URLs and tokens here are operator-authored infrastructure config
 * (requireAdmin on every route), same trust posture as external APIs.
 */

const MASK = '••••••'

interface EnvRow {
  id: number
  name: string
  base_url: string | null
  api_token: string | null
  db_config: string | null
  git_provider: string | null
  git_url: string | null
  git_project: string | null
  git_token: string | null
  git_ref: string | null
  notes: string | null
  color: string | null
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

function serialize(row: EnvRow) {
  const dbCfg = parseDbConfig(row.db_config)
  return {
    ...row,
    api_token: row.api_token ? MASK : null,
    git_token: row.git_token ? MASK : null,
    db_config: dbCfg
      ? { ...dbCfg, ...(dbCfg.password ? { password: MASK } : {}) }
      : null
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

export async function environmentRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  app.get('/', async () => {
    const rows = (await db('nivaro_environments').orderBy('sort').orderBy('id')) as EnvRow[]
    return { data: rows.map(serialize) }
  })

  app.post('/', async (req, reply) => {
    const b = req.body as Record<string, unknown>
    const name = String(b.name ?? '').trim()
    if (!name) return reply.code(400).send({ error: 'name is required' })
    const [inserted] = await db('nivaro_environments')
      .insert({
        name,
        base_url: (b.base_url as string) || null,
        api_token: (b.api_token as string) || null,
        db_config: b.db_config ? JSON.stringify(b.db_config) : null,
        git_provider: (b.git_provider as string) || null,
        git_url: (b.git_url as string) || null,
        git_project: (b.git_project as string) || null,
        git_token: (b.git_token as string) || null,
        git_ref: (b.git_ref as string) || null,
        notes: (b.notes as string) || null,
        color: (b.color as string) || null,
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
    const row = (await db('nivaro_environments').where('id', id).first()) as EnvRow
    return reply.code(201).send({ data: serialize(row) })
  })

  app.patch<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_environments').where('id', req.params.id).first()) as
      | EnvRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    const b = req.body as Record<string, unknown>
    const patch: Record<string, unknown> = { updated_at: new Date() }
    for (const f of [
      'name',
      'base_url',
      'git_provider',
      'git_url',
      'git_project',
      'git_ref',
      'notes',
      'color',
      'sort'
    ]) {
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
        // Masked password keeps the stored one.
        if (incoming.password === MASK) incoming.password = stored.password
        patch.db_config = JSON.stringify(incoming)
      }
    }
    await db('nivaro_environments').where('id', row.id).update(patch)
    await logActivity({
      action: 'environment-update',
      user: req.user?.id,
      collection: 'nivaro_environments',
      item: String(row.id),
      comment: row.name,
      req
    })
    const fresh = (await db('nivaro_environments').where('id', row.id).first()) as EnvRow
    return { data: serialize(fresh) }
  })

  app.delete<{ Params: { id: string } }>('/:id', async (req, reply) => {
    const row = (await db('nivaro_environments').where('id', req.params.id).first()) as
      | EnvRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    await db('nivaro_environments').where('id', row.id).del()
    await logActivity({
      action: 'environment-delete',
      user: req.user?.id,
      collection: 'nivaro_environments',
      item: String(row.id),
      comment: row.name,
      req
    })
    return { data: { deleted: true } }
  })

  /** Live instance probe: version (public), health (public), and — when a
   *  token is stored — the admin-gated detailed health + deploy preflight. */
  app.get<{ Params: { id: string } }>('/:id/status', async (req, reply) => {
    const row = (await db('nivaro_environments').where('id', req.params.id).first()) as
      | EnvRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!row.base_url) return { data: { reachable: false, reason: 'No base URL configured' } }
    const base = row.base_url.replace(/\/+$/, '')
    const authed: Record<string, string> = row.api_token
      ? { authorization: `Bearer ${row.api_token}` }
      : {}

    const out: Record<string, unknown> = { reachable: false }
    try {
      const version = await fetchJson(`${base}/api/version`, {})
      if (version.ok && version.body && typeof version.body === 'object') {
        out.reachable = true
        Object.assign(out, version.body)
      } else {
        out.reason = `version probe answered ${version.status}`
      }
    } catch (err) {
      out.reason = err instanceof Error ? err.message : String(err)
      return { data: out }
    }

    // Best-effort extras — each degrades independently.
    try {
      const health = await fetchJson(`${base}/api/health`, {})
      if (health.body && typeof health.body === 'object') out.health = health.body
    } catch {
      /* health stays absent */
    }
    if (row.api_token) {
      try {
        const preflight = await fetchJson(`${base}/api/preflight`, authed)
        if (preflight.body && typeof preflight.body === 'object') out.preflight = preflight.body
      } catch {
        /* preflight stays absent */
      }
    }
    return { data: out }
  })

  /** Recent CI pipelines from the environment's git provider, normalized. */
  app.get<{ Params: { id: string } }>('/:id/pipelines', async (req, reply) => {
    const row = (await db('nivaro_environments').where('id', req.params.id).first()) as
      | EnvRow
      | undefined
    if (!row) return reply.code(404).send({ error: 'Not found' })
    if (!row.git_provider || !row.git_project) {
      return { data: { configured: false, pipelines: [] } }
    }
    try {
      if (row.git_provider === 'gitlab') {
        const base = (row.git_url || 'https://gitlab.com').replace(/\/+$/, '')
        const project = encodeURIComponent(row.git_project)
        const ref = row.git_ref ? `&ref=${encodeURIComponent(row.git_ref)}` : ''
        const res = await fetchJson(
          `${base}/api/v4/projects/${project}/pipelines?per_page=10${ref}`,
          row.git_token ? { 'PRIVATE-TOKEN': row.git_token } : {}
        )
        if (!res.ok) {
          return { data: { configured: true, error: `GitLab answered ${res.status}`, pipelines: [] } }
        }
        const list = Array.isArray(res.body) ? res.body : []
        return {
          data: {
            configured: true,
            pipelines: list.map((p: Record<string, unknown>) => ({
              id: p.id,
              status: p.status,
              ref: p.ref,
              sha: String(p.sha ?? '').slice(0, 8),
              web_url: p.web_url,
              created_at: p.created_at,
              updated_at: p.updated_at
            }))
          }
        }
      }
      if (row.git_provider === 'github') {
        const ref = row.git_ref ? `&branch=${encodeURIComponent(row.git_ref)}` : ''
        const res = await fetchJson(
          `https://api.github.com/repos/${row.git_project}/actions/runs?per_page=10${ref}`,
          {
            accept: 'application/vnd.github+json',
            ...(row.git_token ? { authorization: `Bearer ${row.git_token}` } : {})
          }
        )
        if (!res.ok) {
          return { data: { configured: true, error: `GitHub answered ${res.status}`, pipelines: [] } }
        }
        const runs = (res.body as { workflow_runs?: Array<Record<string, unknown>> })
          ?.workflow_runs
        return {
          data: {
            configured: true,
            pipelines: (runs ?? []).map((r) => ({
              id: r.id,
              // GitHub splits queued/completed from success/failure — fold to
              // the GitLab-style single status the UI renders.
              status: r.status === 'completed' ? r.conclusion : r.status,
              ref: r.head_branch,
              sha: String(r.head_sha ?? '').slice(0, 8),
              title: r.display_title,
              web_url: r.html_url,
              created_at: r.created_at,
              updated_at: r.updated_at
            }))
          }
        }
      }
      return { data: { configured: true, error: `Unknown provider "${row.git_provider}"`, pipelines: [] } }
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
}
