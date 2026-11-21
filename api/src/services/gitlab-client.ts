// Shared GitLab REST client (moved out of routes/environments.ts so the Hub can reuse it).

export async function fetchJson(
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

export interface GitCtx {
  provider: string
  base: string
  project: string
  token: string | null
  ref: string | null
}

export function gitHeaders(ctx: GitCtx): Record<string, string> {
  if (ctx.provider === 'github') {
    return {
      accept: 'application/vnd.github+json',
      ...(ctx.token ? { authorization: `Bearer ${ctx.token}` } : {})
    }
  }
  return ctx.token ? { 'PRIVATE-TOKEN': ctx.token } : {}
}

export function gitlabApi(ctx: GitCtx, path: string): string {
  return `${ctx.base}/api/v4/projects/${encodeURIComponent(ctx.project)}${path}`
}

/** Commit titles are immutable per sha — cache them for the life of the
 *  process so live polling doesn't re-fetch the same commits every tick. */
const commitCache = new Map<string, { title: string; author: string }>()

export async function gitlabCommit(
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

export interface NormalizedPipeline {
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

export async function gitlabPipelines(
  ctx: GitCtx,
  opts: { perPage?: number } = {}
): Promise<NormalizedPipeline[]> {
  const perPage = opts.perPage ?? 12
  const window = opts.perPage ?? 10
  const ref = ctx.ref ? `&ref=${encodeURIComponent(ctx.ref)}` : ''
  const res = await fetchJson(
    gitlabApi(ctx, `/pipelines?per_page=${perPage}${ref}`),
    gitHeaders(ctx)
  )
  if (!res.ok) throw new Error(`GitLab answered ${res.status}`)
  const list = (Array.isArray(res.body) ? res.body : []) as Array<Record<string, unknown>>
  // Enrich the visible window: commit title/author (sha-cached forever) and
  // per-pipeline duration/user. Parallel, each best-effort.
  const enriched = await Promise.all(
    list.slice(0, window).map(async (p) => {
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

export interface GitlabJob {
  id: number
  name: string
  status: string
  started_at: string | null
  finished_at: string | null
  web_url: string
}

/** Jobs of one pipeline, in the slim shape the Hub shows. Throws when GitLab refuses. */
export async function gitlabJobs(ctx: GitCtx, pipelineId: number): Promise<GitlabJob[]> {
  const res = await fetchJson(
    gitlabApi(ctx, `/pipelines/${pipelineId}/jobs?per_page=50&include_retried=false`),
    gitHeaders(ctx)
  )
  if (!res.ok) throw new Error(`GitLab answered ${res.status}`)
  const list = (Array.isArray(res.body) ? res.body : []) as Array<Record<string, unknown>>
  return list.map((j) => ({
    id: Number(j.id),
    name: String(j.name ?? ''),
    status: String(j.status ?? ''),
    started_at: j.started_at ? String(j.started_at) : null,
    finished_at: j.finished_at ? String(j.finished_at) : null,
    web_url: String(j.web_url ?? '')
  }))
}
