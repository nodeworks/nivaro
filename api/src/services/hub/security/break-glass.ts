import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { withoutLiveGrantees } from '../../break-glass-grants.js'
import { isAppOwner } from '../apps.js'
import { moveOpenRefusal } from '../move-open.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import { flagOf, isProductionEnv } from '../owner-access.js'
import { assertEmailNotOffboarded } from '../people/block.js'
import { identityOf, type PersonIdentity } from '../people/directory.js'
import { type PeopleTarget, peopleTargetOf } from '../people/link-calls.js'
import { callSecurity, type SecurityCallDeps } from './link.js'
import { incidentStillOpen, onCallIncident } from './seams.js'
import { loadSecuritySettings } from './settings.js'

/**
 * Break-glass access (Hub enhancement 45): a person asks for temporary administrator access to
 * one environment of an app for N hours (1 – the Hub's longest grant, ≤ 24), with a reason.
 *
 *   pending ──approve──▶ granting ──app said yes──▶ active ──time / revoke──▶ revoking ──▶ revoked
 *      │                    │                                                      (or expired)
 *      ├─deny──▶ denied     ├─the app refused──▶ failed
 *      └─cancel / 24 h──▶ cancelled                └─already an admin there──▶ not_needed
 *
 * Who: the request and every decision only on the person's OWN browser session (the route
 * checks). The requester is an owner of the app, a Hub administrator, or the person on call for
 * the app during one of its open SEV 1/2 incidents. A Hub administrator approves; nobody approves
 * their own request, except on call during an open SEV 1/2 incident someone ELSE opened, and on
 * call by the rota schedule (not an override younger than 24 h) — ruling M5 (seams.ts
 * onCallIncident). A self-approved grant ends when that incident resolves or its hours run out,
 * whichever first, and every Hub admin and owner is told at once (urgent).
 *
 * The requester is judged again at approve and again before the grant goes out (still an
 * active Hub account, not offboarded, still allowed to ask): a request can sit for 24 h.
 * "Offboard everywhere" cancels the person's pending requests and revokes their grants
 * (endBreakGlassOfPerson).
 *
 * The grant: the requester's PROVEN identity (their Hub account's email + Entra id) and the
 * hours are sent to the app (POST security/break-glass, ref `bg-<id>`); the app computes its own
 * end time and ends the grant itself (services/break-glass-grants.ts). The Hub revokes at
 * `expires_at` (job hub-break-glass, every minute, one leader), retrying until the app answers.
 * A revoke that reaches the app before its grant leaves a tombstone there (a late grant is
 * refused); and when a grant's answer arrives for a row that was revoked meanwhile, the Hub
 * sends the revoke again at once. Runs claim the row by heartbeat.
 */

export const BREAK_GLASS = 'nivaro_hub_break_glass'
export const STALE_MS = 2 * 60_000
export const PENDING_TTL_MS = 24 * 3_600_000
export const GRANT_GIVE_UP_MS = 30 * 60_000
const RETRY_MS = [30_000, 60_000, 120_000, 300_000]

export type BreakGlassStatus =
  | 'pending'
  | 'granting'
  | 'active'
  | 'revoking'
  | 'revoked'
  | 'expired'
  | 'denied'
  | 'cancelled'
  | 'failed'
  | 'not_needed'

export const OPEN_STATUSES: readonly BreakGlassStatus[] = [
  'pending',
  'granting',
  'active',
  'revoking'
]

export interface BreakGlass {
  id: number
  app_id: number
  environment_id: number
  requester_id: string
  reason: string
  hours: number
  status: BreakGlassStatus
  decided_by: string | null
  decided_at: string | null
  approval_kind: 'admin' | 'incident' | null
  incident_id: number | null
  decision_note: string | null
  app_user_id: string | null
  granted_at: string | null
  expires_at: string | null
  revoked_at: string | null
  revoked_by: string | null
  revoke_reason: string | null
  app_state: string | null
  attempts: number
  last_error: string | null
  created_at: string | null
}

export class BreakGlassError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string
  ) {
    super(message)
  }
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isFinite(d.getTime()) ? d.toISOString() : null
}
const upper = (v: unknown) => String(v ?? '').toUpperCase()

export function breakGlassFromRow(r: Record<string, unknown>): BreakGlass {
  const kind =
    r.approval_kind === 'admin' || r.approval_kind === 'incident' ? r.approval_kind : null
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    environment_id: Number(r.environment_id),
    requester_id: String(r.requester_id),
    reason: String(r.reason ?? ''),
    hours: Number(r.hours ?? 0),
    status: String(r.status) as BreakGlassStatus,
    decided_by: r.decided_by == null ? null : String(r.decided_by),
    decided_at: iso(r.decided_at),
    approval_kind: kind,
    incident_id: r.incident_id == null ? null : Number(r.incident_id),
    decision_note: r.decision_note == null ? null : String(r.decision_note),
    app_user_id: r.app_user_id == null ? null : String(r.app_user_id),
    granted_at: iso(r.granted_at),
    expires_at: iso(r.expires_at),
    revoked_at: iso(r.revoked_at),
    revoked_by: r.revoked_by == null ? null : String(r.revoked_by),
    revoke_reason: r.revoke_reason == null ? null : String(r.revoke_reason),
    app_state: r.app_state == null ? null : String(r.app_state),
    attempts: Number(r.attempts ?? 0),
    last_error: r.last_error == null ? null : String(r.last_error),
    created_at: iso(r.created_at)
  }
}

export async function readBreakGlass(id: number): Promise<BreakGlass | null> {
  const r = (await db(BREAK_GLASS).where({ id }).first()) as Record<string, unknown> | undefined
  return r ? breakGlassFromRow(r) : null
}

export async function listBreakGlass(o: {
  appIds: number[] | null
  requesterId?: string | null
  limit?: number
}): Promise<BreakGlass[]> {
  const q = db(BREAK_GLASS)
    .orderBy('id', 'desc')
    .limit(Math.min(200, o.limit ?? 100))
  if (o.appIds && o.requesterId)
    q.where((w) =>
      w
        .whereIn('app_id', o.appIds?.length ? o.appIds : [-1])
        .orWhere('requester_id', o.requesterId as string)
    )
  else if (o.appIds) {
    if (!o.appIds.length) return []
    q.whereIn('app_id', o.appIds)
  } else if (o.requesterId) q.where({ requester_id: o.requesterId })
  return ((await q.select()) as Array<Record<string, unknown>>).map(breakGlassFromRow)
}

export interface BreakGlassDeps extends SecurityCallDeps {
  now?: () => Date
  targetOf?: (env: EnvRow) => Promise<PeopleTarget | null>
  call?: typeof callSecurity
  notice?: typeof deliverHubNotice
  recipients?: (appId: number) => Promise<string[]>
  offboarded?: typeof assertEmailNotOffboarded
  background?: boolean
}

export interface EnvRow {
  id: number
  app_id: number
  key: string
  base_url: string
  hub_token: string | null
  placement_id: number | null
  status: string
  production: boolean
}

async function envRow(envId: number): Promise<EnvRow | null> {
  const r = (await db('nivaro_hub_environments').where({ id: envId }).first()) as
    | Record<string, unknown>
    | undefined
  if (!r) return null
  const all = (await db('nivaro_hub_environments')
    .where({ app_id: r.app_id })
    .select('id', 'key', 'position', 'status', 'production')) as Array<Record<string, unknown>>
  const order = all.map((e) => ({
    id: Number(e.id),
    key: String(e.key),
    position: Number(e.position ?? 0),
    status: String(e.status),
    production: flagOf(e.production)
  }))
  const me = order.find((e) => e.id === Number(r.id))
  return {
    id: Number(r.id),
    app_id: Number(r.app_id),
    key: String(r.key),
    base_url: String(r.base_url ?? ''),
    hub_token: (r.hub_token as string | null) ?? null,
    placement_id: r.placement_id == null ? null : Number(r.placement_id),
    status: String(r.status),
    production: me ? isProductionEnv(me, order) : true
  }
}

async function names(appId: number, envId: number) {
  const app = (await db('nivaro_hub_apps').where({ id: appId }).first('name', 'key')) as
    | { name?: string; key?: string }
    | undefined
  const env = (await db('nivaro_hub_environments').where({ id: envId }).first('key')) as
    | { key?: string }
    | undefined
  return `${app?.name || app?.key || `app ${appId}`} · ${env?.key ?? envId}`
}

/** A Hub person's display name (activity, the app's log, notices). */
async function personName(id: string | null | undefined): Promise<string | null> {
  if (!id) return null
  const u = (await db('nivaro_users').where({ id }).first('first_name', 'last_name', 'email')) as
    | Record<string, unknown>
    | undefined
  if (!u) return null
  const n = [u.first_name, u.last_name].filter((x) => typeof x === 'string' && x).join(' ')
  return (n || String(u.email ?? id)).slice(0, 200)
}

/** Active Hub administrators (people; never a break-glass grantee). */
async function adminIds(): Promise<string[]> {
  const rows = (await withoutLiveGrantees(
    db('nivaro_users as u')
      .join('nivaro_roles as r', 'r.id', 'u.role')
      .where('r.admin_access', true)
      .where('u.status', 'active')
      .whereNull('u.account_kind')
      .select('u.id')
  )) as Array<{ id: unknown }>
  return rows.map((r) => String(r.id))
}

async function tell(
  row: BreakGlass,
  o: {
    subject: string
    message: string
    urgent?: boolean
    /** admins = Hub admins only; all = owners + admins + requester; every = all + EVERY admin */
    to?: 'admins' | 'all' | 'every'
  },
  deps: BreakGlassDeps
): Promise<void> {
  try {
    const owners =
      o.to === 'admins' ? [] : await (deps.recipients ?? hubEventRecipients)(row.app_id)
    const admins = o.to === 'all' ? [] : await adminIds()
    const people = [...owners, ...admins, ...(o.to === 'admins' ? [] : [row.requester_id])]
    await (deps.notice ?? deliverHubNotice)(people, {
      subject: o.subject,
      message: o.message,
      path: `/hub/access?request=${row.id}`,
      urgent: o.urgent,
      ...(o.to === 'admins' ? { action: 'review' as const } : {}),
      source: { kind: 'hub_break_glass', label: 'Break-glass access', id: row.id },
      why: 'You are a Hub administrator or an owner of this app, or you asked for this access.'
    })
  } catch {
    // A notice is never why a grant or a revoke fails.
  }
}

/** The requester's proven identity: their Hub account's email and Entra object id. */
export async function requesterIdentity(userId: string): Promise<PersonIdentity> {
  const hasEntra = await db.schema.hasColumn('nivaro_users', 'entra_oid')
  const u = (await db('nivaro_users')
    .where({ id: userId })
    .first(
      'id',
      'first_name',
      'last_name',
      'email',
      'status',
      'account_kind',
      ...(hasEntra ? ['entra_oid', 'entra_tid'] : [])
    )) as Record<string, unknown> | undefined
  if (!u || String(u.status) !== 'active' || u.account_kind) return { emails: [], entra: [] }
  return identityOf([], {
    id: String(u.id),
    first_name: (u.first_name as string | null) ?? null,
    last_name: (u.last_name as string | null) ?? null,
    email: (u.email as string | null) ?? null,
    entra_oid: (u.entra_oid as string | null) ?? null,
    entra_tid: (u.entra_tid as string | null) ?? null
  })
}

/** Whether this Hub account is an active Hub administrator (never a grantee). */
async function isHubAdmin(userId: string): Promise<boolean> {
  return (await adminIds()).some((id) => upper(id) === upper(userId))
}

/**
 * The requester as they are NOW (M2): an active Hub person, not offboarded, and still allowed to
 * ask for this app (owner, Hub admin, or on call during a qualifying incident). Throws the
 * refusal; answers their identity.
 */
async function requesterNow(
  appId: number,
  userId: string,
  deps: BreakGlassDeps
): Promise<PersonIdentity> {
  const identity = await requesterIdentity(userId)
  if (!identity.emails.length && !identity.entra.length)
    throw new BreakGlassError(
      409,
      'REQUESTER_NOT_ALLOWED',
      'The person who asked has no active Hub account (or nothing an app could know them by).'
    )
  await (deps.offboarded ?? assertEmailNotOffboarded)({
    id: userId,
    email: identity.emails[0] ?? null
  })
  const allowed =
    (await isHubAdmin(userId)) ||
    (await isAppOwner(appId, userId)) ||
    !!(await onCallIncident(appId, userId))
  if (!allowed)
    throw new BreakGlassError(
      409,
      'REQUESTER_NOT_ALLOWED',
      'The person who asked is no longer an owner of this app, a Hub administrator or on call.'
    )
  return identity
}

/** A new request (see the header). `mayRequest` = owner or Hub admin (the route decides). */
export async function requestBreakGlass(
  input: {
    appId: number
    envId: number
    requesterId: string
    hours: unknown
    reason: unknown
    mayRequest: boolean
    selfApprove?: boolean
  },
  deps: BreakGlassDeps = {}
): Promise<BreakGlass> {
  const now = (deps.now ?? (() => new Date()))()
  const env = await envRow(input.envId)
  if (!env || env.app_id !== input.appId || env.status === 'archived')
    throw new BreakGlassError(404, 'NOT_FOUND', 'No such environment of this app')
  const incident = await onCallIncident(input.appId, input.requesterId)
  if (!input.mayRequest && !incident)
    throw new BreakGlassError(
      404,
      'NOT_FOUND',
      'No such app (break-glass is for its owners, Hub administrators and whoever is on call)'
    )
  const settings = await loadSecuritySettings()
  const hours = Number(input.hours)
  if (!Number.isInteger(hours) || hours < 1 || hours > settings.break_glass_max_hours)
    throw new BreakGlassError(
      400,
      'BAD_HOURS',
      `Ask for 1 to ${settings.break_glass_max_hours} hours.`
    )
  const reason = typeof input.reason === 'string' ? input.reason.trim() : ''
  if (reason.length < 10 || reason.length > 1000)
    throw new BreakGlassError(400, 'BAD_REASON', 'Give a reason (10 to 1000 characters).')
  if (input.selfApprove && !incident)
    throw new BreakGlassError(
      403,
      'NO_INCIDENT',
      'Only the person on call by the rota may approve their own request, and only during an open SEV 1 or SEV 2 incident of the app that someone else opened.'
    )
  const identity = await requesterIdentity(input.requesterId)
  if (!identity.emails.length && !identity.entra.length)
    throw new BreakGlassError(
      409,
      'NO_IDENTITY',
      'Your Hub account has no email or Microsoft identity the app could recognise you by.'
    )
  await (deps.offboarded ?? assertEmailNotOffboarded)({
    id: input.requesterId,
    email: identity.emails[0] ?? null
  })
  const open = (await db(BREAK_GLASS)
    .where({ environment_id: env.id, requester_id: input.requesterId })
    .whereIn('status', OPEN_STATUSES as string[])
    .first('id')) as { id: unknown } | undefined
  if (open)
    throw new BreakGlassError(
      409,
      'BREAK_GLASS_OPEN',
      `Request ${open.id} for this environment is still open.`
    )
  const moving = await moveOpenRefusal({ envIds: [env.id] })
  if (moving) throw new BreakGlassError(409, moving.code, moving.message)
  const id = Number(
    await insertReturningId(db, BREAK_GLASS, {
      app_id: input.appId,
      environment_id: env.id,
      requester_id: input.requesterId,
      reason,
      hours,
      status: 'pending',
      identity: JSON.stringify(identity),
      created_at: now,
      updated_at: now
    })
  )
  await logActivity({
    action: 'hub-break-glass-request',
    user: input.requesterId,
    collection: BREAK_GLASS,
    item: String(id),
    comment: `Asked for ${hours} h of administrator access to ${env.key}: ${reason}`.slice(0, 1000)
  })
  const row = (await readBreakGlass(id)) as BreakGlass
  if (input.selfApprove && incident)
    return approveBreakGlass(id, input.requesterId, { incidentId: incident.incident_id }, deps)
  await tell(
    row,
    {
      to: 'admins',
      urgent: env.production,
      subject: `Break-glass request: ${await names(row.app_id, row.environment_id)}`,
      message: `Asked for ${hours} h of administrator access: ${reason}`.slice(0, 1000)
    },
    deps
  )
  return row
}

/**
 * Approve (a Hub admin, never their own request) or self-approve on call during a qualifying
 * incident (`incidentId`, re-judged here). The requester is judged again first. Starts the grant.
 */
export async function approveBreakGlass(
  id: number,
  by: string,
  o: { incidentId?: number | null; note?: string | null } = {},
  deps: BreakGlassDeps = {}
): Promise<BreakGlass> {
  const now = (deps.now ?? (() => new Date()))()
  const row = await readBreakGlass(id)
  if (!row) throw new BreakGlassError(404, 'NOT_FOUND', 'No such request')
  if (row.status !== 'pending')
    throw new BreakGlassError(409, 'NOT_PENDING', 'Only a pending request can be approved.')
  const self = upper(row.requester_id) === upper(by)
  let kind: 'admin' | 'incident' = 'admin'
  let incidentId: number | null = null
  if (self) {
    const incident = await onCallIncident(row.app_id, by)
    if (!incident || (o.incidentId != null && incident.incident_id !== o.incidentId))
      throw new BreakGlassError(
        403,
        'SELF_APPROVAL',
        'Nobody approves their own request (only the person on call by the rota, during an open SEV 1 or SEV 2 incident someone else opened).'
      )
    kind = 'incident'
    incidentId = incident.incident_id
  }
  try {
    await requesterNow(row.app_id, row.requester_id, deps)
  } catch (err) {
    await db(BREAK_GLASS).where({ id, status: 'pending' }).update({
      status: 'cancelled',
      decision_note: 'The requester may no longer ask (checked at approval)',
      updated_at: now
    })
    throw err
  }
  const moving = await moveOpenRefusal({ envIds: [row.environment_id] })
  if (moving) throw new BreakGlassError(409, moving.code, moving.message)
  const n = await db(BREAK_GLASS)
    .where({ id, status: 'pending' })
    .update({
      status: 'granting',
      decided_by: by,
      decided_at: now,
      approval_kind: kind,
      incident_id: incidentId,
      decision_note: o.note ? o.note.slice(0, 500) : null,
      updated_at: now
    })
  if (!n) throw new BreakGlassError(409, 'NOT_PENDING', 'The request changed meanwhile.')
  await logActivity({
    action: 'hub-break-glass-approve',
    user: by,
    collection: BREAK_GLASS,
    item: String(id),
    comment:
      kind === 'incident'
        ? `Approved by the person on call during incident ${incidentId}`
        : 'Approved by a Hub administrator'
  })
  if (kind === 'incident')
    await tell(
      row,
      {
        to: 'every',
        urgent: true,
        subject: `Break-glass self-approved: ${await names(row.app_id, row.environment_id)}`,
        message:
          `${(await personName(row.requester_id)) ?? 'The person on call'} approved their own ${row.hours} h of administrator access during incident ${incidentId}: ${row.reason}. It ends when the incident resolves.`.slice(
            0,
            1000
          )
      },
      deps
    )
  const run = runGrant(id, deps)
  if (deps.background === false) await run
  else void run.catch(() => undefined)
  return (await readBreakGlass(id)) as BreakGlass
}

export async function denyBreakGlass(
  id: number,
  by: string,
  note: string | null,
  deps: BreakGlassDeps = {}
): Promise<BreakGlass> {
  const now = (deps.now ?? (() => new Date()))()
  const row = await readBreakGlass(id)
  if (!row) throw new BreakGlassError(404, 'NOT_FOUND', 'No such request')
  const n = await db(BREAK_GLASS)
    .where({ id, status: 'pending' })
    .update({
      status: 'denied',
      decided_by: by,
      decided_at: now,
      decision_note: note ? note.slice(0, 500) : null,
      updated_at: now
    })
  if (!n) throw new BreakGlassError(409, 'NOT_PENDING', 'Only a pending request can be denied.')
  await logActivity({
    action: 'hub-break-glass-deny',
    user: by,
    collection: BREAK_GLASS,
    item: String(id),
    comment: note ? `Denied: ${note}`.slice(0, 1000) : 'Denied'
  })
  const after = (await readBreakGlass(id)) as BreakGlass
  await tell(
    after,
    {
      subject: `Break-glass denied: ${await names(row.app_id, row.environment_id)}`,
      message: note ? `The request was denied: ${note}` : 'The request was denied.'
    },
    deps
  )
  return after
}

export async function cancelBreakGlass(
  id: number,
  by: string,
  now = new Date()
): Promise<BreakGlass> {
  const row = await readBreakGlass(id)
  if (!row || upper(row.requester_id) !== upper(by))
    throw new BreakGlassError(404, 'NOT_FOUND', 'No such request of yours')
  const n = await db(BREAK_GLASS)
    .where({ id, status: 'pending' })
    .update({ status: 'cancelled', updated_at: now })
  if (!n) throw new BreakGlassError(409, 'NOT_PENDING', 'Only a pending request can be withdrawn.')
  await logActivity({
    action: 'hub-break-glass-cancel',
    user: by,
    collection: BREAK_GLASS,
    item: String(id),
    comment: 'Withdrawn by the requester'
  })
  return (await readBreakGlass(id)) as BreakGlass
}

/** Moves an active / granting row to `revoking` (reason given). Answers whether it moved. */
async function toRevoking(
  id: number,
  reason: string,
  by: string | null,
  now: Date
): Promise<boolean> {
  const n = await db(BREAK_GLASS).where({ id }).whereIn('status', ['active', 'granting']).update({
    status: 'revoking',
    revoke_reason: reason,
    revoked_by: by,
    next_try_at: now,
    heartbeat_at: null,
    updated_at: now
  })
  return n > 0
}

/** End a grant early (Hub admin or the requester). Granting rows are revoked too. */
export async function revokeEarly(
  id: number,
  by: string,
  deps: BreakGlassDeps = {}
): Promise<BreakGlass> {
  const now = (deps.now ?? (() => new Date()))()
  if (!(await toRevoking(id, 'early', by, now)))
    throw new BreakGlassError(409, 'NOT_ACTIVE', 'Only a grant that holds can be ended.')
  await logActivity({
    action: 'hub-break-glass-revoke',
    user: by,
    collection: BREAK_GLASS,
    item: String(id),
    comment: 'Ended early'
  })
  const run = runRevoke(id, deps)
  if (deps.background === false) await run
  else void run.catch(() => undefined)
  return (await readBreakGlass(id)) as BreakGlass
}

/**
 * "Offboard everywhere" of a Hub person (services/hub/people/offboard.ts): every pending request
 * is withdrawn and every grant is revoked. Never throws.
 */
export async function endBreakGlassOfPerson(
  hubUserId: string,
  deps: BreakGlassDeps = {}
): Promise<{ cancelled: number; revoking: number[] }> {
  const now = (deps.now ?? (() => new Date()))()
  const out = { cancelled: 0, revoking: [] as number[] }
  try {
    out.cancelled = await db(BREAK_GLASS)
      .where({ requester_id: hubUserId, status: 'pending' })
      .update({
        status: 'cancelled',
        decision_note: 'The requester was offboarded',
        updated_at: now
      })
    const live = (await db(BREAK_GLASS)
      .where({ requester_id: hubUserId })
      .whereIn('status', ['active', 'granting'])
      .select('id')) as Array<{ id: unknown }>
    for (const r of live)
      if (await toRevoking(Number(r.id), 'offboarded', null, now)) out.revoking.push(Number(r.id))
    for (const id of out.revoking) await runRevoke(id, deps).catch(() => undefined)
  } catch {
    // The tick retries revokes; the offboard itself goes on.
  }
  return out
}

/** Takes the row for one run (heartbeat claim); false when another live run holds it. */
async function claim(id: number, status: BreakGlassStatus, now: Date): Promise<boolean> {
  const stale = new Date(now.getTime() - STALE_MS)
  const n = await db(BREAK_GLASS)
    .where({ id, status })
    .where((w) => w.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale))
    .update({ heartbeat_at: now, updated_at: now })
  return n > 0
}

const TRANSIENT = new Set([
  'LINK_UNREACHABLE',
  'TIMEOUT',
  'LINK_BAD_ANSWER',
  'LINK_REDIRECT',
  'LINK_REFUSED',
  'LINK_MISSING',
  'GRANT_FAILED',
  'REVOKE_FAILED',
  'UNKNOWN_APP',
  'DEPLOYMENT_TOKEN_MISSING',
  'HUB_TOKEN_MISSING'
])
const transient = (code: string, status: number) =>
  TRANSIENT.has(code) || status >= 500 || /^HTTP_5/.test(code)

async function target(row: BreakGlass, deps: BreakGlassDeps): Promise<PeopleTarget | null> {
  const env = await envRow(row.environment_id)
  if (!env) return null
  return (deps.targetOf ?? (async (e: EnvRow) => peopleTargetOf(e)))(env)
}

/** The grant leg: asks the app; retried by the job on a transient failure. */
export async function runGrant(id: number, deps: BreakGlassDeps = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  if (!(await claim(id, 'granting', now))) return
  const row = await readBreakGlass(id)
  if (!row || row.status !== 'granting') return
  // M2: judged again right before anything reaches the app.
  let identity: PersonIdentity
  try {
    identity = await requesterNow(row.app_id, row.requester_id, deps)
  } catch (err) {
    const code = err instanceof BreakGlassError ? err.code : 'REQUESTER_NOT_ALLOWED'
    await db(BREAK_GLASS)
      .where({ id, status: 'granting' })
      .update({
        status: 'failed',
        last_error: code.slice(0, 64),
        heartbeat_at: null,
        updated_at: now
      })
    await tell(
      row,
      {
        subject: `Break-glass not granted: ${await names(row.app_id, row.environment_id)}`,
        message: 'The person who asked may no longer have it (checked before granting).'
      },
      deps
    )
    return
  }
  const t = await target(row, deps).catch(() => null)
  const res = t
    ? await (deps.call ?? callSecurity)(
        t,
        'POST',
        'break-glass',
        {
          ref: `bg-${id}`,
          emails: identity.emails,
          entra: identity.entra,
          hours: row.hours,
          reason: row.reason,
          requested_by: await personName(row.requester_id),
          approved_by: await personName(row.decided_by)
        },
        deps
      )
    : ({ ok: false, code: 'NO_LINK', status: 0 } as const)
  if (res.ok) {
    const state = String(res.body.state ?? '')
    const appUser = typeof res.body.user_id === 'string' ? res.body.user_id.slice(0, 64) : null
    const appUntil = typeof res.body.until === 'string' ? iso(res.body.until) : null
    if (state === 'already_admin') {
      await db(BREAK_GLASS).where({ id, status: 'granting' }).update({
        status: 'not_needed',
        app_state: 'already_admin',
        app_user_id: appUser,
        heartbeat_at: null,
        updated_at: now
      })
      await tell(
        row,
        {
          subject: `Break-glass not needed: ${await names(row.app_id, row.environment_id)}`,
          message: 'The account already has administrator access there; nothing was changed.'
        },
        deps
      )
      return
    }
    if (state === 'granted') {
      const until = appUntil ? new Date(appUntil) : new Date(now.getTime() + row.hours * 3_600_000)
      const n = await db(BREAK_GLASS)
        .where({ id, status: 'granting' })
        .update({
          status: 'active',
          app_state: 'granted',
          app_user_id: appUser,
          granted_at: now,
          expires_at: until,
          attempts: row.attempts + 1,
          last_error: null,
          next_try_at: null,
          heartbeat_at: null,
          updated_at: now
        })
      if (!n) {
        // Revoked while the grant was on its way (TOCTOU): the app holds a grant nobody wants.
        // Tell it to end at once, with the account it named; the revoke leg retries if needed.
        await db(BREAK_GLASS).where({ id }).update({ app_user_id: appUser, updated_at: now })
        if (t)
          await (deps.call ?? callSecurity)(
            t,
            'POST',
            'break-glass/revoke',
            { ref: `bg-${id}`, ...(appUser ? { user_id: appUser } : {}) },
            deps
          ).catch(() => undefined)
        await logActivity({
          action: 'hub-break-glass-revoke',
          user: null,
          collection: BREAK_GLASS,
          item: String(id),
          comment: 'The grant arrived after it was ended; revoked again at once'
        })
        return
      }
      await logActivity({
        action: 'hub-break-glass-granted',
        user: row.decided_by,
        collection: BREAK_GLASS,
        item: String(id),
        comment: `Granted until ${until.toISOString()} (account ${appUser ?? '?'})`
      })
      await tell(
        row,
        {
          urgent: true,
          to: row.approval_kind === 'incident' ? 'every' : 'all',
          subject: `Break-glass granted: ${await names(row.app_id, row.environment_id)}`,
          message:
            `Administrator access for ${row.hours} h until ${until.toISOString()}${row.approval_kind === 'incident' ? ' (or when the incident resolves)' : ''}: ${row.reason}`.slice(
              0,
              1000
            )
        },
        deps
      )
      return
    }
    // An answer the Hub does not understand may still mean a grant: revoke to be sure.
    await db(BREAK_GLASS).where({ id, status: 'granting' }).update({
      status: 'revoking',
      revoke_reason: 'grant_failed',
      last_error: 'LINK_BAD_ANSWER',
      next_try_at: now,
      heartbeat_at: null,
      updated_at: now
    })
    await runRevoke(id, deps)
    return
  }
  const code = res.code
  const status = res.status
  const decided = row.decided_at ? Date.parse(row.decided_at) : now.getTime()
  const tooLong = now.getTime() - decided > GRANT_GIVE_UP_MS
  if (transient(code, status) && !tooLong) {
    const wait = RETRY_MS[Math.min(row.attempts, RETRY_MS.length - 1)]
    await db(BREAK_GLASS)
      .where({ id, status: 'granting' })
      .update({
        attempts: row.attempts + 1,
        last_error: code.slice(0, 64),
        next_try_at: new Date(now.getTime() + wait),
        heartbeat_at: null,
        updated_at: now
      })
    return
  }
  if (transient(code, status)) {
    // Never confirmed: the grant may have landed with its answer lost — revoke to be sure.
    await db(BREAK_GLASS)
      .where({ id, status: 'granting' })
      .update({
        status: 'revoking',
        revoke_reason: 'grant_failed',
        last_error: code.slice(0, 64),
        next_try_at: now,
        heartbeat_at: null,
        updated_at: now
      })
    await runRevoke(id, deps)
    return
  }
  await db(BREAK_GLASS)
    .where({ id, status: 'granting' })
    .update({
      status: 'failed',
      last_error: code.slice(0, 64),
      attempts: row.attempts + 1,
      heartbeat_at: null,
      updated_at: now
    })
  await tell(
    row,
    {
      subject: `Break-glass not granted: ${await names(row.app_id, row.environment_id)}`,
      message: `The app refused the grant (${code}).`
    },
    deps
  )
}

/** The revoke leg: by ref (the app keeps a tombstone); retried until the app answers. */
export async function runRevoke(id: number, deps: BreakGlassDeps = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  if (!(await claim(id, 'revoking', now))) return
  const row = await readBreakGlass(id)
  if (!row || row.status !== 'revoking') return
  const t = await target(row, deps).catch(() => null)
  const res = t
    ? await (deps.call ?? callSecurity)(
        t,
        'POST',
        'break-glass/revoke',
        { ref: `bg-${id}`, ...(row.app_user_id ? { user_id: row.app_user_id } : {}) },
        deps
      )
    : ({ ok: false, code: 'NO_LINK', status: 0 } as const)
  if (res.ok) {
    const state = String(res.body.state ?? '')
    if (['revoked', 'none', 'role_changed', 'restored_over_change'].includes(state)) {
      const expired = row.revoke_reason === 'expired'
      await db(BREAK_GLASS)
        .where({ id, status: 'revoking' })
        .update({
          status: expired ? 'expired' : 'revoked',
          app_state: state,
          revoked_at: now,
          last_error: null,
          next_try_at: null,
          heartbeat_at: null,
          updated_at: now
        })
      const changedBy = typeof res.body.changed_by === 'string' ? res.body.changed_by : null
      const changedTo = typeof res.body.changed_to === 'string' ? res.body.changed_to : null
      const count = typeof res.body.activity_count === 'number' ? res.body.activity_count : null
      const rc = res.body.revoked_credentials as
        | { api_keys?: unknown; static_tokens?: unknown; connections?: unknown }
        | null
        | undefined
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
      const took = rc ? num(rc.api_keys) + num(rc.static_tokens) + num(rc.connections) : 0
      const revokedWords = took
        ? ` Revoked what the account made during the grant: ${num(rc?.api_keys)} API key(s), ${num(rc?.static_tokens)} static token(s), ${num(rc?.connections)} connection(s).`
        : ''
      await logActivity({
        action: 'hub-break-glass-ended',
        user: row.revoked_by,
        collection: BREAK_GLASS,
        item: String(id),
        comment:
          `Administrator access ended (${row.revoke_reason ?? 'revoked'}; the app answered ${state}${changedBy ? `; role changed by ${changedBy} to ${changedTo ?? '?'}` : ''})`.slice(
            0,
            1000
          )
      })
      const env = await envRow(row.environment_id)
      const link =
        env && row.app_user_id
          ? ` Their changes: ${env.base_url.replace(/\/+$/, '')}/users/${encodeURIComponent(row.app_user_id)}?tab=activity`
          : ''
      const did =
        count != null ? ` ${count} change(s) were made by the account during the grant.` : ''
      const changed = state === 'role_changed' || state === 'restored_over_change' || took > 0
      await tell(
        row,
        {
          urgent: changed,
          to: changed ? 'every' : 'all',
          subject: changed
            ? `Break-glass ended — role was changed: ${await names(row.app_id, row.environment_id)}`
            : `Break-glass ended: ${await names(row.app_id, row.environment_id)}`,
          message:
            (state === 'role_changed'
              ? `${changedBy ?? 'Someone'} changed the account’s role to ${changedTo ?? 'another role'} (without admin access) during the grant; that stays.`
              : state === 'restored_over_change'
                ? `${changedBy ?? 'Someone'} changed the account’s role to ${changedTo ?? 'another admin role'} during the grant; the role it had before was put back.`
                : 'The temporary administrator access ended; the account has its own role again.') +
            did +
            revokedWords +
            link
        },
        deps
      )
      return
    }
  }
  const code = res.ok ? 'LINK_BAD_ANSWER' : res.code
  const wait = RETRY_MS[Math.min(row.attempts, RETRY_MS.length - 1)]
  await db(BREAK_GLASS)
    .where({ id, status: 'revoking' })
    .update({
      attempts: row.attempts + 1,
      last_error: code.slice(0, 64),
      next_try_at: new Date(now.getTime() + wait),
      heartbeat_at: null,
      updated_at: now
    })
}

/**
 * The job (hub-break-glass, every minute, one leader): expired grants and self-approved grants
 * whose incident resolved start their revoke; revokes and grants due a retry (or whose process
 * stopped) run again; requests nobody decided within 24 h are withdrawn.
 */
export async function breakGlassTick(
  deps: BreakGlassDeps = {}
): Promise<{ revoked: number[]; retried: number[]; withdrawn: number[] }> {
  const now = (deps.now ?? (() => new Date()))()
  const out = { revoked: [] as number[], retried: [] as number[], withdrawn: [] as number[] }
  const due = (await db(BREAK_GLASS)
    .where({ status: 'active' })
    .where('expires_at', '<=', now)
    .select('id')) as Array<{ id: unknown }>
  const incidentRows = (await db(BREAK_GLASS)
    .where({ status: 'active', approval_kind: 'incident' })
    .whereNotNull('incident_id')
    .select('id', 'incident_id')) as Array<{ id: unknown; incident_id: unknown }>
  const resolved: number[] = []
  for (const r of incidentRows)
    if (!(await incidentStillOpen(Number(r.incident_id)))) resolved.push(Number(r.id))
  for (const [ids, reason] of [
    [due.map((r) => Number(r.id)), 'expired'],
    [resolved, 'incident_resolved']
  ] as const) {
    for (const id of ids) {
      if (await toRevoking(id, reason, null, now)) {
        await runRevoke(id, deps)
        out.revoked.push(id)
      }
    }
  }
  const stale = new Date(now.getTime() - STALE_MS)
  const retry = (await db(BREAK_GLASS)
    .whereIn('status', ['revoking', 'granting'])
    .where((w) => w.whereNull('next_try_at').orWhere('next_try_at', '<=', now))
    .where((w) => w.whereNull('heartbeat_at').orWhere('heartbeat_at', '<', stale))
    .select('id', 'status')) as Array<{ id: unknown; status: string }>
  for (const r of retry) {
    const id = Number(r.id)
    if (out.revoked.includes(id)) continue
    if (r.status === 'revoking') await runRevoke(id, deps)
    else await runGrant(id, deps)
    out.retried.push(id)
  }
  const old = new Date(now.getTime() - PENDING_TTL_MS)
  const pending = (await db(BREAK_GLASS)
    .where({ status: 'pending' })
    .where('created_at', '<', old)
    .select('id')) as Array<{ id: unknown }>
  for (const r of pending) {
    const n = await db(BREAK_GLASS).where({ id: r.id, status: 'pending' }).update({
      status: 'cancelled',
      decision_note: 'Nobody decided within 24 hours',
      updated_at: now
    })
    if (n) out.withdrawn.push(Number(r.id))
  }
  return out
}
