/**
 * Security alerts to administrators (SOC 2 CC7 — security event detection).
 *
 *   noteUserRoleChange / noteRolePermissionChange / noteApiKeyEvent  — from the routes that
 *     change roles, policies and API keys (and the directory / SCIM / bulk paths);
 *   noteAccessDenied(req)   — every 403 answer (root onSend hook in server.ts): one caller (person,
 *     API key or, for anonymous callers, network address) refused ≥ threshold times within the
 *     window raises one alert;
 *   noteAdminNewSignin      — an administrator signing in from an address unseen for them in 90
 *     days (services/security.ts recordLogin already flags new addresses).
 *
 * Delivery is the ordinary notification stack (notifyUser, category `security`, mutable in
 * Profile → Notification rules, administrators only) and every alert sent is also an activity row
 * (`security-alert`) — the evidence trail the Security & privacy page lists.
 *
 * Coalescing: events are pushed onto a Redis list per (tenant, family, actor); the replica whose
 * push found no flush pending owns the flush and sends ONE notice for the whole list a few seconds
 * later — so a bulk role change of 40 people, or a role edited field by field, is one alert, even
 * when the requests landed on different replicas. The 403 counter is a Redis key per caller with
 * the window as its expiry, so every replica counts into the same number; a caller alerts at most
 * once per cooldown. Without Redis both fall back to process memory (single-process installs).
 * Every key carries the tenant; process memory goes through tenantState (cloud mode).
 *
 * Settings: the `security_alerts` key of this instance's nivaro_settings_overrides row (like
 * ops_report) — one switch per family, all on by default, plus the burst threshold and window.
 * Never throws into the caller and never blocks it: every entry point is fire-and-forget.
 */
import type { FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { logActivity } from './activity.js'
import { tenantState } from './ai-tenant-state.js'
import { instanceKey } from './instance-key.js'
import { adminLinkBase } from './instance-links.js'
import { getApp } from './io-holder.js'
import {
  type AccessDeniedEvent,
  buildSecurityNotice,
  coalesceGroup,
  namedUsers,
  type SecurityAlertKind,
  type SecurityEvent,
  type SecurityNotice,
  type UserRoleEvent
} from './security-alerts-text.js'
import { currentTenantKey } from './tenant-rooms.js'
import { viewAsAdminOf } from './view-as-attribution.js'

export * from './security-alerts-text.js'

// ─── Settings ───────────────────────────────────────────────────────────────

export const SECURITY_ALERTS_KEY = 'security_alerts'

export interface SecurityAlertSettings {
  /** A person's role changed (any role). */
  role_changes: boolean
  /** Someone gained or lost administrator rights (also on when role_changes is off). */
  admin_rights: boolean
  /** A role's permissions, administrator flag or screens changed; roles created / deleted. */
  role_permissions: boolean
  /** An API key was created or given more access. */
  api_keys: boolean
  /** One caller was refused access over and over. */
  access_denied: boolean
  access_denied_threshold: number
  access_denied_minutes: number
  /** An administrator signed in from an address unseen for them in 90 days. */
  admin_signin: boolean
}

export const SECURITY_ALERT_DEFAULTS: SecurityAlertSettings = {
  role_changes: true,
  admin_rights: true,
  role_permissions: true,
  api_keys: true,
  access_denied: true,
  access_denied_threshold: 25,
  access_denied_minutes: 5,
  admin_signin: true
}

const BOOL_KEYS = [
  'role_changes',
  'admin_rights',
  'role_permissions',
  'api_keys',
  'access_denied',
  'admin_signin'
] as const

export class SecurityAlertSettingsError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super(Object.values(fields).join('; '))
  }
}

function obj(raw: unknown): Record<string, unknown> {
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : {}
}

function intIn(raw: unknown, min: number, max: number): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  return Number.isInteger(n) && n >= min && n <= max ? n : null
}

/** Stored JSON → settings (pure; anything unreadable is its default — on). */
export function normalizeSecurityAlertSettings(raw: unknown): SecurityAlertSettings {
  const s = obj(raw)
  const out = { ...SECURITY_ALERT_DEFAULTS }
  for (const k of BOOL_KEYS) if (typeof s[k] === 'boolean') out[k] = s[k] as boolean
  out.access_denied_threshold =
    intIn(s.access_denied_threshold, 5, 10_000) ?? SECURITY_ALERT_DEFAULTS.access_denied_threshold
  out.access_denied_minutes =
    intIn(s.access_denied_minutes, 1, 60) ?? SECURITY_ALERT_DEFAULTS.access_denied_minutes
  return out
}

/** An admin's PATCH: every bad field is named, never silently dropped. */
export function mergeSecurityAlertPatch(
  stored: SecurityAlertSettings,
  patch: unknown
): SecurityAlertSettings {
  const p = obj(patch)
  const bad: Record<string, string> = {}
  for (const k of Object.keys(p))
    if (!(k in SECURITY_ALERT_DEFAULTS)) bad[k] = `${k} is not a setting`
  for (const k of BOOL_KEYS)
    if (p[k] !== undefined && typeof p[k] !== 'boolean') bad[k] = 'Must be on or off'
  if (
    p.access_denied_threshold !== undefined &&
    intIn(p.access_denied_threshold, 5, 10_000) == null
  )
    bad.access_denied_threshold = 'A whole number from 5 to 10,000'
  if (p.access_denied_minutes !== undefined && intIn(p.access_denied_minutes, 1, 60) == null)
    bad.access_denied_minutes = 'A whole number of minutes from 1 to 60'
  if (Object.keys(bad).length) throw new SecurityAlertSettingsError(bad)
  return normalizeSecurityAlertSettings({ ...stored, ...p })
}

async function readOverridesRow(): Promise<{ id: number; data: Record<string, unknown> } | null> {
  const row = (await db('nivaro_settings_overrides')
    .where({ instance_key: instanceKey() })
    .first('id', 'data')) as { id: number; data?: string | null } | undefined
  if (!row) return null
  try {
    return { id: row.id, data: obj(row.data ? JSON.parse(row.data) : {}) }
  } catch {
    return { id: row.id, data: {} }
  }
}

const settingsCache = tenantState(() => ({ at: 0, value: null as SecurityAlertSettings | null }))
const SETTINGS_TTL_MS = 30_000

/** This instance's settings (30 s cache per tenant; defaults when unreadable). Never throws. */
export async function getSecurityAlertSettings(): Promise<SecurityAlertSettings> {
  const c = settingsCache()
  if (c.value && Date.now() - c.at < SETTINGS_TTL_MS) return c.value
  let value = SECURITY_ALERT_DEFAULTS
  try {
    value = normalizeSecurityAlertSettings((await readOverridesRow())?.data[SECURITY_ALERTS_KEY])
  } catch {
    value = SECURITY_ALERT_DEFAULTS
  }
  c.value = value
  c.at = Date.now()
  return value
}

export async function saveSecurityAlertSettings(patch: unknown): Promise<SecurityAlertSettings> {
  const row = await readOverridesRow()
  const next = mergeSecurityAlertPatch(
    normalizeSecurityAlertSettings(row?.data[SECURITY_ALERTS_KEY]),
    patch
  )
  const data = { ...(row?.data ?? {}), [SECURITY_ALERTS_KEY]: next }
  if (row) {
    await db('nivaro_settings_overrides')
      .where({ id: row.id })
      .update({ data: JSON.stringify(data), updated_at: new Date() })
  } else {
    await db('nivaro_settings_overrides').insert({
      instance_key: instanceKey(),
      data: JSON.stringify(data),
      updated_at: new Date()
    })
  }
  const c = settingsCache()
  c.value = next
  c.at = Date.now()
  return next
}

/** Is this event's family switched on? A role change that moves administrator rights passes
 *  when EITHER role_changes or admin_rights is on. */
export function eventEnabled(ev: SecurityEvent, s: SecurityAlertSettings): boolean {
  switch (ev.kind) {
    case 'user_role': {
      // A new account is news only when it starts with administrator rights.
      if (ev.created) return !!ev.toAdmin && (s.admin_rights || s.role_changes)
      const adminMove = !!ev.toAdmin !== !!ev.fromAdmin
      return adminMove ? s.admin_rights || s.role_changes : s.role_changes
    }
    case 'role_permissions':
      return s.role_permissions
    case 'api_key':
      return s.api_keys
    case 'access_denied':
      return s.access_denied
    case 'admin_signin':
      return s.admin_signin
  }
}

// ─── Stores (Redis across replicas; memory when there is none) ──────────────

/** A list per coalescing group; the first push after a flush owns the next flush. */
export interface CoalesceStore {
  push(group: string, item: string, ttlSec: number): Promise<{ owner: boolean }>
  drain(group: string): Promise<string[]>
}

/** A counter per caller with the window as its life, and one-shot claims. */
export interface CounterStore {
  hit(key: string, windowSec: number): Promise<number>
  claim(key: string, ttlSec: number): Promise<boolean>
}

function redisClient(): any {
  try {
    return getApp()?.redis ?? null
  } catch {
    return null
  }
}

function tenantPart(): string {
  return currentTenantKey() || '-'
}

const memLists = tenantState(() => new Map<string, string[]>())
const memCounts = tenantState(() => new Map<string, { n: number; until: number }>())
const memClaims = tenantState(() => new Map<string, number>())

export const memoryCoalesceStore: CoalesceStore = {
  async push(group, item) {
    const m = memLists()
    const list = m.get(group)
    if (list) {
      list.push(item)
      return { owner: false }
    }
    m.set(group, [item])
    return { owner: true }
  },
  async drain(group) {
    const m = memLists()
    const list = m.get(group) ?? []
    m.delete(group)
    return list
  }
}

export const memoryCounterStore: CounterStore = {
  async hit(key, windowSec) {
    const m = memCounts()
    const now = Date.now()
    const cur = m.get(key)
    if (!cur || cur.until <= now) {
      m.set(key, { n: 1, until: now + windowSec * 1000 })
      if (m.size > 5000) for (const [k, v] of m) if (v.until <= now) m.delete(k)
      return 1
    }
    cur.n++
    return cur.n
  },
  async claim(key, ttlSec) {
    const m = memClaims()
    const now = Date.now()
    const until = m.get(key)
    if (until != null && until > now) return false
    m.set(key, now + ttlSec * 1000)
    if (m.size > 5000) for (const [k, v] of m) if (v <= now) m.delete(k)
    return true
  }
}

export function redisCoalesceStore(redis: any): CoalesceStore {
  const base = () => `nvr:secalert:${tenantPart()}`
  return {
    async push(group, item, ttlSec) {
      const list = `${base()}:q:${group}`
      const lock = `${base()}:lock:${group}`
      const res = (await redis
        .multi()
        .rpush(list, item)
        .expire(list, ttlSec)
        .set(lock, '1', 'EX', ttlSec, 'NX')
        .exec()) as Array<[Error | null, unknown]>
      return { owner: res?.[2]?.[1] === 'OK' }
    },
    async drain(group) {
      const list = `${base()}:q:${group}`
      const lock = `${base()}:lock:${group}`
      const res = (await redis.multi().lrange(list, 0, -1).del(list).del(lock).exec()) as Array<
        [Error | null, unknown]
      >
      return (res?.[0]?.[1] as string[] | undefined) ?? []
    }
  }
}

export function redisCounterStore(redis: any): CounterStore {
  const base = () => `nvr:secalert:${tenantPart()}`
  return {
    async hit(key, windowSec) {
      const k = `${base()}:n:${key}`
      // The first hit creates the key with the window as its life; later hits only count.
      const res = (await redis.multi().set(k, '0', 'EX', windowSec, 'NX').incr(k).exec()) as Array<
        [Error | null, unknown]
      >
      return Number(res?.[1]?.[1] ?? 0)
    },
    async claim(key, ttlSec) {
      const r = await redis.set(`${base()}:c:${key}`, '1', 'EX', ttlSec, 'NX')
      return r === 'OK'
    }
  }
}

// ─── Delivery ───────────────────────────────────────────────────────────────

/** How long a batch keeps collecting before it is sent. */
export const COALESCE_MS = 8_000
/** A batch whose owner died is picked up by the next push after this. */
const LIST_TTL_S = 120
/** One caller alerts about refusals at most once per this many seconds. */
export const DENIED_COOLDOWN_S = 3600
/** Notices per tenant per hour before the rest are only logged (a runaway script). */
export const HOURLY_CAP = 30

export interface SecurityAlertDeps {
  settings(): Promise<SecurityAlertSettings>
  coalesce(): CoalesceStore
  counters(): CounterStore
  schedule(fn: () => void, ms: number): void
  admins(): Promise<string[]>
  names(ids: string[]): Promise<Map<string, string>>
  keyNames(ids: string[]): Promise<Map<string, string>>
  notify(userId: string, notice: SecurityNotice, url: string): Promise<void>
  log(notice: SecurityNotice, delivered: number): Promise<void>
  linkBase(): string
}

async function activeAdmins(): Promise<string[]> {
  const rows = (await db('nivaro_users as u')
    .join('nivaro_roles as r', 'r.id', 'u.role')
    .where('r.admin_access', true)
    .where((w) => w.where('u.status', 'active').orWhereNull('u.status'))
    .where((w) => w.where('u.is_redacted', false).orWhereNull('u.is_redacted'))
    .whereNull('u.account_kind')
    .limit(100)
    .select('u.id')) as Array<{ id: string }>
  return rows.map((r) => String(r.id))
}

async function personNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  if (ids.length === 0) return out
  const { noticePersonName } = await import('./inactive-people-notice.js')
  const rows = (await db('nivaro_users')
    .whereIn('id', ids.slice(0, 200))
    .select('id', 'first_name', 'last_name', 'email', 'is_redacted')) as Array<
    Record<string, unknown>
  >
  for (const r of rows) out.set(String(r.id).toUpperCase(), noticePersonName(r))
  return out
}

async function apiKeyNames(ids: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const nums = ids.map(Number).filter((n) => Number.isInteger(n))
  if (nums.length === 0) return out
  const rows = (await db('nivaro_api_keys').whereIn('id', nums).select('id', 'name')) as Array<{
    id: number
    name: string | null
  }>
  for (const r of rows) if (r.name) out.set(String(r.id), r.name)
  return out
}

const defaultDeps: SecurityAlertDeps = {
  settings: getSecurityAlertSettings,
  coalesce: () => {
    const r = redisClient()
    return r ? redisCoalesceStore(r) : memoryCoalesceStore
  },
  counters: () => {
    const r = redisClient()
    return r ? redisCounterStore(r) : memoryCounterStore
  },
  // A timer armed inside a tenant's request keeps that tenant (AsyncLocalStorage follows timers).
  schedule: (fn, ms) => {
    const t = setTimeout(fn, ms)
    t.unref?.()
  },
  admins: activeAdmins,
  names: personNames,
  keyNames: apiKeyNames,
  notify: async (userId, notice, url) => {
    const app = getApp()
    if (!app) return
    const { notifyUser } = await import('./notification-channels.js')
    await notifyUser(app, userId, {
      subject: notice.subject,
      message: notice.message,
      category: 'security',
      target: { kind: 'external', url, action: 'review' },
      source: { kind: 'security_alert', label: 'Security alerts', id: notice.kind },
      why: 'You are an administrator, and security alerts go to every administrator. Turn this kind off on Security & privacy, or mute Security alerts in Profile → Notification rules.'
    })
  },
  log: async (notice, delivered) => {
    await logActivity({
      action: 'security-alert',
      user: null,
      collection: notice.collection ?? undefined,
      item: notice.item ?? undefined,
      comment: JSON.stringify({
        kind: notice.kind,
        subject: notice.subject,
        message: notice.message,
        path: notice.path,
        delivered
      }).slice(0, 4000)
    })
  },
  linkBase: adminLinkBase
}

let depsOverride: SecurityAlertDeps | null = null
/** Tests swap the I/O. */
export function setSecurityAlertDeps(d: SecurityAlertDeps | null): void {
  depsOverride = d
}
const deps = () => depsOverride ?? defaultDeps

/** Queue an event for its coalesced notice (checks the family switch first). */
export async function raiseSecurityEvent(ev: SecurityEvent): Promise<void> {
  const d = deps()
  try {
    const s = await d.settings()
    if (!eventEnabled(ev, s)) return
    const group = coalesceGroup(ev)
    const { owner } = await d.coalesce().push(group, JSON.stringify(ev), LIST_TTL_S)
    if (owner) d.schedule(() => void flushSecurityGroup(group).catch(() => {}), COALESCE_MS)
  } catch {
    // an alert must never break the write that caused it
  }
}

/** Send one group's batch now (the timer does this; tests call it directly). */
export async function flushSecurityGroup(group: string): Promise<SecurityNotice | null> {
  const d = deps()
  const raw = await d.coalesce().drain(group)
  const evs: SecurityEvent[] = []
  for (const r of raw) {
    try {
      evs.push(JSON.parse(r) as SecurityEvent)
    } catch {
      /* skip a mangled entry */
    }
  }
  if (evs.length === 0) return null
  const keyIds = evs
    .filter((e): e is AccessDeniedEvent => e.kind === 'access_denied')
    .filter((e) => e.caller.type === 'api_key')
    .map((e) => e.caller.id)
  const [names, keyNames] = await Promise.all([
    d.names(namedUsers(evs)).catch(() => new Map<string, string>()),
    keyIds.length ? d.keyNames(keyIds).catch(() => new Map<string, string>()) : new Map()
  ])
  const notice = buildSecurityNotice(evs, { names, keyNames })
  if (!notice) return null

  const admins = await d.admins().catch(() => [] as string[])
  const exclude = new Set(notice.exclude.map((x) => x.toUpperCase()))
  let recipients = admins.filter((a) => !exclude.has(a.toUpperCase()))
  // The only administrator still hears about their own change: someone with their sign-in would.
  if (recipients.length === 0) recipients = admins
  // Only access-denied bursts (a runaway script) count against the hourly cap. Changes to
  // roles, permissions, API keys and admin sign-ins are always delivered: dropping them is
  // exactly what someone hiding a change would want (security review 2026-11-16).
  const cappable = evs.every((e) => e.kind === 'access_denied')
  let withinCap = true
  let justCapped = false
  if (cappable) {
    const n = await d
      .counters()
      .hit('hourly', 3600)
      .catch(() => 0)
    withinCap = n <= HOURLY_CAP
    justCapped = n === HOURLY_CAP + 1
  }
  if (justCapped) {
    // Say once that more refusal alerts are being held back, instead of going quiet.
    const held: SecurityNotice = {
      kind: 'access_denied',
      subject: 'More access-denied alerts this hour',
      message: `More than ${HOURLY_CAP} access-denied alerts were raised in the last hour. Further ones are recorded under Security alerts but not sent until the hour is up.`,
      path: '/security-center',
      collection: null,
      item: null,
      exclude: []
    }
    const heldUrl = `${d.linkBase().replace(/\/$/, '')}${held.path}`
    for (const admin of admins) await d.notify(admin, held, heldUrl).catch(() => {})
  }
  let delivered = 0
  if (withinCap) {
    const url = `${d.linkBase().replace(/\/$/, '')}${notice.path}`
    for (const admin of recipients) {
      try {
        await d.notify(admin, notice, url)
        delivered++
      } catch {
        /* one recipient's failure never stops the rest */
      }
    }
  }
  await d.log(notice, delivered).catch(() => {})
  return notice
}

// ─── Entry points for the routes ────────────────────────────────────────────

/** Names + administrator flags of roles by id (upper-case keys). */
async function roleFacts(
  ids: Array<string | null>
): Promise<Map<string, { name: string; admin: boolean }>> {
  const want = [...new Set(ids.filter((x): x is string => !!x))]
  const out = new Map<string, { name: string; admin: boolean }>()
  if (want.length === 0) return out
  const rows = (await db('nivaro_roles')
    .whereIn('id', want)
    .select('id', 'name', 'admin_access')) as Array<{
    id: string
    name: string | null
    admin_access: boolean | number | null
  }>
  for (const r of rows)
    out.set(String(r.id).toUpperCase(), {
      name: String(r.name ?? ''),
      admin: r.admin_access === true || r.admin_access === 1
    })
  return out
}

export interface RoleChangeInput {
  actor: string | null
  source?: UserRoleEvent['source']
  userId: string
  fromRole: string | null | undefined
  toRole: string | null | undefined
  created?: boolean
}

/** A person's role changed (or an account was created with a role). Fire-and-forget. */
export function noteUserRoleChange(input: RoleChangeInput): void {
  const from = input.fromRole ? String(input.fromRole) : null
  const to = input.toRole ? String(input.toRole) : null
  if (!input.created && (from ?? '').toUpperCase() === (to ?? '').toUpperCase()) return
  void (async () => {
    const roles = await roleFacts([from, to]).catch(() => new Map())
    const f = from ? roles.get(from.toUpperCase()) : undefined
    const t = to ? roles.get(to.toUpperCase()) : undefined
    await raiseSecurityEvent({
      kind: 'user_role',
      actor: input.actor,
      source: input.source ?? (input.actor ? 'person' : 'system'),
      userId: String(input.userId),
      fromRole: from,
      toRole: to,
      created: input.created,
      fromAdmin: !!f?.admin,
      toAdmin: !!t?.admin,
      fromName: f?.name ?? null,
      toName: t?.name ?? null
    })
  })().catch(() => {})
}

/** A role's permissions changed. `adminChange` when the role itself gained/lost admin rights. */
export function noteRolePermissionChange(input: {
  actor: string | null
  roleId: string
  roleName?: string | null
  change: string
  adminChange?: 'granted' | 'removed'
}): void {
  void (async () => {
    let roleName = input.roleName ?? null
    if (!roleName)
      roleName =
        (await roleFacts([input.roleId]).catch(() => new Map())).get(
          String(input.roleId).toUpperCase()
        )?.name ?? null
    let members: number | undefined
    if (input.adminChange === 'granted') {
      const row = (await db('nivaro_users')
        .where({ role: input.roleId })
        .count({ n: '*' })
        .first()
        .catch(() => undefined)) as { n?: number | string } | undefined
      members = row ? Number(row.n ?? 0) : undefined
    }
    await raiseSecurityEvent({
      kind: 'role_permissions',
      actor: input.actor,
      roleId: String(input.roleId),
      roleName: roleName || 'unnamed',
      change: input.change,
      adminChange: input.adminChange,
      members
    })
  })().catch(() => {})
}

/** An API key was created or reaches further than it did. */
export function noteApiKeyEvent(input: {
  actor: string | null
  keyId: string | number
  keyName: string | null | undefined
  ownerId: string | null | undefined
  change: 'created' | 'widened'
  reasons: string[]
}): void {
  if (input.change === 'widened' && input.reasons.length === 0) return
  void raiseSecurityEvent({
    kind: 'api_key',
    actor: input.actor,
    keyId: String(input.keyId),
    keyName: input.keyName?.trim() || 'unnamed',
    ownerId: input.ownerId ? String(input.ownerId) : null,
    change: input.change,
    reasons: input.reasons
  })
}

/** An administrator signed in from an address unseen for them in 90 days. */
export function noteAdminNewSignin(userId: string, device: string | null): void {
  void raiseSecurityEvent({ kind: 'admin_signin', userId: String(userId), device })
}

// ─── Access-denied bursts ───────────────────────────────────────────────────

interface DeniedReq {
  user?: { id?: string | null } | null
  apiKeyId?: number | null
  ip?: string
}

/** Who a refused request counts against: the key, else the person, else the address. */
export function deniedCaller(req: DeniedReq): AccessDeniedEvent['caller'] | null {
  if (req.apiKeyId != null && Number.isFinite(Number(req.apiKeyId)))
    return { type: 'api_key', id: String(req.apiKeyId) }
  if (req.user?.id) return { type: 'user', id: String(req.user.id) }
  const ip = String(req.ip ?? '').trim()
  return ip ? { type: 'address', id: ip.slice(0, 64) } : null
}

/** Count one refusal; raise when the count reaches the threshold (once per cooldown). */
export async function countAccessDenied(caller: AccessDeniedEvent['caller']): Promise<boolean> {
  const d = deps()
  const s = await d.settings()
  if (!s.access_denied) return false
  const store = d.counters()
  const key = `${caller.type}:${caller.id.toUpperCase()}`
  const n = await store.hit(`denied:${key}`, s.access_denied_minutes * 60)
  // Exactly at the threshold: replicas share the counter, so only one request sees this number.
  if (n !== s.access_denied_threshold) return false
  if (!(await store.claim(`denied-sent:${key}`, DENIED_COOLDOWN_S))) return false
  await raiseSecurityEvent({
    kind: 'access_denied',
    caller,
    count: n,
    minutes: s.access_denied_minutes
  })
  return true
}

/** Root onSend hook body: a 403 counts against its caller. Never throws, never waits. */
export function noteAccessDenied(req: FastifyRequest): void {
  try {
    // An administrator viewing as someone is exploring on purpose: not that person probing.
    if (viewAsAdminOf(req)) return
    const caller = deniedCaller(req as unknown as DeniedReq)
    if (!caller) return
    void countAccessDenied(caller).catch(() => {})
  } catch {
    /* never */
  }
}

/** The families, for the settings card and docs. */
export const SECURITY_ALERT_KINDS: SecurityAlertKind[] = [
  'user_role',
  'role_permissions',
  'api_key',
  'access_denied',
  'admin_signin'
]
