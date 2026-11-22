// In-memory GitLab (REST v4, the calls the Hub's GitLab write client makes) and JSON endpoints
// for verify URLs, served through a `fetch` stub. Hub promotion tests run the real client over it.
// Phase 3 adds the provisioning calls: fork + import status, DELETE /fork, CI variables,
// protected branches, commit actions checked like GitLab (create vs update), GET /user and
// GET /namespaces/:id.

import { createHash } from 'node:crypto'
import type { GitCtx } from '../../../services/gitlab-client.js'

export interface JobSpec {
  name: string
  /** Statuses a GET /jobs/:id walks through (the last one stays). */
  statuses: string[]
  /** For a manual job: statuses after it is played. */
  onPlay?: string[]
  /** Statuses of the new job a retry starts (default running, success). */
  onRetry?: string[]
}

interface Job extends JobSpec {
  id: number
  at: number
  web_url: string
  plays: number
}

interface Pipeline {
  id: number
  ref: string
  sha: string
  web_url: string
  jobs: Job[]
}

interface MR {
  iid: number
  source: string
  target: string
  sha: string
  state: 'opened' | 'merged'
  merge_commit_sha: string | null
}

interface Project {
  branches: Map<string, string>
  commits: Map<string, { id: string; parents: string[]; title: string; tree: Map<string, string> }>
  mrs: Map<number, MR>
  pipelines: Pipeline[]
  /** The jobs every new pipeline of a (non-temporary) branch gets. */
  jobs: (ref: string) => JobSpec[]
  refuseMerge?: boolean
  /** Status every request answers instead (a broken token, a dead GitLab). */
  answerAll?: { status: number; body: unknown }
  /** Numeric project id (GitLab answers it; calls may name the project by it). */
  id?: number
  path_with_namespace?: string
  /** Project this one was forked from (null once DELETE /fork removed the relation). */
  forkedFrom?: string | null
  /** import_status values a GET /projects/:id walks through (the last one stays). */
  importStatuses?: string[]
  importAt?: number
  variables?: FakeVariable[]
  protectedBranches?: Map<string, { push_access_level: number; merge_access_level: number }>
  /** Project settings (PUT /projects/:id): the description the fork got, CI settings. */
  description?: string
  ci_config_path?: string
  ci_pipeline_variables_minimum_override_role?: string
  /** PUT /projects/:id answers this status instead of saving. */
  refuseSettings?: number
  /** Settings a PUT accepts (200) but does not keep (an older GitLab, a policy). */
  ignoreSettings?: string[]
}

export interface FakeVariable {
  key: string
  value: string
  environment_scope: string
  masked: boolean
  protected: boolean
  raw: boolean
}

/** GitLab's rule for a masked value: ≥ 8 characters of the Base64 alphabet plus @ : . ~ (one line). */
const MASKABLE = /^[A-Za-z0-9+/=@:.~-]{8,}$/

export interface Call {
  method: string
  url: string
  path: string
  token: string | null
  redirect: string | undefined
  body: unknown
}

let seq = 0
const sha = (s: string) => createHash('sha1').update(`${s}:${++seq}`).digest('hex')

export class FakeGitLab {
  base = 'https://gitlab.example.com'
  token = 'glpat-SECRET-hub-token-0123456789'
  projects = new Map<string, Project>()
  calls: Call[] = []
  /** url → answers in order (the last one repeats); a number = that HTTP status. */
  served = new Map<string, Array<Record<string, unknown> | number>>()
  servedReads = new Map<string, number>()
  private nextId = 100
  /** Namespaces a fork may land in (full path → kind). */
  namespaces = new Map<string, { id: number; kind: 'group' | 'user'; level: number | null }>()
  /** The user the token belongs to (GET /user). */
  user = { id: 7, username: 'hub-bot' }
  /** import_status values every new fork walks through. */
  forkImport: string[] = ['scheduled', 'started', 'finished']
  /** Status a fork into a taken path answers (GitLab versions answer 409 or 400). */
  forkTakenStatus = 409
  private projectSeq = 1000
  private byId = new Map<number, string>()

  ctx(project: string): GitCtx {
    return { provider: 'gitlab', base: this.base, project, token: this.token, ref: null }
  }

  project(name: string, jobs: (ref: string) => JobSpec[] = () => []): Project {
    const p: Project = {
      branches: new Map(),
      commits: new Map(),
      mrs: new Map(),
      pipelines: [],
      jobs
    }
    this.register(name, p)
    return p
  }

  private register(name: string, p: Project): void {
    p.id = this.projectSeq++
    p.path_with_namespace = name
    p.forkedFrom ??= null
    p.importStatuses ??= ['none']
    p.importAt = 0
    p.variables ??= []
    p.protectedBranches ??= new Map()
    this.projects.set(name, p)
    this.byId.set(p.id, name)
  }

  /** A namespace a fork may land in. */
  namespace(path: string, kind: 'group' | 'user' = 'group', level: number | null = 40): void {
    this.namespaces.set(path, { id: this.projectSeq++, kind, level })
  }

  variablesOf(project: string): FakeVariable[] {
    return this.must(project).variables ?? []
  }

  protectedOf(project: string): string[] {
    return [...(this.must(project).protectedBranches?.keys() ?? [])]
  }

  forkedFromOf(project: string): string | null {
    return this.must(project).forkedFrom ?? null
  }

  /** A commit on `branch` (created when missing) with `files` changed. */
  commit(
    project: string,
    branch: string,
    title: string,
    files: Record<string, string> = {}
  ): string {
    const p = this.must(project)
    const parent = p.branches.get(branch)
    const tree = new Map(parent ? p.commits.get(parent)?.tree : [])
    for (const [k, v] of Object.entries(files)) tree.set(k, v)
    const id = sha(title)
    p.commits.set(id, { id, parents: parent ? [parent] : [], title, tree })
    p.branches.set(branch, id)
    return id
  }

  /** Points `branch` at an existing commit (a fork). */
  branch(project: string, name: string, at: string): void {
    this.must(project).branches.set(name, at)
  }

  file(project: string, branch: string, path: string): string | null {
    const p = this.must(project)
    const head = p.branches.get(branch)
    return head ? (p.commits.get(head)?.tree.get(path) ?? null) : null
  }

  /** A pipeline that already exists for `sha` on `ref` (an old build). */
  pipeline(project: string, ref: string, at: string, jobs: JobSpec[]): Pipeline {
    const p = this.must(project)
    const id = this.nextId++
    const pl: Pipeline = {
      id,
      ref,
      sha: at,
      web_url: `${this.base}/pipelines/${id}`,
      jobs: jobs.map((j) => {
        const jid = this.nextId++
        return {
          ...j,
          statuses: [...j.statuses],
          id: jid,
          at: 0,
          plays: 0,
          web_url: `${this.base}/jobs/${jid}`
        }
      })
    }
    p.pipelines.push(pl)
    return pl
  }

  pipelinesOf(project: string): Pipeline[] {
    return this.must(project).pipelines
  }

  private must(name: string): Project {
    const p = this.projects.get(name)
    if (!p) throw new Error(`no fake project ${name}`)
    return p
  }

  private resolve(p: Project, ref: string): string | null {
    if (p.branches.has(ref)) return p.branches.get(ref) as string
    for (const id of p.commits.keys()) if (ref.length >= 7 && id.startsWith(ref)) return id
    return null
  }

  private ancestors(p: Project, head: string): Set<string> {
    const seen = new Set<string>()
    const stack = [head]
    while (stack.length) {
      const id = stack.pop() as string
      if (seen.has(id)) continue
      seen.add(id)
      for (const parent of p.commits.get(id)?.parents ?? []) stack.push(parent)
    }
    return seen
  }

  private moved(p: Project, ref: string, head: string) {
    if (ref.startsWith('hub/')) return
    const id = this.nextId++
    p.pipelines.push({
      id,
      ref,
      sha: head,
      web_url: `${this.base}/pipelines/${id}`,
      jobs: p.jobs(ref).map((j) => {
        const jid = this.nextId++
        return {
          ...j,
          statuses: [...j.statuses],
          id: jid,
          at: 0,
          plays: 0,
          web_url: `${this.base}/jobs/${jid}`
        }
      })
    })
  }

  private job(id: number): Job | null {
    return this.jobAndPipeline(id)?.job ?? null
  }

  private jobAndPipeline(id: number): { job: Job; pipeline: Pipeline } | null {
    for (const p of this.projects.values())
      for (const pl of p.pipelines)
        for (const j of pl.jobs) if (j.id === id) return { job: j, pipeline: pl }
    return null
  }

  /** Every job retried (old id → new id). */
  retries: Array<{ from: number; to: number }> = []

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    const json = (status: number, b?: unknown) =>
      new Response(b === undefined ? null : JSON.stringify(b), { status })

    const root = `${this.base}/api/v4`
    if (
      url === `${root}/user` ||
      url.startsWith(`${root}/namespaces/`) ||
      url.startsWith(`${root}/groups/`)
    ) {
      const path = decodeURIComponent(url.slice(root.length))
      this.calls.push({
        method,
        url,
        path,
        token: headers['PRIVATE-TOKEN'] ?? null,
        redirect: init.redirect,
        body
      })
      if (headers['PRIVATE-TOKEN'] !== this.token) return json(401, { message: '401 Unauthorized' })
      if (path === '/user') return json(200, { id: this.user.id, username: this.user.username })
      const member = path.match(/^\/groups\/(.+)\/members\/all\/(\d+)$/)
      if (member) {
        const g = this.namespaces.get(member[1])
        if (g?.kind !== 'group' || g.level == null || Number(member[2]) !== this.user.id)
          return json(404, { message: '404 Not found' })
        return json(200, { id: this.user.id, username: this.user.username, access_level: g.level })
      }
      const ns = path.slice('/namespaces/'.length)
      const found = this.namespaces.get(ns)
      return found
        ? json(200, { id: found.id, kind: found.kind, full_path: ns, path: ns.split('/').pop() })
        : json(404, { message: '404 Namespace Not Found' })
    }

    if (!url.startsWith(`${this.base}/api/v4/projects/`)) {
      const seqd = this.served.get(url)
      this.servedReads.set(url, (this.servedReads.get(url) ?? 0) + 1)
      if (!seqd?.length) return json(404, { error: 'not found' })
      const next = seqd.length > 1 ? (seqd.shift() as Record<string, unknown> | number) : seqd[0]
      return typeof next === 'number' ? json(next, {}) : json(200, next)
    }

    const rest = url.slice(`${this.base}/api/v4/projects/`.length)
    const cut = rest.search(/[/?]/)
    const slash = cut === -1 ? rest.length : cut
    const named = decodeURIComponent(rest.slice(0, slash))
    const project = /^\d+$/.test(named) ? (this.byId.get(Number(named)) ?? named) : named
    const u = new URL(`http://x/${rest.slice(slash).replace(/^\//, '')}`)
    const path = decodeURIComponent(u.pathname)
    const q = u.searchParams
    this.calls.push({
      method,
      url,
      path,
      token: headers['PRIVATE-TOKEN'] ?? null,
      redirect: init.redirect,
      body
    })
    const p = this.projects.get(project)
    if (!p) return json(404, { message: '404 Project Not Found' })
    if (p.answerAll) return json(p.answerAll.status, p.answerAll.body)
    if (headers['PRIVATE-TOKEN'] !== this.token) return json(401, { message: '401 Unauthorized' })

    let m: RegExpMatchArray | null
    const view = (proj: Project, status?: string) => ({
      id: proj.id,
      path_with_namespace: proj.path_with_namespace,
      description: proj.description ?? '',
      ci_config_path: proj.ci_config_path ?? '',
      ci_pipeline_variables_minimum_override_role:
        proj.ci_pipeline_variables_minimum_override_role ?? 'developer',
      web_url: `${this.base}/${proj.path_with_namespace}`,
      import_status: status ?? proj.importStatuses?.[proj.importAt ?? 0] ?? 'none',
      ...(proj.forkedFrom
        ? { forked_from_project: { id: this.projects.get(proj.forkedFrom)?.id } }
        : {})
    })
    if (method === 'PUT' && path === '/') {
      if (p.refuseSettings) return json(p.refuseSettings, { message: `refused ${this.token}` })
      for (const k of [
        'description',
        'ci_config_path',
        'ci_pipeline_variables_minimum_override_role'
      ] as const)
        if (body?.[k] !== undefined && !p.ignoreSettings?.includes(k)) p[k] = String(body[k])
      return json(200, view(p))
    }
    if (method === 'GET' && path === '/') {
      const out = view(p)
      const list = p.importStatuses ?? ['none']
      p.importAt = Math.min((p.importAt ?? 0) + 1, list.length - 1)
      return json(200, out)
    }
    if (method === 'POST' && path === '/fork') {
      const ns = String(body?.namespace_path ?? '')
      if (!this.namespaces.has(ns)) return json(404, { message: '404 Namespace Not Found' })
      const full = `${ns}/${body.path}`
      if (this.projects.has(full))
        return json(this.forkTakenStatus, {
          message: { path: ['has already been taken'], token: this.token }
        })
      const fork: Project = {
        branches: new Map(p.branches),
        commits: new Map(p.commits),
        mrs: new Map(),
        pipelines: [],
        jobs: p.jobs,
        forkedFrom: project,
        importStatuses: [...this.forkImport],
        ...(body?.description ? { description: String(body.description) } : {})
      }
      this.register(full, fork)
      const made = view(fork)
      fork.importAt = Math.min(1, this.forkImport.length - 1)
      return json(201, made)
    }
    if (method === 'DELETE' && path === '/fork') {
      if (!p.forkedFrom) return json(304)
      p.forkedFrom = null
      return json(204)
    }
    if (method === 'POST' && path === '/variables') {
      const key = String(body?.key ?? '')
      const scope = String(body?.environment_scope ?? '*')
      const vars = p.variables ?? []
      if (!/^[A-Za-z0-9_]{1,255}$/.test(key)) return json(400, { message: { key: ['is invalid'] } })
      if (body?.masked && !MASKABLE.test(String(body?.value ?? '')))
        return json(400, { message: { value: [`is invalid ${body.value}`] } })
      if (vars.some((v) => v.key === key && v.environment_scope === scope))
        return json(400, { message: { key: [`(${key}) has already been taken`] } })
      const v: FakeVariable = {
        key,
        value: String(body.value ?? ''),
        environment_scope: scope,
        masked: !!body.masked,
        protected: !!body.protected,
        raw: !!body.raw
      }
      vars.push(v)
      p.variables = vars
      return json(201, { ...v, value: undefined })
    }
    m = path.match(/^\/variables\/([^/]+)$/)
    if (m && method === 'PUT') {
      const key = m[1]
      const scope = q.get('filter[environment_scope]')
      const hits = (p.variables ?? []).filter(
        (v) => v.key === key && (scope == null || v.environment_scope === scope)
      )
      if (!hits.length) return json(404, { message: '404 Variable Not Found' })
      if (hits.length > 1) return json(409, { message: 'There are multiple variables with key' })
      const v = hits[0]
      if (body?.masked && !MASKABLE.test(String(body?.value ?? v.value)))
        return json(400, { message: { value: ['is invalid'] } })
      if (body?.value !== undefined) v.value = String(body.value)
      if (body?.masked !== undefined) v.masked = !!body.masked
      if (body?.protected !== undefined) v.protected = !!body.protected
      if (body?.raw !== undefined) v.raw = !!body.raw
      return json(200, { ...v, value: undefined })
    }
    if (method === 'POST' && path === '/protected_branches') {
      const name = String(body?.name ?? '')
      const prot = p.protectedBranches ?? new Map()
      p.protectedBranches = prot
      if (prot.has(name)) return json(409, { message: `Protected branch '${name}' already exists` })
      prot.set(name, {
        push_access_level: Number(body?.push_access_level ?? 40),
        merge_access_level: Number(body?.merge_access_level ?? 40)
      })
      return json(201, { name })
    }
    if (method === 'POST' && path === '/repository/branches') {
      const at = this.resolve(p, body.ref)
      if (!at || p.branches.has(body.branch)) return json(400, { message: 'bad ref' })
      p.branches.set(body.branch, at)
      return json(201, { name: body.branch, commit: { id: at } })
    }
    m = path.match(/^\/repository\/branches\/(.+)$/)
    if (m) {
      const name = m[1]
      if (method === 'DELETE') {
        if (!p.branches.delete(name)) return json(404, { message: 'no branch' })
        return json(204)
      }
      const head = p.branches.get(name)
      return head ? json(200, { name, commit: { id: head } }) : json(404, { message: 'no branch' })
    }
    if (method === 'POST' && path === '/merge_requests') {
      const iid = p.mrs.size + 1
      const mr: MR = {
        iid,
        source: body.source_branch,
        target: body.target_branch,
        sha: p.branches.get(body.source_branch) ?? '',
        state: 'opened',
        merge_commit_sha: null
      }
      p.mrs.set(iid, mr)
      return json(201, { iid, sha: mr.sha })
    }
    m = path.match(/^\/merge_requests\/(\d+)(\/merge)?$/)
    if (m) {
      const mr = p.mrs.get(Number(m[1]))
      if (!mr) return json(404, { message: 'no mr' })
      const view = () => ({
        iid: mr.iid,
        state: mr.state,
        detailed_merge_status: p.refuseMerge ? 'conflict' : 'mergeable',
        has_conflicts: !!p.refuseMerge,
        sha: mr.sha,
        target_branch: mr.target,
        merge_commit_sha: mr.merge_commit_sha
      })
      if (!m[2]) return json(200, view())
      if (p.refuseMerge) return json(405, { message: `405 Method Not Allowed ${this.token}` })
      const targetHead = p.branches.get(mr.target) as string
      const tree = new Map([
        ...(p.commits.get(targetHead)?.tree ?? []),
        ...(p.commits.get(mr.sha)?.tree ?? [])
      ])
      const id = sha('merge')
      p.commits.set(id, {
        id,
        parents: [targetHead, mr.sha],
        title: `Merge into ${mr.target}`,
        tree
      })
      p.branches.set(mr.target, id)
      mr.state = 'merged'
      mr.merge_commit_sha = id
      this.moved(p, mr.target, id)
      return json(200, view())
    }
    m = path.match(/^\/repository\/files\/(.+)$/)
    if (m) {
      const head = p.branches.get(q.get('ref') ?? '')
      const content = head ? p.commits.get(head)?.tree.get(m[1]) : undefined
      if (!head || content === undefined) return json(404, { message: '404 File Not Found' })
      return json(200, {
        content: Buffer.from(content).toString('base64'),
        encoding: 'base64',
        commit_id: head,
        last_commit_id: head
      })
    }
    if (method === 'POST' && path === '/repository/commits') {
      const parent = p.branches.get(body.branch)
      if (!parent) return json(400, { message: 'no branch' })
      const tree = new Map(p.commits.get(parent)?.tree)
      for (const a of body.actions) {
        if (a.action === 'create' && tree.has(a.file_path))
          return json(400, { message: 'A file with this name already exists' })
        if (a.action === 'update' && !tree.has(a.file_path))
          return json(400, { message: "A file with this name doesn't exist" })
        tree.set(a.file_path, a.content)
      }
      const id = sha(body.commit_message)
      p.commits.set(id, { id, parents: [parent], title: body.commit_message, tree })
      p.branches.set(body.branch, id)
      this.moved(p, body.branch, id)
      return json(201, { id })
    }
    if (method === 'GET' && path === '/repository/commits') {
      const head = p.branches.get(q.get('ref_name') ?? '')
      if (!head) return json(200, [])
      const list: Array<{ id: string; title: string }> = []
      for (let id: string | undefined = head; id; id = p.commits.get(id)?.parents[0])
        list.push({ id, title: p.commits.get(id)?.title ?? '' })
      const per = Number(q.get('per_page') ?? 20)
      const page = Number(q.get('page') ?? 1)
      return json(200, list.slice((page - 1) * per, page * per))
    }
    m = path.match(/^\/repository\/commits\/([^/]+)\/refs$/)
    if (m) {
      const id = this.resolve(p, m[1])
      if (!id) return json(404, { message: 'no commit' })
      const names = [...p.branches.entries()]
        .filter(([, head]) => this.ancestors(p, head).has(id))
        .map(([name]) => ({ type: 'branch', name }))
      return json(200, names)
    }
    m = path.match(/^\/repository\/commits\/([^/]+)$/)
    if (m) {
      const id = this.resolve(p, m[1])
      return id ? json(200, { id, short_id: id.slice(0, 8) }) : json(404, { message: 'no commit' })
    }
    if (path === '/pipelines') {
      const list = p.pipelines
        .filter((x) => x.ref === q.get('ref') && x.sha === q.get('sha'))
        .reverse()
        .map((x) => ({ id: x.id, web_url: x.web_url }))
      return json(200, list)
    }
    m = path.match(/^\/pipelines\/(\d+)\/jobs$/)
    if (m) {
      const pl = p.pipelines.find((x) => x.id === Number(m?.[1]))
      if (!pl) return json(404, { message: 'no pipeline' })
      return json(
        200,
        pl.jobs.map((j) => ({
          id: j.id,
          name: j.name,
          status: j.statuses[j.at],
          web_url: j.web_url
        }))
      )
    }
    m = path.match(/^\/jobs\/(\d+)\/retry$/)
    if (m && method === 'POST') {
      const found = this.jobAndPipeline(Number(m[1]))
      if (!found) return json(404, { message: 'no job' })
      const jid = this.nextId++
      const fresh: Job = {
        ...found.job,
        statuses: [...(found.job.onRetry ?? ['running', 'success'])],
        id: jid,
        at: 0,
        plays: 0,
        web_url: `${this.base}/jobs/${jid}`
      }
      found.pipeline.jobs.push(fresh)
      this.retries.push({ from: found.job.id, to: jid })
      return json(201, {
        id: jid,
        name: fresh.name,
        status: fresh.statuses[0],
        web_url: fresh.web_url
      })
    }
    m = path.match(/^\/jobs\/(\d+)(\/play)?$/)
    if (m) {
      const j = this.job(Number(m[1]))
      if (!j) return json(404, { message: 'no job' })
      if (m[2]) {
        if (j.statuses[j.at] !== 'manual') return json(400, { message: 'not manual' })
        j.plays++
        j.statuses = [...(j.onPlay ?? ['success'])]
        j.at = 0
        return json(200, { id: j.id, name: j.name, status: j.statuses[0], web_url: j.web_url })
      }
      const out = { id: j.id, name: j.name, status: j.statuses[j.at], web_url: j.web_url }
      j.at = Math.min(j.at + 1, j.statuses.length - 1)
      return json(200, out)
    }
    return json(404, { message: `fake has no ${method} ${path}` })
  }
}
