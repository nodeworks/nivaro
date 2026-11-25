// Hub enhancement 47: what each retirement step does, and how a reversible one is undone. Every
// step is idempotent per environment (its `detail` records what is done), so Resume after a
// stopped process and Retry after a failure redo only what is missing.
//
//   freeze   a Hub freeze for the app (nivaro_hub_freezes, source `retire:<id>`) + per environment:
//            strict maintenance over its hub link (POST /api/hub-link/maintenance {on: true}), or
//            the tenant served in maintenance (shared: environment status `maintenance`), or the
//            operator's own word (no link). Undo: lift each, end the freeze.
//   export   per environment a database backup and a files backup — the data-care runs
//            (services/hub/data backup.ts / files-backup.ts: the server's BACKUP, the app's own
//            file copy to the policy's target); waits for them. A part may be skipped only with a
//            reason. Undo: nothing to take back (the backups are kept, on Backups & data).
//   notice   the final notice: in the app and by email to the people who signed in to the app
//            through the Hub, its owners and the Hub administrators; the maintenance page shows
//            it. Undo: "called off" to the same people, the page back to the freeze text.
//   remove   per environment: the Docker stack removed through the agent (volumes and database
//            kept), the app taken off its shared deployment, or the operator's word that they
//            stopped it; each environment `suspended`. No undo.
//   archive  every environment `archived`, the app marked retired (archived_at), the freeze
//            ended: every start refuses the archived app with ENV_ARCHIVED from here on.
import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { getApp } from '../../io-holder.js'
import { bearerCall } from '../data/app-calls.js'
import { hubLinkOrigin } from '../move/link-client.js'
import { deliverHubNotice, type HubNotice, hubEventRecipients } from '../notify-events.js'
import { FREEZES } from '../releases/freeze.js'
import { openSecret } from '../secrets.js'
import { RetireError } from './retire-plan.js'
import type { RetireEnvPlan, Retirement, RetirePlan, RetireStepKey } from './retire-store.js'

export const FREEZE_FOR_MS = 366 * 86_400_000
export const EXPORT_POLL_MS = 15_000
export const EXPORT_DEADLINE_MS = 24 * 3600_000

export const retireFreezeSource = (id: number) => `retire:${id}`

export type DataRunEnd = { status: string; error: string | null } | null

export interface RetireDeps {
  /** Strict maintenance on / off over a dedicated app's hub link (message shown on the page). */
  maintenance?: (env: { id: number }, on: boolean, message: string | null) => Promise<void>
  startDbBackup?: (envId: number, by: string | null) => Promise<number>
  startFilesBackup?: (envId: number, by: string | null) => Promise<number>
  readDataRun?: (id: number) => Promise<DataRunEnd>
  /** Removes an environment's Docker stack (volumes kept). */
  removeStack?: (envId: number) => Promise<'removed' | 'absent' | 'not_ours' | 'locked'>
  deliver?: (ids: string[], notice: HubNotice) => Promise<number>
  recipients?: (appId: number, envIds: number[]) => Promise<{ team: string[]; people: string[] }>
  now?: () => Date
  sleep?: (ms: number) => Promise<void>
  pollMs?: number
  /** Run legs in the background (routes); tests await them. */
  background?: boolean
}

export interface StepCtx {
  ret: Retirement
  plan: RetirePlan
  key: RetireStepKey
  input: Record<string, unknown>
  by: string | null
  detail: Record<string, unknown>
  /** Writes the step's detail (throws when the lease is gone). */
  save(detail: Record<string, unknown>): Promise<void>
  deps: RetireDeps
}

export type StepBody = (ctx: StepCtx) => Promise<string>

const envMap = (v: unknown): Record<string, Record<string, unknown>> =>
  v && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, Record<string, unknown>>)
    : {}
const numList = (v: unknown): number[] =>
  Array.isArray(v) ? v.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0) : []

export function freezeMessage(plan: RetirePlan): string {
  return `${plan.app.name} is being retired and no longer takes changes.`
}

export function defaultNotice(plan: RetirePlan): string {
  return `${plan.app.name} is being retired. It no longer takes changes and will be switched off. A copy of its data is kept by the Hub administrators — ask them if you need something from it.`
}

// ─── Default dependencies (real calls) ───────────────────────────────────────────────────────

async function linkMaintenance(env: { id: number }, on: boolean, message: string | null) {
  const e = (await db('nivaro_hub_environments')
    .where({ id: env.id })
    .first('base_url', 'hub_token')) as { base_url: string; hub_token: string | null } | undefined
  const origin = e ? hubLinkOrigin(String(e.base_url ?? '')) : null
  const token = e ? openSecret(e.hub_token ?? null) : null
  if (!origin || !token)
    throw new RetireError(
      'LINK_MISSING',
      'The Hub cannot reach this environment’s hub link (no address or no hub token).',
      502
    )
  // No move_id: a retirement's freeze is the Hub's own (moves are refused while it is open).
  await bearerCall(`${origin}/api/hub-link/maintenance`, token, 'POST', {
    on,
    ...(on && message ? { message: message.slice(0, 500) } : {})
  })
}

async function defaultRemoveStack(envId: number) {
  const { dockerTargetOf, ownsStack, withEnvironmentLock } = await import(
    '../docker/stack-guards.js'
  )
  const { AgentError, agentRemove, agentStack } = await import('../docker/agent-client.js')
  const target = await dockerTargetOf(envId)
  if (!target?.stackName) return 'absent' as const
  const name = target.stackName
  const done = await withEnvironmentLock(envId, async () => {
    const status = await agentStack(target.driver, name)
    if (status && !ownsStack(status, target)) return 'not_ours' as const
    try {
      await agentRemove(target.driver, name, {
        removeVolumes: false,
        owner: { app: target.appKey, environment: target.envKey }
      })
      return 'removed' as const
    } catch (err) {
      if (err instanceof AgentError && err.code === 'STACK_NOT_FOUND') return 'absent' as const
      throw err
    }
  })
  if (!done.held) return 'locked' as const
  // The cached status and deploy reads of a stack that is gone (best-effort, bounded).
  try {
    const { hubStatusKey } = await import('../status.js')
    const { hubDeploysKeys } = await import('../deploys.js')
    const redis = (getApp() as unknown as { redis?: { del(...k: string[]): Promise<unknown> } })
      ?.redis
    if (redis)
      await Promise.race([
        redis.del(hubStatusKey(envId), ...hubDeploysKeys(envId)).catch(() => undefined),
        new Promise((r) => setTimeout(r, 300))
      ])
  } catch {
    /* the cache expires on its own */
  }
  return done.value
}

/** Hub team (admins + owners) and the people who signed in to these environments through the Hub. */
async function defaultRecipients(appId: number, envIds: number[]) {
  const team = await hubEventRecipients(appId)
  const seen = new Set(team.map((t) => t.toUpperCase()))
  let people: string[] = []
  if (envIds.length) {
    try {
      const rows = (await db('nivaro_hub_signins as s')
        .join('nivaro_users as u', 'u.id', 's.hub_user_id')
        .whereIn('s.environment_id', envIds)
        .where('u.status', 'active')
        .whereNull('u.account_kind')
        .distinct('s.hub_user_id')) as Array<{ hub_user_id: unknown }>
      people = rows
        .map((r) => String(r.hub_user_id ?? ''))
        .filter((id) => id && !seen.has(id.toUpperCase()))
    } catch {
      people = []
    }
  }
  return { team, people }
}

export function resolvedDeps(
  d: RetireDeps
): Required<Omit<RetireDeps, 'background'>> & Pick<RetireDeps, 'background'> {
  return {
    maintenance: d.maintenance ?? linkMaintenance,
    startDbBackup:
      d.startDbBackup ??
      (async (envId, by) => (await import('../data/backup.js')).startDbBackup(envId, { by })),
    startFilesBackup:
      d.startFilesBackup ??
      (async (envId, by) =>
        (await import('../data/files-backup.js')).startFilesBackup(envId, { by })),
    readDataRun:
      d.readDataRun ??
      (async (id) => {
        const r = await (await import('../data/runs.js')).readRun(id)
        return r ? { status: r.status, error: r.error } : null
      }),
    removeStack: d.removeStack ?? defaultRemoveStack,
    deliver: d.deliver ?? ((ids, notice) => deliverHubNotice(ids, notice)),
    recipients: d.recipients ?? defaultRecipients,
    now: d.now ?? (() => new Date()),
    sleep: d.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms))),
    pollMs: d.pollMs ?? EXPORT_POLL_MS,
    background: d.background
  }
}

// ─── freeze ──────────────────────────────────────────────────────────────────────────────────

async function liveFreeze(id: number, at: Date): Promise<number | null> {
  const r = (await db(FREEZES)
    .where({ source: retireFreezeSource(id) })
    .where('ends_at', '>', at)
    .orderBy('id', 'asc')
    .first('id')) as { id: number } | undefined
  return r ? Number(r.id) : null
}

const freezeStep: StepBody = async (ctx) => {
  const d = resolvedDeps(ctx.deps)
  const at = d.now()
  const detail = { ...ctx.detail }
  let freezeId = await liveFreeze(ctx.ret.id, at)
  if (!freezeId) {
    freezeId = Number(
      await insertReturningId(db, FREEZES, {
        app_id: ctx.plan.app.id,
        name: `Retiring ${ctx.plan.app.key} (retirement #${ctx.ret.id})`.slice(0, 120),
        source: retireFreezeSource(ctx.ret.id),
        recurrence: 'none',
        starts_at: at,
        ends_at: new Date(at.getTime() + FREEZE_FOR_MS),
        days_before: null,
        days_after: null,
        time_zone: null,
        created_by: ctx.by && /^[0-9a-f-]{36}$/i.test(ctx.by) ? ctx.by : null,
        created_at: at,
        updated_at: at
      })
    )
  }
  detail.freeze_id = freezeId
  const envs = envMap(detail.envs)
  const manual = numList(ctx.input.manual)
  const message = freezeMessage(ctx.plan)
  for (const e of ctx.plan.environments) {
    if (envs[e.id]?.done) continue
    if (e.freeze === 'link') {
      await d.maintenance({ id: e.id }, true, message)
      envs[e.id] = { how: 'link', done: true }
    } else if (e.freeze === 'status') {
      const row = (await db('nivaro_hub_environments').where({ id: e.id }).first('status')) as
        | { status: string }
        | undefined
      const prev = String(row?.status ?? e.status)
      if (prev !== 'maintenance')
        await db('nivaro_hub_environments')
          .where({ id: e.id })
          .update({ status: 'maintenance', updated_at: at })
      envs[e.id] = { how: 'status', prev: prev === 'maintenance' ? e.status : prev, done: true }
    } else if (e.freeze === 'manual') {
      if (!manual.includes(e.id))
        throw new RetireError('MANUAL_NEEDED', `${e.key}: confirm that you put it in maintenance.`)
      envs[e.id] = { how: 'manual', done: true }
    } else envs[e.id] = { how: 'none', done: true }
    detail.envs = envs
    await ctx.save(detail)
  }
  detail.envs = envs
  await ctx.save(detail)
  const n = Object.values(envs).filter((v) => v.how === 'link' || v.how === 'status').length
  return `Hub freeze #${freezeId} on; ${n} of ${ctx.plan.environments.length} environments in maintenance.`
}

const undoFreeze: StepBody = async (ctx) => {
  const d = resolvedDeps(ctx.deps)
  const at = d.now()
  const envs = envMap(ctx.detail.envs)
  const manual: string[] = []
  for (const e of [...ctx.plan.environments].reverse()) {
    const v = envs[e.id]
    if (!v?.done) continue
    if (v.how === 'link') await d.maintenance({ id: e.id }, false, null)
    else if (v.how === 'status') {
      await db('nivaro_hub_environments')
        .where({ id: e.id, status: 'maintenance' })
        .update({ status: String(v.prev ?? 'active'), updated_at: at })
    } else if (v.how === 'manual') manual.push(e.key)
    envs[e.id] = { ...v, done: false }
    await ctx.save({ ...ctx.detail, envs })
  }
  await db(FREEZES)
    .where({ source: retireFreezeSource(ctx.ret.id) })
    .where('ends_at', '>', at)
    .update({ ends_at: at, updated_at: at })
  return `Freeze lifted${manual.length ? `; lift maintenance on ${manual.join(', ')} yourself` : ''}.`
}

// ─── export ──────────────────────────────────────────────────────────────────────────────────

const ENDED_BAD = new Set(['failed', 'refused', 'cancelled', 'interrupted'])

export interface ExportSkip {
  environment_id: number
  what: 'db' | 'files'
}

export function skipsOf(v: unknown): ExportSkip[] {
  if (!Array.isArray(v)) return []
  return v
    .map((s) => ({
      environment_id: Number((s as { environment_id?: unknown })?.environment_id),
      what: (s as { what?: unknown })?.what as ExportSkip['what']
    }))
    .filter(
      (s) =>
        Number.isSafeInteger(s.environment_id) &&
        s.environment_id > 0 &&
        (s.what === 'db' || s.what === 'files')
    )
}

const exportStep: StepBody = async (ctx) => {
  const d = resolvedDeps(ctx.deps)
  const skips = skipsOf(ctx.input.skip)
  const skipped = (envId: number, what: 'db' | 'files') =>
    skips.some((s) => s.environment_id === envId && s.what === what)
  const detail = { ...ctx.detail }
  const envs = envMap(detail.envs)
  // A new sign-off (Retry) gets fresh tries; Resume carries the same attempt on.
  if (detail.attempt !== ctx.input.attempt) {
    for (const v of Object.values(envs)) {
      delete v.db_tries
      delete v.files_tries
    }
    detail.attempt = ctx.input.attempt ?? null
  }
  const started = d.now().getTime()
  const parts: Array<{ env: RetireEnvPlan; what: 'db' | 'files' }> = []
  for (const e of ctx.plan.environments)
    for (const what of ['db', 'files'] as const) parts.push({ env: e, what })
  const runKey = (what: 'db' | 'files') => (what === 'db' ? 'db_run' : 'files_run')
  const stateKey = (what: 'db' | 'files') => (what === 'db' ? 'db' : 'files')

  for (;;) {
    let waiting = false
    for (const { env, what } of parts) {
      const v = { ...(envs[env.id] ?? {}) }
      if (skipped(env.id, what)) {
        v[stateKey(what)] = 'skipped'
        envs[env.id] = v
        continue
      }
      if (v[stateKey(what)] === 'done') continue
      const runId = Number(v[runKey(what)] ?? 0)
      const run = runId ? await d.readDataRun(runId) : null
      if (run?.status === 'done') {
        v[stateKey(what)] = 'done'
      } else if (run && !ENDED_BAD.has(run.status)) {
        v[stateKey(what)] = 'running'
        waiting = true
      } else {
        // None yet, or it ended badly: start one (a second failure in a row stops the step).
        if (run && Number(v[`${what}_tries`] ?? 0) >= 2)
          throw new RetireError(
            'EXPORT_FAILED',
            `${env.key}: the ${what === 'db' ? 'database' : 'files'} backup did not finish (${run.error ?? run.status}). Fix it on Backups & data, then Retry.`
          )
        try {
          v[runKey(what)] =
            what === 'db'
              ? await d.startDbBackup(env.id, ctx.by)
              : await d.startFilesBackup(env.id, ctx.by)
        } catch (err) {
          const code = (err as { code?: unknown } | null)?.code
          const msg = err instanceof Error ? err.message : 'it could not start'
          throw new RetireError(
            'EXPORT_FAILED',
            `${env.key}: the ${what === 'db' ? 'database' : 'files'} backup could not start (${typeof code === 'string' ? code : 'error'}: ${msg.slice(0, 200)}).`
          )
        }
        v[`${what}_tries`] = Number(v[`${what}_tries`] ?? 0) + 1
        v[stateKey(what)] = 'running'
        waiting = true
      }
      envs[env.id] = v
    }
    detail.envs = envs
    await ctx.save(detail)
    if (!waiting) break
    if (d.now().getTime() - started > EXPORT_DEADLINE_MS)
      throw new RetireError(
        'EXPORT_TIMEOUT',
        'The backups did not finish within 24 hours; Resume keeps waiting.'
      )
    await d.sleep(d.pollMs)
  }
  const done = Object.values(envs).reduce(
    (n, v) => n + (v.db === 'done' ? 1 : 0) + (v.files === 'done' ? 1 : 0),
    0
  )
  return `${done} backups made${skips.length ? `, ${skips.length} skipped (${String(ctx.input.reason ?? '').slice(0, 120)})` : ''}. They are kept on Backups & data.`
}

const undoExport: StepBody = async () =>
  'Nothing to take back: the backups are kept on Backups & data.'

// ─── notice ──────────────────────────────────────────────────────────────────────────────────

function peoplePath(plan: RetirePlan, envBase: Map<number, string>): string {
  const prod = plan.environments.find((e) => e.production) ?? plan.environments[0]
  const base = prod ? envBase.get(prod.id) : undefined
  return base && /^https?:\/\//i.test(base) ? base : '/'
}

async function baseUrls(plan: RetirePlan): Promise<Map<number, string>> {
  const ids = plan.environments.map((e) => e.id)
  if (!ids.length) return new Map()
  const rows = (await db('nivaro_hub_environments')
    .whereIn('id', ids)
    .select('id', 'base_url')) as Array<{ id: number; base_url: string }>
  return new Map(rows.map((r) => [Number(r.id), String(r.base_url ?? '')]))
}

const noticeStep: StepBody = async (ctx) => {
  const d = resolvedDeps(ctx.deps)
  const detail = { ...ctx.detail }
  const text = String(ctx.input.notice ?? ctx.ret.notice ?? '').trim() || defaultNotice(ctx.plan)
  detail.text = text
  const envIds = ctx.plan.environments.map((e) => e.id)
  if (!detail.sent_at) {
    const { team, people } = await d.recipients(ctx.plan.app.id, envIds)
    const base = {
      subject: `${ctx.plan.app.name} is being retired`,
      message: text,
      urgent: false,
      email: true,
      source: { kind: 'hub-retirement', label: ctx.plan.app.key, id: ctx.ret.id }
    }
    const sentTeam = await d.deliver(team, {
      ...base,
      path: `/hub/lifecycle?retirement=${ctx.ret.id}`,
      why: 'You are a Hub administrator or an owner of this app.'
    })
    const sentPeople = await d.deliver(people, {
      ...base,
      path: peoplePath(ctx.plan, await baseUrls(ctx.plan)),
      why: 'You signed in to this app through the Hub.'
    })
    detail.team = team
    detail.people = people
    detail.sent = sentTeam + sentPeople
    detail.sent_at = d.now().toISOString()
    await ctx.save(detail)
  }
  const shown: string[] = []
  for (const e of ctx.plan.environments) {
    if (e.freeze !== 'link') continue
    await d.maintenance({ id: e.id }, true, text)
    shown.push(e.key)
  }
  return `Final notice sent to ${Number(detail.sent ?? 0)} people${shown.length ? `; shown on the maintenance page of ${shown.join(', ')}` : ''}.`
}

const undoNotice: StepBody = async (ctx) => {
  const d = resolvedDeps(ctx.deps)
  const ids = [
    ...(Array.isArray(ctx.detail.team) ? (ctx.detail.team as string[]) : []),
    ...(Array.isArray(ctx.detail.people) ? (ctx.detail.people as string[]) : [])
  ]
  const n = ids.length
    ? await d.deliver(ids, {
        subject: `${ctx.plan.app.name} is not being retired after all`,
        message: `The retirement of ${ctx.plan.app.name} was called off. Ignore the earlier notice.`,
        path: `/hub/lifecycle?retirement=${ctx.ret.id}`,
        email: true,
        source: { kind: 'hub-retirement', label: ctx.plan.app.key, id: ctx.ret.id },
        why: 'You were told this app would be retired.'
      })
    : 0
  for (const e of ctx.plan.environments)
    if (e.freeze === 'link') await d.maintenance({ id: e.id }, true, freezeMessage(ctx.plan))
  return `"Called off" sent to ${n} people.`
}

// ─── remove ──────────────────────────────────────────────────────────────────────────────────

const removeStep: StepBody = async (ctx) => {
  const d = resolvedDeps(ctx.deps)
  const detail = { ...ctx.detail }
  const envs = envMap(detail.envs)
  const manual = numList(ctx.input.manual)
  for (const e of ctx.plan.environments) {
    if (envs[e.id]?.done) continue
    const at = d.now()
    if (e.kind === 'docker') {
      const r = await d.removeStack(e.id)
      if (r === 'locked')
        throw new RetireError(
          'LOCKED',
          `${e.key}: a promotion or another stack action holds the environment now. Retry when it ends.`
        )
      if (r === 'not_ours')
        throw new RetireError(
          'STACK_NOT_OURS',
          `${e.key}: the stack ${e.stack} on the agent does not carry this app's labels; nothing was removed. Check the placement.`
        )
      await db('nivaro_hub_environments')
        .where({ id: e.id })
        .update({ status: 'suspended', version_pin: null, updated_at: at })
      envs[e.id] = { how: 'stack', result: r, stack: e.stack, done: true }
    } else if (e.kind === 'shared') {
      const row = (await db('nivaro_hub_environments').where({ id: e.id }).first('placement_id')) as
        | { placement_id: number | null }
        | undefined
      await db('nivaro_hub_environments')
        .where({ id: e.id })
        .update({ status: 'suspended', placement_id: null, updated_at: at })
      envs[e.id] = { how: 'shared', placement_id: row?.placement_id ?? null, done: true }
    } else {
      if (!manual.includes(e.id))
        throw new RetireError('MANUAL_NEEDED', `${e.key}: confirm that you stopped it.`)
      await db('nivaro_hub_environments')
        .where({ id: e.id })
        .update({ status: 'suspended', updated_at: at })
      envs[e.id] = { how: 'manual', done: true }
    }
    detail.envs = envs
    await ctx.save(detail)
  }
  const stacks = Object.values(envs).filter((v) => v.how === 'stack').length
  return `${ctx.plan.environments.length} environments stopped (${stacks} Docker stacks removed; volumes and databases kept).`
}

// ─── archive ─────────────────────────────────────────────────────────────────────────────────

const archiveStep: StepBody = async (ctx) => {
  const d = resolvedDeps(ctx.deps)
  const at = d.now()
  await db('nivaro_hub_environments')
    .where({ app_id: ctx.plan.app.id })
    .whereNot({ status: 'archived' })
    .update({ status: 'archived', updated_at: at })
  await db('nivaro_hub_apps')
    .where({ id: ctx.plan.app.id })
    .update({
      archived_at: at,
      archived_by: ctx.by && /^[0-9a-f-]{36}$/i.test(ctx.by) ? ctx.by : null,
      updated_at: at
    })
  // The freeze has done its job: from here every start refuses the archived app with
  // ENV_ARCHIVED (services/hub/releases/archived.ts, judged inside freezeRefusal).
  await db(FREEZES)
    .where({ source: retireFreezeSource(ctx.ret.id) })
    .where('ends_at', '>', at)
    .update({ ends_at: at, updated_at: at })
  return `${ctx.plan.app.name} is retired: its environments are archived, and every deploy, move, scale or restart of it is refused.`
}

export const STEP_BODIES: Record<RetireStepKey, StepBody> = {
  freeze: freezeStep,
  export: exportStep,
  notice: noticeStep,
  remove: removeStep,
  archive: archiveStep
}

export const UNDO_BODIES: Partial<Record<RetireStepKey, StepBody>> = {
  freeze: undoFreeze,
  export: undoExport,
  notice: undoNotice
}
