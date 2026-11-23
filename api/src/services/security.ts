import type { FastifyInstance, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { isMultiTenant } from './deployment-mode.js'
import { hubLinkKeyTag } from './hub-link/retire.js'
import { getApp } from './io-holder.js'
import { observeMaintenance, recheckMaintenanceSoon } from './maintenance-live.js'
import { notifyUser } from './notification-channels.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * Login-event capture. Called from every successful sign-in path; a sign-in
 * from an IP unseen for this user in 90 days is flagged and the USER is
 * notified ("new sign-in from …") — the cheap, honest tier of unusual-login
 * detection. Best-effort: auth must never fail because bookkeeping did.
 */
export async function recordLogin(
  app: FastifyInstance | null,
  userId: string,
  method: 'oidc' | 'password' | 'saml' | 'masquerade' | 'static_token',
  req: FastifyRequest
): Promise<void> {
  try {
    const ip = String(req.headers['x-forwarded-for'] ?? req.ip ?? '')
      .split(',')[0]
      .trim()
      .slice(0, 100)
    const agent = String(req.headers['user-agent'] ?? '').slice(0, 500)
    let newIp = false
    if (ip) {
      const seen = await db('nivaro_login_events')
        .where('user', userId)
        .where('ip', ip)
        .where('created_at', '>=', new Date(Date.now() - 90 * 86_400_000))
        .first('id')
      newIp = !seen
    }
    const inserted = (await db('nivaro_login_events')
      .insert({
        user: userId,
        method,
        ip: ip || null,
        user_agent: agent || null,
        new_ip: newIp,
        created_at: new Date()
      })
      .returning('id')) as Array<{ id: number } | number>
    const eventId = typeof inserted[0] === 'object' ? inserted[0]?.id : inserted[0]
    // Masquerade "logins" are an admin acting deliberately — notifying the
    // target that "you" signed in would be confusing, not protective.
    if (newIp && app && method !== 'masquerade') {
      const priorLogins = await db('nivaro_login_events')
        .where('user', userId)
        .count({ c: '*' })
        .first()
      // A user's very FIRST login is always a new IP — don't greet them with
      // a security alert.
      if (Number((priorLogins as { c?: number } | undefined)?.c ?? 0) > 1) {
        const { buildSignInMail } = await import('./mail-builders.js')
        const built =
          eventId != null ? await buildSignInMail(eventId, userId).catch(() => null) : null
        await notifyUser(app, userId, {
          subject: 'New sign-in to your account',
          category: 'system',
          message: `A sign-in from a new location (${ip || 'unknown IP'}) just occurred. If this was you, no action is needed — otherwise contact an administrator.`,
          ...(built ? { template: built.template, template_data: built.data } : {})
        }).catch(() => {})
        // An ADMINISTRATOR from a new address also tells the other administrators
        // (services/security-alerts.ts, switch `admin_signin`).
        const admin = (await db('nivaro_users as u')
          .join('nivaro_roles as r', 'r.id', 'u.role')
          .where('u.id', userId)
          .where('r.admin_access', true)
          .first('u.id')
          .catch(() => null)) as { id?: string } | null | undefined
        if (admin) {
          const { describeUserAgent } = await import('./mail-builders.js')
          const { noteAdminNewSignin } = await import('./security-alerts.js')
          noteAdminNewSignin(userId, describeUserAgent(agent))
        }
      }
    }
  } catch {
    // never block auth
  }
}

/** Maintenance-mode flag, cached 15s — read on every write request. */
export type MaintenanceDisplay = 'banner' | 'page'

/** What the freeze means for the person reading the STRIP: exempt admins, and
 *  any client that only knows the banner (it can still browse). Reused by the
 *  write refusal — the caller who hit it was, by definition, still reading. */
export const MAINTENANCE_EXPLAINER =
  'You can keep reading and browsing, but saving changes is paused until maintenance ends. Anything you saved earlier is unaffected.'

/** What the freeze means on the FULL PAGE, where nothing can be browsed. */
export const MAINTENANCE_PAGE_EXPLAINER =
  'The portal is unavailable until maintenance ends. Anything you saved earlier is safe and will be here when it is back.'

export function maintenanceExplainer(display: MaintenanceDisplay): string {
  return display === 'page' ? MAINTENANCE_PAGE_EXPLAINER : MAINTENANCE_EXPLAINER
}

export const MAINTENANCE_DEFAULT_MESSAGE = 'Maintenance in progress.'

export interface MaintenanceState {
  on: boolean
  message: string | null
  /** How non-exempt people see the freeze: a strip above the app, or a page
   *  that replaces it. Admins always get the strip — they stay exempt. */
  display: MaintenanceDisplay
  /** When the freeze is expected to lift (ISO), or null when nobody said. */
  until: string | null
  /** 'settings' = the nivaro_settings row; 'override' = the Redis flag an
   *  operator or a rebuild job set (`MAINTENANCE_OVERRIDE_KEY`), which wins
   *  while present — it is the one thing that survives a database restore. */
  source: 'settings' | 'override'
  /** Hub phase 6 (Decision 19): the override was written with `strict: true` — no caller is
   *  exempt from the write freeze, administrators on their own session included. Present only
   *  when true. */
  strict?: true
  /** The override was set by the Nivaro Hub over the hub link (a move); an admin's End
   *  maintenance leaves it alone. Present only when true. */
  hub?: true
}

/**
 * Redis key holding an out-of-band maintenance flag: JSON
 * `{on, message?, display?, until?, set_by?}`. A rebuild that restores
 * production over the database (wiping nivaro_settings) or copies another
 * instance's settings over it cannot keep a flag in the database — the
 * golive chain sets this key in the API's own Redis instead, and clears it
 * when it finishes. An admin's "End maintenance" clears it too.
 */
export const MAINTENANCE_OVERRIDE_KEY = 'nvr:maintenance'

/** The cached state per tenant (`currentTenantKey()`; '' = self-hosted, one entry). One process
 *  serves many apps in cloud and on a Hub shared deployment: a single module variable let one
 *  app's maintenance mode (or its absence) answer for another for up to 15 s (ruling P5-6). */
const maintCache = new Map<string, { at: number } & MaintenanceState>()

/** Forget the cached maintenance state: one tenant's (`currentTenantKey()` value) when named,
 *  else every tenant's. */
export function bustMaintenanceCache(tenant?: string): void {
  if (tenant === undefined) maintCache.clear()
  else maintCache.delete(tenant)
}

/**
 * rt4 #13: maintenance was written in this process (settings, a window starting or ending,
 * End maintenance): forget the cached state and read it again shortly, so open tabs hear the
 * change at once (services/maintenance-live.ts) — the full page returns to the app by itself.
 */
export function maintenanceWritten(): void {
  bustMaintenanceCache()
  recheckMaintenanceSoon()
}

// The ioredis client off the app holder, best-effort — null before boot.
function redisClient(): any {
  try {
    return getApp()?.redis ?? null
  } catch {
    return null
  }
}

async function readOverride(): Promise<Omit<MaintenanceState, 'source'> | null> {
  const redis = redisClient()
  if (!redis) return null
  try {
    const raw = (await redis.get(MAINTENANCE_OVERRIDE_KEY)) as string | null
    if (!raw) return null
    const j = JSON.parse(raw) as {
      on?: unknown
      message?: unknown
      display?: unknown
      until?: unknown
      strict?: unknown
      hub?: unknown
    }
    if (j?.on !== true) return null
    const until = typeof j.until === 'string' && j.until ? new Date(j.until) : null
    return {
      on: true,
      message: typeof j.message === 'string' && j.message.trim() ? j.message.trim() : null,
      display: normalizeMaintenanceDisplay(j.display),
      until: until && !Number.isNaN(until.getTime()) ? until.toISOString() : null,
      ...(j.strict === true ? { strict: true as const } : {}),
      ...(j.hub === true ? { hub: true as const } : {})
    }
  } catch {
    return null
  }
}

/**
 * Remove the out-of-band flag (an admin ending maintenance, a finished rebuild).
 *
 * Hub phase 5 (rule T7) — on a multi-tenant process (cloud, a Hub shared deployment) the flag is
 * the operator's freeze of the whole deployment, and the caller is one app's admin: it is left
 * alone, so their End maintenance ends only their app's own setting (the settings row the same
 * request writes). Nothing in cloud sets the flag today.
 */
export async function clearMaintenanceOverride(): Promise<void> {
  if (isMultiTenant()) {
    maintenanceWritten()
    return
  }
  const redis = redisClient()
  if (!redis) return
  try {
    // Hub phase 6: a freeze the Hub set for a move is the Hub's to lift (POST
    // /api/hub-link/maintenance {on:false}); an admin's End maintenance leaves it.
    if (!(await hubOverrideSet(redis))) await redis.del(MAINTENANCE_OVERRIDE_KEY)
  } catch {
    /* best-effort */
  }
  maintenanceWritten()
}

async function hubOverrideSet(redis: any): Promise<boolean> {
  const raw = (await redis.get(MAINTENANCE_OVERRIDE_KEY)) as string | null
  if (!raw) return false
  try {
    return (JSON.parse(raw) as { hub?: unknown })?.hub === true
  } catch {
    return false
  }
}

// ─── Hub phase 6: strict maintenance over the hub link (a move) ─────────────────────────────

/** Marker that a move's boot maintenance was released (HUB_BOOT_MAINTENANCE=<move id>). Per app
 *  (REDIS_CHANNEL_PREFIX + the hub-link key tag), so a shared Redis db never releases another
 *  app's boot maintenance. */
export function hubBootMaintenanceDoneKey(
  moveId: number,
  env: NodeJS.ProcessEnv = process.env
): string {
  return `${(env.REDIS_CHANNEL_PREFIX ?? '').trim()}nvr:hub:boot-maintenance-done:${hubLinkKeyTag(env)}:${moveId}`
}

export const HUB_MAINTENANCE_DEFAULT_MESSAGE =
  'This app is moving to a new home. It will be back in a few minutes.'

interface OverrideJson {
  on?: unknown
  hub?: unknown
  move_id?: unknown
  /** The operator's own freeze the Hub's covered (raw JSON), put back when the Hub lifts its own. */
  operator?: unknown
}

async function readOverrideJson(redis: any): Promise<OverrideJson | null> {
  const raw = (await redis.get(MAINTENANCE_OVERRIDE_KEY)) as string | null
  if (!raw) return null
  try {
    const j = JSON.parse(raw) as OverrideJson
    return j && typeof j === 'object' ? j : null
  } catch {
    return null
  }
}

/** The Hub's override, keeping an operator's freeze it covers so lifting it puts that one back. */
async function hubOverrideJson(
  redis: any,
  message: string | null,
  moveId: number | null
): Promise<string> {
  const cur = await readOverrideJson(redis)
  const operator =
    cur && cur.hub !== true
      ? JSON.stringify(cur)
      : cur?.hub === true && typeof cur.operator === 'string'
        ? cur.operator
        : null
  return JSON.stringify({
    on: true,
    display: 'page',
    strict: true,
    hub: true,
    message: message || HUB_MAINTENANCE_DEFAULT_MESSAGE,
    ...(moveId ? { move_id: moveId } : {}),
    ...(operator ? { operator } : {}),
    set_by: 'hub'
  })
}

/** A release for one move met the Hub freeze of another move (409 MAINTENANCE_OTHER_MOVE). */
export class HubMaintenanceMoveMismatch extends Error {
  code = 'MAINTENANCE_OTHER_MOVE'
  constructor(readonly heldBy: number) {
    super(`The maintenance here belongs to move ${heldBy}`)
  }
}

/**
 * Set or clear the Hub's strict maintenance (POST /api/hub-link/maintenance).
 *  - On: the override `{on, display:'page', strict, hub, message, move_id?}`. An operator's own
 *    freeze already there is kept inside it (`operator`) and comes back when the Hub lifts its own.
 *  - Off: only the Hub's own override is lifted (an operator's freeze stays). With `moveId` it must
 *    be that move's (else HubMaintenanceMoveMismatch, nothing changed), and the move's boot
 *    maintenance is released: a restart carrying HUB_BOOT_MAINTENANCE=<moveId> does not set it
 *    again. **Every rollback must send `move_id`** — otherwise a restart re-enters it.
 * Busts this process's cached state at once (ruling R14); other replicas follow within 15 s.
 * Throws without Redis: a freeze that is not stored would hold on one replica only.
 */
export async function setHubMaintenance(input: {
  on: boolean
  message?: string | null
  moveId?: number | null
}): Promise<void> {
  const redis = redisClient()
  if (!redis) throw new Error('Redis is not available')
  if (input.on) {
    await redis.set(
      MAINTENANCE_OVERRIDE_KEY,
      await hubOverrideJson(redis, input.message ?? null, input.moveId ?? null)
    )
    // Hub phase 6 (P6-26): a move freezing its target again (rollback) invalidates that move's
    // boot-maintenance done marker, so the app — restarted or re-created — boots in maintenance.
    if (input.moveId) await redis.del(hubBootMaintenanceDoneKey(input.moveId))
  } else {
    const cur = await readOverrideJson(redis)
    if (cur?.hub === true) {
      const held = Number(cur.move_id)
      if (input.moveId && Number.isSafeInteger(held) && held > 0 && held !== input.moveId)
        throw new HubMaintenanceMoveMismatch(held)
      if (typeof cur.operator === 'string' && cur.operator)
        await redis.set(MAINTENANCE_OVERRIDE_KEY, cur.operator)
      else await redis.del(MAINTENANCE_OVERRIDE_KEY)
    }
    if (input.moveId)
      await redis.set(hubBootMaintenanceDoneKey(input.moveId), new Date().toISOString())
  }
  maintenanceWritten()
}

/**
 * Boot (index.ts): a dedicated target a move deployed carries HUB_BOOT_MAINTENANCE=<move id> and
 * starts in strict maintenance until the Hub releases it. Applies once per value: after the
 * release (`maintenance {on:false, move_id}`) the done marker stops a restart from setting it
 * again. Only where the hub link is mounted. Returns whether it set the freeze.
 *
 * Escape hatch when the Hub cannot release it (the move is lost): remove HUB_BOOT_MAINTENANCE from
 * the stack, then lift the freeze (the Hub's maintenance {on:false}, or delete `nvr:maintenance`
 * in the app's Redis). An administrator cannot lift it from the app: strict refuses their write.
 */
export async function applyHubBootMaintenance(
  redis: any,
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  const raw = (env.HUB_BOOT_MAINTENANCE ?? '').trim()
  if (!/^[1-9]\d{0,15}$/.test(raw)) return false
  const moveId = Number(raw)
  if (!redis) return false
  if (await redis.get(hubBootMaintenanceDoneKey(moveId, env))) return false
  await redis.set(MAINTENANCE_OVERRIDE_KEY, await hubOverrideJson(redis, null, moveId))
  maintenanceWritten()
  return true
}

export function normalizeMaintenanceDisplay(v: unknown): MaintenanceDisplay {
  return v === 'page' ? 'page' : 'banner'
}

export async function maintenanceState(): Promise<MaintenanceState> {
  // Keyed per tenant, and the answer is the entry computed in THIS call, never the shared cache
  // read again after an await (another tenant's read may have written it meanwhile).
  const key = currentTenantKey()
  const cached = maintCache.get(key)
  if (cached && Date.now() - cached.at <= 15_000) {
    const { at: _at, ...state } = cached
    return state
  }
  const override = await readOverride()
  if (override) {
    const entry = { at: Date.now(), ...override, source: 'override' as const }
    maintCache.set(key, entry)
    const { at: _o, ...state } = entry
    observeMaintenance(state)
    return state
  }
  let entry: { at: number } & MaintenanceState
  try {
    const row = (await db('nivaro_settings')
      .where({ id: 1 })
      .first('maintenance_mode', 'maintenance_message', 'maintenance_display', 'maintenance_until')
      // A tenant behind migration 405 has no display/until columns yet —
      // the freeze itself must keep working, so fall back to the two
      // columns every database has.
      .catch(() =>
        db('nivaro_settings').where({ id: 1 }).first('maintenance_mode', 'maintenance_message')
      )) as
      | {
          maintenance_mode?: boolean
          maintenance_message?: string | null
          maintenance_display?: string | null
          maintenance_until?: Date | string | null
        }
      | undefined
    const until = row?.maintenance_until ? new Date(row.maintenance_until) : null
    entry = {
      at: Date.now(),
      on: !!row?.maintenance_mode,
      message: row?.maintenance_message ?? null,
      display: normalizeMaintenanceDisplay(row?.maintenance_display),
      until: until && !Number.isNaN(until.getTime()) ? until.toISOString() : null,
      source: 'settings'
    }
    maintCache.set(key, entry)
    // A read that worked (never the failure below: an offline database is not "over").
    observeMaintenance(entry)
  } catch {
    entry = {
      at: Date.now(),
      on: false,
      message: null,
      display: 'banner',
      until: null,
      source: 'settings'
    }
    maintCache.set(key, entry)
  }
  const { at: _at, ...state } = entry
  return state
}
