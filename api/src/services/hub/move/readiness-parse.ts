import type {
  SharedReadiness,
  SharedReadinessCode,
  SharedReadinessItem
} from '../../hub-link/shared-readiness.js'
import { parseObjectCounts } from '../../hub-transfer/copyable.js'

/**
 * The ONE reader of an app's hub-link shared-readiness report (R2-M-9): the plan's gather and the
 * move's hub-link client (sourceBusy, the target's database identity) both parse it here, so a
 * report one of them refuses is never read as "idle, nothing to lose" by the other. Pure.
 */

const READINESS_CODES: Record<SharedReadinessCode, true> = {
  ISSUE_TRACKERS: true,
  EXEC_SCRIPT_FLOWS: true,
  SQLITE: true,
  ENV_OBJECT_STORAGE: true,
  HUDDLE_TURN: true,
  ENV_SMTP: true,
  SESSION_REPLAYS: true,
  HELP_VIDEO_RENDERS: true,
  DIRECTORY_ENV_CREDENTIALS: true,
  TEAMS_BOT_ENV_CREDENTIALS: true,
  PUSH_RELAY_ENV: true,
  // Older apps (before 0.3.212) still send these: kept known, so their report stays readable;
  // the plan decides by the target's version (plan.ts SHARED_FEATURES_SINCE).
  STAGED_IMPORTS: true,
  ROW_SCHEDULES: true,
  DIRECTORY_SYNC: true,
  PHONE_PUSH: true,
  TEAMS_BOT: true,
  MAIL_RETRY: true
}

export const isObj = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v)
export const num = (v: unknown) =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null
export const shortStr = (v: unknown, max: number) =>
  typeof v === 'string' && v.length <= max ? v : null

/**
 * The report checked for shape; null when it is not one. A code this Hub does not know at level
 * `blocker` makes the whole report unreadable: an app newer than the Hub may report something a
 * shared deployment would lose, and the Hub must not read that as nothing (fails closed). An
 * unknown warning is dropped.
 */
export function parseReadiness(raw: unknown): SharedReadiness | null {
  if (!isObj(raw) || !Array.isArray(raw.codes) || raw.codes.length > 50) return null
  const codes: SharedReadinessItem[] = []
  for (const c of raw.codes) {
    if (!isObj(c) || typeof c.code !== 'string') return null
    if (c.level !== 'blocker' && c.level !== 'warning') return null
    if (!Object.hasOwn(READINESS_CODES, c.code)) {
      if (c.level === 'blocker') return null
      continue
    }
    const detail = typeof c.detail === 'string' ? c.detail.slice(0, 300) : ''
    codes.push({ code: c.code as SharedReadinessCode, level: c.level, detail })
  }
  const fp = raw.key_fp
  if (fp !== null && (typeof fp !== 'string' || !/^[0-9a-f]{32}$/.test(fp))) return null
  let oidc: SharedReadiness['oidc'] = null
  if (raw.oidc !== null && raw.oidc !== undefined) {
    if (!isObj(raw.oidc)) return null
    const host = shortStr(raw.oidc.issuer_host, 253)
    const rawTenant = raw.oidc.tenant
    const absent = rawTenant === null || rawTenant === undefined
    const tenant = absent ? null : shortStr(rawTenant, 128)
    // A tenant that is there but malformed rejects the report (never "no tenant", M-7).
    if (!host || (!absent && tenant === null)) return null
    oidc = { issuer_host: host, tenant }
  }
  const identity = raw.db_identity === null ? null : shortStr(raw.db_identity, 600)
  if (identity === undefined || (raw.db_identity !== null && identity === null)) return null
  const busy = isObj(raw.busy) ? raw.busy : null
  const files = isObj(raw.files) ? raw.files : null
  const version = shortStr(raw.version, 64)
  if (!busy || !files || !version) return null
  const b = { imports: num(busy.imports), exports: num(busy.exports), renders: num(busy.renders) }
  const f = { count: num(files.count), bytes: num(files.bytes), local: num(files.local) }
  if (Object.values(b).includes(null) || Object.values(f).includes(null)) return null
  const extensions: Record<string, string> = {}
  if (raw.extensions !== undefined && raw.extensions !== null) {
    if (!isObj(raw.extensions)) return null
    for (const [id, v] of Object.entries(raw.extensions)) {
      if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || typeof v !== 'string' || v.length > 64)
        return null
      extensions[id] = v
    }
  }
  return {
    codes,
    key_fp: fp as string | null,
    oidc,
    signin_hub: raw.signin_hub === true,
    db_identity: identity,
    busy: b as SharedReadiness['busy'],
    files: { ...(f as SharedReadiness['files']), objects: parseObjectCounts(files.objects) },
    version,
    extensions
  }
}
