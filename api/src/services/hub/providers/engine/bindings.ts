import { db } from '../../../../db/index.js'
import { runInBackgroundPool } from '../../../../db/pool-context.js'
import { logActivity } from '../../../activity.js'
import { appSettingAllowed } from '../../../hub-link/settings-allow.js'
import { getApp } from '../../../io-holder.js'
import { GENERATED_SECRET_KEYS } from '../../docker/stack-settings.js'
import { envPolicy } from '../../owner-access.js'
import { openSecret, sealSecret } from '../../secrets.js'
import { AppSettingsLinkError, pushAppSettings } from '../app-settings-link.js'
import { scrubValues } from '../context.js'
import { findType } from '../registry.js'
import { type HubResourceRow, readResource } from '../store.js'
import type { OpResult, OutputSpec, ResourceTypeSpec } from '../types.js'
import { ROTATE_OUTPUTS_FIELD } from '../types.js'
import type { HubActor } from './contract.js'
import { contextFor, openConnection, regionFor, secretFieldFingerprint } from './plan.js'

/**
 * Hub providers, Wave 2 framework (Task 13): a resource's OUTPUTS (a DSN, an API key, a URL the
 * provider hands out) and the BINDINGS that carry them into an environment.
 *
 *  - An apply's `OpResult.outputs` is split off here before anything stores the result
 *    (splitOutputs): each declared value is sealed at once (nivaro_hub_resource_outputs) and
 *    scrubbed from the result, the observed state, the step and every message. Undeclared keys
 *    are dropped. Nothing outside this file ever opens a stored value, and no route answers one:
 *    reads carry the key, a fingerprint and when it changed.
 *  - A binding sends one output to one destination of one environment:
 *      stack_setting  a plain stack setting (never a secret output: SECRET_TO_PLAIN)
 *      stack_secret   a sealed stack secret
 *      app_setting    an allow-listed app setting, through the hub link (settings-allow.ts)
 *    A stack write only saves the stack's settings: the stack then shows it needs Apply now — the
 *    Hub never deploys by itself. `pushBindings` runs after an apply that changed an output (in the
 *    background) and when bindings are saved.
 *  - A `onceOnly` output (shown by the provider at create only) is never re-read: once its sealed
 *    copy is gone it can only be rotated (ROTATE_OUTPUTS_FIELD); other outputs are re-read through
 *    `adapter.readOutputs` when a push finds no stored value.
 */

export const OUTPUTS = 'nivaro_hub_resource_outputs'
export const BINDINGS = 'nivaro_hub_resource_bindings'

export type BindingTarget = 'stack_setting' | 'stack_secret' | 'app_setting'
export const BINDING_TARGETS: readonly BindingTarget[] = [
  'stack_setting',
  'stack_secret',
  'app_setting'
]

export class BindingError extends Error {
  code: string
  status: number
  constructor(code: string, status: number, message: string) {
    super(message)
    this.name = 'BindingError'
    this.code = code
    this.status = status
  }
}

const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/
const OUTPUT_KEY_RE = /^[a-z][a-z0-9_]{0,63}$/
const MAX_BINDINGS = 50

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const t =
    v instanceof Date
      ? v.getTime()
      : typeof v === 'number' || /^\d{12,}$/.test(String(v))
        ? Number(v)
        : Date.parse(String(v))
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}

/** The outputs a type declares (a malformed key is ignored). */
export function declaredOutputs(type: ResourceTypeSpec | null | undefined): OutputSpec[] {
  return (type?.outputs ?? []).filter((o) => OUTPUT_KEY_RE.test(o.key))
}

function typeOf(key: string): ResourceTypeSpec | null {
  return findType(key)?.type ?? null
}

// ── Splitting an apply's answer ──

/**
 * The result without its outputs, plus the declared output values (non-empty text only). Pure.
 * Every value is scrubbed out of the rest of the result too (an adapter that echoed a key in
 * `answer` or `observed` never gets it stored).
 */
export function splitOutputs(
  type: ResourceTypeSpec,
  result: OpResult
): { result: OpResult; values: Record<string, string> } {
  const declared = new Set(declaredOutputs(type).map((o) => o.key))
  const values: Record<string, string> = {}
  const raw = result.outputs
  if (raw && typeof raw === 'object' && !Array.isArray(raw))
    for (const [k, v] of Object.entries(raw))
      if (declared.has(k) && typeof v === 'string' && v !== '') values[k] = v
  const { outputs: _dropped, ...rest } = result
  const all = raw && typeof raw === 'object' ? Object.values(raw) : []
  const secrets = all.filter((v): v is string => typeof v === 'string')
  if (!secrets.length) return { result: rest, values }
  try {
    return { result: JSON.parse(scrubValues(JSON.stringify(rest), secrets)) as OpResult, values }
  } catch {
    return { result: { ok: rest.ok, externalId: rest.externalId, observed: null }, values }
  }
}

// ── Stored outputs ──

export interface StoredOutputMeta {
  key: string
  fingerprint: string | null
  updated_at: string | null
}

/** Seals and stores each value; answers the keys whose value changed (by fingerprint). */
export async function storeOutputs(
  resourceId: number,
  values: Record<string, string>
): Promise<string[]> {
  const changed: string[] = []
  for (const [key, plain] of Object.entries(values)) {
    const fingerprint = secretFieldFingerprint(plain)
    const row = (await db(OUTPUTS)
      .where({ resource_id: resourceId, key })
      .first('id', 'fingerprint')) as { id: number; fingerprint: string | null } | undefined
    if (row && row.fingerprint === fingerprint) continue
    const patch = { value: sealSecret(plain), fingerprint, updated_at: new Date() }
    if (row) await db(OUTPUTS).where({ id: row.id }).update(patch)
    else await db(OUTPUTS).insert({ resource_id: resourceId, key, ...patch })
    changed.push(key)
  }
  return changed
}

/** Keys, fingerprints and times only — never a value. */
export async function outputMeta(resourceId: number): Promise<StoredOutputMeta[]> {
  const rows = (await db(OUTPUTS)
    .where({ resource_id: resourceId })
    .orderBy('key', 'asc')
    .select('key', 'fingerprint', 'updated_at')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    key: String(r.key),
    fingerprint: r.fingerprint == null ? null : String(r.fingerprint),
    updated_at: iso(r.updated_at)
  }))
}

/** Opens one stored output (this file only: pushes). */
async function openOutput(resourceId: number, key: string): Promise<string | null> {
  const row = (await db(OUTPUTS).where({ resource_id: resourceId, key }).first('value')) as
    | { value: string | null }
    | undefined
  try {
    return row?.value ? openSecret(row.value) : null
  } catch {
    return null
  }
}

/** A deleted resource's outputs no longer work: the sealed copies go (bindings stay, unfed). */
export async function forgetOutputs(resourceId: number): Promise<void> {
  await db(OUTPUTS).where({ resource_id: resourceId }).del()
}

/**
 * Re-reads the outputs the provider shows again (never a `onceOnly` one, even if an adapter
 * answers it) and stores them. Answers the keys stored; [] when the adapter cannot re-read.
 */
export async function rereadOutputs(row: HubResourceRow): Promise<string[]> {
  const type = typeOf(row.type)
  if (!type || !row.external_id || row.deleted_at) return []
  const want = declaredOutputs(type).filter((o) => !o.onceOnly)
  if (!want.length) return []
  const conn = await openConnection(row.connection_id)
  if (!conn.adapter.readOutputs) return []
  const ctx = contextFor(conn, regionFor(conn.row.config, row.desired, row.observed))
  const got = await conn.adapter.readOutputs(ctx, type.key, row.external_id)
  const keep: Record<string, string> = {}
  for (const o of want) {
    const v = got?.[o.key]
    if (typeof v === 'string' && v !== '') keep[o.key] = v
  }
  await storeOutputs(row.id, keep)
  return Object.keys(keep)
}

// ── The read the resource page shows ──

export interface OutputView {
  key: string
  label: string
  secret: boolean
  once_only: boolean
  /** A sealed value is stored. */
  set: boolean
  fingerprint: string | null
  updated_at: string | null
  /** A once-only output whose copy is gone: only a rotation brings it back. */
  lost: boolean
  /** The type offers the rotate op (ROTATE_OUTPUTS_FIELD); plan `{rotate_outputs: true}`. */
  rotate: boolean
}

export async function outputsView(row: HubResourceRow): Promise<OutputView[]> {
  const type = typeOf(row.type)
  const specs = declaredOutputs(type)
  if (!specs.length) return []
  const meta = new Map((await outputMeta(row.id)).map((m) => [m.key, m]))
  const rotate = !!type?.fields.some((f) => f.key === ROTATE_OUTPUTS_FIELD && f.trigger)
  return specs.map((o) => {
    const m = meta.get(o.key)
    return {
      key: o.key,
      label: o.label,
      secret: o.secret,
      once_only: o.onceOnly === true,
      set: !!m,
      fingerprint: m?.fingerprint ?? null,
      updated_at: m?.updated_at ?? null,
      lost: o.onceOnly === true && !m && !!row.external_id && !row.deleted_at,
      rotate
    }
  })
}

// ── Bindings ──

export interface BindingRow {
  id: number
  resource_id: number
  output_key: string
  environment_id: number
  target: BindingTarget
  target_key: string
  last_pushed_at: string | null
  last_fingerprint: string | null
  last_error: string | null
  created_by: string | null
}

function bindingOf(r: Record<string, unknown>): BindingRow {
  const target = String(r.target)
  return {
    id: Number(r.id),
    resource_id: Number(r.resource_id),
    output_key: String(r.output_key),
    environment_id: Number(r.environment_id),
    target: (BINDING_TARGETS as readonly string[]).includes(target)
      ? (target as BindingTarget)
      : 'app_setting',
    target_key: String(r.target_key),
    last_pushed_at: iso(r.last_pushed_at),
    last_fingerprint: r.last_fingerprint == null ? null : String(r.last_fingerprint),
    last_error: r.last_error == null ? null : String(r.last_error),
    created_by: r.created_by == null ? null : String(r.created_by)
  }
}

export async function listBindings(resourceId: number): Promise<BindingRow[]> {
  const rows = (await db(BINDINGS)
    .where({ resource_id: resourceId })
    .orderBy('id', 'asc')
    .select('*')) as Array<Record<string, unknown>>
  return rows.map(bindingOf)
}

export interface BindingInput {
  output_key: string
  environment_id: number
  target: BindingTarget
  target_key: string
}

/** Problems with one binding's shape (pure): null = fine. */
export function bindingShapeProblem(spec: OutputSpec | undefined, b: BindingInput): string | null {
  if (!spec) return `${b.output_key} is not an output of this resource.`
  if (!BINDING_TARGETS.includes(b.target))
    return 'target must be stack_setting, stack_secret or app_setting.'
  if (b.target === 'app_setting') {
    if (!appSettingAllowed(b.target_key))
      return `SETTING_NOT_ALLOWED: the Hub may not set ${b.target_key} on an app.`
    return null
  }
  if (!ENV_KEY_RE.test(b.target_key))
    return `${b.target_key} is not a setting name (A–Z, 0–9 and _, up to 64).`
  if ((GENERATED_SECRET_KEYS as readonly string[]).includes(b.target_key))
    return `${b.target_key} belongs to the stack and is never bound.`
  if (b.target === 'stack_setting' && spec.secret)
    return `SECRET_TO_PLAIN: ${spec.label} is a secret; bind it to a stack secret or an app credential.`
  return null
}

/**
 * Replaces the resource's bindings with `inputs` (the whole list). Admins: any resource (a shared
 * one to any environment; an app one to its own app's environments). Owners: only an app-scope
 * resource of an app they own, only that app's environments, and production only when the app lets
 * owners deploy production. Refusals are BindingError (status + code).
 */
export async function setBindings(
  row: HubResourceRow,
  inputs: BindingInput[],
  actor: Pick<HubActor, 'id' | 'isAdmin'>
): Promise<BindingRow[]> {
  if (row.deleted_at) throw new BindingError('NOT_FOUND', 404, 'No such resource.')
  if (!actor.isAdmin) {
    if (row.scope !== 'app' || row.app_id == null)
      throw new BindingError(
        'SHARED_ADMIN_ONLY',
        403,
        'Shared resources are bound by Hub administrators.'
      )
    const own = await db('nivaro_hub_app_owners')
      .where({ app_id: row.app_id, user_id: actor.id })
      .first('id')
    if (!own) throw new BindingError('NOT_FOUND', 404, 'No such resource.')
  }
  if (inputs.length > MAX_BINDINGS)
    throw new BindingError('INVALID_FIELDS', 400, `At most ${MAX_BINDINGS} bindings per resource.`)
  const type = typeOf(row.type)
  const specs = new Map(declaredOutputs(type).map((o) => [o.key, o]))
  const seen = new Set<string>()
  const envApp = new Map<number, number | null>()
  for (const b of inputs) {
    const problem = bindingShapeProblem(specs.get(b.output_key), b)
    if (problem) {
      const code = problem.startsWith('SETTING_NOT_ALLOWED')
        ? 'SETTING_NOT_ALLOWED'
        : problem.startsWith('SECRET_TO_PLAIN')
          ? 'SECRET_TO_PLAIN'
          : 'INVALID_FIELDS'
      throw new BindingError(code, 400, problem.replace(/^[A-Z_]+: /, ''))
    }
    const dest = `${b.environment_id}\0${b.target}\0${b.target_key}`
    if (seen.has(dest))
      throw new BindingError('INVALID_FIELDS', 400, `${b.target_key} is bound twice in this list.`)
    seen.add(dest)
    if (!envApp.has(b.environment_id)) {
      const env = (await db('nivaro_hub_environments')
        .where({ id: b.environment_id })
        .first('app_id')) as { app_id: number } | undefined
      envApp.set(b.environment_id, env ? Number(env.app_id) : null)
    }
    const app = envApp.get(b.environment_id)
    if (app == null) throw new BindingError('INVALID_FIELDS', 400, 'No such environment.')
    if (row.scope === 'app' && row.app_id !== app)
      throw new BindingError(
        'ENV_NOT_OF_APP',
        400,
        'A resource of an app is bound only to that app’s environments.'
      )
  }
  if (!actor.isAdmin)
    for (const envId of envApp.keys()) {
      const p = await envPolicy(envId).catch(() => null)
      if (!p || (p.production && !p.ownersDeployProduction))
        throw new BindingError(
          'PRODUCTION_ADMIN_ONLY',
          403,
          'Production is changed by Hub administrators on this app. A Hub administrator can let owners deploy production.'
        )
    }
  // One source per destination: another resource's binding there refuses (BINDING_TAKEN).
  for (const b of inputs) {
    const other = (await db(BINDINGS)
      .where({ environment_id: b.environment_id, target: b.target, target_key: b.target_key })
      .whereNot({ resource_id: row.id })
      .first('resource_id')) as { resource_id: number } | undefined
    if (other)
      throw new BindingError(
        'BINDING_TAKEN',
        409,
        `${b.target_key} on that environment is already fed by another resource.`
      )
  }
  const before = await listBindings(row.id)
  const keyOf = (b: Pick<BindingRow, 'output_key' | 'environment_id' | 'target' | 'target_key'>) =>
    `${b.output_key}\0${b.environment_id}\0${b.target}\0${b.target_key}`
  const want = new Map(inputs.map((b) => [keyOf(b), b]))
  const have = new Map(before.map((b) => [keyOf(b), b]))
  const now = new Date()
  await db.transaction(async (trx) => {
    const gone = before.filter((b) => !want.has(keyOf(b))).map((b) => b.id)
    if (gone.length) await trx(BINDINGS).whereIn('id', gone).del()
    for (const [k, b] of want) {
      if (have.has(k)) continue
      await trx(BINDINGS).insert({
        resource_id: row.id,
        output_key: b.output_key,
        environment_id: b.environment_id,
        target: b.target,
        target_key: b.target_key,
        created_by: actor.id || null,
        created_at: now,
        updated_at: now
      })
    }
  })
  return listBindings(row.id)
}

// ── Pushing ──

export interface PushOutcome {
  bindingId: number
  ok: boolean
  error?: string
}

/** Saves one stack setting or secret through the Stack panel's own validation; never deploys. */
async function writeStack(
  envId: number,
  target: 'stack_setting' | 'stack_secret',
  key: string,
  value: string
): Promise<void> {
  const ss = await import('../../docker/stack-settings.js')
  const existing = await ss.readStackSettings(envId)
  if (!existing)
    throw new BindingError(
      'NO_STACK_SETTINGS',
      409,
      'This environment has no stack settings yet — open its Stack panel and save once.'
    )
  if (target === 'stack_secret') {
    const map = ss.openSealedMap(existing.secrets)
    if (map[key] && openSecret(map[key]) === value) return
  } else if (existing.settings[key] === value) return
  const body =
    target === 'stack_secret'
      ? { secrets: { [key]: value } }
      : { settings: { ...existing.settings, [key]: value } }
  // The driver / environment are not read by the validation (stack-settings.ts ctx); no agent
  // prefixes are read, so only keys Nivaro knows bind (fail closed).
  const v = await ss.validateStackSettings(body, existing, {
    driver: {} as never,
    env: {} as never
  })
  if (!v.ok) throw new BindingError(v.code, 400, v.message)
  await ss.saveStackSettings(envId, v.row.fields)
}

/**
 * Writes every binding of the resource (or only those of `keys`) with the stored values. A value
 * that is not stored is re-read when the provider shows it again; a once-only one is reported as
 * lost (rotate it). Results land on each binding (last_pushed_at / last_fingerprint / last_error,
 * scrubbed). Never throws for one binding; never deploys a stack.
 */
export async function pushBindings(
  resourceId: number,
  opts: { keys?: string[]; actorId?: string | null } = {}
): Promise<PushOutcome[]> {
  const row = await readResource(resourceId)
  if (!row || row.deleted_at) return []
  let bindings = await listBindings(resourceId)
  if (opts.keys) bindings = bindings.filter((b) => opts.keys?.includes(b.output_key))
  if (!bindings.length) return []
  const type = typeOf(row.type)
  const specs = new Map(declaredOutputs(type).map((o) => [o.key, o]))
  const meta = new Map((await outputMeta(resourceId)).map((m) => [m.key, m]))
  const missing = [...new Set(bindings.map((b) => b.output_key))].filter(
    (k) => !meta.has(k) && specs.get(k) && !specs.get(k)?.onceOnly
  )
  if (missing.length) {
    try {
      await rereadOutputs(row)
      for (const m of await outputMeta(resourceId)) meta.set(m.key, m)
    } catch {
      // Reported per binding below.
    }
  }
  const values = new Map<string, string>()
  for (const k of new Set(bindings.map((b) => b.output_key))) {
    const v = meta.has(k) ? await openOutput(resourceId, k) : null
    if (v != null) values.set(k, v)
  }
  const scrub = (text: string) => scrubValues(text, values.values()).slice(0, 1000)
  const out: PushOutcome[] = []
  const record = async (b: BindingRow, error: string | null) => {
    const fp = meta.get(b.output_key)?.fingerprint ?? null
    await db(BINDINGS)
      .where({ id: b.id })
      .update(
        error
          ? { last_error: scrub(error), updated_at: new Date() }
          : {
              last_pushed_at: new Date(),
              last_fingerprint: fp,
              last_error: null,
              updated_at: new Date()
            }
      )
    out.push({ bindingId: b.id, ok: !error, ...(error ? { error: scrub(error) } : {}) })
  }
  const appBatch = new Map<number, BindingRow[]>()
  for (const b of bindings) {
    const spec = specs.get(b.output_key)
    const value = values.get(b.output_key)
    if (!spec) {
      await record(b, `${b.output_key} is no longer an output of this resource.`)
      continue
    }
    if (value == null) {
      await record(
        b,
        spec.onceOnly
          ? `${spec.label} was shown by the provider only once and the Hub no longer holds it — rotate it to get a new one.`
          : `${spec.label} is not known yet — the provider has not handed it out.`
      )
      continue
    }
    if (b.target === 'app_setting') {
      const list = appBatch.get(b.environment_id) ?? []
      list.push(b)
      appBatch.set(b.environment_id, list)
      continue
    }
    try {
      await writeStack(b.environment_id, b.target, b.target_key, value)
      await record(b, null)
    } catch (e) {
      await record(b, e instanceof Error ? e.message : 'The stack setting could not be saved.')
    }
  }
  for (const [envId, list] of appBatch) {
    const settings: Record<string, string> = {}
    for (const b of list) settings[b.target_key] = values.get(b.output_key) as string
    try {
      await pushAppSettings(envId, settings)
      for (const b of list) await record(b, null)
    } catch (e) {
      const msg =
        e instanceof AppSettingsLinkError
          ? `${e.code}: ${e.message}`
          : 'The app settings could not be sent.'
      for (const b of list) await record(b, msg)
    }
  }
  await logActivity({
    action: 'hub-resource-bindings-push',
    user: opts.actorId ?? null,
    collection: BINDINGS,
    item: String(resourceId),
    origin: opts.actorId ? 'person' : 'machine',
    comment: JSON.stringify({
      resource_id: resourceId,
      pushed: out.filter((o) => o.ok).map((o) => o.bindingId),
      failed: out.filter((o) => !o.ok).map((o) => o.bindingId)
    })
  }).catch(() => null)
  return out
}

/** Pushes in the background (an apply's end, a bindings save): never holds the caller. */
export function schedulePush(
  resourceId: number,
  opts: { keys?: string[]; actorId?: string | null } = {}
) {
  void runInBackgroundPool(() => pushBindings(resourceId, opts)).catch((err) =>
    getApp()?.log?.warn?.(
      { resource: resourceId, err: (err as Error | null)?.name ?? 'Error' },
      'hub bindings push failed'
    )
  )
}

// ── The read the resource page shows ──

export interface BindingView extends BindingRow {
  environment_key: string | null
  /** The value now stored differs from what this binding last pushed. */
  stale: boolean
  /** A stack target pushed after the stack's last deploy: the stack needs Apply now. */
  needs_apply: boolean
}

export async function bindingsView(row: HubResourceRow): Promise<BindingView[]> {
  const list = await listBindings(row.id)
  if (!list.length) return []
  const meta = new Map((await outputMeta(row.id)).map((m) => [m.key, m]))
  const envIds = [...new Set(list.map((b) => b.environment_id))]
  const envs = (await db('nivaro_hub_environments')
    .whereIn('id', envIds)
    .select('id', 'key')) as Array<{ id: number; key: string }>
  const keyOf = new Map(envs.map((e) => [Number(e.id), String(e.key)]))
  const lastDeploy = new Map<number, string | null>()
  for (const id of envIds) {
    const d = (await db('nivaro_hub_deploys')
      .where({ environment_id: id })
      .whereIn('status', ['running', 'success'])
      .orderBy('id', 'desc')
      .first('started_at')
      .catch(() => undefined)) as { started_at?: unknown } | undefined
    lastDeploy.set(id, iso(d?.started_at))
  }
  return list.map((b) => {
    const deployed = lastDeploy.get(b.environment_id) ?? null
    const pushed = b.last_pushed_at
    return {
      ...b,
      environment_key: keyOf.get(b.environment_id) ?? null,
      stale: !!meta.get(b.output_key) && meta.get(b.output_key)?.fingerprint !== b.last_fingerprint,
      needs_apply:
        b.target !== 'app_setting' &&
        !!pushed &&
        (!deployed || Date.parse(deployed) < Date.parse(pushed))
    }
  })
}
