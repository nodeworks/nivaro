import type { FastifyRequest } from 'fastify'
import type { Redis } from 'ioredis'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { parseRefusal } from '../lib/parse-refusal.js'
import { logActivityThrottled } from './activity.js'
import { apiLogSource } from './api-log-source.js'
import { listDeviceGrants } from './device-grants.js'
import {
  appOfOrigin,
  browserKey,
  decodeFailureComment,
  describeAgent,
  encodeFailureComment,
  isKnownBrowser,
  pickIdentityMatch,
  type ReasonOwner,
  reasonFromLegacyRow,
  SIGN_IN_REASONS,
  type SignInReason
} from './sign-in-reasons.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * The person page's sign-in troubleshooter (idea 32, admin-only).
 *
 * Writes: every failed sign-in path in routes/auth.ts calls `noteSignInFailure`, which leaves one
 * `sign-in-failed` activity row on `nivaro_users` (item = the account when the attempt named one,
 * else null) with comment JSON {reason, method, app, code}. Same failure from the same place is
 * written at most once a minute (bots hitting the callback cannot flood the log). Successful web
 * sign-ins also note which app they were for in Redis (`noteSignInApp`).
 *
 * Reads (`readSignInTroubleshooter`): 30 days of failures named to the person, failures nobody
 * could name that came from a browser the person signed in from ("probably them"), the older
 * `login-refused` and `device-revoked` rows, recent successful sign-ins, the account's current
 * standing, and their phones. `readSignInRefusals` reads the request log (NOLOCK) for refused
 * requests made as the person — a separate, slower call the page asks for on demand.
 */

const DAY = 86_400_000
const WINDOW_DAYS = 30
const FAIL_CAP = 200
const SUCCESS_CAP = 25
const KNOWN_BROWSER_DAYS = 90
const APP_TTL_S = 35 * 24 * 3600

function allowedOrigins(): string[] {
  const out: string[] = []
  for (const u of [config.ADMIN_URL, config.PUBLIC_URL, ...config.APP_URLS.split(',')]) {
    try {
      if (u.trim()) out.push(new URL(u.trim()).origin)
    } catch {
      /* a malformed entry is skipped, as resolveReturnTo does */
    }
  }
  return out
}

/** The app a sign-in request was for: its returnTo, else the page that posted it. */
export function signInAppOf(req: FastifyRequest): string | null {
  const returnTo = (req.session as { returnTo?: string } | undefined)?.returnTo
  const origin = req.headers.origin ?? req.headers.referer
  return appOfOrigin(
    returnTo ?? (typeof origin === 'string' ? origin : null),
    config.ADMIN_URL,
    allowedOrigins()
  )
}

/**
 * Record one failed sign-in. Best-effort: never throws, never blocks the sign-in answer.
 * `userId` only when the attempt really named the account (its subject, Entra id or email).
 */
export async function noteSignInFailure(
  req: FastifyRequest,
  redis: Redis | null | undefined,
  f: {
    reason: SignInReason
    method: 'oidc' | 'saml' | 'password' | 'totp' | 'token' | 'phone'
    userId?: string | null
    code?: string | null
    app?: string | null
  }
): Promise<void> {
  try {
    const who = f.userId ? String(f.userId).toUpperCase() : `ip:${req.ip ?? ''}`
    await logActivityThrottled(
      redis,
      `signin-fail:${currentTenantKey()}:${who}:${f.reason}:${f.code ?? ''}`,
      60,
      {
        action: 'sign-in-failed',
        user: null,
        collection: 'nivaro_users',
        item: f.userId ? String(f.userId) : undefined,
        comment: encodeFailureComment({
          reason: f.reason,
          method: f.method,
          app: f.app === undefined ? signInAppOf(req) : f.app,
          code: f.code ?? null
        }),
        origin: 'person',
        req
      }
    )
  } catch {
    /* never block a sign-in on bookkeeping */
  }
}

/** The account an attempted identity names (subject, then Entra id, then email), or null. */
export async function matchAttemptedIdentity(attempt: {
  sub?: string | null
  oid?: string | null
  email?: string | null
}): Promise<string | null> {
  try {
    const sub = attempt.sub || null
    const oid = attempt.oid ? String(attempt.oid).trim().toLowerCase() : null
    const email = attempt.email ? String(attempt.email).trim() : null
    if (!sub && !oid && !email) return null
    const hasOid = await import('../lib/column-probe.js').then(({ hasColumn }) =>
      hasColumn('nivaro_users', 'entra_oid')
    )
    const rows = (await db('nivaro_users')
      .where((w) => {
        if (sub) w.orWhere('external_id', sub)
        if (oid && hasOid) w.orWhere('entra_oid', oid)
        if (email) w.orWhere('email', email)
      })
      .limit(5)
      .select('id', 'external_id', 'email', ...(hasOid ? ['entra_oid'] : []))) as Array<{
      id: string
      external_id?: string | null
      entra_oid?: string | null
      email?: string | null
    }>
    return pickIdentityMatch(rows, { sub, oid, email })?.id ?? null
  } catch {
    return null
  }
}

function appKey(userId: string): string {
  const t = currentTenantKey()
  return `nvr:signin-app:${t ? `${t}:` : ''}${String(userId).toUpperCase()}`
}

/** A successful web sign-in: remember which app it was for (Redis, 35 days). */
export async function noteSignInApp(
  redis: Redis | null | undefined,
  userId: string,
  req: FastifyRequest
): Promise<void> {
  if (!redis) return
  try {
    const app = signInAppOf(req) ?? 'unknown'
    const key = appKey(userId)
    await redis.hset(key, app, new Date().toISOString())
    await redis.expire(key, APP_TTL_S)
  } catch {
    /* best-effort */
  }
}

// ─── Read ──────────────────────────────────────────────────────────────────────

export interface TroubleAttempt {
  id: string
  at: string
  outcome: 'failed' | 'signed_in' | 'ended'
  reason: SignInReason | null
  label: string
  explain: string | null
  todo: string | null
  owner: ReasonOwner | null
  method: string | null
  app: string | null
  code: string | null
  /** `named` = the attempt named this account; `browser` = same address + browser as one of their sign-ins. */
  match: 'named' | 'browser'
  browser: string | null
  ip: string | null
  new_ip?: boolean
}

export interface TroubleCheck {
  key: string
  ok: boolean | null
  label: string
  detail: string
}

export interface SignInTroubleshooter {
  window_days: number
  checks: TroubleCheck[]
  last_success: {
    at: string
    method: string
    browser: string | null
    ip: string | null
    app: string | null
  } | null
  apps: Array<{ app: string; at: string }>
  phones: Array<{ name: string; platform: string | null; last_used_at: string | null }>
  attempts: TroubleAttempt[]
  /** Failures in the window, by reason, most frequent first. */
  by_reason: Array<{ reason: SignInReason; label: string; n: number; last_at: string }>
  /** The newest failure since the last successful sign-in — the one to act on. */
  current: (TroubleAttempt & { since_success: boolean }) | null
}

const iso = (v: unknown): string | null => {
  if (v == null || v === '') return null
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

function reasonFields(reason: SignInReason) {
  const r = SIGN_IN_REASONS[reason]
  return { reason, label: r.label, explain: r.explain, todo: r.todo, owner: r.owner }
}

/** The account's standing right now, each as a check. Pure over the row it is given. */
export function accountChecks(
  u: {
    status?: string | null
    is_redacted?: unknown
    account_kind?: string | null
    external_id?: string | null
    entra_oid?: string | null
    email?: string | null
    directory_status?: string | null
    directory_checked_at?: unknown
    has_password?: boolean
  },
  roleAllowsSignIn: boolean,
  now = Date.now()
): TroubleCheck[] {
  const out: TroubleCheck[] = []
  const active = u.status === 'active' && !u.is_redacted
  out.push({
    key: 'account',
    ok: active,
    label: active ? 'Account active' : u.is_redacted ? 'Account redacted' : 'Account not active',
    detail: active
      ? 'Their account here may sign in.'
      : `Status is “${u.status ?? 'unknown'}”, so every sign-in is refused here even when the provider lets them in.`
  })
  out.push({
    key: 'role',
    ok: roleAllowsSignIn,
    label: roleAllowsSignIn ? 'Role may sign in' : 'Sign-in is off for their role',
    detail: roleAllowsSignIn
      ? 'Their role allows signing in to the apps.'
      : 'Their role has sign-in turned off. Change the role, or allow sign-in for it under Roles.'
  })
  const ds = String(u.directory_status ?? '').toLowerCase()
  const checked = iso(u.directory_checked_at)
  const checkedAgo = checked
    ? ` (checked ${Math.max(0, Math.round((now - new Date(checked).getTime()) / DAY))} days ago)`
    : ''
  if (ds === 'disabled' || ds === 'missing') {
    out.push({
      key: 'directory',
      ok: false,
      label: ds === 'disabled' ? 'Disabled in Microsoft' : 'Not in the Microsoft directory',
      detail:
        (ds === 'disabled'
          ? 'The directory sync found the account disabled in Microsoft'
          : 'The directory sync could not find the account in Microsoft') +
        `${checkedAgo}. Microsoft will refuse their sign-in until their IT team fixes it.`
    })
  } else if (ds) {
    out.push({
      key: 'directory',
      ok: true,
      label: 'Active in Microsoft',
      detail: `The directory sync found the account active${checkedAgo}.`
    })
  } else {
    out.push({
      key: 'directory',
      ok: null,
      label: 'Microsoft directory not checked',
      detail:
        'The directory sync has no answer for this account (it is off, or has not reached them).'
    })
  }
  if (u.account_kind) {
    out.push({
      key: 'link',
      ok: null,
      label: 'Machine account',
      detail: 'A machine account signs in with its own credential, not through a provider.'
    })
  } else if (u.external_id) {
    out.push({
      key: 'link',
      ok: true,
      label: u.entra_oid ? 'Linked to their Microsoft identity' : 'Linked to a sign-in identity',
      detail: u.entra_oid
        ? 'Sign-ins match by the provider’s subject and their Microsoft person id, not by email.'
        : 'Sign-ins match by the provider’s subject, not by email. A different sign-in that only shares the email is refused.'
    })
  } else {
    out.push({
      key: 'link',
      ok: null,
      label: 'Not linked yet',
      detail: u.email
        ? `Their first provider sign-in links the account by its email (${u.email}). A sign-in under another email creates a new account instead.`
        : 'The account has no email, so a provider sign-in cannot link to it.'
    })
  }
  return out
}

/** Pick the failure to act on: the newest one after the last successful sign-in. */
export function currentProblem(
  attempts: TroubleAttempt[],
  lastSuccessAt: string | null
): (TroubleAttempt & { since_success: boolean }) | null {
  const fails = attempts.filter((a) => a.outcome === 'failed' && a.reason)
  if (!fails.length) return null
  const newest = fails[0]
  const since = !lastSuccessAt || new Date(newest.at).getTime() > new Date(lastSuccessAt).getTime()
  return since ? { ...newest, since_success: true } : null
}

// ─── Who may read it ───────────────────────────────────────────────────────────

/**
 * `admin` = the full view; `desk` = a support-desk member (canWorkDesk: on a team an active
 * support category routes to) — same reasons and advice, no network details; null = refused.
 */
export type SignInHelpAudience = 'admin' | 'desk'

/** The rule, given whether the viewer works the desk (pure — tested on its own). */
export function audienceFor(isAdmin: boolean, worksDesk: boolean): SignInHelpAudience | null {
  if (isAdmin) return 'admin'
  return worksDesk ? 'desk' : null
}

export async function signInHelpAudience(viewer: {
  id: string
  isAdmin: boolean
}): Promise<SignInHelpAudience | null> {
  if (viewer.isAdmin) return 'admin'
  const { canWorkDesk } = await import('./support-tickets.js')
  const desk = await canWorkDesk({ id: String(viewer.id).toUpperCase(), isAdmin: false }).catch(
    () => false
  )
  return audienceFor(false, desk)
}

/**
 * Whose sign-in history the support desk may NOT read (pure): administrators and machine
 * accounts (service/integration identities). Those are for administrators only.
 */
export function deskRefusedTarget(t: {
  account_kind?: string | null
  admin_access?: unknown
}): boolean {
  return !!t.account_kind || t.admin_access === true || t.admin_access === 1
}

/**
 * True when `userId` is an administrator or a machine account. Unknown person = false (the
 * reader answers 404 for it). A lookup that fails counts as refused (fail closed).
 */
export async function isDeskRefusedTarget(userId: string): Promise<boolean> {
  try {
    const row = (await db('nivaro_users as u')
      .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.id', userId)
      .first('u.account_kind as account_kind', 'r.admin_access as admin_access')) as
      | { account_kind?: string | null; admin_access?: unknown }
      | undefined
    return row ? deskRefusedTarget(row) : false
  } catch {
    return true
  }
}

/**
 * The answer a support-desk member gets: every IP address removed. "Probably them" was already
 * decided on the server from address + browser; the browser shows only as its plain name
 * ("Chrome on Windows"), which is all `browser` ever carries.
 */
export function forAudience(
  t: SignInTroubleshooter,
  audience: SignInHelpAudience
): SignInTroubleshooter {
  if (audience === 'admin') return t
  const strip = <A extends { ip: string | null }>(a: A): A => ({ ...a, ip: null })
  return {
    ...t,
    last_success: t.last_success ? strip(t.last_success) : null,
    attempts: t.attempts.map((a) => {
      const { new_ip: _n, ...rest } = strip(a)
      return rest
    }),
    current: t.current
      ? (() => {
          const { new_ip: _n, ...rest } = strip(t.current)
          return rest
        })()
      : null
  }
}

export async function readSignInTroubleshooter(
  redis: Redis | null | undefined,
  userId: string,
  now = Date.now()
): Promise<SignInTroubleshooter | null> {
  const { hasColumn } = await import('../lib/column-probe.js')
  const [hasDir, hasOid] = await Promise.all([
    hasColumn('nivaro_users', 'directory_status'),
    hasColumn('nivaro_users', 'entra_oid')
  ])
  const u = (await db('nivaro_users')
    .where({ id: userId })
    .first(
      'id',
      'email',
      'status',
      'is_redacted',
      'role',
      'account_kind',
      'external_id',
      ...(hasOid ? ['entra_oid'] : []),
      ...(hasDir ? ['directory_status', 'directory_checked_at'] : [])
    )) as Record<string, unknown> | undefined
  if (!u) return null
  const id = String(u.id)
  const since = new Date(now - WINDOW_DAYS * DAY)
  const { signInAllowedByRole } = await import('../auth/role-sign-in.js')

  const [roleOk, successes, knownRows, named, legacy, apps, phones] = await Promise.all([
    signInAllowedByRole(u as { role: string | null; account_kind?: string | null }).catch(
      () => true
    ),
    db('nivaro_login_events')
      .where('user', id)
      .where('created_at', '>=', since)
      .whereNot('method', 'masquerade')
      .orderBy('id', 'desc')
      .limit(SUCCESS_CAP)
      .select('id', 'created_at', 'method', 'ip', 'user_agent', 'new_ip')
      .catch(() => [] as Array<Record<string, unknown>>) as Promise<Array<Record<string, unknown>>>,
    // The browsers they signed in from (90 days): an unnamed failure from one is "probably them".
    db('nivaro_login_events')
      .where('user', id)
      .where('created_at', '>=', new Date(now - KNOWN_BROWSER_DAYS * DAY))
      .whereNot('method', 'masquerade')
      .distinct('ip', 'user_agent')
      .limit(200)
      .catch(() => [] as Array<Record<string, unknown>>) as Promise<Array<Record<string, unknown>>>,
    // Rows about this account: (collection, item, timestamp) index.
    db('nivaro_activity')
      .where('collection', 'nivaro_users')
      .where('item', id)
      .whereIn('action', ['sign-in-failed', 'device-revoked', 'login-refused'])
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(FAIL_CAP)
      .select('id', 'action', 'timestamp', 'comment', 'ip', 'user_agent')
      .catch(() => [] as Array<Record<string, unknown>>) as Promise<Array<Record<string, unknown>>>,
    // Older refusals written with the person as the actor (user, timestamp index).
    db('nivaro_activity')
      .where('user', id)
      .where('action', 'login-refused')
      .where('timestamp', '>=', since)
      .orderBy('timestamp', 'desc')
      .limit(FAIL_CAP)
      .select('id', 'action', 'timestamp', 'comment', 'ip', 'user_agent')
      .catch(() => [] as Array<Record<string, unknown>>) as Promise<Array<Record<string, unknown>>>,
    redis
      ? redis.hgetall(appKey(id)).catch(() => ({}) as Record<string, string>)
      : Promise.resolve({} as Record<string, string>),
    redis ? listDeviceGrants(redis, id).catch(() => []) : Promise.resolve([])
  ])

  const known = new Set<string>()
  const knownIps: string[] = []
  for (const r of knownRows) {
    const k = browserKey(r.ip, r.user_agent)
    if (k) known.add(k)
    if (r.ip && !knownIps.includes(String(r.ip))) knownIps.push(String(r.ip))
  }
  // Failures nobody could name, from an address they signed in from; the browser is compared below.
  const unnamed = knownIps.length
    ? ((await db('nivaro_activity')
        .where('collection', 'nivaro_users')
        .where('action', 'sign-in-failed')
        .where('timestamp', '>=', since)
        .whereNull('item')
        .whereIn('ip', knownIps.slice(0, 100))
        .orderBy('timestamp', 'desc')
        .limit(FAIL_CAP)
        .select('id', 'action', 'timestamp', 'comment', 'ip', 'user_agent')
        .catch(() => [])) as Array<Record<string, unknown>>)
    : []

  const attempts: TroubleAttempt[] = []
  const seen = new Set<string>()
  const pushRow = (r: Record<string, unknown>, match: 'named' | 'browser') => {
    const key = `a:${r.id}`
    if (seen.has(key)) return
    seen.add(key)
    const action = String(r.action ?? '')
    const at = iso(r.timestamp)
    if (!at) return
    if (action === 'sign-in-failed') {
      const c = decodeFailureComment(r.comment)
      attempts.push({
        id: key,
        at,
        outcome: 'failed',
        ...reasonFields(c.reason),
        method: c.method,
        app: c.app,
        code: c.code,
        match,
        browser: describeAgent(r.user_agent),
        ip: (r.ip as string | null) ?? null
      })
      return
    }
    const reason = reasonFromLegacyRow(action, r.comment)
    const device = action === 'device-revoked'
    attempts.push({
      id: key,
      at,
      outcome: device ? 'ended' : 'failed',
      ...reasonFields(reason),
      // A phone row's sentence names the phone and why ("… on Pat's iPhone: signed out everywhere").
      explain:
        device && r.comment
          ? String(r.comment).replace(/\s*\(admin_id [^)]*\)/, '')
          : SIGN_IN_REASONS[reason].explain,
      method: device ? 'phone' : null,
      app: device ? 'phone' : null,
      code: null,
      match,
      browser: describeAgent(r.user_agent),
      ip: (r.ip as string | null) ?? null
    })
  }
  for (const r of [...named, ...legacy]) pushRow(r, 'named')
  for (const r of unnamed) if (isKnownBrowser(known, r.ip, r.user_agent)) pushRow(r, 'browser')
  for (const s of successes) {
    const at = iso(s.created_at)
    if (!at) continue
    attempts.push({
      id: `s:${s.id}`,
      at,
      outcome: 'signed_in',
      reason: null,
      label: 'Signed in',
      explain: null,
      todo: null,
      owner: null,
      method: String(s.method ?? '') || null,
      app: null,
      code: null,
      match: 'named',
      browser: describeAgent(s.user_agent),
      ip: (s.ip as string | null) ?? null,
      new_ip: !!s.new_ip
    })
  }
  attempts.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))

  const counts = new Map<SignInReason, { n: number; last_at: string }>()
  for (const a of attempts) {
    if (a.outcome !== 'failed' || !a.reason) continue
    const g = counts.get(a.reason)
    if (g) g.n++
    else counts.set(a.reason, { n: 1, last_at: a.at })
  }
  const appList = Object.entries(apps ?? {})
    .map(([app, at]) => ({ app, at: iso(at) ?? '' }))
    .filter((a) => a.at)
    .sort((a, b) => (a.at < b.at ? 1 : -1))
  const top = successes[0]
  const lastSuccess = top
    ? {
        at: iso(top.created_at) ?? '',
        method: String(top.method ?? ''),
        browser: describeAgent(top.user_agent),
        ip: (top.ip as string | null) ?? null,
        // The app noted within a minute of that sign-in, when there is one.
        app:
          appList.find(
            (a) =>
              Math.abs(new Date(a.at).getTime() - new Date(iso(top.created_at) ?? 0).getTime()) <
              60_000
          )?.app ?? null
      }
    : null

  return {
    window_days: WINDOW_DAYS,
    checks: accountChecks(
      {
        status: u.status as string | null,
        is_redacted: u.is_redacted,
        account_kind: u.account_kind as string | null,
        external_id: u.external_id as string | null,
        entra_oid: (u.entra_oid as string | null) ?? null,
        email: u.email as string | null,
        directory_status: (u.directory_status as string | null) ?? null,
        directory_checked_at: u.directory_checked_at
      },
      roleOk,
      now
    ),
    last_success: lastSuccess,
    apps: appList,
    phones: phones.map((g) => ({
      name: `${g.client_name}${g.device_name ? ` on ${g.device_name}` : ''}`,
      platform: g.platform ?? null,
      last_used_at: iso(g.last_used_at)
    })),
    attempts: attempts.slice(0, 120),
    by_reason: [...counts.entries()]
      .map(([reason, g]) => ({ reason, label: SIGN_IN_REASONS[reason].label, ...g }))
      .sort((a, b) => b.n - a.n),
    current: currentProblem(attempts, lastSuccess?.at ?? null)
  }
}

/**
 * Requests made as the person that the API refused for their credential (401) or access (403)
 * — the Traffic Map's per-caller `auth_failures`, for one person. Reads the request log WITH
 * (NOLOCK) over at most 7 days (it keeps 14).
 */
export async function readSignInRefusals(
  userId: string,
  days = 7,
  now = Date.now()
): Promise<
  Array<{ code: string; status: number; message: string | null; n: number; last_at: string }>
> {
  const since = new Date(now - Math.min(14, Math.max(1, days)) * DAY)
  const rows = (await apiLogSource(db)
    .where('created_at', '>=', since)
    .where('user', userId)
    .whereIn('status', [401, 403])
    .orderBy('created_at', 'desc')
    .limit(500)
    .select('created_at', 'status', 'error')) as Array<Record<string, unknown>>
  const groups = new Map<
    string,
    { code: string; status: number; message: string | null; n: number; last_at: string }
  >()
  for (const r of rows) {
    const status = Number(r.status)
    const p = parseRefusal(r.error, status)
    const g = groups.get(p.code)
    if (g) g.n++
    else
      groups.set(p.code, {
        code: p.code,
        status,
        message: p.message,
        n: 1,
        last_at: iso(r.created_at) ?? ''
      })
  }
  return [...groups.values()].sort((a, b) => b.n - a.n)
}
