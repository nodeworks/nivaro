/**
 * Session policy (#665) — max age and idle timeout for signed-in browser
 * sessions, set in Settings → Sign-in providers, optionally per role.
 *
 * The store's own TTL (SESSION_TTL env, rolled on every request) stays the
 * outer bound; this policy can only shorten a session. A role entry beats the
 * default entry field by field, so a role that sets only an idle timeout keeps
 * the default max age.
 *
 * The session carries two stamps: `loginAt` (the first request it was seen
 * on — sessions that predate this feature start their clock then) and
 * `lastSeenAt` (every authenticated request). API keys, static tokens and
 * masquerade tokens are not sessions and are never judged here.
 */
import { db } from '../db/index.js'
import { hasColumn } from '../lib/column-probe.js'

export interface SessionLimits {
  max_age_hours: number | null
  idle_minutes: number | null
}

export interface SessionPolicy extends Partial<SessionLimits> {
  roles?: Record<string, Partial<SessionLimits>>
}

const MAX_AGE_HOURS = 24 * 90
const MAX_IDLE_MINUTES = 60 * 24 * 30

function limitOrNull(raw: unknown, max: number): number | null {
  if (raw == null || raw === '') return null
  const n = Number(raw)
  if (!Number.isFinite(n) || n <= 0) return null
  return Math.min(Math.round(n), max)
}

/** Lenient read of whatever is stored (bad entries dropped, never thrown). */
export function parseSessionPolicy(raw: unknown): SessionPolicy | null {
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return null
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return null
  const o = v as Record<string, unknown>
  const out: SessionPolicy = {
    max_age_hours: limitOrNull(o.max_age_hours, MAX_AGE_HOURS),
    idle_minutes: limitOrNull(o.idle_minutes, MAX_IDLE_MINUTES)
  }
  const roles = o.roles && typeof o.roles === 'object' ? (o.roles as Record<string, unknown>) : {}
  const r: Record<string, Partial<SessionLimits>> = {}
  for (const [roleId, entry] of Object.entries(roles)) {
    if (!entry || typeof entry !== 'object') continue
    const e = entry as Record<string, unknown>
    const limits = {
      max_age_hours: limitOrNull(e.max_age_hours, MAX_AGE_HOURS),
      idle_minutes: limitOrNull(e.idle_minutes, MAX_IDLE_MINUTES)
    }
    if (limits.max_age_hours != null || limits.idle_minutes != null)
      r[roleId.toUpperCase()] = limits
  }
  if (Object.keys(r).length) out.roles = r
  return out
}

/** Strict check for the settings PATCH: returns an error sentence or null. */
export function validateSessionPolicy(raw: unknown): string | null {
  if (raw == null || raw === '') return null
  let v: unknown = raw
  if (typeof v === 'string') {
    try {
      v = JSON.parse(v)
    } catch {
      return 'session_policy must be JSON'
    }
  }
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'session_policy must be an object'
  const check = (label: string, e: Record<string, unknown>): string | null => {
    for (const [k, max, unit] of [
      ['max_age_hours', MAX_AGE_HOURS, 'hours'],
      ['idle_minutes', MAX_IDLE_MINUTES, 'minutes']
    ] as const) {
      const x = e[k]
      if (x == null || x === '') continue
      const n = Number(x)
      if (!Number.isInteger(n) || n < 1 || n > max)
        return `${label} ${k} must be a whole number of ${unit} from 1 to ${max}`
    }
    return null
  }
  const o = v as Record<string, unknown>
  const top = check('Default', o)
  if (top) return top
  if (o.roles != null) {
    if (typeof o.roles !== 'object' || Array.isArray(o.roles)) return 'roles must be an object'
    for (const [roleId, entry] of Object.entries(o.roles as Record<string, unknown>)) {
      if (!/^[0-9a-f-]{36}$/i.test(roleId)) return `Role key ${roleId} is not a role id`
      if (!entry || typeof entry !== 'object') return `Role ${roleId} entry must be an object`
      const e = check('Role', entry as Record<string, unknown>)
      if (e) return e
    }
  }
  return null
}

/** The limits that apply to one role: the role entry beats the default. */
export function limitsFor(
  policy: SessionPolicy | null,
  roleId: string | null | undefined
): SessionLimits {
  const role = roleId ? policy?.roles?.[String(roleId).toUpperCase()] : undefined
  return {
    max_age_hours: role?.max_age_hours ?? policy?.max_age_hours ?? null,
    idle_minutes: role?.idle_minutes ?? policy?.idle_minutes ?? null
  }
}

export type SessionVerdict = { ok: true } | { ok: false; reason: 'max_age' | 'idle' }

/** Pure judgement over the two stamps. A missing stamp never expires a session. */
export function judgeSession(
  limits: SessionLimits,
  stamps: { loginAt?: number; lastSeenAt?: number },
  now: number
): SessionVerdict {
  if (
    limits.max_age_hours != null &&
    stamps.loginAt &&
    now - stamps.loginAt > limits.max_age_hours * 3_600_000
  )
    return { ok: false, reason: 'max_age' }
  if (
    limits.idle_minutes != null &&
    stamps.lastSeenAt &&
    now - stamps.lastSeenAt > limits.idle_minutes * 60_000
  )
    return { ok: false, reason: 'idle' }
  return { ok: true }
}

let cache: { at: number; value: SessionPolicy | null } | null = null
const TTL_MS = 60_000

export function bustSessionPolicy(): void {
  cache = null
}

export async function getSessionPolicy(): Promise<SessionPolicy | null> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value
  let value: SessionPolicy | null = null
  try {
    if (await hasColumn('nivaro_settings', 'session_policy')) {
      const row = await db('nivaro_settings').where({ id: 1 }).first('session_policy')
      value = parseSessionPolicy(row?.session_policy)
    }
  } catch {
    value = cache?.value ?? null
  }
  cache = { at: Date.now(), value }
  return value
}
