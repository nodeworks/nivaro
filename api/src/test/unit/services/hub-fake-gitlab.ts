// In-memory GitLab (REST v4, the calls the Hub's GitLab write client makes) and JSON endpoints
// for verify URLs, served through a `fetch` stub. Hub promotion tests run the real client over it.

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
  /** GitLab's failure_reason, answered while the job is failed. */
  failureReason?: string
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
}

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
  /**
   * url → answers in order (the last one repeats); a number = that HTTP status; a function is
   * asked at read time (an app whose answer follows what was deployed).
   */
  served = new Map<
    string,
    Array<Record<string, unknown> | number | (() => Record<string, unknown> | number)>
  >()
  servedReads = new Map<string, number>()
  private nextId = 100

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
    this.projects.set(name, p)
    return p
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
    this.order.set(id, ++seq)
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

  /** Merge requests merged into a branch (project → target branch → count). */
  merges(project: string, target: string): number {
    return [...this.must(project).mrs.values()].filter(
      (m) => m.target === target && m.state === 'merged'
    ).length
  }

  /**
   * A three-way merge of an MR's head into its target, file by file, as git does: a path both
   * sides changed differently since their newest common ancestor is a conflict.
   */
  private mergeTree(p: Project, mr: MR): { tree: Map<string, string>; conflicts: string[] } {
    const ours = p.branches.get(mr.target) as string
    const theirs = mr.sha
    const a = this.ancestors(p, ours)
    const common = [...this.ancestors(p, theirs)].filter((id) => a.has(id))
    const base = common.sort((x, y) => (this.order.get(y) ?? 0) - (this.order.get(x) ?? 0))[0]
    const t = (id: string | undefined) => (id ? (p.commits.get(id)?.tree ?? new Map()) : new Map())
    const [b, o, th] = [t(base), t(ours), t(theirs)]
    const tree = new Map<string, string>()
    const conflicts: string[] = []
    for (const path of new Set([...b.keys(), ...o.keys(), ...th.keys()])) {
      const [vb, vo, vt] = [b.get(path), o.get(path), th.get(path)]
      if (vo !== vb && vt !== vb && vo !== vt) conflicts.push(path)
      const v = vo === vb ? vt : vo
      if (v !== undefined) tree.set(path, v)
    }
    return { tree, conflicts }
  }

  /** Commit id → creation order (the newest common ancestor is a merge's base). */
  private order = new Map<string, number>()

  /** Every job retried (old id → new id). */
  retries: Array<{ from: number; to: number }> = []

  readonly fetch = async (input: string | URL, init: RequestInit = {}): Promise<Response> => {
    const url = String(input)
    const method = (init.method ?? 'GET').toUpperCase()
    const headers = (init.headers ?? {}) as Record<string, string>
    const body = init.body ? JSON.parse(String(init.body)) : undefined
    const json = (status: number, b?: unknown) =>
      new Response(b === undefined ? null : JSON.stringify(b), { status })

    if (!url.startsWith(`${this.base}/api/v4/projects/`)) {
      const seqd = this.served.get(url)
      this.servedReads.set(url, (this.servedReads.get(url) ?? 0) + 1)
      if (!seqd?.length) return json(404, { error: 'not found' })
      const head = seqd.length > 1 ? seqd.shift() : seqd[0]
      const next = typeof head === 'function' ? head() : head
      return typeof next === 'number' ? json(next, {}) : json(200, next)
    }

    const rest = url.slice(`${this.base}/api/v4/projects/`.length)
    const slash = rest.indexOf('/')
    const project = decodeURIComponent(rest.slice(0, slash))
    const u = new URL(`http://x${rest.slice(slash)}`)
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
      const conflict = () =>
        !!p.refuseMerge || (mr.state === 'opened' && !!this.mergeTree(p, mr).conflicts.length)
      const view = () => ({
        iid: mr.iid,
        state: mr.state,
        detailed_merge_status: conflict() ? 'conflict' : 'mergeable',
        has_conflicts: conflict(),
        sha: mr.sha,
        target_branch: mr.target,
        merge_commit_sha: mr.merge_commit_sha
      })
      if (!m[2]) return json(200, view())
      if (p.refuseMerge) return json(405, { message: `405 Method Not Allowed ${this.token}` })
      const targetHead = p.branches.get(mr.target) as string
      const merged = this.mergeTree(p, mr)
      if (merged.conflicts.length) return json(406, { message: 'Branch cannot be merged' })
      const tree = merged.tree
      const id = sha('merge')
      this.order.set(id, ++seq)
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
      for (const a of body.actions) tree.set(a.file_path, a.content)
      const id = sha(body.commit_message)
      this.order.set(id, ++seq)
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
      const out = {
        id: j.id,
        name: j.name,
        status: j.statuses[j.at],
        web_url: j.web_url,
        ...(j.statuses[j.at] === 'failed' && j.failureReason
          ? { failure_reason: j.failureReason }
          : {})
      }
      j.at = Math.min(j.at + 1, j.statuses.length - 1)
      return json(200, out)
    }
    return json(404, { message: `fake has no ${method} ${path}` })
  }
}
