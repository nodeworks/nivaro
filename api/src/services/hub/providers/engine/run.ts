import { randomUUID } from 'node:crypto'
import { db } from '../../../../db/index.js'
import { runInBackgroundPool } from '../../../../db/pool-context.js'
import { openSecret, sealSecret } from '../../secrets.js'
import { findType } from '../registry.js'
import {
  HubProviderStoreError,
  type HubResourceChangeRow,
  type HubResourceRow,
  insertChange,
  insertResource,
  listChanges,
  listResources,
  readChange,
  readResource,
  type StoredSecretField,
  updateChange,
  updateResource
} from '../store.js'
import type {
  Observed,
  OpError,
  OpResult,
  PlannedOp,
  ProviderContext,
  ResourceTypeSpec
} from '../types.js'
import { approversOf, auditChange, opAuditAction, opAuditDetail, tellAboutChange } from './audit.js'
import {
  type ChangePlan,
  type ChangeStatus,
  type ChangeStep,
  type HubActor,
  type PlanRequest,
  RESOURCE_CHANGE_CODES,
  type ResourceChangeCode,
  ResourceChangeError,
  type StoredChangePlan
} from './contract.js'
import { engineDeps } from './deps.js'
import {
  assertMayWrite,
  claimResourceChecklist,
  judgeAccess,
  judgeChangeGates,
  judgeOrigin
} from './gates.js'
import {
  holdResourceLocks,
  hubResourceChangeLockKey,
  hubResourceLockKey,
  type ResourceHold
} from './locks.js'
import {
  type ComputedPlan,
  computePlan,
  contextFor,
  desiredFromObservedFields,
  desiredOf,
  mergeForUpdate,
  movedPreconditions,
  nameOf,
  type OpenConnection,
  openConnection,
  openSealedSecrets,
  type PlanOptions,
  planFormOf,
  providerFailure,
  refsIn,
  regionFor,
  type SealedSecrets,
  withDefaults
} from './plan.js'

/**
 * Hub provider changes, steps 2–4 — confirm, apply, after (spec "The change engine"):
 *
 *  - START re-plans from the stored request (fresh observe) and refuses STALE_PLAN when the
 *    hash moved (the change turns `stale`), then judges blockers, the change gates (freezes,
 *    windows, open move), the typed confirm, approval (an owner's `cost` change is saved
 *    `pending_approval`) and the production checklist (claimed, linked as run kind `resource`).
 *  - ONE run per change: it holds nvr:hub-res:change:<id> and nvr:hub-res:<resourceId> for every
 *    resource it touches, renewed with the heartbeat (every 30 s, `heartbeat_at`). Every write of
 *    the change row is compare-and-set on status `applying` + its run key: a run that lost its
 *    lock or its row stops before its next provider call (`interrupted`, LOCK_LOST).
 *  - Each step re-reads the provider first; a precondition that moved stops the run
 *    (PRECONDITION_CHANGED — re-plan), recording what was already done. A create inserts its
 *    resource row BEFORE the provider call (so the provider tag `nivaro-hub:resource` carries the
 *    row id and a replayed create finds what it made). A delete / replace snapshots first where
 *    the type can. Every step records the before-state, the previous desired fields and the
 *    provider's answer; `apply` is idempotent (read-before-write), so a resume replays only steps
 *    without a recorded success.
 *  - A Hub that restarted mid-apply leaves `applying` with an old heartbeat and no lock:
 *    healResourceChanges marks it `interrupted`; resume runs the rest.
 * Runs go on in the background pool; the start answers once the run row is `applying`.
 */

class Stop extends Error {
  status: 'failed' | 'interrupted' | 'cancelled'
  code: string
  retryable: boolean
  constructor(status: Stop['status'], code: string, message: string, retryable = false) {
    super(message)
    this.status = status
    this.code = code
    this.retryable = retryable
  }
}

const refuse = (code: ResourceChangeCode, message: string, details?: Record<string, unknown>) =>
  new ResourceChangeError(code, message, details)

const isRecord = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
const isStoredSecret = (v: unknown): v is StoredSecretField =>
  isRecord(v) && typeof v.$sealed === 'string' && typeof v.fingerprint === 'string'

// ── Views ──

export function viewOf(row: HubResourceChangeRow): ChangePlan {
  const p = row.plan
  return {
    changeId: row.id,
    planHash: row.plan_hash ?? '',
    status: row.status,
    ops: p?.ops ?? [],
    gates: p?.gates ?? [],
    needsConfirm: p?.needsConfirm ?? null,
    needsApproval: p?.needsApproval ?? false,
    blockers: p?.blockers ?? []
  }
}

function initSteps(plan: StoredChangePlan): ChangeStep[] {
  return plan.ops.map((_, i) => ({
    index: i,
    status: 'pending',
    resourceId: plan.resourceIds[i] ?? null,
    before: null,
    result: null,
    snapshot: null,
    error: null,
    startedAt: null,
    finishedAt: null
  }))
}

async function mustRead(changeId: number): Promise<HubResourceChangeRow> {
  const row = await readChange(Number(changeId))
  if (!row) throw refuse('NOT_FOUND', 'No such change.')
  return row
}

// ── Plan → stored change ──

export async function createPlannedChange(
  req: PlanRequest,
  actor: HubActor,
  opts: PlanOptions
): Promise<ChangePlan> {
  const fresh = await computePlan(req, actor, opts)
  const row = await insertChange({
    connection_id: fresh.connection.id,
    app_id: fresh.access.app?.id ?? null,
    environment_id: fresh.access.env?.id ?? null,
    scope: fresh.stored.request.scope,
    status: 'planned',
    plan: fresh.stored,
    plan_hash: fresh.planHash,
    steps: [],
    requested_by: actor.id
  })
  return viewOf(row)
}

/**
 * The plan as it stands now, from the stored request (fresh observe). A hash that moved marks
 * the change `stale` and refuses STALE_PLAN (the person plans again).
 */
export async function replanFresh(
  row: HubResourceChangeRow,
  actor: HubActor
): Promise<ComputedPlan> {
  const plan = row.plan
  if (!plan) throw refuse('BAD_STATUS', 'This change has no plan.')
  const fresh = await computePlan(plan.request, actor, {
    mode: 'stored',
    sealed: plan.sealed ?? null,
    undoOf: plan.undoOf ?? null,
    origin: plan.origin ?? null
  })
  if (fresh.planHash !== row.plan_hash) {
    await updateChange(
      row.id,
      {
        status: 'stale',
        error_code: 'STALE_PLAN',
        error: 'The resources changed since this plan was made.'
      },
      { expectStatus: row.status }
    ).catch(() => null)
    throw refuse(
      'STALE_PLAN',
      'The resources changed at the provider (or in the Hub) since this plan was made — plan again.',
      { planHash: fresh.planHash }
    )
  }
  return fresh
}

function throwBlockers(plan: StoredChangePlan): void {
  const b = plan.blockers[0]
  if (!b) return
  const code = (b.code in RESOURCE_CHANGE_CODES ? b.code : 'BAD_STATUS') as ResourceChangeCode
  throw refuse(code, b.message, { blockers: plan.blockers })
}

// ── Start / approve → run ──

export interface BeginOptions {
  expect: ChangeStatus
  checklistRunId?: unknown
  claimChecklist: boolean
  approvedBy?: string | null
  audit: 'hub-resource-change-start' | 'hub-resource-change-resume' | 'hub-resource-change-approve'
  steps?: ChangeStep[]
}

/** Takes the locks, claims the checklist, moves the change to `applying` and launches the run. */
export async function beginRun(
  row: HubResourceChangeRow,
  actor: HubActor,
  o: BeginOptions
): Promise<ChangePlan> {
  const plan = row.plan as StoredChangePlan
  const deps = engineDeps()
  const ids = new Set<number>()
  for (const id of plan.resourceIds) if (id != null) ids.add(id)
  for (const s of row.steps) if (s.resourceId != null) ids.add(s.resourceId)
  const hold = await holdResourceLocks(deps.lock(), [
    hubResourceChangeLockKey(row.id),
    ...[...ids].map(hubResourceLockKey)
  ])
  let claim: Awaited<ReturnType<typeof claimResourceChecklist>> = null
  let runKey: string
  try {
    if (o.claimChecklist && row.environment_id != null)
      claim = await claimResourceChecklist(row.environment_id, row.id, o.checklistRunId)
    runKey = randomUUID()
    const started = await updateChange(
      row.id,
      {
        status: 'applying',
        run_key: runKey,
        heartbeat_at: new Date(deps.now()),
        steps: o.steps ?? (row.steps.length ? row.steps : initSteps(plan)),
        error_code: null,
        error: null,
        finished_at: null,
        ...(o.approvedBy !== undefined ? { approved_by: o.approvedBy } : {})
      },
      { expectStatus: o.expect }
    )
    if (!started) throw refuse('BAD_STATUS', 'This change was started or changed a moment ago.')
    if (claim) await claim.link('resource', row.id).catch(() => undefined)
  } catch (err) {
    await claim?.release().catch(() => undefined)
    await hold.release()
    throw err
  }
  await auditChange(o.audit, actor.id, row, { ops: plan.ops.length })
  const done = runInBackgroundPool(() => execute(row.id, runKey, hold))
  if (deps.inline) await done
  return viewOf(await mustRead(row.id))
}

export async function startChange(
  changeId: number,
  input: { planHash: string; confirm?: string; checklistRunId?: number | null },
  actor: HubActor
): Promise<ChangePlan> {
  assertMayWrite(actor)
  await healResourceChanges(changeId)
  const row = await mustRead(changeId)
  if (row.status === 'pending_approval')
    throw refuse(
      'APPROVAL_REQUIRED',
      'This change is waiting for a Hub administrator to approve it.'
    )
  if (row.status !== 'planned')
    throw refuse(
      'BAD_STATUS',
      `This change is ${row.status}; only a planned change can be started.`
    )
  if (!input || input.planHash !== row.plan_hash)
    throw refuse('STALE_PLAN', 'This is not the plan you saw — check the plan again.', {
      planHash: row.plan_hash
    })
  const fresh = await replanFresh(row, actor)
  throwBlockers(fresh.stored)
  if (fresh.gateRefusal) throw fresh.gateRefusal
  const needs = fresh.stored.needsConfirm
  if (needs && input.confirm !== needs)
    throw refuse('CONFIRM_MISMATCH', `Type ${needs} to start this change.`, { needsConfirm: needs })
  const plan = row.plan as StoredChangePlan
  if (fresh.stored.needsApproval) {
    const pending = await updateChange(
      row.id,
      {
        status: 'pending_approval',
        plan: { ...plan, checklistRunId: input.checklistRunId ?? null }
      },
      { expectStatus: 'planned' }
    )
    if (!pending) throw refuse('BAD_STATUS', 'This change was started or changed a moment ago.')
    await auditChange('hub-resource-change-approval-request', actor.id, row, {
      ops: plan.ops.length
    })
    const people = (await approversOf(row.app_id)).filter((p) => p !== actor.id)
    await tellAboutChange(
      people,
      row,
      'A resource change waits for approval',
      'An app owner asked for a resource change that adds a monthly cost. Approve or decline it.',
      'You are a Hub administrator or an owner of this app.'
    )
    return viewOf(pending)
  }
  return beginRun(row, actor, {
    expect: 'planned',
    checklistRunId: input.checklistRunId,
    // Task 11a: a carried change runs under its run's own checklist.
    claimChecklist: !plan.origin,
    audit: 'hub-resource-change-start'
  })
}

/** Access + change gates for a run that does not re-plan (resume). */
async function judgeForRun(row: HubResourceChangeRow, actor: HubActor): Promise<void> {
  const plan = row.plan as StoredChangePlan
  const { readConnection } = await import('../store.js')
  const connection = await readConnection(row.connection_id)
  if (!connection) throw refuse('CONNECTION_NOT_FOUND', 'Connection not found.')
  const types = [...new Set(plan.ops.map((o) => o.type))]
    .map((t) => findType(t)?.type)
    .filter((t): t is ResourceTypeSpec => !!t)
  const ids = [...new Set(plan.resourceIds.filter((x): x is number => x != null))]
  const rows = ids.length ? await listResources({ ids, includeDeleted: true }) : []
  const access = await judgeAccess(
    {
      connection,
      scope: row.scope,
      appId: row.app_id,
      environmentId: row.environment_id,
      types,
      rows
    },
    actor
  )
  // Task 11a: a carried change resumes only while its run still carries it.
  if (plan.origin)
    await judgeOrigin(plan.origin, {
      scope: row.scope,
      appId: row.app_id,
      environmentId: row.environment_id,
      actions: plan.request.ops.map((o) => o.action)
    })
  const gates = await judgeChangeGates({
    scope: row.scope,
    appId: row.app_id,
    environmentId: row.environment_id,
    production: access.production,
    origin: plan.origin ?? null
  })
  if (gates.refusal) throw gates.refusal
}

const lastFailed = (row: HubResourceChangeRow) =>
  [...row.steps].reverse().find((s) => s.status === 'failed') ?? null

export async function resumeChange(changeId: number, actor: HubActor): Promise<ChangePlan> {
  assertMayWrite(actor)
  await healResourceChanges(changeId)
  const row = await mustRead(changeId)
  const retryable = row.status === 'failed' && lastFailed(row)?.error?.retryable === true
  if (row.status !== 'interrupted' && !retryable)
    throw refuse(
      'BAD_STATUS',
      row.status === 'failed'
        ? 'This change failed on something a retry will not fix — plan the change again.'
        : `This change is ${row.status}; only an interrupted (or retryable failed) change can be resumed.`
    )
  if (!actor.isAdmin && row.requested_by !== actor.id)
    throw refuse(
      'ADMIN_ONLY',
      'Only the person who started this change or a Hub administrator can resume it.'
    )
  await judgeForRun(row, actor)
  const steps = row.steps.map((s) =>
    s.status === 'done' || s.status === 'skipped'
      ? s
      : { ...s, status: 'pending' as const, error: null }
  )
  return beginRun(row, actor, {
    expect: row.status,
    claimChecklist: false,
    audit: 'hub-resource-change-resume',
    steps
  })
}

export async function cancelChange(changeId: number, actor: HubActor): Promise<ChangePlan> {
  assertMayWrite(actor)
  await healResourceChanges(changeId)
  const row = await mustRead(changeId)
  if (!actor.isAdmin && row.requested_by !== actor.id)
    throw refuse(
      'ADMIN_ONLY',
      'Only the person who planned this change or a Hub administrator can cancel it.'
    )
  if (row.status === 'applying') {
    const asked = await updateChange(
      row.id,
      { error_code: 'CANCEL_REQUESTED' },
      { expectStatus: 'applying', expectRunKey: row.run_key }
    )
    if (!asked) throw refuse('BAD_STATUS', 'This change ended a moment ago.')
    await auditChange('hub-resource-change-cancel', actor.id, row, { while: 'applying' })
    return viewOf(asked)
  }
  const open: ChangeStatus[] = ['planned', 'pending_approval', 'interrupted', 'failed', 'stale']
  if (!open.includes(row.status))
    throw refuse('BAD_STATUS', `This change is ${row.status}; it cannot be cancelled.`)
  const done = await updateChange(
    row.id,
    { status: 'cancelled', finished_at: new Date(engineDeps().now()) },
    { expectStatus: row.status }
  )
  if (!done) throw refuse('BAD_STATUS', 'This change changed a moment ago.')
  await auditChange('hub-resource-change-cancel', actor.id, row, { from: row.status })
  return viewOf(done)
}

// ── Heal ──

/**
 * `applying` changes whose heartbeat is older than the stale window and whose change lock is gone
 * (the process running them stopped) become `interrupted`. A lock that cannot be read leaves the
 * change alone. Answers how many were marked. `changeId` limits it to one change.
 */
export async function healResourceChanges(changeId?: number): Promise<number> {
  const deps = engineDeps()
  const rows =
    changeId != null
      ? [await readChange(Number(changeId))].filter(
          (r): r is HubResourceChangeRow => !!r && r.status === 'applying'
        )
      : await listChanges({ status: 'applying', limit: 200 })
  let marked = 0
  for (const row of rows) {
    const beat = Date.parse(row.heartbeat_at ?? row.updated_at ?? '')
    if (Number.isFinite(beat) && deps.now() - beat < deps.staleMs) continue
    const held = await deps.lock().held(hubResourceChangeLockKey(row.id))
    if (held !== false) continue
    const done = await updateChange(
      row.id,
      {
        status: 'interrupted',
        error_code: 'INTERRUPTED',
        error:
          'The Hub stopped while this change was applying. Resume it to run the steps not yet done.'
      },
      { expectStatus: 'applying', expectRunKey: row.run_key }
    )
    if (!done) continue
    marked++
    await auditChange('hub-resource-change-interrupted', null, row, {})
  }
  return marked
}

// ── The run ──

/** The row form of plan-form fields (secrets sealed; kept ones copied from `current`). */
function rowFormOf(
  type: ResourceTypeSpec,
  fields: Record<string, unknown>,
  source: number,
  sealed: SealedSecrets,
  current: Record<string, unknown> | null
): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) {
    const spec = type.fields.find((f) => f.key === k)
    if (spec?.kind !== 'secret') {
      out[k] = v
      continue
    }
    if (!isRecord(v) || typeof v.fingerprint !== 'string') continue
    const plain = sealed[`${source}:${k}`]
    if (plain !== undefined) out[k] = { $sealed: sealSecret(plain), fingerprint: v.fingerprint }
    else {
      const was = current?.[k]
      if (isStoredSecret(was) && was.fingerprint === v.fingerprint) out[k] = was
    }
  }
  return out
}

/** The plain value of each secret field (new from the envelope, else the stored one opened). */
function plainsOf(
  type: ResourceTypeSpec,
  fields: Record<string, unknown>,
  source: number,
  sealed: SealedSecrets,
  current: Record<string, unknown> | null
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const spec of type.fields) {
    if (spec.kind !== 'secret' || !(spec.key in fields)) continue
    const fresh = sealed[`${source}:${spec.key}`]
    if (fresh !== undefined) {
      out[spec.key] = fresh
      continue
    }
    const was = current?.[spec.key]
    if (isStoredSecret(was)) {
      const plain = openSecret(was.$sealed)
      if (plain != null) out[spec.key] = plain
    }
  }
  return out
}

/** Swaps every in-change ref (negative id) for the row the earlier step created. */
function resolveRefs(
  type: ResourceTypeSpec,
  fields: Record<string, unknown>,
  created: Map<number, number>
): { fields: Record<string, unknown>; missing: string[] } {
  const out = { ...fields }
  const missing: string[] = []
  const swap = (v: unknown, field: string): unknown => {
    if (!isRecord(v) || !Number.isInteger(Number(v.resourceId))) return v
    const id = Number(v.resourceId)
    if (id > 0) return v
    const made = created.get(-id - 1)
    if (made == null) {
      missing.push(field)
      return v
    }
    return { resourceId: made }
  }
  for (const r of new Set(refsIn(type, fields).map((x) => x.field))) {
    const v = out[r]
    out[r] = Array.isArray(v) ? v.map((x) => swap(x, r)) : swap(v, r)
  }
  return { fields: out, missing }
}

async function execute(changeId: number, runKey: string, hold: ResourceHold): Promise<void> {
  const deps = engineDeps()
  const abort = new AbortController()
  let alive = true
  const lose = () => {
    alive = false
    abort.abort()
  }
  const beat = async () => {
    if (!alive) return
    if (!(await hold.renew())) return lose()
    const ok = await updateChange(
      changeId,
      { heartbeat_at: new Date(deps.now()) },
      { expectStatus: 'applying', expectRunKey: runKey }
    ).catch(() => undefined)
    if (ok === null) lose()
  }
  const timer = setInterval(() => void beat(), deps.heartbeatMs)
  timer.unref?.()
  const ensure = async () => {
    if (alive && (await hold.renew())) return
    lose()
    throw new Stop(
      'interrupted',
      'LOCK_LOST',
      'The run lost its lock; nothing more was sent to the provider.'
    )
  }

  let row = await readChange(changeId)
  const steps: ChangeStep[] = row?.steps ?? []
  const persist = async (extra: Parameters<typeof updateChange>[1] = {}) => {
    const r = await updateChange(
      changeId,
      { steps, heartbeat_at: new Date(deps.now()), ...extra },
      { expectStatus: 'applying', expectRunKey: runKey }
    )
    if (!r) {
      lose()
      throw new Stop(
        'interrupted',
        'LOCK_LOST',
        'Another run took this change over; this one stopped.'
      )
    }
    return r
  }
  try {
    if (!row?.plan) throw new Stop('failed', 'NOT_FOUND', 'The change has no plan.')
    const plan = row.plan
    let conn: OpenConnection
    try {
      conn = await openConnection(row.connection_id)
    } catch (e) {
      throw new Stop(
        'failed',
        e instanceof ResourceChangeError ? e.code : 'CONNECTION_NOT_FOUND',
        e instanceof Error ? e.message : 'Connection not found.'
      )
    }
    const sealed = openSealedSecrets(plan.sealed)
    const created = new Map<number, number>()
    plan.ops.forEach((_, i) => {
      const id = steps[i]?.resourceId
      if (plan.resourceIds[i] == null && id != null) created.set(plan.sources?.[i] ?? i, id)
    })
    const change: HubResourceChangeRow = row
    const keys = await keysOf(change)

    for (let i = 0; i < plan.ops.length; i++) {
      if (steps[i]?.status === 'done' || steps[i]?.status === 'skipped') continue
      await ensure()
      const fresh = await readChange(changeId)
      if (fresh?.error_code === 'CANCEL_REQUESTED')
        throw new Stop(
          'cancelled',
          'CANCELLED',
          `Cancelled after ${steps.filter((s) => s.status === 'done').length} of ${plan.ops.length} steps; what ran stays as it is.`
        )
      await runStep(i)
    }
    const end = await persist({
      status: 'applied',
      finished_at: new Date(deps.now()),
      error_code: null,
      error: null
    })
    await auditChange('hub-resource-change-end', end.requested_by, end, { status: 'applied' })

    async function runStep(i: number): Promise<void> {
      const p = plan
      const op = p.ops[i]
      const source = p.sources?.[i] ?? i
      const reqOp = p.request.ops[source]
      const type = findType(op.type)?.type
      const now = () => new Date(deps.now()).toISOString()
      steps[i] = { ...steps[i], status: 'running', startedAt: now(), error: null }
      if (!type)
        return failStep(i, {
          code: 'UNKNOWN_TYPE',
          message: `The type ${op.type} is no longer registered.`,
          retryable: false
        })
      if (op.kind === 'noop' && op.action !== 'adopt' && op.action !== 'accept') {
        steps[i] = { ...steps[i], status: 'skipped', finishedAt: now() }
        await persist()
        return
      }
      let resId = steps[i].resourceId ?? p.resourceIds[i] ?? created.get(source) ?? null
      let res: HubResourceRow | null = resId != null ? await readResource(resId) : null
      const region = regionFor(
        conn.row.config,
        isRecord(reqOp?.fields) ? reqOp.fields : (res?.desired ?? null),
        res?.observed ?? null
      )
      const readCtx = contextFor(conn, region, { signal: abort.signal })
      const observeNow = async (externalId: string): Promise<Observed | null> => {
        try {
          return await conn.adapter.observe(readCtx, type.key, externalId)
        } catch (e) {
          const f = providerFailure(readCtx, e)
          await failStep(i, {
            code: f.code,
            message: f.message,
            retryable: f.details?.retryable === true,
            ...(typeof f.details?.status === 'number' ? { status: f.details.status } : {})
          })
          return null
        }
      }
      const peersRowOf = async () => {
        const peers = await listResources({ connectionId: conn.row.id })
        const m = new Map(peers.map((x) => [`${x.type}\0${x.external_id}`, x.id]))
        return (t: string, ext: string) => m.get(`${t}\0${ext}`) ?? null
      }

      // ── Engine ops: adopt / accept (no provider write) ──
      if (op.action === 'adopt') {
        const ext = op.externalId as string
        const seen = await observeNow(ext)
        if (!seen) return preconditionStop(i, ['$exists'])
        const moved = movedPreconditions(seen, op.preconditions)
        if (moved.length) return preconditionStop(i, moved)
        const rowOf = await peersRowOf()
        if (rowOf(type.key, ext) != null)
          return failStep(i, {
            code: 'RESOURCE_ALREADY_MANAGED',
            message: 'The Hub already manages this resource.',
            retryable: false
          })
        const back = desiredFromObservedFields(type, seen, rowOf)
        let made: HubResourceRow
        try {
          made = await insertResource({
            connection_id: conn.row.id,
            provider: conn.row.provider,
            type: type.key,
            external_id: ext,
            name: seen.name,
            scope: change.scope,
            app_id: change.app_id,
            environment_id: change.environment_id,
            desired: back.fields,
            observed: seen,
            drift: false,
            observed_at: new Date(deps.now()),
            tags: seen.tags ?? {},
            refs: refsIn(type, back.fields),
            created_by: change.requested_by,
            adopted: true
          })
        } catch (e) {
          if (e instanceof HubProviderStoreError)
            return failStep(i, {
              code: 'RESOURCE_ALREADY_MANAGED',
              message: e.message,
              retryable: false
            })
          throw e
        }
        return finishStep(i, op, made.id, ext, { ok: true, externalId: ext, observed: seen }, null)
      }
      if (op.action === 'accept') {
        if (!res?.external_id) return preconditionStop(i, ['$exists'])
        const seen = await observeNow(res.external_id)
        if (!seen) {
          if (steps[i].status === 'failed') return
          return preconditionStop(i, ['$exists'])
        }
        const moved = movedPreconditions(seen, op.preconditions)
        if (moved.length) return preconditionStop(i, moved)
        const back = desiredFromObservedFields(type, seen, await peersRowOf())
        const fields = { ...back.fields }
        for (const spec of type.fields)
          if (spec.kind === 'secret' && isStoredSecret(res.desired?.[spec.key]))
            fields[spec.key] = res.desired?.[spec.key]
        await updateResource(res.id, {
          desired: fields,
          observed: seen,
          drift: false,
          observed_at: new Date(deps.now()),
          refs: refsIn(type, fields)
        })
        steps[i] = { ...steps[i], beforeDesired: res.desired ?? null, before: res.observed ?? null }
        return finishStep(
          i,
          op,
          res.id,
          res.external_id,
          { ok: true, externalId: res.external_id, observed: seen },
          null
        )
      }

      // ── Provider ops ──
      let planFields: Record<string, unknown> | null = null
      if (op.kind !== 'delete') {
        const overlay = isRecord(reqOp?.fields) ? reqOp.fields : {}
        if (reqOp?.action === 'create') planFields = withDefaults(type, overlay)
        else if (reqOp?.action === 'update' && res)
          planFields = mergeForUpdate(type, res, overlay, await peersRowOf()).fields
        else if (res?.desired) planFields = planFormOf(type, res.desired)
        else planFields = {}
      }
      let resolved: Record<string, unknown> | null = null
      if (planFields) {
        const r = resolveRefs(type, planFields, created)
        if (r.missing.length)
          return failStep(i, {
            code: 'PRECONDITION_CHANGED',
            message: `${r.missing.join(', ')} points at a resource this change did not create — plan again.`,
            retryable: false
          })
        resolved = r.fields
      }
      const current = res?.desired ?? null
      // A create's row exists BEFORE the provider call (its tag names the row).
      if (op.kind === 'create' && !res) {
        res = await insertResource({
          connection_id: conn.row.id,
          provider: conn.row.provider,
          type: type.key,
          external_id: null,
          name: nameOf(type, resolved, null, null, null),
          scope: change.scope,
          app_id: change.app_id,
          environment_id: change.environment_id,
          desired: rowFormOf(type, resolved ?? {}, source, sealed, null),
          tags: {},
          refs: refsIn(type, resolved),
          created_by: change.requested_by
        })
        resId = res.id
        created.set(source, res.id)
        steps[i] = { ...steps[i], resourceId: res.id }
        await persist()
      }
      if (!res)
        return failStep(i, {
          code: 'NOT_FOUND',
          message: 'The resource row is gone.',
          retryable: false
        })
      const externalId = res.external_id ?? op.externalId ?? null

      let before: Observed | null = null
      if (op.kind !== 'create' && externalId) {
        before = await observeNow(externalId)
        if (steps[i].status === 'failed') return
        if (op.kind === 'delete' && !before) {
          await updateResource(res.id, {
            deleted_at: new Date(deps.now()),
            observed: null,
            drift: false
          })
          return finishStep(
            i,
            op,
            res.id,
            externalId,
            { ok: true, externalId, observed: null, answer: { already_gone: true } },
            null
          )
        }
        const moved = movedPreconditions(before, op.preconditions)
        if (moved.length) return preconditionStop(i, moved)
      }
      let snapshot = steps[i].snapshot
      if (
        (op.kind === 'delete' || op.kind === 'replace') &&
        type.capabilities.snapshot &&
        conn.adapter.snapshot &&
        !snapshot &&
        externalId &&
        before
      ) {
        try {
          snapshot = await conn.adapter.snapshot(readCtx, type.key, externalId)
        } catch (e) {
          const f = providerFailure(readCtx, e)
          return failStep(i, {
            code: f.code,
            message: `The snapshot before the ${op.kind} failed, so nothing was changed: ${f.message}`,
            retryable: f.details?.retryable === true
          })
        }
      }
      steps[i] = { ...steps[i], before, beforeDesired: current, snapshot: snapshot ?? null }
      await persist()

      // Refs → provider ids, now that parents exist.
      const extOf = new Map<number, string | null>()
      for (const r of refsIn(type, resolved)) {
        const target = await readResource(r.resourceId)
        extOf.set(r.resourceId, target?.external_id ?? null)
        if (!target?.external_id || target.deleted_at)
          return failStep(i, {
            code: 'PRECONDITION_CHANGED',
            message: `${r.field} points at a resource that does not exist at the provider — plan again.`,
            retryable: false
          })
      }
      const plains = resolved ? plainsOf(type, resolved, source, sealed, current) : {}
      const ctx: ProviderContext = contextFor(conn, region, {
        signal: abort.signal,
        scrubExtra: Object.values(plains)
      })
      const desired =
        op.kind === 'delete'
          ? null
          : desiredOf({ type, row: res, externalId }, resolved ?? {}, {
              scope: change.scope,
              appId: change.app_id,
              environmentId: change.environment_id,
              appKey: keys.app,
              envKey: keys.env,
              refExternal: (id) => extOf.get(id) ?? null,
              plainOf: (f) => plains[f] ?? null
            })
      await ensure()
      let result: OpResult
      try {
        result = await conn.adapter.apply(ctx, op, desired)
      } catch (e) {
        const f = providerFailure(ctx, e)
        return failStep(i, {
          code: f.code,
          message: f.message,
          retryable: f.details?.retryable === true,
          ...(typeof f.details?.status === 'number' ? { status: f.details.status } : {})
        })
      }
      if (!result?.ok) {
        const er = result?.error
        return failStep(i, {
          code: er?.code && er.code in RESOURCE_CHANGE_CODES ? er.code : 'PROVIDER_ERROR',
          message: ctx.scrub(er?.message ?? 'The provider refused the change.').slice(0, 1000),
          retryable: er?.retryable === true,
          ...(er?.status !== undefined ? { status: er.status } : {})
        })
      }
      const cleanResult = scrubResult(ctx, result)
      const ext = cleanResult.externalId ?? externalId
      if (op.kind === 'delete') {
        await updateResource(res.id, {
          deleted_at: new Date(deps.now()),
          observed: null,
          drift: false
        })
        return finishStep(i, op, res.id, ext, cleanResult, snapshot ?? null)
      }
      let after = cleanResult.observed
      if (!after && ext)
        after = await conn.adapter.observe(readCtx, type.key, ext).catch(() => null)
      try {
        await updateResource(res.id, {
          external_id: ext,
          name: nameOf(type, resolved, after, res, ext),
          desired: withoutOneShot(
            type,
            op,
            rowFormOf(type, resolved ?? {}, source, sealed, current),
            after
          ),
          observed: after,
          observed_at: after ? new Date(deps.now()) : null,
          drift: false,
          tags: after?.tags ?? desired?.tags ?? {},
          refs: refsIn(type, resolved)
        })
      } catch (e) {
        if (e instanceof HubProviderStoreError)
          return failStep(i, {
            code: 'RESOURCE_ALREADY_MANAGED',
            message: e.message,
            retryable: false
          })
        throw e
      }
      return finishStep(i, op, res.id, ext, cleanResult, snapshot ?? null)
    }

    async function finishStep(
      i: number,
      op: PlannedOp,
      resourceId: number,
      externalId: string | null,
      result: OpResult,
      snapshot: ChangeStep['snapshot']
    ): Promise<void> {
      steps[i] = {
        ...steps[i],
        status: 'done',
        resourceId,
        result,
        snapshot: snapshot ?? steps[i].snapshot ?? null,
        error: null,
        finishedAt: new Date(deps.now()).toISOString()
      }
      await persist()
      await auditChange(
        opAuditAction(op),
        change.requested_by,
        change,
        opAuditDetail(op, resourceId, externalId)
      )
    }

    async function failStep(i: number, error: OpError): Promise<never> {
      steps[i] = {
        ...steps[i],
        status: 'failed',
        error,
        finishedAt: new Date(deps.now()).toISOString()
      }
      await persist().catch(() => undefined)
      throw new Stop('failed', error.code, error.message, error.retryable)
    }

    async function preconditionStop(i: number, moved: string[]): Promise<never> {
      return failStep(i, {
        code: 'PRECONDITION_CHANGED',
        message: `The resource changed at the provider since the plan (${moved.join(', ')}) — nothing was sent for this step; plan the change again.`,
        retryable: false
      })
    }
  } catch (err) {
    const stop =
      err instanceof Stop
        ? err
        : new Stop(
            'failed',
            'INTERNAL',
            'The run stopped on an error inside the Hub — see the Hub log.'
          )
    const end = await updateChange(
      changeId,
      {
        steps,
        status: stop.status,
        error_code: stop.code.slice(0, 64),
        error: stop.message.slice(0, 1000),
        ...(stop.status === 'interrupted' ? {} : { finished_at: new Date(deps.now()) })
      },
      { expectStatus: 'applying', expectRunKey: runKey }
    ).catch(() => null)
    if (end)
      await auditChange('hub-resource-change-end', end.requested_by, end, {
        status: stop.status,
        error_code: stop.code
      })
  } finally {
    clearInterval(timer)
    await hold.release()
    row = null
  }
}

/** The provider's answer kept on the step, scrubbed of the connection's and the resource's secrets. */
function scrubResult(ctx: ProviderContext, r: OpResult): OpResult {
  const text = ctx.scrub(JSON.stringify(r))
  try {
    return JSON.parse(text) as OpResult
  } catch {
    return { ok: r.ok, externalId: r.externalId, observed: null }
  }
}

/**
 * Stored desired fields after an op applied, without its one-shot triggers: a re-apply, resume
 * or drift never fires a dispatch / build / promote again. A trigger is a FieldSpec marked
 * `trigger`, a field the op lists in `data.$oneShot`, or — after a NAMED op (`op.action`) — a
 * field the op changed that the provider does not report back (GitHub's `dispatch: true`).
 */
export function withoutOneShot(
  type: ResourceTypeSpec,
  op: PlannedOp,
  fields: Record<string, unknown>,
  after: Observed | null = null
): Record<string, unknown> {
  const drop = new Set(type.fields.filter((f) => f.trigger).map((f) => f.key))
  const listed = isRecord(op.data) ? op.data.$oneShot : null
  if (Array.isArray(listed)) for (const k of listed) if (typeof k === 'string') drop.add(k)
  if (op.action && op.action !== 'adopt' && op.action !== 'accept')
    for (const c of op.changes)
      if (!c.secret && !(after && c.field in after.fields)) drop.add(c.field)
  if (!drop.size) return fields
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(fields)) if (!drop.has(k)) out[k] = v
  return out
}

/** The app and environment keys a create tags its resource with. */
async function keysOf(
  change: HubResourceChangeRow
): Promise<{ app: string | null; env: string | null }> {
  try {
    const app = change.app_id
      ? ((await db('nivaro_hub_apps').where({ id: change.app_id }).first('key')) as
          | { key?: string }
          | undefined)
      : undefined
    const env = change.environment_id
      ? ((await db('nivaro_hub_environments').where({ id: change.environment_id }).first('key')) as
          | { key?: string }
          | undefined)
      : undefined
    return { app: app?.key ?? null, env: env?.key ?? null }
  } catch {
    return { app: null, env: null }
  }
}
