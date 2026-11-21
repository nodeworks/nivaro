import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitCtx } from '../../../services/gitlab-client.js'
import {
  commitExistsOn,
  commitFile,
  createBranch,
  deleteBranch,
  GitlabWriteError,
  jobNamed,
  latestCommitMatching,
  mergeMergeRequest,
  openMergeRequest,
  pipelineFor,
  playJob,
  readFile,
  runDeployJob,
  waitJob
} from '../../../services/hub/gitlab-write.js'

const TOKEN = 'glpat-SECRET-token-123'
const ctx: GitCtx = {
  provider: 'gitlab',
  base: 'https://gl.test',
  project: 'grp/deploy',
  token: TOKEN,
  ref: 'main'
}
const P = '/api/v4/projects/grp%2Fdeploy'

interface Call {
  method: string
  url: string
  body: unknown
  init: { headers: Record<string, string>; redirect?: string; method?: string }
}
type Answer = { status?: number; body?: unknown } | undefined
type Route = (method: string, path: string, body: unknown, call: Call) => Answer

/** A fake GitLab: `route` answers (method, path-after-project) — unmatched calls answer 599. */
function gitlab(route: Route) {
  const calls: Call[] = []
  const f = vi.fn(async (url: string, init: Call['init'] & { body?: string }) => {
    const method = init.method ?? 'GET'
    const body = init.body ? JSON.parse(init.body) : undefined
    const call: Call = { method, url: String(url), body, init }
    calls.push(call)
    const u = String(url)
    const path = u.startsWith(`https://gl.test${P}`) ? u.slice(`https://gl.test${P}`.length) : u
    const a = route(method, path, body, call) ?? { status: 599, body: { message: 'unrouted' } }
    const status = a.status ?? 200
    return {
      ok: status < 400,
      status,
      text: async () => (a.body === undefined ? '' : JSON.stringify(a.body))
    }
  })
  vi.stubGlobal('fetch', f)
  return calls
}

function expectSafe(calls: Call[]) {
  expect(calls.length).toBeGreaterThan(0)
  for (const c of calls) {
    expect(c.init.redirect).toBe('error')
    expect(c.init.headers['PRIVATE-TOKEN']).toBe(TOKEN)
    expect(c.url).not.toContain(TOKEN)
    expect(JSON.stringify(c.body ?? null)).not.toContain(TOKEN)
  }
}

async function caught(p: Promise<unknown>): Promise<GitlabWriteError> {
  try {
    await p
  } catch (err) {
    expect(err).toBeInstanceOf(GitlabWriteError)
    return err as GitlabWriteError
  }
  throw new Error('expected a rejection')
}

const noSleep = async () => {}

afterEach(() => vi.unstubAllGlobals())

describe('errors', () => {
  it('carry code, status and step — never the token or the GitLab body text', async () => {
    gitlab(() => ({ status: 403, body: { message: `forbidden body text ${TOKEN}` } }))
    const err = await caught(createBranch(ctx, 'hub/promote-1-1', 'abc123'))
    expect(err.code).toBe('GITLAB_FORBIDDEN')
    expect(err.status).toBe(403)
    expect(err.step).toBe('createBranch')
    const text = `${err.message} ${JSON.stringify(err)} ${String(err.stack)}`
    expect(text).not.toContain(TOKEN)
    expect(text).not.toContain('forbidden body text')
  })

  it('an expired token answers GITLAB_UNAUTHORIZED', async () => {
    gitlab(() => ({ status: 401, body: { message: '401 Unauthorized' } }))
    const err = await caught(readFile(ctx, 'pin', 'main'))
    expect(err.code).toBe('GITLAB_UNAUTHORIZED')
  })

  it('a redirect is refused and named, a network failure is GITLAB_UNREACHABLE', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw Object.assign(new TypeError('fetch failed'), {
          cause: { message: 'unexpected redirect' }
        })
      })
    )
    expect((await caught(deleteBranch(ctx, 'x'))).code).toBe('FETCH_REDIRECT')
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError(`fetch failed ${TOKEN}`)
      })
    )
    const err = await caught(deleteBranch(ctx, 'x'))
    expect(err.code).toBe('GITLAB_UNREACHABLE')
    expect(err.message).not.toContain(TOKEN)
  })

  it('refuses to call without a token', async () => {
    const calls = gitlab(() => ({ body: {} }))
    const err = await caught(createBranch({ ...ctx, token: null }, 'b', 'main'))
    expect(err.code).toBe('GITLAB_NO_TOKEN')
    expect(calls).toHaveLength(0)
  })
})

describe('branches', () => {
  it('createBranch posts branch + ref', async () => {
    const calls = gitlab((m, p) =>
      m === 'POST' && p === '/repository/branches'
        ? { status: 201, body: { name: 'b' } }
        : undefined
    )
    await createBranch(ctx, 'hub/promote-7-1', 'deadbeef')
    expect(calls[0].body).toEqual({ branch: 'hub/promote-7-1', ref: 'deadbeef' })
    expectSafe(calls)
  })

  it('deleteBranch: 204 and 404 are both fine, other refusals throw', async () => {
    let status = 204
    const calls = gitlab((m, p) =>
      m === 'DELETE' && p === '/repository/branches/hub%2Fpromote-7-1' ? { status } : undefined
    )
    await deleteBranch(ctx, 'hub/promote-7-1')
    status = 404
    await deleteBranch(ctx, 'hub/promote-7-1')
    status = 500
    expect((await caught(deleteBranch(ctx, 'hub/promote-7-1'))).code).toBe('GITLAB_REFUSED')
    expectSafe(calls)
  })
})

describe('merge requests', () => {
  it('openMergeRequest answers iid + head sha', async () => {
    const calls = gitlab((m, p) =>
      m === 'POST' && p === '/merge_requests'
        ? { status: 201, body: { iid: 12, sha: 'aaa111' } }
        : undefined
    )
    expect(await openMergeRequest(ctx, 'hub/promote-7-1', 'production', 'Promote 0.3.9')).toEqual({
      iid: 12,
      sha: 'aaa111'
    })
    expect(calls[0].body).toMatchObject({
      source_branch: 'hub/promote-7-1',
      target_branch: 'production',
      title: 'Promote 0.3.9'
    })
    expectSafe(calls)
  })

  it('openMergeRequest reads the MR again while GitLab has not computed its sha yet', async () => {
    let reads = 0
    const calls = gitlab((m, p) => {
      if (m === 'POST' && p === '/merge_requests')
        return { status: 201, body: { iid: 3, sha: null } }
      if (m === 'GET' && p === '/merge_requests/3') {
        reads++
        return { body: { iid: 3, sha: reads < 2 ? null : 'bbb222' } }
      }
      return undefined
    })
    expect(await openMergeRequest(ctx, 's', 't', 'x', { sleep: noSleep })).toEqual({
      iid: 3,
      sha: 'bbb222'
    })
    expectSafe(calls)
  })

  it('mergeMergeRequest waits while GitLab checks, then merges with the sha guard', async () => {
    let reads = 0
    const calls = gitlab((m, p) => {
      if (m === 'GET' && p === '/merge_requests/12') {
        reads++
        return {
          body: { iid: 12, detailed_merge_status: reads < 3 ? 'checking' : 'mergeable' }
        }
      }
      if (m === 'PUT' && p === '/merge_requests/12/merge')
        return { body: { state: 'merged', merge_commit_sha: 'mmm333', sha: 'aaa111' } }
      return undefined
    })
    expect(await mergeMergeRequest(ctx, 12, 'aaa111', { sleep: noSleep })).toEqual({
      mergeSha: 'mmm333'
    })
    const put = calls.find((c) => c.method === 'PUT')
    expect(put?.body).toMatchObject({ sha: 'aaa111' })
    expect(reads).toBe(3)
    expectSafe(calls)
  })

  it('a fast-forward merge (no merge commit) answers the head sha', async () => {
    gitlab((m, p) => {
      if (m === 'GET') return { body: { iid: 1, merge_status: 'can_be_merged' } }
      if (m === 'PUT' && p === '/merge_requests/1/merge')
        return { body: { state: 'merged', merge_commit_sha: null, sha: 'fff000' } }
      return undefined
    })
    expect(await mergeMergeRequest(ctx, 1, 'fff000', { sleep: noSleep })).toEqual({
      mergeSha: 'fff000'
    })
  })

  it.each([405, 406, 409, 422])('GitLab answering %i is MERGE_REFUSED', async (status) => {
    gitlab((m) =>
      m === 'GET'
        ? { body: { iid: 1, detailed_merge_status: 'mergeable' } }
        : { status, body: { message: 'Branch cannot be merged' } }
    )
    const err = await caught(mergeMergeRequest(ctx, 1, 'abc', { sleep: noSleep }))
    expect(err.code).toBe('MERGE_REFUSED')
    expect(err.status).toBe(status)
    expect(err.step).toBe('mergeMergeRequest')
  })

  it('a merge request with conflicts is refused without trying the merge', async () => {
    const calls = gitlab((m) =>
      m === 'GET'
        ? { body: { iid: 1, has_conflicts: true, detailed_merge_status: 'conflict' } }
        : undefined
    )
    expect((await caught(mergeMergeRequest(ctx, 1, 'abc', { sleep: noSleep }))).code).toBe(
      'MERGE_REFUSED'
    )
    expect(calls.some((c) => c.method === 'PUT')).toBe(false)
  })
})

describe('files and commits', () => {
  it('readFile decodes the base64 content; 404 is null', async () => {
    const calls = gitlab((_m, p) => {
      if (p === '/repository/files/deploy%2Fpin.txt?ref=production')
        return {
          body: { encoding: 'base64', content: Buffer.from('0.3.9\nsha256:x\n').toString('base64') }
        }
      if (p.startsWith('/repository/files/missing'))
        return { status: 404, body: { message: '404 File Not Found' } }
      return undefined
    })
    expect(await readFile(ctx, 'deploy/pin.txt', 'production')).toBe('0.3.9\nsha256:x\n')
    expect(await readFile(ctx, 'missing', 'production')).toBeNull()
    expectSafe(calls)
  })

  it('commitFile updates an existing file and creates a missing one', async () => {
    let exists = true
    const calls = gitlab((m, p) => {
      if (m === 'GET' && p.startsWith('/repository/files/pin?ref=production'))
        return exists
          ? { body: { encoding: 'base64', content: Buffer.from('old').toString('base64') } }
          : { status: 404, body: { message: 'not found' } }
      if (m === 'POST' && p === '/repository/commits')
        return { status: 201, body: { id: 'ccc999' } }
      return undefined
    })
    expect(await commitFile(ctx, 'production', 'pin', 'new\n', 'chore: pin nivaro 0.3.9')).toEqual({
      sha: 'ccc999'
    })
    const first = calls.find((c) => c.method === 'POST')
    expect(first?.body).toEqual({
      branch: 'production',
      commit_message: 'chore: pin nivaro 0.3.9',
      actions: [{ action: 'update', file_path: 'pin', content: 'new\n' }]
    })
    exists = false
    await commitFile(ctx, 'production', 'pin', 'new\n', 'm')
    const second = calls.filter((c) => c.method === 'POST')[1]
    expect((second.body as { actions: Array<{ action: string }> }).actions[0].action).toBe('create')
    expectSafe(calls)
  })

  it('latestCommitMatching walks newest first and pages up to the limit', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({
      id: `p1-${i}`,
      title: `chore: other ${i}`
    }))
    const page2 = [
      { id: 'hit-new', title: 'chore: sync for nivaro 0.3.9' },
      { id: 'hit-old', title: 'chore: sync for nivaro 0.3.9' }
    ]
    const calls = gitlab((_m, p) => {
      const q = /^\/repository\/commits\?ref_name=main&per_page=(\d+)&page=(\d+)$/.exec(p)
      if (!q) return undefined
      const per = Number(q[1])
      const all = [...page1, ...page2]
      return { body: all.slice((Number(q[2]) - 1) * per, Number(q[2]) * per) }
    })
    expect(await latestCommitMatching(ctx, 'main', /nivaro 0\.3\.9\b/g, 200)).toEqual({
      sha: 'hit-new',
      subject: 'chore: sync for nivaro 0.3.9'
    })
    expect(await latestCommitMatching(ctx, 'main', /nivaro 0\.3\.9\b/)).toBeNull()
    expect(await latestCommitMatching(ctx, 'main', /other 7$/, 20)).toEqual({
      sha: 'p1-7',
      subject: 'chore: other 7'
    })
    expect(calls.at(-1)?.url).toContain('per_page=20')
    expectSafe(calls)
  })

  it('commitExistsOn reads the branches holding the commit; an unknown commit is false', async () => {
    const calls = gitlab((_m, p) => {
      if (p === '/repository/commits/abc/refs?type=branch&per_page=100&page=1')
        return {
          body: [
            { type: 'branch', name: 'main' },
            { type: 'branch', name: 'dev' }
          ]
        }
      if (p.startsWith('/repository/commits/nope/refs')) return { status: 404, body: {} }
      return undefined
    })
    expect(await commitExistsOn(ctx, 'abc', 'main')).toBe(true)
    expect(await commitExistsOn(ctx, 'abc', 'production')).toBe(false)
    expect(await commitExistsOn(ctx, 'nope', 'main')).toBe(false)
    expectSafe(calls)
  })
})

describe('pipelines and jobs', () => {
  it('pipelineFor waits for GitLab to create the pipeline', async () => {
    let polls = 0
    const waits: number[] = []
    const calls = gitlab((_m, p) => {
      if (p === '/pipelines?ref=production&sha=abc&per_page=5') {
        polls++
        return {
          body: polls < 3 ? [] : [{ id: 55, web_url: 'https://gl.test/p/55', status: 'running' }]
        }
      }
      return undefined
    })
    const sleep = vi.fn(async () => {})
    expect(
      await pipelineFor(ctx, 'production', 'abc', { sleep, onWait: (i) => waits.push(i) })
    ).toEqual({ id: 55, web_url: 'https://gl.test/p/55' })
    expect(waits).toEqual([1, 2])
    expect(sleep).toHaveBeenCalledWith(15_000, undefined)
    expectSafe(calls)
  })

  it('pipelineFor gives up after 40 polls', async () => {
    const calls = gitlab(() => ({ body: [] }))
    const sleep = vi.fn(async () => {})
    const err = await caught(pipelineFor(ctx, 'production', 'abcdef1234', { sleep }))
    expect(err.code).toBe('PIPELINE_NOT_CREATED')
    expect(calls).toHaveLength(40)
    expect(sleep).toHaveBeenCalledTimes(39)
  })

  it('pipelineFor stops when the signal aborts', async () => {
    const ctl = new AbortController()
    const calls = gitlab(() => ({ body: [] }))
    const sleep = vi.fn(async () => {
      if (sleep.mock.calls.length === 2) ctl.abort()
    })
    const err = await caught(pipelineFor(ctx, 'production', 'abc', { sleep, signal: ctl.signal }))
    expect(err.code).toBe('ABORTED')
    expect(calls).toHaveLength(2)
  })

  it('jobNamed picks the newest job of that name', async () => {
    const calls = gitlab((_m, p) =>
      p === '/pipelines/55/jobs?per_page=100&include_retried=false'
        ? {
            body: [
              { id: 1, name: 'deploy', status: 'failed', web_url: 'u1' },
              { id: 3, name: 'deploy', status: 'manual', web_url: 'u3' },
              { id: 2, name: 'build', status: 'success', web_url: 'u2' }
            ]
          }
        : undefined
    )
    expect(await jobNamed(ctx, 55, 'deploy')).toEqual({
      id: 3,
      name: 'deploy',
      status: 'manual',
      web_url: 'u3'
    })
    expect(await jobNamed(ctx, 55, 'nope')).toBeNull()
    expectSafe(calls)
  })

  it('playJob posts play and answers the job', async () => {
    const calls = gitlab((m, p) =>
      m === 'POST' && p === '/jobs/3/play'
        ? { body: { id: 4, name: 'deploy', status: 'pending', web_url: 'u4' } }
        : undefined
    )
    expect(await playJob(ctx, 3)).toEqual({
      id: 4,
      name: 'deploy',
      status: 'pending',
      web_url: 'u4'
    })
    expectSafe(calls)
  })

  it('waitJob polls every 20 s until a terminal state and reports status changes', async () => {
    const seq = ['pending', 'running', 'running', 'success']
    let i = 0
    const calls = gitlab((_m, p) =>
      p === '/jobs/9' ? { body: { id: 9, status: seq[i++], web_url: 'u9' } } : undefined
    )
    const seen: string[] = []
    const sleep = vi.fn(async () => {})
    const j = await waitJob(ctx, 9, { minutes: 10, sleep, onStatus: (s) => seen.push(s) })
    expect(j).toEqual({ id: 9, status: 'success', web_url: 'u9' })
    expect(seen).toEqual(['pending', 'running'])
    expect(sleep).toHaveBeenCalledWith(20_000, undefined)
    expectSafe(calls)
  })

  it.each(['failed', 'canceled', 'skipped', 'manual'])('waitJob returns on %s', async (status) => {
    gitlab(() => ({ body: { id: 9, status, web_url: 'u9' } }))
    expect((await waitJob(ctx, 9, { minutes: 1, sleep: noSleep })).status).toBe(status)
  })

  it('waitJob gives up after its minutes with the job URL', async () => {
    gitlab(() => ({ body: { id: 9, status: 'running', web_url: 'https://gl.test/j/9' } }))
    let t = 0
    const now = () => t
    const sleep = vi.fn(async (ms: number) => {
      t += ms
    })
    const err = await caught(waitJob(ctx, 9, { minutes: 1, sleep, now }))
    expect(err.code).toBe('JOB_TIMEOUT')
    expect(err.webUrl).toBe('https://gl.test/j/9')
    expect(err.message).toContain('https://gl.test/j/9')
  })

  it('waitJob stops when the signal aborts', async () => {
    gitlab(() => ({ body: { id: 9, status: 'running', web_url: 'u' } }))
    const ctl = new AbortController()
    ctl.abort()
    expect(
      (await caught(waitJob(ctx, 9, { minutes: 5, sleep: noSleep, signal: ctl.signal }))).code
    ).toBe('ABORTED')
  })
})

describe('runDeployJob', () => {
  /** GitLab with one pipeline (55) holding `jobs`; job statuses advance through `next`. */
  function deployGitlab(
    jobs: Array<{ id: number; name: string; status: string }>,
    next: Record<number, string[]> = {}
  ) {
    const plays: number[] = []
    const calls = gitlab((m, p) => {
      if (p.startsWith('/pipelines?'))
        return { body: [{ id: 55, web_url: 'https://gl.test/p/55' }] }
      if (p.startsWith('/pipelines/55/jobs'))
        return { body: jobs.map((j) => ({ ...j, web_url: `https://gl.test/j/${j.id}` })) }
      const play = /^\/jobs\/(\d+)\/play$/.exec(p)
      if (m === 'POST' && play) {
        plays.push(Number(play[1]))
        return {
          body: { id: 100, name: 'deploy', status: 'pending', web_url: 'https://gl.test/j/100' }
        }
      }
      const job = /^\/jobs\/(\d+)$/.exec(p)
      if (job) {
        const id = Number(job[1])
        const queue = next[id] ?? []
        const status = queue.length > 1 ? (queue.shift() as string) : (queue[0] ?? 'success')
        return { body: { id, status, web_url: `https://gl.test/j/${id}` } }
      }
      return undefined
    })
    return { calls, plays }
  }
  const base = { deploy: 'deploy', minutes: 60, sleep: noSleep }

  it('deploy already succeeded for this commit → not run again', async () => {
    const { calls, plays } = deployGitlab([{ id: 7, name: 'deploy', status: 'success' }])
    const events: string[] = []
    const r = await runDeployJob(ctx, 'production', 'abc', {
      ...base,
      onEvent: (e) => events.push(e.kind)
    })
    expect(r).toEqual({
      status: 'success',
      job: { id: 7, name: 'deploy', status: 'success', web_url: 'https://gl.test/j/7' }
    })
    expect(plays).toEqual([])
    expect(events).toContain('already-succeeded')
    expectSafe(calls)
  })

  it('deploy running on its own → waits for it, never plays it', async () => {
    const { plays } = deployGitlab([{ id: 7, name: 'deploy', status: 'running' }], {
      7: ['running', 'success']
    })
    const events: string[] = []
    const r = await runDeployJob(ctx, 'production', 'abc', {
      ...base,
      onEvent: (e) => events.push(e.kind)
    })
    expect(r.status).toBe('success')
    expect(r.job.id).toBe(7)
    expect(plays).toEqual([])
    expect(events).toContain('auto-run')
  })

  it('manual deploy → plays it and waits for the played job', async () => {
    const { plays, calls } = deployGitlab([{ id: 7, name: 'deploy', status: 'manual' }], {
      100: ['pending', 'running', 'success']
    })
    const r = await runDeployJob(ctx, 'production', 'abc', base)
    expect(plays).toEqual([7])
    expect(r.job).toMatchObject({ id: 100, status: 'success' })
    expect(calls.some((c) => c.url.endsWith('/jobs/100'))).toBe(true)
  })

  it('waits for the before job first; a failed before job stops before the deploy', async () => {
    const ok = deployGitlab(
      [
        { id: 6, name: 'build_extension', status: 'running' },
        { id: 7, name: 'deploy', status: 'manual' }
      ],
      { 6: ['running', 'success'] }
    )
    await runDeployJob(ctx, 'production', 'abc', { ...base, before: 'build_extension' })
    expect(ok.plays).toEqual([7])

    const bad = deployGitlab(
      [
        { id: 6, name: 'build_extension', status: 'running' },
        { id: 7, name: 'deploy', status: 'manual' }
      ],
      { 6: ['failed'] }
    )
    const err = await caught(
      runDeployJob(ctx, 'production', 'abc', { ...base, before: 'build_extension' })
    )
    expect(err.code).toBe('BEFORE_JOB_FAILED')
    expect(err.webUrl).toBe('https://gl.test/j/6')
    expect(bad.plays).toEqual([])
  })

  it('a missing job is JOB_MISSING', async () => {
    deployGitlab([{ id: 6, name: 'build', status: 'success' }])
    expect((await caught(runDeployJob(ctx, 'production', 'abc', base))).code).toBe('JOB_MISSING')
  })

  it('a failed deploy is DEPLOY_FAILED with the job URL (played and automatic)', async () => {
    deployGitlab([{ id: 7, name: 'deploy', status: 'manual' }], { 100: ['running', 'failed'] })
    const played = await caught(runDeployJob(ctx, 'production', 'abc', base))
    expect(played.code).toBe('DEPLOY_FAILED')
    expect(played.webUrl).toBe('https://gl.test/j/100')
    expect(played.message).toContain('https://gl.test/j/100')

    deployGitlab([{ id: 7, name: 'deploy', status: 'pending' }], { 7: ['running', 'failed'] })
    const auto = await caught(runDeployJob(ctx, 'production', 'abc', base))
    expect(auto.code).toBe('DEPLOY_FAILED')
    expect(auto.webUrl).toBe('https://gl.test/j/7')
  })

  it.each([
    'failed',
    'canceled',
    'skipped',
    'created_weird'
  ])('a deploy job that is %s (not manual, not running) is DEPLOY_JOB_UNEXPECTED', async (status) => {
    const { plays } = deployGitlab([{ id: 7, name: 'deploy', status }])
    const err = await caught(runDeployJob(ctx, 'production', 'abc', base))
    expect(err.code).toBe('DEPLOY_JOB_UNEXPECTED')
    expect(plays).toEqual([])
  })

  it('stops when the signal aborts', async () => {
    deployGitlab([{ id: 7, name: 'deploy', status: 'manual' }])
    const ctl = new AbortController()
    ctl.abort()
    expect(
      (await caught(runDeployJob(ctx, 'production', 'abc', { ...base, signal: ctl.signal }))).code
    ).toBe('ABORTED')
  })
})
