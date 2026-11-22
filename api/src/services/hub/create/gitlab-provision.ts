// GitLab provisioning calls for Hub app creation (phase 3): fork the template project into the
// target namespace and cut the fork link, create and protect environment branches, set CI
// variables and commit the per-environment files — GitLab REST v4 only, never a local git.
//
// Every project call goes through gitlabCall (gitlab-write.ts): the token rides PRIVATE-TOKEN
// only, redirects are refused, and errors are GitlabWriteError without GitLab's answer text (a
// body can echo request data — for a variable, its value). The two account calls (GET /user,
// GET /namespaces/:id) are not under /projects/:id, which gitlabCall always builds, so they go
// through rootCall below: the same three guarantees, for a root API path.
//
// Variable values never appear in a log, an error or a return value.

import { type FetchJsonOptions, fetchJson, type GitCtx } from '../../gitlab-client.js'
import { GitlabWriteError, gitlabCall, type PollOptions } from '../gitlab-write.js'

export const IMPORT_POLLS = 40
export const IMPORT_POLL_MS = 3_000
/** Push and merge access level for protected environment branches (Maintainers). */
const MAINTAINER = 40

const enc = (s: string) => encodeURIComponent(s)

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** The same context, aimed at another project (a path or a numeric id). */
function at(ctx: GitCtx, project: string | number): GitCtx {
  return { ...ctx, project: String(project) }
}

const defaultSleep = (ms: number, signal?: AbortSignal) =>
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

function checkAbort(signal: AbortSignal | undefined, step: string): void {
  if (signal?.aborted)
    throw new GitlabWriteError('ABORTED', 'Stopped before GitLab finished', { step })
}

function httpCode(status: number): string {
  if (status === 401) return 'GITLAB_UNAUTHORIZED'
  if (status === 403) return 'GITLAB_FORBIDDEN'
  if (status === 404) return 'GITLAB_NOT_FOUND'
  return 'GITLAB_REFUSED'
}

/**
 * One authenticated call to a GitLab API path outside /projects/:id (GET /user,
 * GET /namespaces/:id). Same rules as gitlabCall: token header only, redirects refused, errors
 * without body text.
 */
async function rootCall(
  ctx: GitCtx,
  step: string,
  path: string,
  allow: number[] = []
): Promise<{ status: number; body: unknown }> {
  if (!ctx.token) {
    throw new GitlabWriteError('GITLAB_NO_TOKEN', 'The target has no GitLab token', { step })
  }
  const opts: FetchJsonOptions = { redirect: 'error' }
  let res: { ok: boolean; status: number; body: unknown }
  try {
    res = await fetchJson(`${ctx.base}/api/v4${path}`, { 'PRIVATE-TOKEN': ctx.token }, 15_000, opts)
  } catch (err) {
    if ((err as { code?: unknown } | null)?.code === 'FETCH_REDIRECT') {
      throw new GitlabWriteError('FETCH_REDIRECT', `GitLab redirected ${step}; refused`, { step })
    }
    throw new GitlabWriteError('GITLAB_UNREACHABLE', `GitLab did not answer ${step}`, { step })
  }
  if (res.ok || allow.includes(res.status)) return { status: res.status, body: res.body }
  throw new GitlabWriteError(httpCode(res.status), `GitLab refused ${step} (${res.status})`, {
    status: res.status,
    step
  })
}

// ── account ──────────────────────────────────────────────────────────────────────────────

/** The user the token belongs to (a refused token is GITLAB_UNAUTHORIZED). */
export async function currentUser(ctx: GitCtx): Promise<{ id: number; username: string }> {
  const u = obj((await rootCall(ctx, 'currentUser', '/user')).body)
  return { id: Number(u.id), username: str(u.username) }
}

/** A namespace (group or user) by full path; null when GitLab does not know it (or hides it). */
export async function namespaceExists(
  ctx: GitCtx,
  namespace: string
): Promise<{ id: number; kind: string; full_path: string } | null> {
  const res = await rootCall(ctx, 'namespaceExists', `/namespaces/${enc(namespace)}`, [404])
  if (res.status === 404) return null
  const n = obj(res.body)
  return { id: Number(n.id), kind: str(n.kind), full_path: str(n.full_path) || namespace }
}

// ── projects ─────────────────────────────────────────────────────────────────────────────

/** A project by path (or id); null when GitLab answers 404. */
export async function projectExists(
  ctx: GitCtx,
  path: string
): Promise<{ id: number; path_with_namespace: string } | null> {
  const res = await gitlabCall(at(ctx, path), 'projectExists', '', { allow: [404] })
  if (res.status === 404) return null
  const p = obj(res.body)
  return { id: Number(p.id), path_with_namespace: str(p.path_with_namespace) }
}

/**
 * Forks `template` into `<namespace>/<path>`, waits for GitLab's import to finish (≤ 40 × 3 s:
 * IMPORT_FAILED / IMPORT_TIMEOUT) and then removes the fork relation, so the deploy repository
 * is a project of its own (no merge requests back to the template). A taken path is
 * PROJECT_EXISTS.
 */
export async function forkProject(
  ctx: GitCtx,
  template: string,
  namespace: string,
  path: string,
  name: string,
  opts: PollOptions = {}
): Promise<{ id: number; path_with_namespace: string; web_url: string }> {
  const step = 'forkProject'
  checkAbort(opts.signal, step)
  let res: { status: number; body: unknown }
  try {
    res = await gitlabCall(at(ctx, template), step, '/fork', {
      method: 'POST',
      body: { namespace_path: namespace, path, name },
      timeoutMs: 60_000
    })
  } catch (err) {
    if (err instanceof GitlabWriteError && err.status === 409) {
      throw new GitlabWriteError(
        'PROJECT_EXISTS',
        `GitLab already has a project at ${namespace}/${path}`,
        { status: 409, step }
      )
    }
    throw err
  }
  const made = obj(res.body)
  const id = Number(made.id)
  if (!Number.isFinite(id) || id <= 0) {
    throw new GitlabWriteError('GITLAB_BAD_ANSWER', 'GitLab answered no project id for the fork', {
      step
    })
  }
  let project = made
  const sleep = opts.sleep ?? defaultSleep
  for (let i = 0; ; i++) {
    const status = str(project.import_status)
    if (status === 'finished' || status === 'none') break
    if (status === 'failed') {
      throw new GitlabWriteError('IMPORT_FAILED', `GitLab could not copy ${template}`, { step })
    }
    if (i >= IMPORT_POLLS) {
      throw new GitlabWriteError(
        'IMPORT_TIMEOUT',
        `GitLab was still copying ${template} after ${(IMPORT_POLLS * IMPORT_POLL_MS) / 1000} s`,
        { step }
      )
    }
    await sleep(IMPORT_POLL_MS, opts.signal)
    checkAbort(opts.signal, step)
    project = obj((await gitlabCall(at(ctx, id), step, '')).body)
  }
  // 304 = no fork relation (already removed by an earlier try).
  await gitlabCall(at(ctx, id), step, '/fork', { method: 'DELETE', allow: [304] })
  return {
    id,
    path_with_namespace: str(project.path_with_namespace) || str(made.path_with_namespace),
    web_url: str(project.web_url) || str(made.web_url)
  }
}

// ── branches ─────────────────────────────────────────────────────────────────────────────

/** Creates `name` from `ref` unless it exists. */
export async function ensureBranch(
  ctx: GitCtx,
  name: string,
  ref: string
): Promise<'created' | 'existed'> {
  const step = 'ensureBranch'
  const probe = await gitlabCall(ctx, step, `/repository/branches/${enc(name)}`, { allow: [404] })
  if (probe.status !== 404) return 'existed'
  const res = await gitlabCall(ctx, step, '/repository/branches', {
    method: 'POST',
    body: { branch: name, ref },
    allow: [400]
  })
  if (res.status !== 400) return 'created'
  // 400 = "Branch already exists" (made in between) or a bad ref: look again.
  const again = await gitlabCall(ctx, step, `/repository/branches/${enc(name)}`, { allow: [404] })
  if (again.status !== 404) return 'existed'
  throw new GitlabWriteError('GITLAB_REFUSED', `GitLab refused to create branch ${name} (400)`, {
    status: 400,
    step
  })
}

/** Protects `name` (push and merge: Maintainers, no force push); already protected is fine. */
export async function protectBranch(ctx: GitCtx, name: string): Promise<void> {
  await gitlabCall(ctx, 'protectBranch', '/protected_branches', {
    method: 'POST',
    body: {
      name,
      push_access_level: MAINTAINER,
      merge_access_level: MAINTAINER,
      allow_force_push: false
    },
    allow: [409]
  })
}

// ── variables ────────────────────────────────────────────────────────────────────────────

export interface HubCiVariable {
  key: string
  value: string
  /** environment_scope: an environment key, or '*' for every environment. */
  scope: string
  masked: boolean
  protected: boolean
}

function alreadyTaken(body: unknown): boolean {
  const b = obj(body)
  const keyErrors = obj(b.message).key
  const text = Array.isArray(keyErrors) ? keyErrors.join(' ') : str(b.message)
  return /has already been taken/i.test(text)
}

/**
 * Creates a project CI variable (raw: GitLab never expands `$` in it). When GitLab answers that
 * the key is already taken in that scope: keepExisting → 'kept' (nothing written: a generated
 * SESSION_SECRET / ENCRYPTION_KEY is never replaced), else the variable of THAT scope is
 * updated in place. Any other refusal is VARIABLE_REFUSED naming the key only.
 */
export async function upsertVariable(
  ctx: GitCtx,
  v: HubCiVariable,
  opts: { keepExisting?: boolean } = {}
): Promise<'created' | 'updated' | 'kept'> {
  const step = 'upsertVariable'
  const fields = {
    value: v.value,
    environment_scope: v.scope,
    masked: v.masked,
    protected: v.protected,
    raw: true,
    variable_type: 'env_var'
  }
  const refused = (status: number) =>
    new GitlabWriteError('VARIABLE_REFUSED', `GitLab refused variable ${v.key} (${status})`, {
      status,
      step
    })
  const res = await gitlabCall(ctx, step, '/variables', {
    method: 'POST',
    body: { key: v.key, ...fields },
    allow: [400]
  })
  if (res.status !== 400) return 'created'
  if (!alreadyTaken(res.body)) throw refused(400)
  if (opts.keepExisting) return 'kept'
  const put = await gitlabCall(
    ctx,
    step,
    `/variables/${enc(v.key)}?${enc('filter[environment_scope]')}=${enc(v.scope)}`,
    { method: 'PUT', body: fields, allow: [400] }
  )
  if (put.status === 400) throw refused(400)
  return 'updated'
}

// ── files ────────────────────────────────────────────────────────────────────────────────

/**
 * Writes `files` on `branch` as ONE commit: each file is read first; a missing file is a
 * `create` action, a different one an `update` (with its last commit, so GitLab refuses a
 * concurrent change). When every file already holds its content nothing is committed and the
 * branch head is answered (`changed: false`).
 */
export async function commitFiles(
  ctx: GitCtx,
  branch: string,
  files: Array<{ path: string; content: string }>,
  message: string
): Promise<{ sha: string; changed: boolean }> {
  const step = 'commitFiles'
  const actions: Array<Record<string, string>> = []
  for (const f of files) {
    const probe = await gitlabCall(
      ctx,
      step,
      `/repository/files/${enc(f.path)}?ref=${enc(branch)}`,
      { allow: [404] }
    )
    if (probe.status === 404) {
      actions.push({ action: 'create', file_path: f.path, content: f.content })
      continue
    }
    const file = obj(probe.body)
    const raw = str(file.content)
    const current = file.encoding === 'base64' ? Buffer.from(raw, 'base64').toString('utf8') : raw
    if (current === f.content) continue
    const last = str(file.last_commit_id)
    actions.push({
      action: 'update',
      file_path: f.path,
      content: f.content,
      ...(last ? { last_commit_id: last } : {})
    })
  }
  if (!actions.length) {
    const head = await gitlabCall(ctx, step, `/repository/branches/${enc(branch)}`)
    const sha = str(obj(obj(head.body).commit).id)
    if (!sha)
      throw new GitlabWriteError('GITLAB_BAD_ANSWER', 'GitLab named no branch head', { step })
    return { sha, changed: false }
  }
  const res = await gitlabCall(ctx, step, '/repository/commits', {
    method: 'POST',
    body: { branch, commit_message: message, actions }
  })
  const sha = str(obj(res.body).id)
  if (!sha) throw new GitlabWriteError('GITLAB_BAD_ANSWER', 'GitLab named no commit', { step })
  return { sha, changed: true }
}
