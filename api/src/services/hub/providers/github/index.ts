import { scrubValues } from '../context.js'
import { fieldWords, typedName } from '../plan-words.js'
import {
  type ConnectionTest,
  type DesiredResource,
  type FieldChange,
  type HealthAnswer,
  type ListPage,
  type Observed,
  type OpResult,
  type PlannedOp,
  type ProviderAdapter,
  type ProviderContext,
  ProviderError
} from '../types.js'
import {
  authMethod,
  checkOwner,
  checkWorkflowFile,
  gh,
  installationPermissions,
  ownerOf,
  seg
} from './api.js'
import { GITHUB_BUNDLED } from './pricing.js'
import {
  approvePendingDeployment,
  archiveRepository,
  dispatchWorkflow,
  type Handler,
  handlerFor,
  same,
  splitChild,
  splitRepo
} from './resources.js'
import { connection, TYPES, typeSpec } from './specs.js'

/**
 * GitHub (+ GitHub Actions) provider. Auth: a GitHub App (JWT → installation token, cached in
 * `ctx.tokens` until 60 s before expiry) or a personal access token. See specs.ts for the
 * resource types and their external ids.
 */

type Json = Record<string, any>

// ── Planning (pure) ──

function secretChanged(h: Handler, desired: DesiredResource): boolean {
  if (!h.secretField) return false
  const v = desired.fields[h.secretField] as { changed?: boolean } | undefined
  return !!v?.changed
}

function specFieldKinds(type: string): Map<string, string> {
  const t = TYPES.find((x) => x.key === type)
  return new Map((t?.fields ?? []).map((f) => [f.key, f.kind]))
}

function createChanges(type: string, desired: DesiredResource): FieldChange[] {
  const kinds = specFieldKinds(type)
  const out: FieldChange[] = []
  for (const [field, value] of Object.entries(desired.fields)) {
    if (value === undefined || value === null || value === '') continue
    const kind = kinds.get(field)
    if (kind === 'ref' || field === 'destroy' || field === 'dispatch' || field === 'approve')
      continue
    if (kind === 'secret') out.push({ field, secret: true })
    else out.push({ field, to: value })
  }
  return out
}

function diffChanges(h: Handler, desired: DesiredResource, observed: Observed): FieldChange[] {
  const out: FieldChange[] = []
  for (const field of h.compare) {
    const want = desired.fields[field]
    if (want === undefined) continue
    const was = observed.fields[field]
    if (!same(want, was)) out.push({ field, from: was, to: want })
  }
  return out
}

function preconditionsOf(observed: Observed, changes: FieldChange[]): Record<string, unknown> {
  const pre: Record<string, unknown> = {}
  for (const c of changes) if (!c.secret) pre[c.field] = observed.fields[c.field] ?? null
  if (observed.version) pre.version = observed.version
  if (observed.status) pre.status = observed.status
  return pre
}

function parseInputs(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'string' || !raw.trim()) return {}
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function noop(type: string, observed: Observed | null, reason: string): PlannedOp {
  return {
    kind: 'noop',
    type,
    resourceId: null,
    externalId: observed?.externalId ?? null,
    reason,
    changes: [],
    preconditions: {},
    risk: []
  }
}

export function planGithub(
  _ctx: ProviderContext | null,
  desired: DesiredResource | null,
  observed: Observed | null
): PlannedOp[] {
  const type = desired?.type ?? observed?.type
  if (!type) return []
  const h = handlerFor(type)
  const resourceId = desired?.resourceId ?? null
  const base = { type, resourceId }
  const spec = typeSpec(type)
  const label = spec?.label ?? type
  const named = (ext: string | null | undefined) =>
    typedName(label, ext ?? (desired?.fields[spec?.nameField ?? 'name'] as string | undefined))

  if (desired === null) {
    if (!observed) return []
    if (type === 'github.workflow')
      return [noop(type, observed, 'Workflows are removed by deleting their file; nothing to do.')]
    if (type === 'github.repository') {
      if (observed.fields.archived === true)
        return [noop(type, observed, `${observed.externalId} is already archived.`)]
      return [
        {
          ...base,
          kind: 'delete',
          externalId: observed.externalId,
          action: 'archive',
          reason: `Archive ${named(observed.externalId)} (kept read-only, not deleted).`,
          changes: [{ field: 'archived', from: false, to: true }],
          preconditions: preconditionsOf(observed, [{ field: 'archived' }]),
          risk: []
        }
      ]
    }
    return [
      {
        ...base,
        kind: 'delete',
        externalId: observed.externalId,
        reason: `Remove ${named(observed.externalId)} from GitHub.`,
        changes: [],
        preconditions: preconditionsOf(observed, []),
        risk: []
      }
    ]
  }

  if (!observed) {
    if (type === 'github.workflow')
      return [
        {
          ...base,
          kind: 'create',
          externalId: null,
          reason:
            'The workflow file is not in the repository. Commit it first, then adopt the workflow.',
          changes: createChanges(type, desired),
          preconditions: {},
          risk: []
        }
      ]
    return [
      {
        ...base,
        kind: 'create',
        externalId: desired.externalId,
        reason: `Create ${named(null)}.`,
        changes: createChanges(type, desired),
        preconditions: {},
        risk: []
      }
    ]
  }

  const ops: PlannedOp[] = []

  if (type === 'github.repository' && desired.fields.destroy === true) {
    return [
      {
        ...base,
        kind: 'delete',
        externalId: observed.externalId,
        action: 'destroy',
        reason: `Delete ${named(observed.externalId)} permanently, including its issues and history.`,
        changes: [],
        preconditions: preconditionsOf(observed, []),
        risk: []
      }
    ]
  }

  const changes = diffChanges(h, desired, observed)
  const secret = secretChanged(h, desired)
  if (secret && h.secretField) changes.push({ field: h.secretField, secret: true })
  if (changes.length) {
    const replace = changes.some((c) => h.replaceKeys.includes(c.field))
    ops.push({
      ...base,
      kind: replace ? 'replace' : 'update',
      externalId: observed.externalId,
      reason: replace
        ? `Replace ${named(observed.externalId)}: ${fieldWords(spec?.fields, changes)} cannot change in place.`
        : `Change ${fieldWords(spec?.fields, changes)} on ${named(observed.externalId)}.`,
      changes,
      preconditions: preconditionsOf(observed, changes),
      risk: [],
      ...(type === 'github.workflow'
        ? { action: desired.fields.enabled === false ? 'disable' : 'enable' }
        : {})
    })
  }

  if (type === 'github.workflow' && desired.fields.dispatch === true) {
    const inputs = parseInputs(desired.fields.inputs)
    ops.push({
      ...base,
      kind: 'update',
      externalId: observed.externalId,
      action: 'dispatch',
      reason: `Run ${observed.externalId.split('#')[1]} now.`,
      changes: [{ field: 'dispatch', from: false, to: true }],
      preconditions: { status: observed.status ?? null },
      risk: [],
      data: {
        ref: typeof desired.fields.ref === 'string' ? desired.fields.ref : '',
        inputs
      }
    })
  }

  // Task 11c: environment approval — approve ONE waiting run (id + commit named by the
  // promotion that planned it; bound in the plan hash through op.data).
  if (type === 'github.workflow' && desired.fields.approve === true) {
    const w = approvalWant(desired)
    ops.push({
      ...base,
      kind: 'update',
      externalId: observed.externalId,
      action: 'approve_deployment',
      reason: `Approve run ${w.runId || '?'} (commit ${w.headSha.slice(0, 12) || '?'}) of ${observed.externalId.split('#')[1]} on ${w.branch || '?'} for ${w.environment || '?'}.`,
      changes: [{ field: 'approve', from: false, to: true }],
      preconditions: { status: observed.status ?? null },
      risk: [],
      data: {
        environment: w.environment,
        ref: w.branch,
        run_id: w.runId,
        head_sha: w.headSha
      }
    })
  }

  return ops.length ? ops : [noop(type, observed, 'Already as desired.')]
}

/** What an approval names, from the desired resource only (strings; empty when missing). */
function approvalWant(desired: DesiredResource): {
  environment: string
  branch: string
  runId: string
  headSha: string
} {
  const t = (v: unknown) => (typeof v === 'string' ? v.trim() : '')
  return {
    environment: t(desired.fields.approve_environment),
    branch: t(desired.fields.ref),
    runId: t(desired.fields.approve_run_id),
    headSha: t(desired.fields.approve_sha).toLowerCase()
  }
}

// ── Apply ──

/** The write-only values of a desired resource: the connection scrubber does not know them. */
function plainValues(desired: DesiredResource | null): string[] {
  const out: string[] = []
  for (const v of Object.values(desired?.fields ?? {})) {
    const plain = (v as { plain?: unknown } | null)?.plain
    if (typeof plain === 'string') out.push(plain)
  }
  return out
}

function wrap(
  ctx: ProviderContext,
  err: unknown,
  desired: DesiredResource | null = null
): ProviderError {
  const plains = plainValues(desired)
  if (err instanceof ProviderError) {
    if (!plains.length) return err
    const clean = new ProviderError(err.code, scrubValues(err.message, plains), {
      retryable: err.retryable,
      status: err.status
    })
    return clean
  }
  const msg = scrubValues(ctx.scrub(err instanceof Error ? err.message : String(err)), plains)
  return new ProviderError('PROVIDER_ERROR', msg.slice(0, 300))
}

async function applyOp(
  ctx: ProviderContext,
  op: PlannedOp,
  desired: DesiredResource | null
): Promise<OpResult> {
  if (op.kind === 'noop') return { ok: true, externalId: op.externalId, observed: null }
  const h = handlerFor(op.type)
  const ext = op.externalId

  if (op.action === 'dispatch') {
    if (!ext) throw new ProviderError('BAD_ID', 'The workflow to run is not known.')
    const target =
      desired &&
      `${(Array.isArray(desired.refs.repository) ? desired.refs.repository[0] : desired.refs.repository) ?? ''}#${String(desired.fields.workflow ?? '')}`
    if (!desired || target !== ext)
      throw new ProviderError(
        'TARGET_MISMATCH',
        'The workflow this run targets is not the one the resource points at.'
      )
    const data = (op.data ?? {}) as { ref?: string; inputs?: Record<string, unknown> }
    await dispatchWorkflow(ctx, ext, data.ref ?? '', data.inputs ?? {})
    return {
      ok: true,
      externalId: ext,
      observed: await h.observe(ctx, ext),
      answer: { dispatched: true, ref: data.ref || 'default branch' }
    }
  }

  if (op.action === 'approve_deployment') {
    if (!ext) throw new ProviderError('BAD_ID', 'The workflow whose run to approve is not known.')
    const target =
      desired &&
      `${(Array.isArray(desired.refs.repository) ? desired.refs.repository[0] : desired.refs.repository) ?? ''}#${String(desired.fields.workflow ?? '')}`
    if (!desired || target !== ext)
      throw new ProviderError(
        'TARGET_MISMATCH',
        'The workflow this approval targets is not the one the resource points at.'
      )
    // What is sent comes from the desired resource only; the planned data is compared, never sent.
    const w = approvalWant(desired)
    const data = (op.data ?? {}) as Record<string, unknown>
    if (
      !w.environment ||
      !w.branch ||
      !w.runId ||
      !w.headSha ||
      data.environment !== w.environment ||
      data.ref !== w.branch ||
      data.run_id !== w.runId ||
      data.head_sha !== w.headSha
    )
      throw new ProviderError(
        'TARGET_MISMATCH',
        'The environment, branch, run or commit to approve is not the one the plan named — plan again.'
      )
    const done = await approvePendingDeployment(ctx, ext, w)
    return {
      ok: true,
      externalId: ext,
      observed: await h.observe(ctx, ext),
      answer: {
        approved: true,
        run_id: done.runId,
        head_sha: done.headSha,
        environment: done.environment,
        ref: w.branch
      }
    }
  }

  if (op.kind === 'delete') {
    if (!ext) throw new ProviderError('BAD_ID', 'The resource to remove is not known.')
    const before = await h.observe(ctx, ext)
    if (!before) return { ok: true, externalId: ext, observed: null, answer: { alreadyGone: true } }
    if (op.action === 'archive') {
      await archiveRepository(ctx, ext)
      return {
        ok: true,
        externalId: ext,
        observed: await h.observe(ctx, ext),
        answer: { archived: true }
      }
    }
    await h.remove(ctx, ext)
    return { ok: true, externalId: ext, observed: null }
  }

  if (!desired) throw new ProviderError('BAD_PLAN', 'This change needs the desired values.')

  if (op.kind === 'create') {
    // Only the Hub's own interrupted create (an external id already recorded) may continue onto
    // an existing resource; anything else found there was not made by the Hub: never take it over.
    if (!desired.externalId) {
      const found = await h.existing(ctx, desired)
      if (found)
        throw new ProviderError(
          'ALREADY_EXISTS',
          `${found} already exists at GitHub and was not created by the Hub. Adopt it instead of creating it.`
        )
    }
    const created = await h.create(ctx, desired)
    return { ok: true, externalId: created, observed: await h.observe(ctx, created) }
  }

  if (op.kind === 'replace') {
    if (!ext) throw new ProviderError('BAD_ID', 'The resource to replace is not known.')
    if (await h.observe(ctx, ext)) await h.remove(ctx, ext)
    const created = await h.create(ctx, desired)
    return { ok: true, externalId: created, observed: await h.observe(ctx, created) }
  }

  // update: read first, write only what is still different.
  if (!ext) throw new ProviderError('BAD_ID', 'The resource to update is not known.')
  const current = await h.observe(ctx, ext)
  if (!current) throw new ProviderError('NOT_FOUND', `${ext} no longer exists at GitHub.`)
  if (op.action === 'enable' || op.action === 'disable') {
    const want = op.action === 'enable'
    if ((current.fields.enabled === true) !== want) await h.update(ctx, ext, desired, current)
    return { ok: true, externalId: ext, observed: await h.observe(ctx, ext) }
  }
  const needed = diffChanges(h, desired, current).length > 0 || secretChanged(h, desired)
  const next = needed ? await h.update(ctx, ext, desired, current) : ext
  return { ok: true, externalId: next, observed: await h.observe(ctx, next) }
}

// ── Connection test ──

interface Need {
  type: string
  perm: string
  scope: string[]
}
const NEEDS: Need[] = [
  { type: 'github.repository', perm: 'administration', scope: ['repo'] },
  { type: 'github.branch_protection', perm: 'administration', scope: ['repo'] },
  { type: 'github.environment', perm: 'administration', scope: ['repo'] },
  { type: 'github.actions_secret', perm: 'secrets', scope: ['repo'] },
  { type: 'github.actions_variable', perm: 'variables', scope: ['repo'] },
  { type: 'github.workflow', perm: 'actions', scope: ['repo'] },
  { type: 'github.deploy_key', perm: 'administration', scope: ['repo'] },
  {
    type: 'github.webhook',
    perm: 'repository_hooks',
    scope: ['repo', 'admin:repo_hook', 'write:repo_hook']
  }
]

async function testConnection(ctx: ProviderContext): Promise<ConnectionTest> {
  const owner = ownerOf(ctx)
  try {
    const account = await gh<Json>(ctx, 'GET', `/users/${seg(checkOwner(owner))}`, { ok: [404] })
    if (account.status === 404) return fail(`GitHub has no organisation or user called ${owner}.`)

    if (authMethod(ctx) === 'app') {
      const perms = await installationPermissions(ctx)
      const repos = await gh<Json>(ctx, 'GET', '/installation/repositories?per_page=1')
      const total = typeof repos.json?.total_count === 'number' ? repos.json.total_count : 0
      const permissions = NEEDS.map((n) => ({
        type: n.type,
        need: `${n.perm}:write`,
        has: perms[n.perm] === 'write' || perms[n.perm] === 'admin'
      }))
      return done(
        `GitHub App installation on ${owner} (${total} repositories visible)`,
        permissions
      )
    }

    const me = await gh<Json>(ctx, 'GET', '/user')
    const header = me.headers.get('x-oauth-scopes')
    const login = typeof me.json?.login === 'string' ? me.json.login : 'unknown'
    if (header === null) {
      // A fine-grained token lists no scopes: it can only be proven by using it.
      const permissions = NEEDS.map((n) => ({ type: n.type, need: `${n.perm}:write`, has: true }))
      return {
        ...done(`user ${login} (fine-grained token)`, permissions),
        message: 'A fine-grained token cannot list its permissions; each change proves them.'
      }
    }
    const scopes = header
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)
    const permissions = NEEDS.map((n) => ({
      type: n.type,
      need: n.scope[0],
      has: n.scope.some((s) => scopes.includes(s))
    }))
    return done(`user ${login} (scopes: ${scopes.join(', ') || 'none'})`, permissions)
  } catch (err) {
    const e = wrap(ctx, err)
    return fail(e.message)
  }
}

function fail(message: string): ConnectionTest {
  return { ok: false, identity: null, permissions: [], missing: [], message }
}

function done(identity: string, permissions: ConnectionTest['permissions']): ConnectionTest {
  const missing = [...new Set(permissions.filter((p) => !p.has).map((p) => p.need))]
  return { ok: missing.length === 0, identity, permissions, missing }
}

// ── Health ──

async function health(ctx: ProviderContext, type: string, ext: string): Promise<HealthAnswer> {
  const checkedAt = ctx.now().toISOString()
  const found = await handlerFor(type).observe(ctx, ext)
  if (!found) return { status: 'down', message: 'Not found at GitHub.', checkedAt }
  if (type === 'github.repository' && found.fields.archived === true)
    return { status: 'warn', message: 'The repository is archived (read-only).', checkedAt }
  if (type === 'github.workflow') {
    if (found.status !== 'active')
      return { status: 'warn', message: `The workflow is ${found.status}.`, checkedAt }
    const { repo, rest: file } = splitChild(ext)
    const { owner, repo: r } = splitRepo(repo)
    const runs = await gh<Json>(
      ctx,
      'GET',
      `/repos/${seg(owner)}/${seg(r)}/actions/workflows/${seg(checkWorkflowFile(file))}/runs?per_page=1`,
      { ok: [404] }
    )
    const last: Json | undefined = runs.json?.workflow_runs?.[0]
    if (last?.conclusion === 'failure')
      return {
        status: 'warn',
        message: 'The latest run failed.',
        checkedAt,
        details: { run: Number(last.run_number ?? 0) }
      }
  }
  return { status: 'ok', checkedAt }
}

export const githubAdapter: ProviderAdapter = {
  bundledPrices: GITHUB_BUNDLED,
  key: 'github',
  label: 'GitHub',
  connection,
  types: TYPES,
  testConnection,
  async observe(ctx, type, externalId): Promise<Observed | null> {
    try {
      return await handlerFor(type).observe(ctx, externalId)
    } catch (err) {
      throw wrap(ctx, err)
    }
  },
  /** Plan time: what a create would collide with (repository by name, environment by name …). */
  async findExisting(ctx, type, desired): Promise<Observed | null> {
    try {
      const h = handlerFor(type)
      const ext = await h.existing(ctx, desired)
      return ext ? await h.observe(ctx, ext) : null
    } catch (err) {
      // A parent made in the same change has no id yet, so nothing can collide yet.
      if (err instanceof ProviderError && err.code === 'REF_UNRESOLVED') return null
      throw wrap(ctx, err)
    }
  },
  async list(ctx, type, cursor): Promise<ListPage> {
    try {
      return await handlerFor(type).list(ctx, cursor ?? null)
    } catch (err) {
      throw wrap(ctx, err)
    }
  },
  plan: planGithub,
  async apply(ctx, op, desired) {
    try {
      return await applyOp(ctx, op, desired)
    } catch (err) {
      throw wrap(ctx, err, desired)
    }
  },
  async health(ctx, type, externalId) {
    try {
      return await health(ctx, type, externalId)
    } catch (err) {
      const e = wrap(ctx, err)
      return { status: 'unknown', message: e.message, checkedAt: ctx.now().toISOString() }
    }
  }
}
