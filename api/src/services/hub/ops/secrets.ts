import { createHash, randomBytes } from 'node:crypto'
import { db } from '../../../db/index.js'
import { AgentError, agentHealth } from '../docker/agent-client.js'
import { dockerTargetOf } from '../docker/stack-guards.js'
import { getDriver } from '../drivers.js'
import { hubTokenColumns } from '../link-token.js'
import { moveOpenRefusal } from '../move-open.js'
import { startStackApply } from '../promote-run.js'
import { openSecret } from '../secrets.js'
import { deploymentClient } from '../shared/deployment-client.js'
import { getShared } from '../shared/store.js'
import { readEnvironmentStatus } from '../status.js'
import { hubAdminIds, notifyOps, type OpsNotifier } from './notify.js'

/**
 * Hub enhancement 19: the secret rotation helper.
 *
 * INVENTORY — every secret the Hub holds or delivers, read from where it lives: environments'
 * hub tokens and app keys, drivers' tokens, shared deployments' tokens and secrets, sign-in
 * client secrets and signing keys, stack secrets (per key), targets' tokens, database servers'
 * admin logins, databases' connections, apps' own OpenID secrets. A secret's VALUE is never read
 * for this: its fingerprint is the SHA-256 of the SEALED value as stored (a stack's secrets
 * column is opened only to list its per-key SEALED values). A changed fingerprint = a rotation.
 * Nothing here ever answers a value, a mask or a sealed string; the once-on-create / once-on-
 * rotate reveal of the existing routes is the only time a person sees one.
 *
 * STATE — nivaro_hub_secrets (migration 568): one row per secret ref, the fingerprint, when it
 * was first seen and last rotated, the reminder sent, the readiness check after a rotation;
 * nivaro_hub_secret_rotations keeps the history.
 *
 * SCHEDULES — nivaro_hub_secret_policies: per kind, rotate every N days (null = no schedule),
 * remind N days before the due date. Defaults in KINDS. An app key is never on a schedule:
 * rotating it means re-encrypting the app's data.
 *
 * ROTATION — through the paths that already exist (shared token rotate, sign-in client rotate,
 * signing key rotate; the admin page calls them and then `markRotated`), plus one the Hub did not
 * have: a Docker environment's hub token (`rotateHubToken`: a new token, delivered by Apply now;
 * the old one is put back if the apply cannot start). Every other kind is replaced where it
 * lives, and the scan sees it.
 *
 * READINESS — every rotation gets a check a few minutes later (the Hub cron `hub-secrets`):
 * the environment's link / status, the shared deployment's link, the Docker agent. A failed
 * check tells the Hub administrators.
 */

export const SECRETS = 'nivaro_hub_secrets'
export const ROTATIONS = 'nivaro_hub_secret_rotations'
export const POLICIES = 'nivaro_hub_secret_policies'

export type SecretKind =
  | 'hub_token'
  | 'app_key'
  | 'driver_token'
  | 'deployment_token'
  | 'shared_secrets'
  | 'oidc_client_secret'
  | 'oidc_signing_key'
  | 'stack_secret'
  | 'target_token'
  | 'db_server_secret'
  | 'db_connection'
  | 'app_oidc_secret'

/** How a kind is rotated: by this helper, by an existing Hub route, by hand where it lives, never. */
export type RotateMode = 'helper' | 'route' | 'manual' | 'never'

export interface KindInfo {
  label: string
  every_days: number | null
  remind_days: number
  rotate: RotateMode
  /** What rotating it involves, for the page. */
  how: string
}

export const KINDS: Record<SecretKind, KindInfo> = {
  hub_token: {
    label: 'Hub token',
    every_days: 180,
    remind_days: 14,
    rotate: 'helper',
    how: 'Docker environments: the Hub makes a new token and delivers it with Apply now. Others: set a new HUB_TOKEN on the app, then type it on the environment.'
  },
  app_key: {
    label: 'App encryption key',
    every_days: null,
    remind_days: 14,
    rotate: 'never',
    how: 'Never rotated here: a new key means re-encrypting the app’s data. Shown by fingerprint only.'
  },
  driver_token: {
    label: 'Driver token',
    every_days: 365,
    remind_days: 30,
    rotate: 'manual',
    how: 'Issue a new GitLab token (or a new agent token file), then paste it on the driver.'
  },
  deployment_token: {
    label: 'Shared deployment token',
    every_days: 180,
    remind_days: 14,
    rotate: 'route',
    how: 'Rotate on the shared deployment: the old token keeps working for 24 h, a Docker deployment gets the new one when its stack is applied.'
  },
  shared_secrets: {
    label: 'Shared deployment secrets',
    every_days: null,
    remind_days: 14,
    rotate: 'manual',
    how: 'Replace REDIS_URL (or another secret) on the shared deployment, then apply it.'
  },
  oidc_client_secret: {
    label: 'Sign-in client secret',
    every_days: 365,
    remind_days: 30,
    rotate: 'route',
    how: 'Rotate on Sign-in: the new secret is shown once; set it as HUB_CLIENT_SECRET on the app.'
  },
  oidc_signing_key: {
    label: 'Sign-in signing key',
    every_days: 180,
    remind_days: 14,
    rotate: 'route',
    how: 'Rotate on Sign-in: the new key is published first and signs about 6 minutes later.'
  },
  stack_secret: {
    label: 'Stack secret',
    every_days: null,
    remind_days: 14,
    rotate: 'manual',
    how: 'Replace it in the environment’s Stack settings (SESSION_SECRET can be regenerated there), then Apply now.'
  },
  target_token: {
    label: 'Target token',
    every_days: 365,
    remind_days: 30,
    rotate: 'manual',
    how: 'Issue a new GitLab token and paste it on the target; created apps are re-synced.'
  },
  db_server_secret: {
    label: 'Database server login',
    every_days: null,
    remind_days: 14,
    rotate: 'manual',
    how: 'Change the login on the database server, then save it on the Databases tab.'
  },
  db_connection: {
    label: 'Database connection',
    every_days: null,
    remind_days: 14,
    rotate: 'manual',
    how: 'Change the login on the database, then save the connection on the Databases tab.'
  },
  app_oidc_secret: {
    label: 'App sign-in secret',
    every_days: null,
    remind_days: 14,
    rotate: 'manual',
    how: 'Issue a new secret in the identity provider, then save it on the app.'
  }
}

export const SECRET_KINDS = Object.keys(KINDS) as SecretKind[]

export function isSecretKind(v: unknown): v is SecretKind {
  return typeof v === 'string' && Object.hasOwn(KINDS, v)
}

/** One secret as found where it lives. Never its value. */
export interface FoundSecret {
  ref: string
  kind: SecretKind
  label: string
  fp: string
  /** When the place it lives says it was made / last rotated, if it says. */
  since: Date | null
  /** Admin page that holds it. */
  path: string
  env_id?: number
  /** The environment key (what Rotate asks to be typed). */
  env_key?: string
  shared_id?: number
  driver_id?: number
}

export const fingerprintOf = (sealed: string): string =>
  createHash('sha256').update(String(sealed)).digest('hex').slice(0, 32)

const dateOf = (v: unknown): Date | null => {
  if (v == null) return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d
}
const has = (v: unknown): v is string => typeof v === 'string' && v !== ''

/** Every secret the Hub holds or delivers right now. */
export async function gatherSecrets(): Promise<FoundSecret[]> {
  const out: FoundSecret[] = []
  const envs = (await db('nivaro_hub_environments as e')
    .join('nivaro_hub_apps as a', 'a.id', 'e.app_id')
    .select(
      'e.id',
      'e.key',
      'e.app_id',
      'e.hub_token',
      'e.encryption_key',
      'e.created_at',
      'a.key as app_key'
    )) as Array<Record<string, unknown>>
  const envLabel = new Map<number, string>()
  const envApp = new Map<number, number>()
  for (const e of envs) {
    const id = Number(e.id)
    const name = `${e.app_key} / ${e.key}`
    envLabel.set(id, name)
    envApp.set(id, Number(e.app_id))
    const path = `/hub?app=${Number(e.app_id)}`
    if (has(e.hub_token))
      out.push({
        ref: `hub_token:${id}`,
        kind: 'hub_token',
        label: `${name} — hub token`,
        fp: fingerprintOf(e.hub_token),
        since: dateOf(e.created_at),
        path,
        env_id: id,
        env_key: String(e.key)
      })
    if (has(e.encryption_key))
      out.push({
        ref: `app_key:${id}`,
        kind: 'app_key',
        label: `${name} — app encryption key`,
        fp: fingerprintOf(e.encryption_key),
        since: null,
        path,
        env_id: id
      })
  }

  for (const d of (await db('nivaro_hub_drivers').select(
    'id',
    'kind',
    'name',
    'secret',
    'created_at'
  )) as Array<Record<string, unknown>>) {
    if (!has(d.secret)) continue
    out.push({
      ref: `driver_token:${Number(d.id)}`,
      kind: 'driver_token',
      label: `${d.name} — ${d.kind === 'docker' ? 'agent token' : 'GitLab token'}`,
      fp: fingerprintOf(d.secret),
      since: dateOf(d.created_at),
      path: `/hub/drivers?driver=${Number(d.id)}`,
      driver_id: Number(d.id)
    })
  }

  for (const s of (await db('nivaro_hub_shared_deployments')
    .whereNot('status', 'retired')
    .select('id', 'name', 'token', 'secrets', 'created_at')) as Array<Record<string, unknown>>) {
    const id = Number(s.id)
    const path = `/hub/shared?shared=${id}`
    if (has(s.token))
      out.push({
        ref: `deployment_token:${id}`,
        kind: 'deployment_token',
        label: `${s.name} — deployment token`,
        fp: fingerprintOf(s.token),
        since: dateOf(s.created_at),
        path,
        shared_id: id
      })
    if (has(s.secrets))
      out.push({
        ref: `shared_secrets:${id}`,
        kind: 'shared_secrets',
        label: `${s.name} — secrets`,
        fp: fingerprintOf(s.secrets),
        since: dateOf(s.created_at),
        path,
        shared_id: id
      })
  }

  for (const c of (await db('nivaro_hub_oidc_clients').select(
    'environment_id',
    'client_secret',
    'secret_rotated_at',
    'created_at'
  )) as Array<Record<string, unknown>>) {
    if (!has(c.client_secret)) continue
    const envId = Number(c.environment_id)
    out.push({
      ref: `oidc_client_secret:${envId}`,
      kind: 'oidc_client_secret',
      label: `${envLabel.get(envId) ?? `environment ${envId}`} — sign-in client secret`,
      fp: fingerprintOf(c.client_secret),
      since: dateOf(c.secret_rotated_at) ?? dateOf(c.created_at),
      path: '/hub/signin',
      env_id: envId
    })
  }

  // The signing key in use is the newest one not retired: its kid is its identity.
  const key = (await db('nivaro_hub_oidc_keys')
    .whereNull('retired_at')
    .orderBy('created_at', 'desc')
    .orderBy('id', 'desc')
    .first('kid', 'created_at')) as Record<string, unknown> | undefined
  if (key && has(key.kid))
    out.push({
      ref: 'oidc_signing_key:current',
      kind: 'oidc_signing_key',
      label: 'Hub sign-in — signing key',
      fp: fingerprintOf(`kid:${key.kid}`),
      since: dateOf(key.created_at),
      path: '/hub/signin'
    })

  for (const r of (await db('nivaro_hub_stack_settings').select(
    'environment_id',
    'secrets'
  )) as Array<Record<string, unknown>>) {
    if (!has(r.secrets)) continue
    const envId = Number(r.environment_id)
    let map: Record<string, unknown> = {}
    try {
      // The outer object holds each key's SEALED value; no value is opened here.
      const parsed = JSON.parse(openSecret(r.secrets) ?? '{}') as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        map = parsed as Record<string, unknown>
    } catch {
      map = {}
    }
    for (const [k, sealed] of Object.entries(map)) {
      if (!has(sealed) || !/^[A-Z][A-Z0-9_]{0,63}$/.test(k)) continue
      out.push({
        ref: `stack_secret:${envId}:${k}`,
        kind: 'stack_secret',
        label: `${envLabel.get(envId) ?? `environment ${envId}`} — ${k}`,
        fp: fingerprintOf(sealed),
        since: null,
        path: envApp.has(envId) ? `/hub?app=${envApp.get(envId)}` : '/hub',
        env_id: envId
      })
    }
  }

  for (const t of (await db('nivaro_hub_targets').select(
    'id',
    'name',
    'secret',
    'created_at'
  )) as Array<Record<string, unknown>>) {
    if (!has(t.secret)) continue
    out.push({
      ref: `target_token:${Number(t.id)}`,
      kind: 'target_token',
      label: `${t.name} — target token`,
      fp: fingerprintOf(t.secret),
      since: dateOf(t.created_at),
      path: '/hub/targets'
    })
  }

  for (const s of (await db('nivaro_hub_db_servers').select(
    'id',
    'name',
    'admin_secret',
    'created_at'
  )) as Array<Record<string, unknown>>) {
    if (!has(s.admin_secret)) continue
    out.push({
      ref: `db_server_secret:${Number(s.id)}`,
      kind: 'db_server_secret',
      label: `${s.name} — admin login`,
      fp: fingerprintOf(s.admin_secret),
      since: dateOf(s.created_at),
      path: '/hub/databases'
    })
  }

  for (const d of (await db('nivaro_hub_databases').select(
    'id',
    'database_name',
    'host',
    'connection',
    'created_at'
  )) as Array<Record<string, unknown>>) {
    if (!has(d.connection)) continue
    out.push({
      ref: `db_connection:${Number(d.id)}`,
      kind: 'db_connection',
      label: `${d.database_name} on ${d.host} — connection`,
      fp: fingerprintOf(d.connection),
      since: dateOf(d.created_at),
      path: '/hub/databases'
    })
  }

  if (await db.schema.hasColumn('nivaro_hub_apps', 'oidc_secret')) {
    for (const a of (await db('nivaro_hub_apps').select(
      'id',
      'key',
      'oidc_secret',
      'created_at'
    )) as Array<Record<string, unknown>>) {
      if (!has(a.oidc_secret)) continue
      out.push({
        ref: `app_oidc_secret:${Number(a.id)}`,
        kind: 'app_oidc_secret',
        label: `${a.key} — sign-in secret`,
        fp: fingerprintOf(a.oidc_secret),
        since: dateOf(a.created_at),
        path: `/hub?app=${Number(a.id)}`
      })
    }
  }
  return out
}

// ─── policies ────────────────────────────────────────────────────────────────────────────────

export interface SecretPolicy {
  kind: SecretKind
  every_days: number | null
  remind_days: number
  /** False = the defaults in KINDS (no row saved). */
  saved: boolean
}

export async function readPolicies(): Promise<Record<SecretKind, SecretPolicy>> {
  const rows = (await db(POLICIES).select('kind', 'every_days', 'remind_days')) as Array<
    Record<string, unknown>
  >
  const saved = new Map(rows.map((r) => [String(r.kind), r]))
  const out = {} as Record<SecretKind, SecretPolicy>
  for (const kind of SECRET_KINDS) {
    const r = saved.get(kind)
    out[kind] = r
      ? {
          kind,
          every_days: r.every_days == null ? null : Number(r.every_days),
          remind_days: Number(r.remind_days ?? KINDS[kind].remind_days),
          saved: true
        }
      : {
          kind,
          every_days: KINDS[kind].every_days,
          remind_days: KINDS[kind].remind_days,
          saved: false
        }
  }
  return out
}

export type PolicyCheck =
  | { ok: true; every_days: number | null; remind_days: number }
  | { ok: false; code: string; message: string }

export function validatePolicy(kind: SecretKind, body: unknown): PolicyCheck {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>
  const every = b.every_days
  const remind = b.remind_days ?? KINDS[kind].remind_days
  if (every !== null && (typeof every !== 'number' || !Number.isInteger(every)))
    return { ok: false, code: 'BAD_EVERY', message: 'every_days must be a whole number or null.' }
  if (typeof every === 'number' && (every < 1 || every > 3650))
    return { ok: false, code: 'BAD_EVERY', message: 'every_days must be between 1 and 3650.' }
  if (every !== null && KINDS[kind].rotate === 'never')
    return {
      ok: false,
      code: 'NEVER_ROTATED',
      message: `${KINDS[kind].label}s are never rotated on a schedule.`
    }
  if (typeof remind !== 'number' || !Number.isInteger(remind) || remind < 0 || remind > 365)
    return { ok: false, code: 'BAD_REMIND', message: 'remind_days must be between 0 and 365.' }
  if (typeof every === 'number' && remind >= every)
    return {
      ok: false,
      code: 'BAD_REMIND',
      message: 'The reminder must come before the due date (remind_days < every_days).'
    }
  return { ok: true, every_days: every as number | null, remind_days: remind }
}

export async function savePolicy(
  kind: SecretKind,
  p: { every_days: number | null; remind_days: number },
  userId: string | null
): Promise<void> {
  const fields = {
    every_days: p.every_days,
    remind_days: p.remind_days,
    updated_by: userId,
    updated_at: new Date()
  }
  const n = await db(POLICIES).where({ kind }).update(fields)
  if (Number(n) > 0) return
  try {
    await db(POLICIES).insert({ kind, ...fields })
  } catch {
    await db(POLICIES).where({ kind }).update(fields)
  }
  // A new schedule is a new due date: reminders for the old one no longer apply.
  await db(SECRETS).where({ kind }).update({ reminded_for: null })
}

// ─── scan (detect rotations) ─────────────────────────────────────────────────────────────────

/** How long after a rotation its readiness check runs. */
export const CHECK_DELAY_MS = 5 * 60_000

export interface ScanResult {
  found: number
  added: number
  rotated: string[]
  gone: number
}

/**
 * Syncs nivaro_hub_secrets with what is found. A changed fingerprint is a rotation: recorded
 * (history row), its reminder cleared and a readiness check set CHECK_DELAY_MS later. `by` +
 * `refs`: those refs' rotations are recorded as the helper's, by that person.
 */
export async function scanSecrets(
  opts: { now?: Date; by?: string | null; refs?: string[]; found?: FoundSecret[] } = {}
): Promise<ScanResult> {
  const now = opts.now ?? new Date()
  const found = opts.found ?? (await gatherSecrets())
  const rows = (await db(SECRETS).select('ref', 'fp', 'gone_at')) as Array<{
    ref: string
    fp: string
    gone_at: unknown
  }>
  const known = new Map(rows.map((r) => [r.ref, r]))
  const result: ScanResult = { found: found.length, added: 0, rotated: [], gone: 0 }
  const mine = new Set(opts.refs ?? [])
  for (const f of found) {
    const row = known.get(f.ref)
    known.delete(f.ref)
    if (!row) {
      try {
        await db(SECRETS).insert({
          ref: f.ref,
          kind: f.kind,
          fp: f.fp,
          first_seen_at: f.since ?? now,
          rotated_at: null
        })
        result.added++
      } catch {
        // Another scan inserted it first.
      }
      continue
    }
    if (row.fp === f.fp) {
      if (row.gone_at != null) await db(SECRETS).where({ ref: f.ref }).update({ gone_at: null })
      continue
    }
    const helper = mine.has(f.ref)
    const via = helper ? 'helper' : 'detected'
    const by = helper ? (opts.by ?? null) : null
    await db(SECRETS)
      .where({ ref: f.ref })
      .update({
        fp: f.fp,
        rotated_at: now,
        rotated_via: via,
        rotated_by: by,
        reminded_for: null,
        reminded_at: null,
        check_state: 'pending',
        check_due_at: new Date(now.getTime() + CHECK_DELAY_MS),
        check_detail: null,
        gone_at: null
      })
    await db(ROTATIONS).insert({
      ref: f.ref,
      kind: f.kind,
      via,
      rotated_by: by,
      rotated_at: now,
      check_state: 'pending'
    })
    result.rotated.push(f.ref)
  }
  const goneRefs = [...known.values()].filter((r) => r.gone_at == null).map((r) => r.ref)
  if (goneRefs.length) {
    await db(SECRETS).whereIn('ref', goneRefs).update({ gone_at: now })
    result.gone = goneRefs.length
  }
  return result
}

// ─── inventory for the page ──────────────────────────────────────────────────────────────────

export type DueState = 'ok' | 'due_soon' | 'overdue' | 'no_schedule' | 'never'

export interface InventoryItem {
  ref: string
  kind: SecretKind
  kind_label: string
  label: string
  /** First 12 hex of the fingerprint of the SEALED value: shows a change, says nothing of it. */
  fingerprint: string
  path: string
  rotate: RotateMode
  /** For rotate = helper: whether this one can be rotated here (a Docker environment). */
  helper_ready: boolean
  first_seen_at: string | null
  rotated_at: string | null
  rotated_via: string | null
  age_days: number | null
  due_at: string | null
  due: DueState
  check_state: string | null
  check_detail: string | null
  check_due_at: string | null
  env_id: number | null
  env_key: string | null
  shared_id: number | null
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null)
const DAY = 86_400_000

export function dueOf(
  base: Date | null,
  policy: Pick<SecretPolicy, 'every_days' | 'remind_days'>,
  kind: SecretKind,
  now: Date
): { due_at: Date | null; due: DueState } {
  if (KINDS[kind].rotate === 'never') return { due_at: null, due: 'never' }
  if (policy.every_days == null || !base) return { due_at: null, due: 'no_schedule' }
  const due = new Date(base.getTime() + policy.every_days * DAY)
  if (now >= due) return { due_at: due, due: 'overdue' }
  if (now.getTime() >= due.getTime() - policy.remind_days * DAY)
    return { due_at: due, due: 'due_soon' }
  return { due_at: due, due: 'ok' }
}

/** The inventory: a fresh scan, then the stored state with its due dates. */
export async function secretInventory(now = new Date()): Promise<InventoryItem[]> {
  const found = await gatherSecrets()
  await scanSecrets({ now, found })
  const policies = await readPolicies()
  const rows = (await db(SECRETS).whereNull('gone_at').select('*')) as Array<
    Record<string, unknown>
  >
  const byRef = new Map(rows.map((r) => [String(r.ref), r]))
  const dockerEnvs = await dockerEnvIds(found.filter((f) => f.kind === 'hub_token'))
  const items: InventoryItem[] = []
  for (const f of found) {
    const r = byRef.get(f.ref)
    const first = dateOf(r?.first_seen_at) ?? f.since
    const rotated = dateOf(r?.rotated_at)
    const base = rotated ?? first
    const { due_at, due } = dueOf(base, policies[f.kind], f.kind, now)
    items.push({
      ref: f.ref,
      kind: f.kind,
      kind_label: KINDS[f.kind].label,
      label: f.label,
      fingerprint: f.fp.slice(0, 12),
      path: f.path,
      rotate: KINDS[f.kind].rotate,
      helper_ready: f.kind === 'hub_token' && f.env_id != null && dockerEnvs.has(f.env_id),
      first_seen_at: iso(first),
      rotated_at: iso(rotated),
      rotated_via: (r?.rotated_via as string | null) ?? null,
      age_days: base ? Math.max(0, Math.floor((now.getTime() - base.getTime()) / DAY)) : null,
      due_at: iso(due_at),
      due,
      check_state: (r?.check_state as string | null) ?? null,
      check_detail: (r?.check_detail as string | null) ?? null,
      check_due_at: iso(dateOf(r?.check_due_at)),
      env_id: f.env_id ?? null,
      env_key: f.env_key ?? null,
      shared_id: f.shared_id ?? null
    })
  }
  const order: Record<DueState, number> = {
    overdue: 0,
    due_soon: 1,
    ok: 2,
    no_schedule: 3,
    never: 4
  }
  items.sort((a, b) => order[a.due] - order[b.due] || a.label.localeCompare(b.label))
  return items
}

/** Environments (of these) deployed through a Docker driver with a deployed stack. */
async function dockerEnvIds(hubTokens: FoundSecret[]): Promise<Set<number>> {
  const out = new Set<number>()
  for (const f of hubTokens) {
    if (f.env_id == null) continue
    const t = await dockerTargetOf(f.env_id).catch(() => null)
    if (t?.stackName) out.add(f.env_id)
  }
  return out
}

/** The rotation history of one ref (newest first, at most 20). */
export async function rotationHistory(ref: string): Promise<
  Array<{
    via: string
    rotated_at: string | null
    check_state: string | null
    check_detail: string | null
  }>
> {
  const rows = (await db(ROTATIONS)
    .where({ ref })
    .orderBy('id', 'desc')
    .limit(20)
    .select('via', 'rotated_at', 'check_state', 'check_detail')) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    via: String(r.via),
    rotated_at: iso(dateOf(r.rotated_at)),
    check_state: (r.check_state as string | null) ?? null,
    check_detail: (r.check_detail as string | null) ?? null
  }))
}

// ─── the helper's own rotation: a Docker environment's hub token ────────────────────────────

export class SecretRotateError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string
  ) {
    super(message)
    this.name = 'SecretRotateError'
  }
}

export interface RotateDeps {
  apply?: typeof startStackApply
}

/**
 * A new hub token for a Docker environment, delivered by Apply now. Refused while a move is open
 * (MOVE_OPEN), without a deployed Docker stack (NOT_DOCKER / NOT_DEPLOYED); when the apply
 * cannot start (a promotion holds the environment, …) the old token is put back and the
 * apply's own refusal is passed on. The new token is never answered: it goes to the stack only.
 */
export async function rotateHubToken(
  envId: number,
  user: { id: string },
  deps: RotateDeps = {}
): Promise<{ deploy_id: number; job_run_id: number | null }> {
  const env = (await db('nivaro_hub_environments')
    .where({ id: envId })
    .first('id', 'key', 'version_pin', 'hub_token', 'hub_token_lookup')) as
    | Record<string, unknown>
    | undefined
  if (!env) throw new SecretRotateError('NOT_FOUND', 404, 'Not found')
  const open = await moveOpenRefusal({ envIds: [envId] })
  if (open) throw new SecretRotateError(open.code, open.status, open.message)
  const target = await dockerTargetOf(envId)
  if (!target?.stackName)
    throw new SecretRotateError(
      'NOT_DOCKER',
      409,
      'Only an environment deployed through a Docker driver gets its hub token from the Hub. Set a new HUB_TOKEN on the app, then type it on the environment.'
    )
  if (!env.version_pin)
    throw new SecretRotateError(
      'NOT_DEPLOYED',
      409,
      'This environment has no deployed stack to deliver a new token to.'
    )
  const before = {
    hub_token: (env.hub_token as string | null) ?? null,
    hub_token_lookup: (env.hub_token_lookup as string | null) ?? null
  }
  await db('nivaro_hub_environments')
    .where({ id: envId })
    .update({ ...hubTokenColumns(randomBytes(32).toString('hex')), updated_at: new Date() })
  let started: { deployId: number; jobRunId: number | null }
  try {
    started = await (deps.apply ?? startStackApply)(envId, {
      confirm: String(env.key),
      user: { id: user.id }
    })
  } catch (err) {
    await db('nivaro_hub_environments')
      .where({ id: envId })
      .update({ ...before, updated_at: new Date() })
    throw err
  }
  await scanSecrets({ by: user.id, refs: [`hub_token:${envId}`] })
  return { deploy_id: started.deployId, job_run_id: started.jobRunId }
}

/** After an existing route rotated `ref`: records it as the helper's (by `userId`). */
export async function markRotated(ref: string, userId: string): Promise<{ rotated: boolean }> {
  const r = await scanSecrets({ by: userId, refs: [ref] })
  return { rotated: r.rotated.includes(ref) }
}

// ─── readiness checks + reminders (the hub-secrets cron) ────────────────────────────────────

export type CheckOutcome = { state: 'ok' | 'failed' | 'skipped' | 'wait'; detail: string }

export interface CheckDeps {
  envStatus?: (envId: number) => Promise<{ state: string; error?: string } | null>
  sharedStatus?: (sharedId: number) => Promise<void>
  agent?: (driverId: number) => Promise<void>
  notify?: OpsNotifier
}

async function defaultEnvStatus(envId: number) {
  const env = (await db('nivaro_hub_environments')
    .where({ id: envId })
    .first('id', 'key', 'base_url', 'hub_token', 'placement_id')) as
    | Record<string, unknown>
    | undefined
  if (!env) return null
  return readEnvironmentStatus(
    {
      id: Number(env.id),
      key: String(env.key),
      base_url: String(env.base_url),
      hub_token: (env.hub_token as string | null) ?? null,
      placement_id: env.placement_id == null ? null : Number(env.placement_id)
    },
    { fresh: true }
  )
}

async function defaultSharedStatus(sharedId: number) {
  const s = await getShared(sharedId)
  if (!s) throw Object.assign(new Error('gone'), { code: 'NOT_FOUND' })
  await deploymentClient(s).status()
}

async function defaultAgent(driverId: number) {
  const d = await getDriver(driverId)
  if (d?.kind !== 'docker') throw Object.assign(new Error('gone'), { code: 'NOT_DOCKER' })
  await agentHealth(d)
}

/** A deploy of this environment still running (the hub token waits for its Apply now). */
async function deployRunning(envId: number): Promise<boolean> {
  const row = await db('nivaro_hub_deploys')
    .where({ environment_id: envId })
    .whereIn('status', ['planned', 'running'])
    .first('id')
  return !!row
}

const codeOf = (err: unknown): string => {
  if (err instanceof AgentError) return err.code
  const c = (err as { code?: unknown } | null)?.code
  return typeof c === 'string' && /^[A-Z][A-Z0-9_]{0,63}$/.test(c) ? c : 'UNREACHABLE'
}

/** The readiness check for one ref. */
export async function checkSecret(ref: string, deps: CheckDeps = {}): Promise<CheckOutcome> {
  const [kind, a] = ref.split(':')
  const id = Number(a)
  const envStatus = async (envId: number): Promise<CheckOutcome> => {
    const s = await (deps.envStatus ?? defaultEnvStatus)(envId)
    if (!s) return { state: 'skipped', detail: 'The environment is gone.' }
    if (s.state === 'ok' || s.state === 'degraded')
      return {
        state: 'ok',
        detail:
          s.state === 'ok'
            ? 'The app answers the Hub.'
            : 'The app answers the Hub (some of its own checks fail).'
      }
    return {
      state: 'failed',
      detail:
        s.state === 'link_refused'
          ? `The app refuses the Hub’s link (${s.error ?? 'HUB_LINK_REFUSED'}).`
          : `The app does not answer (${s.error ?? 'UNREACHABLE'}).`
    }
  }
  try {
    switch (kind) {
      case 'hub_token':
        if (await deployRunning(id))
          return { state: 'wait', detail: 'Waiting for Apply now to finish.' }
        return await envStatus(id)
      case 'oidc_client_secret':
      case 'stack_secret':
        return await envStatus(id)
      case 'deployment_token':
        await (deps.sharedStatus ?? defaultSharedStatus)(id)
        return { state: 'ok', detail: 'The shared deployment answers with the new token.' }
      case 'driver_token': {
        const d = await getDriver(id)
        if (d?.kind !== 'docker')
          return { state: 'skipped', detail: 'No automatic check for a GitLab token.' }
        await (deps.agent ?? defaultAgent)(id)
        return { state: 'ok', detail: 'The Hub agent accepts the token.' }
      }
      default:
        return { state: 'skipped', detail: 'No automatic check for this kind of secret.' }
    }
  } catch (err) {
    return { state: 'failed', detail: `The check failed (${codeOf(err)}).` }
  }
}

/** How long a hub token check waits for its Apply now before it fails. */
export const CHECK_WAIT_MAX_MS = 60 * 60_000

/** Runs every check that is due; notifies the administrators of each failure. */
export async function runDueChecks(
  now = new Date(),
  deps: CheckDeps = {}
): Promise<{ ran: number; failed: number }> {
  const rows = (await db(SECRETS)
    .where({ check_state: 'pending' })
    .whereNull('gone_at')
    .where('check_due_at', '<=', now)
    .limit(50)
    .select('ref', 'kind', 'rotated_at')) as Array<Record<string, unknown>>
  let ran = 0
  let failed = 0
  for (const r of rows) {
    const ref = String(r.ref)
    let out = await checkSecret(ref, deps)
    if (out.state === 'wait') {
      const since = dateOf(r.rotated_at)
      if (since && now.getTime() - since.getTime() < CHECK_WAIT_MAX_MS) {
        await db(SECRETS)
          .where({ ref })
          .update({ check_due_at: new Date(now.getTime() + 2 * 60_000), check_detail: out.detail })
        continue
      }
      out = { state: 'failed', detail: 'Apply now did not finish within an hour.' }
    }
    ran++
    await db(SECRETS)
      .where({ ref })
      .update({ check_state: out.state, check_detail: out.detail.slice(0, 300) })
    const last = (await db(ROTATIONS).where({ ref }).orderBy('id', 'desc').first('id')) as
      | { id: number }
      | undefined
    if (last)
      await db(ROTATIONS)
        .where({ id: last.id })
        .update({ check_state: out.state, check_detail: out.detail.slice(0, 300) })
    if (out.state === 'failed') {
      failed++
      const kind = String(r.kind) as SecretKind
      await (deps.notify ?? notifyOps)(await hubAdminIds(), {
        subject: `Check failed after rotating a ${KINDS[kind]?.label.toLowerCase() ?? 'secret'}`,
        message: `${out.detail} Open the Secrets tab to look at it (${ref}).`,
        path: '/hub/secrets',
        why: 'You are a Hub administrator.',
        source: { kind: 'hub_secret_check', label: ref }
      })
    }
  }
  return { ran, failed }
}

/** One notice per run listing what is due soon or overdue and not reminded for that due date. */
export async function sendReminders(
  now = new Date(),
  deps: { notify?: OpsNotifier; items?: InventoryItem[] } = {}
): Promise<number> {
  const items = deps.items ?? (await secretInventory(now))
  const rows = (await db(SECRETS).select('ref', 'reminded_for')) as Array<{
    ref: string
    reminded_for: string | null
  }>
  const reminded = new Map(rows.map((r) => [r.ref, r.reminded_for]))
  const due = items.filter(
    (i) =>
      (i.due === 'due_soon' || i.due === 'overdue') &&
      i.due_at &&
      reminded.get(i.ref) !== i.due_at.slice(0, 10)
  )
  if (!due.length) return 0
  const overdue = due.filter((i) => i.due === 'overdue').length
  const names = due
    .slice(0, 5)
    .map((i) => i.label)
    .join('; ')
  await (deps.notify ?? notifyOps)(await hubAdminIds(), {
    subject:
      overdue > 0
        ? `${due.length} Hub secret${due.length === 1 ? '' : 's'} due for rotation (${overdue} overdue)`
        : `${due.length} Hub secret${due.length === 1 ? '' : 's'} due for rotation soon`,
    message: `${names}${due.length > 5 ? ` and ${due.length - 5} more` : ''}. Open the Secrets tab to rotate them.`,
    path: '/hub/secrets',
    why: 'You are a Hub administrator and these secrets reach their rotation date.',
    source: { kind: 'hub_secret_reminder', label: 'Secret rotation' }
  })
  for (const i of due)
    await db(SECRETS)
      .where({ ref: i.ref })
      .update({ reminded_for: (i.due_at as string).slice(0, 10), reminded_at: now })
  return due.length
}
