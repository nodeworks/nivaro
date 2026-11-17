import { safeFetch } from '../../lib/ssrf.js'
import {
  type CreateIssueInput,
  type RemoteIssue,
  type RemoteNote,
  TrackerError,
  type TrackerProvider
} from './types.js'

const TIMEOUT_MS = 10000
const MAX_UPDATED = 500

function kindFor(status: number): TrackerError['kind'] {
  if (status === 401 || status === 403) return 'auth'
  if (status === 404) return 'not_found'
  if (status === 429) return 'rate'
  if (status >= 500) return 'server'
  return 'invalid'
}

/** Pull GitLab's own message/error text out of an error body (never the token). */
function errorText(raw: string): string {
  let text = raw
  try {
    const j = JSON.parse(raw)
    const m = j?.message ?? j?.error
    if (m !== undefined) text = typeof m === 'string' ? m : JSON.stringify(m)
  } catch {
    // not JSON — use the raw text
  }
  return text.slice(0, 300)
}

const pid = (id: string | number) => (typeof id === 'number' ? String(id) : encodeURIComponent(id))

export function gitlabProvider(
  cfg: { baseUrl: string; token: string },
  fetchImpl: typeof safeFetch = safeFetch
): TrackerProvider {
  const api = `${cfg.baseUrl.replace(/\/+$/, '')}/api/v4`

  async function call(
    path: string,
    init: { method?: string; json?: unknown; body?: Buffer; contentType?: string } = {}
  ): Promise<Response> {
    const headers: Record<string, string> = {
      'PRIVATE-TOKEN': cfg.token,
      accept: 'application/json'
    }
    let body: Buffer | string | undefined
    if (init.json !== undefined) {
      headers['content-type'] = 'application/json'
      body = JSON.stringify(init.json)
    } else if (init.body) {
      if (init.contentType) headers['content-type'] = init.contentType
      body = init.body
    }
    let res: Response
    try {
      res = await fetchImpl(`${api}${path}`, {
        method: init.method ?? 'GET',
        headers,
        body: body as RequestInit['body'],
        redirect: 'manual',
        timeoutMs: TIMEOUT_MS
      })
    } catch (err) {
      throw new TrackerError(
        `GitLab unreachable: ${err instanceof Error ? err.message : 'request failed'}`.slice(
          0,
          300
        ),
        null,
        'network'
      )
    }
    if (res.status >= 300 && res.status < 400) {
      let host = 'another address'
      try {
        const loc = res.headers.get('location')
        if (loc) host = new URL(loc, api).host
      } catch {
        // keep the generic wording
      }
      throw new TrackerError(
        `GitLab answered with a redirect to ${host} — set the connection URL to the address GitLab serves its API on`,
        res.status,
        'invalid'
      )
    }
    if (!res.ok) {
      let text = ''
      try {
        text = errorText(await res.text())
      } catch {
        // ignore
      }
      throw new TrackerError(
        `GitLab answered ${res.status}${text ? `: ${text}` : ''}`,
        res.status,
        kindFor(res.status)
      )
    }
    return res
  }

  async function json<T>(path: string, init?: Parameters<typeof call>[1]): Promise<T> {
    const res = await call(path, init)
    try {
      return (await res.json()) as T
    } catch {
      throw new TrackerError('GitLab answered with invalid JSON', res.status, 'server')
    }
  }

  const q = (params: Record<string, string | number | undefined>) => {
    const u = new URLSearchParams()
    for (const [k, v] of Object.entries(params)) if (v !== undefined) u.set(k, String(v))
    return u.toString()
  }

  const issue = (raw: any): RemoteIssue => ({
    id: raw.id,
    iid: raw.iid,
    project_id: raw.project_id,
    web_url: raw.web_url,
    title: raw.title,
    state: raw.state === 'closed' ? 'closed' : 'opened',
    labels: Array.isArray(raw.labels)
      ? raw.labels.map((l: any) => (typeof l === 'string' ? l : l?.name))
      : [],
    assignees: Array.isArray(raw.assignees)
      ? raw.assignees.map((a: any) => ({ id: a.id, username: a.username, name: a.name }))
      : [],
    milestone: raw.milestone ? { id: raw.milestone.id, title: raw.milestone.title } : null,
    updated_at: raw.updated_at,
    description: raw.description ?? null
  })

  const note = (raw: any): RemoteNote => ({
    id: raw.id,
    body: raw.body,
    author: { username: raw.author?.username ?? '', name: raw.author?.name ?? '' },
    created_at: raw.created_at,
    system: !!raw.system
  })

  return {
    async whoami() {
      const u = await json<any>('/user')
      return { username: u.username, name: u.name }
    },

    async project(idOrPath) {
      const p = await json<any>(`/projects/${pid(idOrPath)}`)
      const level = Math.max(
        p?.permissions?.project_access?.access_level ?? 0,
        p?.permissions?.group_access?.access_level ?? 0
      )
      return {
        id: p.id,
        path_with_namespace: p.path_with_namespace,
        access_level: level > 0 ? level : null
      }
    },

    async searchProjects(search) {
      const rows = await json<any[]>(
        `/projects?${q({ search, membership: 'true', simple: 'true', per_page: 20 })}`
      )
      return rows.map((p) => ({ id: p.id, path_with_namespace: p.path_with_namespace }))
    },

    async searchUsers(search, projectId) {
      const rows = await json<any[]>(`/projects/${projectId}/users?${q({ search, per_page: 20 })}`)
      return rows.map((u) => ({ id: u.id, username: u.username, name: u.name }))
    },

    async createIssue(projectId, input: CreateIssueInput) {
      const body: Record<string, unknown> = { title: input.title, description: input.description }
      if (input.labels?.length) body.labels = input.labels.join(',')
      if (input.assignee_ids?.length) body.assignee_ids = input.assignee_ids
      if (input.milestone_id !== undefined) body.milestone_id = input.milestone_id
      if (input.due_date) body.due_date = input.due_date
      if (input.weight !== undefined) body.weight = input.weight
      if (input.confidential !== undefined) body.confidential = input.confidential
      if (input.issue_type) body.issue_type = input.issue_type
      return issue(await json(`/projects/${projectId}/issues`, { method: 'POST', json: body }))
    },

    async getIssue(projectId, iid) {
      return issue(await json(`/projects/${projectId}/issues/${iid}`))
    },

    async findIssueByMarker(projectId, marker) {
      const rows = await json<any[]>(
        `/projects/${projectId}/issues?${q({ search: marker, in: 'description', per_page: 5 })}`
      )
      // GitLab search is fuzzy: require the exact marker text.
      const hit = rows.find(
        (r) => typeof r.description === 'string' && r.description.includes(marker)
      )
      return hit ? issue(hit) : null
    },

    async updatedIssues(projectId, since) {
      const out: RemoteIssue[] = []
      let page: string | number = 1
      while (page && out.length < MAX_UPDATED) {
        const res = await call(
          `/projects/${projectId}/issues?${q({
            updated_after: since.toISOString(),
            order_by: 'updated_at',
            sort: 'asc',
            per_page: 100,
            page
          })}`
        )
        const rows = (await res.json()) as any[]
        for (const r of rows) out.push(issue(r))
        page = res.headers.get('x-next-page') || ''
        if (!rows.length) break
      }
      return out.slice(0, MAX_UPDATED)
    },

    async setState(projectId, iid, state) {
      return issue(
        await json(`/projects/${projectId}/issues/${iid}`, {
          method: 'PUT',
          json: { state_event: state }
        })
      )
    },

    async addNote(projectId, iid, body) {
      return note(
        await json(`/projects/${projectId}/issues/${iid}/notes`, { method: 'POST', json: { body } })
      )
    },

    async notes(projectId, iid, since) {
      const rows = await json<any[]>(
        `/projects/${projectId}/issues/${iid}/notes?${q({
          sort: 'asc',
          order_by: 'created_at',
          per_page: 100
        })}`
      )
      const cut = since?.getTime()
      return rows
        .filter((r) => cut === undefined || new Date(r.created_at).getTime() > cut)
        .map(note)
    },

    async upload(projectId, file) {
      const form = new FormData()
      form.append('file', new Blob([new Uint8Array(file.data)], { type: file.mime }), file.name)
      // safeFetch does not take FormData; serialise it (gives the multipart boundary too).
      const enc = new Response(form)
      const res = await json<any>(`/projects/${projectId}/uploads`, {
        method: 'POST',
        body: Buffer.from(await enc.arrayBuffer()),
        contentType: enc.headers.get('content-type') ?? undefined
      })
      return { markdown: res.markdown }
    }
  }
}

/**
 * Parse `https://host/<projectPath>/-/issues/<iid>`. projectPath is everything between the
 * host and `/-/issues` (the connection's base path is not known here, so a GitLab served
 * under a path prefix yields that prefix as part of projectPath). Merge requests etc. → null.
 */
export function parseIssueUrl(url: string): { projectPath: string; iid: number } | null {
  let u: URL
  try {
    u = new URL(url)
  } catch {
    return null
  }
  const m = u.pathname.match(/^\/(.+?)\/-\/issues\/(\d+)\/?$/)
  if (!m) return null
  return { projectPath: m[1], iid: Number(m[2]) }
}
