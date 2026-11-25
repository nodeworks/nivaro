import { insertReturningId } from '../../../db/dialect/ef.js'
import { db } from '../../../db/index.js'
import { logActivity } from '../../activity.js'
import { moveOpenRefusal } from '../move-open.js'
import { deliverHubNotice, hubEventRecipients } from '../notify-events.js'
import { flagOf, isProductionEnv } from '../owner-access.js'
import { assertEmailNotOffboarded } from '../people/block.js'
import { identityOf, type PersonIdentity } from '../people/directory.js'
import { type PeopleTarget, peopleTargetOf } from '../people/link-calls.js'
import { callSecurity, type SecurityCallDeps } from './link.js'
import { onCallIncident, type SeamDeps } from './seams.js'
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
 * Who: the request and every decision only on the person's OWN browser session (never View-as, an
 * API key, a phone/OAuth token or an MCP call — the route checks). The requester is an owner of
 * the app, a Hub administrator, or — through the incident seam — the person on call for the app
 * during one of its open incidents. A Hub administrator approves; nobody approves their own
 * request, except the person on call during an open incident of the app (approval_kind
 * `incident`, the incident recorded). Every step is logged and told to the app's owners + Hub
 * admins through the Hub's one notice path (deliverHubNotice).
 *
 * The grant: the requester's PROVEN identity (their Hub account's email + Entra id) is asked of
 * the app over the hub link (POST security/break-glass, ref `bg-<id>`); the app swaps the
 * account's role to its admin role and stores the expiry itself (services/hub-link/security.ts),
 * so the app ends the grant on time even if the Hub is gone. The Hub revokes at `expires_at`
 * (job hub-break-glass, every minute, one leader), retrying forever until the app answers; a grant
 * that could not be confirmed within GRANT_GIVE_UP_MS is revoked anyway (it may have landed).
 * Runs claim the row by heartbeat, so a run whose process stopped is resumed by the job.
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

export interface BreakGlassDeps extends SecurityCallDeps, SeamDeps {
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

async function tell(
  row: BreakGlass,
  o: { subject: string; message: string; urgent?: boolean; to?: 'admins' | 'all' },
  deps: BreakGlassDeps
): Promise<void> {
  try {
    const people =
      o.to === 'admins'
        ? await adminIds()
        : [...(await (deps.recipients ?? hubEventRecipients)(row.app_id)), row.requester_id]
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

async function adminIds(): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where('u.status', 'active')
    .whereNull('u.account_kind')
    .select('u.id')) as Array<{ id: unknown }>
  return rows.map((r) => String(r.id))
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
      ...(hasEntra ? ['entra_oid', 'entra_tid'] : [])
    )) as Record<string, unknown> | undefined
  if (!u || String(u.status) !== 'active') return { emails: [], entra: [] }
  return identityOf([], {
    id: String(u.id),
    first_name: (u.first_name as string | null) ?? null,
    last_name: (u.last_name as string | null) ?? null,
    email: (u.email as string | null) ?? null,
    entra_oid: (u.entra_oid as string | null) ?? null,
    entra_tid: (u.entra_tid as string | null) ?? null
  })
}

/** A new request (see the header). `onCallFor` = the incident seam's answer for the requester. */
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
  const incident = await onCallIncident(input.appId, input.requesterId, deps)
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
      'Only the person on call may approve their own request, and only during an open incident of the app.'
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
 * Approve (Hub admin, never their own request) or self-approve during an incident
 * (`incidentId` set by the route only after the seam said so). Starts the grant.
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
  const self = row.requester_id.toUpperCase() === by.toUpperCase()
  let kind: 'admin' | 'incident' = 'admin'
  let incidentId: number | null = null
  if (self) {
    const incident = await onCallIncident(row.app_id, by, deps)
    if (!incident || (o.incidentId != null && incident.incident_id !== o.incidentId))
      throw new BreakGlassError(
        403,
        'SELF_APPROVAL',
        'Nobody approves their own request (only the person on call, during an open incident).'
      )
    kind = 'incident'
    incidentId = incident.incident_id
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
  if (!row || row.requester_id.toUpperCase() !== by.toUpperCase())
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

/** End a grant early (Hub admin or the requester). Granting rows are revoked too. */
export async function revokeEarly(
  id: number,
  by: string,
  deps: BreakGlassDeps = {}
): Promise<BreakGlass> {
  const now = (deps.now ?? (() => new Date()))()
  const n = await db(BREAK_GLASS).where({ id }).whereIn('status', ['active', 'granting']).update({
    status: 'revoking',
    revoke_reason: 'early',
    revoked_by: by,
    next_try_at: now,
    heartbeat_at: null,
    updated_at: now
  })
  if (!n) throw new BreakGlassError(409, 'NOT_ACTIVE', 'Only a grant that holds can be ended.')
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

function parseIdentity(raw: unknown): PersonIdentity {
  try {
    const v = typeof raw === 'string' ? JSON.parse(raw) : raw
    const emails = Array.isArray(v?.emails)
      ? v.emails.filter((x: unknown) => typeof x === 'string')
      : []
    const entra = Array.isArray(v?.entra) ? v.entra : []
    return { emails: emails.slice(0, 5), entra: entra.slice(0, 5) }
  } catch {
    return { emails: [], entra: [] }
  }
}

/** The grant leg: asks the app; retried by the job on a transient failure. */
export async function runGrant(id: number, deps: BreakGlassDeps = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  if (!(await claim(id, 'granting', now))) return
  const row = await readBreakGlass(id)
  if (!row || row.status !== 'granting') return
  const raw = (await db(BREAK_GLASS).where({ id }).first('identity')) as { identity: unknown }
  const identity = parseIdentity(raw?.identity)
  const t = await target(row, deps).catch(() => null)
  const until = new Date(now.getTime() + row.hours * 3_600_000)
  const res = t
    ? await (deps.call ?? callSecurity)(
        t,
        'POST',
        'break-glass',
        {
          ref: `bg-${id}`,
          emails: identity.emails,
          entra: identity.entra,
          until: until.toISOString(),
          reason: row.reason
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
      await db(BREAK_GLASS)
        .where({ id, status: 'granting' })
        .update({
          status: 'active',
          app_state: 'granted',
          app_user_id: appUser,
          granted_at: now,
          expires_at: appUntil ? new Date(appUntil) : until,
          attempts: row.attempts + 1,
          last_error: null,
          next_try_at: null,
          heartbeat_at: null,
          updated_at: now
        })
      await logActivity({
        action: 'hub-break-glass-granted',
        user: row.decided_by,
        collection: BREAK_GLASS,
        item: String(id),
        comment: `Granted until ${appUntil ?? until.toISOString()} (account ${appUser ?? '?'})`
      })
      await tell(
        row,
        {
          urgent: true,
          subject: `Break-glass granted: ${await names(row.app_id, row.environment_id)}`,
          message:
            `Administrator access for ${row.hours} h until ${appUntil ?? until.toISOString()}: ${row.reason}`.slice(
              0,
              1000
            )
        },
        deps
      )
      return
    }
  }
  const code = res.ok ? 'LINK_BAD_ANSWER' : res.code
  const status = res.ok ? 200 : res.status
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

/** The revoke leg: retried forever (the app ends the grant by itself meanwhile). */
export async function runRevoke(id: number, deps: BreakGlassDeps = {}): Promise<void> {
  const now = (deps.now ?? (() => new Date()))()
  if (!(await claim(id, 'revoking', now))) return
  const row = await readBreakGlass(id)
  if (!row || row.status !== 'revoking') return
  const done = async (appState: string) => {
    const expired = row.revoke_reason === 'expired'
    await db(BREAK_GLASS)
      .where({ id, status: 'revoking' })
      .update({
        status: expired ? 'expired' : 'revoked',
        app_state: appState,
        revoked_at: now,
        last_error: null,
        next_try_at: null,
        heartbeat_at: null,
        updated_at: now
      })
    await logActivity({
      action: 'hub-break-glass-ended',
      user: row.revoked_by,
      collection: BREAK_GLASS,
      item: String(id),
      comment: `Administrator access ended (${row.revoke_reason ?? 'revoked'}; the app answered ${appState})`
    })
    await tell(
      row,
      {
        subject: `Break-glass ended: ${await names(row.app_id, row.environment_id)}`,
        message:
          appState === 'role_changed'
            ? 'The grant ended; the account’s role had been changed during it and stays as it is.'
            : 'The temporary administrator access ended; the account has its own role again.'
      },
      deps
    )
  }
  // Without the account id (a grant whose answer was lost) the app finds the account by the
  // same proven identity the grant used — and only a mark with this ref is touched.
  let who: Record<string, unknown> = { user_id: row.app_user_id }
  if (!row.app_user_id) {
    const raw = (await db(BREAK_GLASS).where({ id }).first('identity')) as { identity: unknown }
    const identity = parseIdentity(raw?.identity)
    if (!identity.emails.length && !identity.entra.length) {
      await done('unknown_account')
      return
    }
    who = { emails: identity.emails, entra: identity.entra }
  }
  const t = await target(row, deps).catch(() => null)
  const res = t
    ? await (deps.call ?? callSecurity)(
        t,
        'POST',
        'break-glass/revoke',
        { ref: `bg-${id}`, ...who },
        deps
      )
    : ({ ok: false, code: 'NO_LINK', status: 0 } as const)
  if (res.ok) {
    const state = String(res.body.state ?? '')
    if (state === 'revoked' || state === 'none' || state === 'role_changed') {
      await done(state)
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
 * The job (hub-break-glass, every minute, one leader): expired grants start their revoke,
 * revokes and grants due a retry (or whose process stopped) run again, requests nobody decided
 * within 24 h are withdrawn.
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
  for (const r of due) {
    const id = Number(r.id)
    const n = await db(BREAK_GLASS)
      .where({ id, status: 'active' })
      .update({ status: 'revoking', revoke_reason: 'expired', next_try_at: now, updated_at: now })
    if (n) {
      await runRevoke(id, deps)
      out.revoked.push(id)
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
