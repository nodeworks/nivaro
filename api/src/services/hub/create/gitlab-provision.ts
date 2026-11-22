// GitLab provisioning calls for Hub app creation (phase 3): fork the template project into the
// target namespace and cut the fork link, create and protect environment branches, set CI
// variables and commit the per-environment files — GitLab REST v4 only, never a local git.
//
// Every call goes through gitlab-write.ts (gitlabCall for project paths, gitlabRootCall for
// GET /user and /namespaces): the token rides PRIVATE-TOKEN only, redirects are refused, and
// errors are GitlabWriteError without GitLab's answer text (a body can echo request data — for
// a variable, its value). Names that reach a URL path are refused when they are `.` or `..`.
//
// Variable values never appear in a log, an error or a return value.

import type { GitCtx } from '../../gitlab-client.js'
import {
  checkAbort,
  defaultSleep,
  GitlabWriteError,
  gitlabCall,
  gitlabRootCall,
  gitlabTextCall,
  type PollOptions
} from '../gitlab-write.js'
import { deployProjectVariables } from './app-config.js'
import type { HubTargetConfig } from './targets.js'

export const IMPORT_POLLS = 40
export const IMPORT_POLL_MS = 3_000
/** Push and merge access level for protected environment branches (Maintainers). */
const MAINTAINER = 40

const enc = (s: string) => encodeURIComponent(s)

/**
 * A name that goes into a URL path (branch, project, namespace, variable key, file path): never
 * empty and no `.` / `..` segment (a fetch would resolve it to another API path).
 */
function safeName(name: string, what: string, step: string): string {
  if (typeof name !== 'string' || !name || name.split('/').some((p) => p === '.' || p === '..')) {
    throw new GitlabWriteError('GITLAB_BAD_NAME', `Refused ${what} name for ${step}`, { step })
  }
  return name
}

function obj(body: unknown): Record<string, unknown> {
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {}
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

/** GitLab's "has already been taken" validation answer (key or path), in any message shape. */
function alreadyTaken(body: unknown): boolean {
  let text: string
  try {
    text = typeof body === 'string' ? body : JSON.stringify(body ?? '')
  } catch {
    return false
  }
  return /has already been taken/i.test(text)
}

/** The same context, aimed at another project (a path or a numeric id). */
function at(ctx: GitCtx, project: string | number): GitCtx {
  return { ...ctx, project: safeName(String(project), 'project', 'project') }
}

// ── account ──────────────────────────────────────────────────────────────────────────────

/** The user the token belongs to (a refused token is GITLAB_UNAUTHORIZED). */
export async function currentUser(ctx: GitCtx): Promise<{ id: number; username: string }> {
  const u = obj((await gitlabRootCall(ctx, 'currentUser', '/user')).body)
  return { id: Number(u.id), username: str(u.username) }
}

/** A namespace (group or user) by full path; null when GitLab does not know it (or hides it). */
export async function namespaceExists(
  ctx: GitCtx,
  namespace: string
): Promise<{ id: number; kind: string; full_path: string } | null> {
  const step = 'namespaceExists'
  const res = await gitlabRootCall(
    ctx,
    step,
    `/namespaces/${enc(safeName(namespace, 'namespace', step))}`,
    { allow: [404] }
  )
  if (res.status === 404) return null
  const n = obj(res.body)
  return { id: Number(n.id), kind: str(n.kind), full_path: str(n.full_path) || namespace }
}

/**
 * The access level user `userId` holds on group `group` (inherited memberships count): 10 guest
 * … 40 maintainer, 50 owner; null when the user is no member.
 */
export async function groupAccessLevel(
  ctx: GitCtx,
  group: string,
  userId: number
): Promise<number | null> {
  const step = 'groupAccessLevel'
  const res = await gitlabRootCall(
    ctx,
    step,
    `/groups/${enc(safeName(group, 'group', step))}/members/all/${Number(userId)}`,
    { allow: [404] }
  )
  if (res.status === 404) return null
  const level = Number(obj(res.body).access_level)
  return Number.isFinite(level) ? level : null
}

// ── projects ─────────────────────────────────────────────────────────────────────────────

/** A project by path (or id); null when GitLab answers 404. `description` is '' when unset. */
export async function projectExists(
  ctx: GitCtx,
  path: string
): Promise<{
  id: number
  path_with_namespace: string
  description: string
  /** The GitLab user who made the project; null when GitLab does not say. */
  creator_id: number | null
} | null> {
  const res = await gitlabCall(at(ctx, path), 'projectExists', '', { allow: [404] })
  if (res.status === 404) return null
  const p = obj(res.body)
  return {
    id: Number(p.id),
    path_with_namespace: str(p.path_with_namespace),
    description: str(p.description),
    creator_id:
      Number.isInteger(Number(p.creator_id)) && p.creator_id != null ? Number(p.creator_id) : null
  }
}

/** The project settings the Hub enforces on an app's deploy repository. */
export interface HubProjectSettings {
  /** `ci/deploy.yml@<template>:<ref>` (app-config ciConfigPath). */
  ci_config_path: string
  /** Nobody may set pipeline variables when running a pipeline by hand. */
  ci_pipeline_variables_minimum_override_role: 'no_one_allowed'
  /** Pipeline variables are restricted to that role (GitLab 17.1+ honours both together). */
  restrict_user_defined_variables: true
}

/**
 * Sets `settings` on project `ctx.project` (PUT), then reads the project back: any setting GitLab
 * refused or answers differently is CI_CONFIG_REFUSED (fail closed — a deploy repository whose
 * CI configuration is not the pinned template must not deploy). Answers whether a write was made.
 */
export async function configureProject(
  ctx: GitCtx,
  settings: HubProjectSettings,
  opts: { verifyOnly?: boolean } = {}
): Promise<{ changed: boolean }> {
  const step = 'configureProject'
  const differs = (p: Record<string, unknown>) =>
    (Object.keys(settings) as Array<keyof HubProjectSettings>).filter((k) =>
      typeof settings[k] === 'boolean' ? p[k] !== settings[k] : str(p[k]) !== settings[k]
    )
  const before = obj((await gitlabCall(ctx, step, '')).body)
  const missing = differs(before)
  if (!missing.length) return { changed: false }
  if (opts.verifyOnly)
    throw new GitlabWriteError(
      'CI_CONFIG_REFUSED',
      `The deploy repository's ${missing.join(', ')} is not what the Hub set`,
      { step }
    )
  try {
    await gitlabCall(ctx, step, '', { method: 'PUT', body: settings })
  } catch (err) {
    if (err instanceof GitlabWriteError)
      throw new GitlabWriteError(
        'CI_CONFIG_REFUSED',
        `GitLab refused the deploy repository's CI settings${err.status ? ` (${err.status})` : ''}`,
        { status: err.status, step }
      )
    throw err
  }
  const after = obj((await gitlabCall(ctx, step, '')).body)
  const still = differs(after)
  if (still.length)
    throw new GitlabWriteError(
      'CI_CONFIG_REFUSED',
      `GitLab did not keep the deploy repository's ${still.join(', ')}`,
      { step }
    )
  return { changed: true }
}

type MadeProject = { id: number; path_with_namespace: string }
type ForkResult = { id: number; path_with_namespace: string; web_url: string }

/** Rethrows `err` as a GitlabWriteError that names the project GitLab already made. */
function withProject(err: unknown, project: MadeProject, step: string): GitlabWriteError {
  if (err instanceof GitlabWriteError) {
    if (!err.project) err.project = project
    return err
  }
  return new GitlabWriteError('FORK_UNFINISHED', 'The fork stopped before it was finished', {
    step,
    project
  })
}

/**
 * Waits for a fork's import (≤ 40 × 3 s: IMPORT_FAILED / IMPORT_TIMEOUT), then removes the fork
 * relation. `first` = the project as GitLab last answered it (null = read it now).
 */
async function settleFork(
  ctx: GitCtx,
  id: number,
  first: Record<string, unknown> | null,
  known: MadeProject,
  opts: PollOptions,
  step: string
): Promise<ForkResult> {
  const project: MadeProject = { ...known }
  try {
    let p = first ?? obj((await gitlabCall(at(ctx, id), step, '')).body)
    const sleep = opts.sleep ?? defaultSleep
    for (let i = 0; ; i++) {
      if (str(p.path_with_namespace)) project.path_with_namespace = str(p.path_with_namespace)
      const status = str(p.import_status)
      if (status === 'finished' || status === 'none') break
      if (status === 'failed') {
        throw new GitlabWriteError('IMPORT_FAILED', 'GitLab could not copy the template', { step })
      }
      if (i >= IMPORT_POLLS) {
        throw new GitlabWriteError(
          'IMPORT_TIMEOUT',
          `GitLab was still copying the template after ${(IMPORT_POLLS * IMPORT_POLL_MS) / 1000} s`,
          { step }
        )
      }
      await sleep(IMPORT_POLL_MS, opts.signal)
      checkAbort(opts.signal, step)
      p = obj((await gitlabCall(at(ctx, id), step, '')).body)
    }
    // 304 = no fork relation (already removed by an earlier try).
    await gitlabCall(at(ctx, id), step, '/fork', { method: 'DELETE', allow: [304] })
    return { id, path_with_namespace: project.path_with_namespace, web_url: str(p.web_url) }
  } catch (err) {
    throw withProject(err, project, step)
  }
}

/**
 * Forks `template` into `<namespace>/<path>`, waits for GitLab's import and removes the fork
 * relation, so the deploy repository is a project of its own. A taken path (409, or 400 "has
 * already been taken") is PROJECT_EXISTS. `opts.description` marks the fork as the Hub's own (the
 * creation runner adopts a project at the path on retry only by its id or that mark). Every
 * error after GitLab accepted the fork carries
 * `project: {id, path_with_namespace}` so the caller can record it and resume with finishFork.
 */
export async function forkProject(
  ctx: GitCtx,
  template: string,
  namespace: string,
  path: string,
  name: string,
  opts: PollOptions & { description?: string } = {}
): Promise<ForkResult> {
  const step = 'forkProject'
  checkAbort(opts.signal, step)
  safeName(namespace, 'namespace', step)
  safeName(path, 'project', step)
  const res = await gitlabCall(at(ctx, template), step, '/fork', {
    method: 'POST',
    body: {
      namespace_path: namespace,
      path,
      name,
      ...(opts.description ? { description: opts.description } : {})
    },
    timeoutMs: 60_000,
    allow: [400, 409]
  })
  if (res.status === 409 || (res.status === 400 && alreadyTaken(res.body))) {
    throw new GitlabWriteError(
      'PROJECT_EXISTS',
      `GitLab already has a project at ${namespace}/${path}`,
      { status: res.status, step }
    )
  }
  if (res.status === 400) {
    throw new GitlabWriteError('GITLAB_REFUSED', 'GitLab refused the fork (400)', {
      status: 400,
      step
    })
  }
  const made = obj(res.body)
  const id = Number(made.id)
  if (!Number.isFinite(id) || id <= 0) {
    throw new GitlabWriteError('GITLAB_BAD_ANSWER', 'GitLab answered no project id for the fork', {
      step
    })
  }
  const known = { id, path_with_namespace: str(made.path_with_namespace) || `${namespace}/${path}` }
  const out = await settleFork(ctx, id, made, known, opts, step)
  return { ...out, web_url: out.web_url || str(made.web_url) }
}

/**
 * Resumes a fork made earlier (project `id`): waits for its import and removes the fork
 * relation. Never forks again. Errors carry `project` like forkProject's.
 */
export async function finishFork(
  ctx: GitCtx,
  id: number,
  opts: PollOptions = {}
): Promise<ForkResult> {
  return settleFork(ctx, id, null, { id, path_with_namespace: '' }, opts, 'finishFork')
}

// ── branches ─────────────────────────────────────────────────────────────────────────────

/** Creates `name` from `ref` unless it exists. */
export async function ensureBranch(
  ctx: GitCtx,
  name: string,
  ref: string
): Promise<'created' | 'existed'> {
  const step = 'ensureBranch'
  safeName(name, 'branch', step)
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
  safeName(name, 'branch', 'protectBranch')
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
  safeName(v.key, 'variable', step)
  safeName(v.scope, 'environment scope', step)
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

/**
 * The target's project variables on an app repository (app-config deployProjectVariables):
 * DEPLOY_HOST together with DEPLOY_KNOWN_HOSTS (masked; the deploy job refuses to connect
 * without the manager's host key), HUB_HOST_SUFFIX for wildcard targets, HUB_PIN_FILE when not
 * the default. Each is created or updated in place (scope `*`, protected, raw). Answers each
 * key's outcome, never a value.
 */
export async function pushDeployVariables(
  ctx: GitCtx,
  target: HubTargetConfig
): Promise<Array<{ key: string; result: 'created' | 'updated' | 'kept' }>> {
  const out: Array<{ key: string; result: 'created' | 'updated' | 'kept' }> = []
  for (const v of deployProjectVariables(target)) {
    out.push({ key: v.key, result: await upsertVariable(ctx, v) })
  }
  return out
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
  safeName(branch, 'branch', step)
  for (const f of files) safeName(f.path, 'file', step)
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

// ── job logs ─────────────────────────────────────────────────────────────────────────────

/** The end of a job's log (GET /jobs/:id/trace), as text. */
export async function jobLogTail(ctx: GitCtx, jobId: number, maxBytes = 65_536): Promise<string> {
  if (!Number.isInteger(jobId) || jobId <= 0)
    throw new GitlabWriteError('GITLAB_BAD_NAME', 'Refused job id for jobLogTail', {
      step: 'jobLogTail'
    })
  return gitlabTextCall(ctx, 'jobLogTail', `/jobs/${jobId}/trace`, maxBytes)
}
