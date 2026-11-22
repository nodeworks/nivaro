// GitLab write client for Hub promotions (phase 2): branches, merge requests, files, pipelines
// and deploy jobs — GitLab REST v4 only, never a local git process.
//
// Every call carries the token in the PRIVATE-TOKEN header only and refuses redirects
// ({ redirect: 'error' }), so the token is never resent to wherever a redirect points.
// Errors are GitlabWriteError { code, status, step }: they never carry the token or the text
// GitLab answered (a body can echo request data). The deploy branching is a port of
// scripts/promote-production.mjs pipelineFor / jobNamed / waitJob / runDeploy.

import { type FetchJsonOptions, fetchJson, type GitCtx, gitlabApi } from '../gitlab-client.js'

export class GitlabWriteError extends Error {
  code: string
  /** HTTP status GitLab answered; null when the error is not an HTTP answer. */
  status: number | null
  /** The client function that failed (createBranch, mergeMergeRequest, waitJob, …). */
  step: string
  /** The GitLab page of the job or pipeline concerned, when there is one. */
  webUrl?: string
  /** A project GitLab already made before the call failed (a fork whose import did not finish). */
  project?: { id: number; path_with_namespace: string }

  constructor(
    code: string,
    message: string,
    opts: {
      status?: number | null
      step: string
      webUrl?: string
      project?: { id: number; path_with_namespace: string }
    }
  ) {
    super(message)
    this.name = 'GitlabWriteError'
    this.code = code
    this.status = opts.status ?? null
    this.step = opts.step
    if (opts.webUrl) this.webUrl = opts.webUrl
    if (opts.project) this.project = opts.project
  }
}

export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>

/** Polling knobs every waiting function takes; tests pass a no-op sleep and a fake clock. */
export interface PollOptions {
  signal?: AbortSignal
  sleep?: Sleep
  now?: () => number
}

/** Job states a job never leaves on its own (manual = waiting to be played). */
export const JOB_TERMINAL = ['success', 'failed', 'canceled', 'skipped', 'manual'] as const
/** Deploy job states that mean "GitLab runs it on its own" (automatic deploy). */
const JOB_RUNNING = ['created', 'pending', 'running', 'waiting_for_resource', 'preparing']
/** Merge-request states GitLab is still computing (merging now would be refused). */
const MR_CHECKING = [
  'checking',
  'unchecked',
  'preparing',
  'approvals_syncing',
  'cannot_be_merged_recheck',
  // Pipelines-must-pass projects: wait (within the poll bound) for the MR pipeline.
  'ci_still_running',
  'ci_must_pass'
]

export const PIPELINE_POLLS = 40
export const PIPELINE_POLL_MS = 15_000
export const JOB_POLL_MS = 20_000
const MR_POLLS = 15
const MR_POLL_MS = 2_000
const BEFORE_JOB_MINUTES = 30

export const defaultSleep: Sleep = (ms, signal) =>
  new Promise<void>((resolve) => {
    if (signal?.aborted) return resolve()
    const t = setTimeout(done, ms)
    function done() {
      clearTimeout(t)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    signal?.addEventListener('abort', done, { once: true })
  })

export function checkAbort(signal: AbortSignal | undefined, step: string): void {
  if (signal?.aborted)
    throw new GitlabWriteError('ABORTED', 'Stopped before GitLab finished', { step })
}

async function pause(opts: PollOptions, ms: number, step: string): Promise<void> {
  await (opts.sleep ?? defaultSleep)(ms, opts.signal)
  checkAbort(opts.signal, step)
}

const enc = (s: string) => encodeURIComponent(s)

function httpCode(status: number): string {
  if (status === 401) return 'GITLAB_UNAUTHORIZED'
  if (status === 403) return 'GITLAB_FORBIDDEN'
  if (status === 404) return 'GITLAB_NOT_FOUND'
  return 'GITLAB_REFUSED'
}

export interface CallOptions {
  method?: string
  body?: unknown
  /** Statuses answered back to the caller instead of thrown. */
  allow?: number[]
  timeoutMs?: number
}

/**
 * The one authenticated GitLab request: token in PRIVATE-TOKEN only, redirects refused, errors
 * without body text. Every Hub GitLab call (project or root path) comes through here.
 */
async function send(
  url: string,
  ctx: GitCtx,
  step: string,
  opts: CallOptions
): Promise<{ status: number; body: unknown }> {
  if (!ctx.token) {
    throw new GitlabWriteError('GITLAB_NO_TOKEN', 'The deploy repository has no GitLab token', {
      step
    })
  }
  const fetchOpts: FetchJsonOptions = { redirect: 'error' }
  if (opts.method) fetchOpts.method = opts.method
  if (opts.body !== undefined) fetchOpts.body = opts.body
  let res: { ok: boolean; status: number; body: unknown }
  try {
    res = await fetchJson(
      url,
      { 'PRIVATE-TOKEN': ctx.token },
      opts.timeoutMs ?? (opts.method && opts.method !== 'GET' ? 30_000 : 15_000),
      fetchOpts
    )
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT') {
      throw new GitlabWriteError('FETCH_REDIRECT', `GitLab redirected ${step}; refused`, { step })
    }
    throw new GitlabWriteError('GITLAB_UNREACHABLE', `GitLab did not answer ${step}`, { step })
  }
  if (res.ok || opts.allow?.includes(res.status)) return { status: res.status, body: res.body }
  throw new GitlabWriteError(httpCode(res.status), `GitLab refused ${step} (${res.status})`, {
    status: res.status,
    step
  })
}

/** One authenticated call to a project path (/projects/:ctx.project<path>). */
async function call(
  ctx: GitCtx,
  step: string,
  path: string,
  opts: CallOptions = {}
): Promise<{ status: number; body: unknown }> {
  return send(gitlabApi(ctx, path), ctx, step, opts)
}

export { call as gitlabCall }

/**
 * Reads a response body as a stream and keeps only its last `maxBytes` bytes: a job log of any
 * size never sits in memory whole (chunks before the tail are dropped as the next arrive).
 */
async function streamTail(
  body: ReadableStream<Uint8Array> | null | undefined,
  maxBytes: number
): Promise<string> {
  if (!body) return ''
  const kept: Uint8Array[] = []
  let size = 0
  const reader = body.getReader()
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (!value?.length) continue
      kept.push(value)
      size += value.length
      // Drop whole chunks the tail no longer needs.
      while (kept.length > 1 && size - kept[0].length >= maxBytes)
        size -= (kept.shift() as Uint8Array).length
    }
  } finally {
    reader.releaseLock()
  }
  const all = Buffer.concat(kept)
  return all.subarray(Math.max(0, all.length - maxBytes)).toString('utf8')
}

/**
 * One authenticated GET of a project path answered as TEXT (a job log), same rules as every call:
 * token in PRIVATE-TOKEN only, redirects refused, errors without body text. The body is streamed
 * and only its last `maxBytes` bytes are kept (a job log ends with what matters).
 */
export async function gitlabTextCall(
  ctx: GitCtx,
  step: string,
  path: string,
  maxBytes = 65_536
): Promise<string> {
  if (!ctx.token) {
    throw new GitlabWriteError('GITLAB_NO_TOKEN', 'The deploy repository has no GitLab token', {
      step
    })
  }
  const ctl = new AbortController()
  const timer = setTimeout(() => ctl.abort(), 15_000)
  try {
    let res: Response
    try {
      res = await fetch(gitlabApi(ctx, path), {
        headers: { 'PRIVATE-TOKEN': ctx.token },
        redirect: 'error',
        signal: ctl.signal
      })
    } catch (err) {
      const cause = (err as { cause?: { message?: unknown } } | null)?.cause
      if (/redirect/i.test(String(cause?.message ?? ''))) {
        throw new GitlabWriteError('FETCH_REDIRECT', `GitLab redirected ${step}; refused`, { step })
      }
      throw new GitlabWriteError('GITLAB_UNREACHABLE', `GitLab did not answer ${step}`, { step })
    }
    if (!res.ok) {
      throw new GitlabWriteError(httpCode(res.status), `GitLab refused ${step} (${res.status})`, {
        status: res.status,
        step
      })
    }
    try {
      return await streamTail(res.body, maxBytes)
    } catch {
      // A body that breaks off (or the 15 s bound): never the stream's own error text.
      throw new GitlabWriteError('GITLAB_UNREACHABLE', `GitLab did not answer ${step}`, { step })
    }
  } finally {
    clearTimeout(timer)
  }
}

/** One authenticated call to a root API path outside /projects (GET /user, /namespaces/:id). */
export async function gitlabRootCall(
  ctx: GitCtx,
  step: string,
  path: string,
  opts: CallOptions = {}
): Promise<{ status: number; body: unknown }> {
  return send(`${ctx.base}/api/v4${path}`, ctx, step, opts)
}

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

// ── branches ──────────────────────────────────────────────────────────────────────────────

export async function createBranch(ctx: GitCtx, name: string, ref: string): Promise<void> {
  await call(ctx, 'createBranch', '/repository/branches', {
    method: 'POST',
    body: { branch: name, ref }
  })
}

/** Deletes a branch; a branch that is already gone (404) is fine. */
export async function deleteBranch(ctx: GitCtx, name: string): Promise<void> {
  await call(ctx, 'deleteBranch', `/repository/branches/${enc(name)}`, {
    method: 'DELETE',
    allow: [404]
  })
}

// ── merge requests ────────────────────────────────────────────────────────────────────────

/** Opens a merge request; answers its iid and head sha (read again while GitLab computes it). */
export async function openMergeRequest(
  ctx: GitCtx,
  source: string,
  target: string,
  title: string,
  opts: PollOptions = {}
): Promise<{ iid: number; sha: string }> {
  const step = 'openMergeRequest'
  const res = await call(ctx, step, '/merge_requests', {
    method: 'POST',
    body: {
      source_branch: source,
      target_branch: target,
      title,
      remove_source_branch: false
    }
  })
  const mr = obj(res.body)
  const iid = Number(mr.iid)
  if (!Number.isFinite(iid) || iid <= 0) {
    throw new GitlabWriteError('GITLAB_BAD_ANSWER', 'GitLab answered no merge request number', {
      step
    })
  }
  let sha = str(mr.sha)
  for (let i = 0; !sha && i < MR_POLLS; i++) {
    await pause(opts, MR_POLL_MS, step)
    const again = obj((await call(ctx, step, `/merge_requests/${iid}`)).body)
    sha = str(again.sha)
  }
  if (!sha) {
    throw new GitlabWriteError('MR_NO_SHA', `Merge request !${iid} never got a head commit`, {
      step
    })
  }
  return { iid, sha }
}

/** The commit a branch points at, or '' when GitLab does not know the branch. */
async function branchHead(ctx: GitCtx, branch: string, step: string): Promise<string> {
  const res = await call(ctx, step, `/repository/branches/${enc(branch)}`, { allow: [404] })
  if (res.status === 404) return ''
  return str(obj(obj(res.body).commit).id)
}

/**
 * The commit a merged MR left on its target branch: merge_commit_sha / squash_commit_sha, or —
 * for a fast-forward merge, which makes neither — the MR head, but only once the target branch
 * points at it. GitLab may answer the merge before it fills merge_commit_sha in, so the MR is
 * read again (≤ 15 × 2 s) instead of guessing.
 */
async function mergedSha(
  ctx: GitCtx,
  iid: number,
  first: Record<string, unknown>,
  opts: PollOptions,
  step: string
): Promise<string> {
  let mr = first
  for (let i = 0; ; i++) {
    const made = str(mr.merge_commit_sha) || str(mr.squash_commit_sha)
    if (made) return made
    const head = str(mr.sha)
    const target = str(mr.target_branch)
    if (head && target && (await branchHead(ctx, target, step)) === head) return head
    if (i + 1 >= MR_POLLS) break
    await pause(opts, MR_POLL_MS, step)
    mr = obj((await call(ctx, step, `/merge_requests/${iid}`)).body)
  }
  throw new GitlabWriteError(
    'MERGE_SHA_UNKNOWN',
    `Merge request !${iid} is merged but GitLab never named its merge commit`,
    { step }
  )
}

/**
 * Merges a merge request, guarded by `sha` (GitLab refuses when the source moved). Waits while
 * GitLab is still checking mergeability or the MR pipeline runs; a conflict, a closed MR or a
 * refusal (405/406/409/422) is MERGE_REFUSED. An MR that is already merged (a resumed
 * promotion) answers its merge commit without merging again.
 */
export async function mergeMergeRequest(
  ctx: GitCtx,
  iid: number,
  sha: string,
  opts: PollOptions = {}
): Promise<{ mergeSha: string }> {
  const step = 'mergeMergeRequest'
  for (let i = 0; ; i++) {
    checkAbort(opts.signal, step)
    const mr = obj((await call(ctx, step, `/merge_requests/${iid}`)).body)
    if (mr.state === 'merged') return { mergeSha: await mergedSha(ctx, iid, mr, opts, step) }
    if (mr.state === 'closed' || mr.state === 'locked') {
      throw new GitlabWriteError('MERGE_REFUSED', `Merge request !${iid} is ${mr.state}`, { step })
    }
    const state = str(mr.detailed_merge_status) || str(mr.merge_status)
    if (mr.has_conflicts === true || state === 'conflict' || state === 'cannot_be_merged') {
      throw new GitlabWriteError('MERGE_REFUSED', `Merge request !${iid} has conflicts`, { step })
    }
    if (!MR_CHECKING.includes(state) || i + 1 >= MR_POLLS) break
    await pause(opts, MR_POLL_MS, step)
  }
  checkAbort(opts.signal, step)
  let res: { status: number; body: unknown }
  try {
    res = await call(ctx, step, `/merge_requests/${iid}/merge`, {
      method: 'PUT',
      body: { sha, should_remove_source_branch: false, merge_when_pipeline_succeeds: false },
      timeoutMs: 60_000
    })
  } catch (err) {
    if (err instanceof GitlabWriteError && [405, 406, 409, 422].includes(err.status ?? 0)) {
      throw new GitlabWriteError(
        'MERGE_REFUSED',
        `GitLab refused to merge !${iid} (${err.status})`,
        { status: err.status, step }
      )
    }
    throw err
  }
  const merged = obj(res.body)
  if (merged.state !== 'merged') {
    throw new GitlabWriteError(
      'MERGE_REFUSED',
      `GitLab did not merge !${iid} (state ${str(merged.state) || 'unknown'})`,
      { status: res.status, step }
    )
  }
  return { mergeSha: await mergedSha(ctx, iid, merged, opts, step) }
}

// ── files and commits ─────────────────────────────────────────────────────────────────────

/** A file's text on `ref`; null when the file (or ref) does not exist. */
export async function readFile(ctx: GitCtx, path: string, ref: string): Promise<string | null> {
  const res = await call(ctx, 'readFile', `/repository/files/${enc(path)}?ref=${enc(ref)}`, {
    allow: [404]
  })
  if (res.status === 404) return null
  const f = obj(res.body)
  const content = str(f.content)
  return f.encoding === 'base64' ? Buffer.from(content, 'base64').toString('utf8') : content
}

/**
 * Writes `content` to `path` on `branch` as one commit (creates the file when missing). When the
 * file already holds exactly `content` nothing is committed: `changed: false` and `sha` = the
 * branch head (or the file's last commit). An update carries the probed last_commit_id, so
 * GitLab refuses it if someone changed the file in between.
 */
export async function commitFile(
  ctx: GitCtx,
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<{ sha: string; changed: boolean }> {
  const step = 'commitFile'
  const probe = await call(ctx, step, `/repository/files/${enc(path)}?ref=${enc(branch)}`, {
    allow: [404]
  })
  const exists = probe.status !== 404
  const file = obj(probe.body)
  if (exists) {
    const raw = str(file.content)
    const current = file.encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw
    const head = str(file.commit_id) || str(file.last_commit_id)
    if (current === content && head) return { sha: head, changed: false }
  }
  const lastCommit = str(file.last_commit_id)
  const action = exists
    ? {
        action: 'update',
        file_path: path,
        content,
        ...(lastCommit ? { last_commit_id: lastCommit } : {})
      }
    : { action: 'create', file_path: path, content }
  const res = await call(ctx, step, '/repository/commits', {
    method: 'POST',
    body: { branch, commit_message: message, actions: [action] }
  })
  const sha = str(obj(res.body).id)
  if (!sha) throw new GitlabWriteError('GITLAB_BAD_ANSWER', 'GitLab named no commit', { step })
  return { sha, changed: true }
}

/** The newest commit on `branch` (within the newest `limit`) whose subject matches `re`. */
export async function latestCommitMatching(
  ctx: GitCtx,
  branch: string,
  re: RegExp,
  limit = 100
): Promise<{ sha: string; subject: string } | null> {
  const test = new RegExp(re.source, re.flags.replace(/[gy]/g, ''))
  const perPage = Math.max(1, Math.min(limit, 100))
  let seen = 0
  for (let page = 1; seen < limit; page++) {
    const res = await call(
      ctx,
      'latestCommitMatching',
      `/repository/commits?ref_name=${enc(branch)}&per_page=${perPage}&page=${page}`
    )
    const list = Array.isArray(res.body) ? (res.body as Array<Record<string, unknown>>) : []
    for (const c of list.slice(0, limit - seen)) {
      const subject = (str(c.title) || str(c.message)).split('\n')[0]
      if (test.test(subject)) return { sha: str(c.id), subject }
    }
    seen += list.length
    if (list.length < perPage) break
  }
  return null
}

/** Whether commit `sha` is on `branch` (an unknown commit is false). */
export async function commitExistsOn(ctx: GitCtx, sha: string, branch: string): Promise<boolean> {
  for (let page = 1; page <= 10; page++) {
    const res = await call(
      ctx,
      'commitExistsOn',
      `/repository/commits/${enc(sha)}/refs?type=branch&per_page=100&page=${page}`,
      { allow: [404] }
    )
    if (res.status === 404) return false
    const list = Array.isArray(res.body) ? (res.body as Array<Record<string, unknown>>) : []
    if (list.some((r) => str(r.name) === branch)) return true
    if (list.length < 100) break
  }
  return false
}

// ── pipelines and jobs ────────────────────────────────────────────────────────────────────

export interface HubJob {
  id: number
  name: string
  status: string
  web_url: string
  /** When GitLab started the job (ISO), when it says so. */
  started_at?: string
}

function toJob(body: unknown): HubJob {
  const j = obj(body)
  const job: HubJob = {
    id: Number(j.id),
    name: str(j.name),
    status: str(j.status),
    web_url: str(j.web_url)
  }
  if (str(j.started_at)) job.started_at = str(j.started_at)
  return job
}

/** The pipeline GitLab created for `sha` on `ref`; waits ≤ 40 × 15 s for it to appear. */
export async function pipelineFor(
  ctx: GitCtx,
  ref: string,
  sha: string,
  opts: PollOptions & { onWait?: (attempt: number, of: number) => void } = {}
): Promise<{ id: number; web_url: string }> {
  const step = 'pipelineFor'
  for (let i = 1; ; i++) {
    checkAbort(opts.signal, step)
    const res = await call(ctx, step, `/pipelines?ref=${enc(ref)}&sha=${enc(sha)}&per_page=5`)
    const list = Array.isArray(res.body) ? (res.body as unknown[]) : []
    if (list.length) {
      const p = obj(list[0])
      return { id: Number(p.id), web_url: str(p.web_url) }
    }
    if (i >= PIPELINE_POLLS) {
      throw new GitlabWriteError(
        'PIPELINE_NOT_CREATED',
        `GitLab never created a pipeline for ${sha.slice(0, 8)} on ${ref}`,
        { step }
      )
    }
    opts.onWait?.(i, PIPELINE_POLLS)
    await pause(opts, PIPELINE_POLL_MS, step)
  }
}

/** The newest pipeline for `sha` on `ref` right now (one read, no waiting), or null. */
export async function findPipeline(
  ctx: GitCtx,
  ref: string,
  sha: string
): Promise<{ id: number; web_url: string } | null> {
  const res = await call(
    ctx,
    'findPipeline',
    `/pipelines?ref=${enc(ref)}&sha=${enc(sha)}&per_page=5`
  )
  const list = Array.isArray(res.body) ? (res.body as unknown[]) : []
  if (!list.length) return null
  const p = obj(list[0])
  return { id: Number(p.id), web_url: str(p.web_url) }
}

/** The newest (non-retried) job called `name` in a pipeline, or null. */
export async function jobNamed(
  ctx: GitCtx,
  pipelineId: number,
  name: string
): Promise<HubJob | null> {
  const res = await call(
    ctx,
    'jobNamed',
    `/pipelines/${pipelineId}/jobs?per_page=100&include_retried=false`
  )
  const list = (Array.isArray(res.body) ? res.body : []).map(toJob)
  return list.filter((j) => j.name === name).sort((a, b) => b.id - a.id)[0] ?? null
}

/**
 * Plays a manual job; answers the job GitLab started (it may carry a new id). `variables` ride
 * the play call only (job_variables_attributes); their values are never logged or put in an
 * error.
 */
export async function playJob(
  ctx: GitCtx,
  jobId: number,
  variables?: Record<string, string>
): Promise<HubJob> {
  const vars = Object.entries(variables ?? {}).map(([key, value]) => ({ key, value }))
  const res = await call(ctx, 'playJob', `/jobs/${jobId}/play`, {
    method: 'POST',
    body: vars.length ? { job_variables_attributes: vars } : {}
  })
  const job = toJob(res.body)
  return Number.isFinite(job.id) && job.id > 0 ? job : { ...job, id: jobId }
}

/**
 * Retries a finished job (a frontend rollback redeploys the old commit's own build); answers the
 * new job GitLab started. A refusal is JOB_RETRY_REFUSED with GitLab's status, never its text.
 */
export async function retryJob(ctx: GitCtx, jobId: number): Promise<HubJob> {
  const step = 'retryJob'
  let res: { status: number; body: unknown }
  try {
    res = await call(ctx, step, `/jobs/${jobId}/retry`, { method: 'POST' })
  } catch (err) {
    if (err instanceof GitlabWriteError && err.status != null) {
      throw new GitlabWriteError(
        'JOB_RETRY_REFUSED',
        `GitLab refused to retry job ${jobId} (${err.status})`,
        { status: err.status, step }
      )
    }
    throw err
  }
  const job = toJob(res.body)
  if (!Number.isFinite(job.id) || job.id <= 0) {
    throw new GitlabWriteError('GITLAB_BAD_ANSWER', 'GitLab named no retried job', { step })
  }
  return job
}

/** Polls a job every 20 s until it reaches a terminal state; JOB_TIMEOUT after `minutes`. */
export async function waitJob(
  ctx: GitCtx,
  jobId: number,
  opts: PollOptions & { minutes: number; onStatus?: (status: string) => void }
): Promise<{ id: number; status: string; web_url: string }> {
  const step = 'waitJob'
  const now = opts.now ?? Date.now
  const deadline = now() + opts.minutes * 60_000
  let last = ''
  for (;;) {
    checkAbort(opts.signal, step)
    const j = toJob((await call(ctx, step, `/jobs/${jobId}`)).body)
    const out = {
      id: Number.isFinite(j.id) && j.id > 0 ? j.id : jobId,
      status: j.status,
      web_url: j.web_url
    }
    if ((JOB_TERMINAL as readonly string[]).includes(j.status)) return out
    if (j.status !== last) opts.onStatus?.(j.status)
    last = j.status
    if (now() > deadline) {
      throw new GitlabWriteError(
        'JOB_TIMEOUT',
        `Job still ${j.status} after ${opts.minutes} min (${j.web_url})`,
        { step, webUrl: j.web_url || undefined }
      )
    }
    await pause(opts, JOB_POLL_MS, step)
  }
}

export type DeployEvent =
  | { kind: 'pipeline-wait'; attempt: number; of: number; message: string }
  | { kind: 'pipeline'; id: number; web_url: string; message: string }
  | { kind: 'job-status'; job: string; status: string; message: string }
  | { kind: 'already-succeeded'; job: string; web_url: string; message: string }
  | { kind: 'auto-run'; job: string; web_url: string; message: string }
  | { kind: 'play'; job: string; web_url: string; message: string }
  | { kind: 'passed'; job: string; web_url: string; message: string }

/**
 * Runs the deploy job of the pipeline for `sha` on `ref` (port of promote-production.mjs
 * runDeploy): wait for the `before` job to succeed, then — deploy already succeeded → done;
 * running on its own → wait for it; manual → play it and wait; anything else →
 * DEPLOY_JOB_UNEXPECTED. A deploy that ends other than success → DEPLOY_FAILED with its URL.
 * `variables` go with the play call only (DEPLOY_VARIABLES_REFUSED when the deploy already
 * started on its own); events and errors name their keys, never their values.
 */
export async function runDeployJob(
  ctx: GitCtx,
  ref: string,
  sha: string,
  opts: PollOptions & {
    before?: string | null
    /** Sent with the play call only; a deploy that already started on its own cannot take them. */
    variables?: Record<string, string>
    deploy: string
    minutes: number
    onEvent?: (e: DeployEvent) => void
  }
): Promise<{ status: 'success'; job: HubJob }> {
  const step = 'runDeployJob'
  const emit = (e: DeployEvent) => opts.onEvent?.(e)
  const poll: PollOptions = { signal: opts.signal, sleep: opts.sleep, now: opts.now }
  const p = await pipelineFor(ctx, ref, sha, {
    ...poll,
    onWait: (attempt, of) =>
      emit({
        kind: 'pipeline-wait',
        attempt,
        of,
        message: `waiting for the pipeline (${attempt}/${of})`
      })
  })
  emit({
    kind: 'pipeline',
    id: p.id,
    web_url: p.web_url,
    message: `pipeline ${p.id} (${p.web_url})`
  })

  const statusEvents = (job: string) => (status: string) =>
    emit({ kind: 'job-status', job, status, message: `${job}: ${status}` })

  if (opts.before) {
    const b = await jobNamed(ctx, p.id, opts.before)
    if (!b) {
      throw new GitlabWriteError('JOB_MISSING', `Pipeline ${p.id} has no ${opts.before} job`, {
        step,
        webUrl: p.web_url || undefined
      })
    }
    const done = await waitJob(ctx, b.id, {
      ...poll,
      minutes: BEFORE_JOB_MINUTES,
      onStatus: statusEvents(opts.before)
    })
    if (done.status !== 'success') {
      throw new GitlabWriteError(
        'BEFORE_JOB_FAILED',
        `${opts.before} ${done.status} (${done.web_url})`,
        { step, webUrl: done.web_url || undefined }
      )
    }
  }

  checkAbort(opts.signal, step)
  const d = await jobNamed(ctx, p.id, opts.deploy)
  if (!d) {
    throw new GitlabWriteError('JOB_MISSING', `Pipeline ${p.id} has no ${opts.deploy} job`, {
      step,
      webUrl: p.web_url || undefined
    })
  }
  const failed = (job: { status: string; web_url: string }) =>
    new GitlabWriteError(
      'DEPLOY_FAILED',
      `${opts.deploy} ${job.status} — the deploy script rolled back (${job.web_url})`,
      { step, webUrl: job.web_url || undefined }
    )

  if (d.status === 'success') {
    emit({
      kind: 'already-succeeded',
      job: opts.deploy,
      web_url: d.web_url,
      message: `${opts.deploy} already succeeded for this commit — not run again`
    })
    return { status: 'success', job: d }
  }
  // Deploys may run on their own (rules on_success / needs): the job is already queued or
  // running when the build finishes — wait for it instead of playing it.
  const varKeys = Object.keys(opts.variables ?? {})
  if (JOB_RUNNING.includes(d.status)) {
    if (varKeys.length) {
      throw new GitlabWriteError(
        'DEPLOY_VARIABLES_REFUSED',
        `${opts.deploy} already started on its own — it cannot take ${varKeys.join(', ')} (${d.web_url})`,
        { step, webUrl: d.web_url || undefined }
      )
    }
    emit({
      kind: 'auto-run',
      job: opts.deploy,
      web_url: d.web_url,
      message: `${opts.deploy} runs on its own (automatic deploy) — waiting for it`
    })
    const auto = await waitJob(ctx, d.id, {
      ...poll,
      minutes: opts.minutes,
      onStatus: statusEvents(opts.deploy)
    })
    if (auto.status !== 'success') throw failed(auto)
    emit({
      kind: 'passed',
      job: opts.deploy,
      web_url: auto.web_url,
      message: `${opts.deploy} passed`
    })
    return { status: 'success', job: { ...d, ...auto } }
  }
  if (d.status !== 'manual') {
    throw new GitlabWriteError(
      'DEPLOY_JOB_UNEXPECTED',
      `${opts.deploy} is ${d.status}, expected a manual job waiting to be played (${d.web_url})`,
      { step, webUrl: d.web_url || undefined }
    )
  }
  emit({
    kind: 'play',
    job: opts.deploy,
    web_url: d.web_url,
    message: `playing ${opts.deploy}${varKeys.length ? ` with ${varKeys.join(', ')}` : ''}`
  })
  const played = await playJob(ctx, d.id, opts.variables)
  const done = await waitJob(ctx, played.id, {
    ...poll,
    minutes: opts.minutes,
    onStatus: statusEvents(opts.deploy)
  })
  if (done.status !== 'success') throw failed(done)
  emit({
    kind: 'passed',
    job: opts.deploy,
    web_url: done.web_url,
    message: `${opts.deploy} passed`
  })
  return { status: 'success', job: { ...d, ...played, ...done, name: d.name } }
}
