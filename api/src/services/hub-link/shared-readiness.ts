import type { Knex } from 'knex'
import { config } from '../../config.js'
import { db } from '../../db/index.js'
import { rawRows } from '../../db/raw-rows.js'
import { NIVARO_VERSION } from '../../version.js'
import { APP_KEY_RE, keyFingerprint } from '../app-key-fingerprint.js'
import {
  DB_IDENTITY_DEFAULT_PORT,
  type DbIdentityEngine,
  dbIdentitySql,
  formatDbIdentity,
  oidcIdentity
} from '../db-identity.js'
import { objectStorageCounts } from '../hub-transfer/object-counts.js'

/**
 * Nivaro Hub phase 6 (Decision 12): what this dedicated app would lose on a Hub shared deployment,
 * read over its hub link (GET /api/hub-link/shared-readiness) when the Hub plans a move. A closed
 * list of codes; the move plan turns blockers into refusals and warnings into notes.
 *
 * Every detail is counts and kinds ("3 scheduled reports, 1 retention policy"), never record
 * content, names, hosts or settings values. The other facts are what the plan compares: the
 * encryption key's fingerprint (never the key), the sign-in issuer host + Entra tenant, whether
 * this app signs in through the Hub, the database identity (ruling R2), busy work, files, the
 * version and the loaded extensions.
 *
 * A blocker whose check cannot be read is reported as that blocker ("could not be checked"):
 * an unreadable check must never read as "nothing to lose". A warning that cannot be read is
 * left out.
 *
 * Shared features (0.3.212): staged imports, row schedules, directory sync, the Teams bot, phone
 * push and mail retry run per app on a shared deployment, so this version no longer reports
 * STAGED_IMPORTS, ROW_SCHEDULES, DIRECTORY_SYNC, TEAMS_BOT, PHONE_PUSH or MAIL_RETRY. They stay in
 * the type because older apps still send them; the Hub's plan decides by the target's version
 * (services/hub/move/plan.ts SHARED_FEATURES_SINCE). What a shared app must bring itself is
 * warned instead: the server's own Microsoft app registration, Teams bot or push relay key, and
 * any NIVARO_SETTINGS_OVERRIDES key a shared deployment does not apply (SETTINGS_ENV_OVERRIDES).
 *
 * GitLab issue sync (0.3.215) runs per app on a shared deployment too: ISSUE_TRACKERS is sent as
 * a warning now (sync is on, and whether the server's ISSUE_TRACKERS switch is what turns it on,
 * which a shared deployment does not apply). The Hub still blocks it for a target before 0.3.215
 * (plan.ts SHARED_TRACKERS_SINCE); an older Hub reads the code as a blocker whatever its level.
 */

export type SharedReadinessCode =
  | 'ISSUE_TRACKERS'
  | 'EXEC_SCRIPT_FLOWS'
  | 'SQLITE'
  | 'ENV_OBJECT_STORAGE'
  | 'HUDDLE_TURN'
  | 'ENV_SMTP'
  | 'SESSION_REPLAYS'
  | 'HELP_VIDEO_RENDERS'
  | 'DIRECTORY_ENV_CREDENTIALS'
  | 'TEAMS_BOT_ENV_CREDENTIALS'
  | 'PUSH_RELAY_ENV'
  | 'SETTINGS_ENV_OVERRIDES'
  // Sent only by apps before 0.3.212 (blockers there: the first two).
  | 'STAGED_IMPORTS'
  | 'ROW_SCHEDULES'
  | 'DIRECTORY_SYNC'
  | 'PHONE_PUSH'
  | 'TEAMS_BOT'
  | 'MAIL_RETRY'

/** Ruling R1 adds ENV_OBJECT_STORAGE: objects under an env-driven S3/Azure provider are never
 *  pulled by a move (only `local` rows), so they would be lost. */
export const SHARED_READINESS_BLOCKERS: readonly SharedReadinessCode[] = [
  'EXEC_SCRIPT_FLOWS',
  'SQLITE',
  'ENV_OBJECT_STORAGE'
]

export interface SharedReadinessItem {
  code: SharedReadinessCode
  level: 'blocker' | 'warning'
  detail: string
}

export interface SharedReadiness {
  codes: SharedReadinessItem[]
  key_fp: string | null
  oidc: { issuer_host: string; tenant: string | null } | null
  signin_hub: boolean
  /** `engine|server|port|database`, lower case (ruling R2); null when it cannot be read. */
  db_identity: string | null
  busy: { imports: number; exports: number; renders: number }
  /** objects (P6-31): rows per non-local provider; absent from older apps (= unknown). */
  files: { count: number; bytes: number; local: number; objects?: Record<string, number> }
  version: string
  extensions: Record<string, string>
}

const COULD_NOT_CHECK = 'Could not be checked.'

const num = (v: unknown): number => {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}

/** "1 scheduled report" / "3 scheduled reports". */
function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

async function hasTable(table: string): Promise<boolean> {
  return db.schema.hasTable(table)
}

/** COUNT(*) of `q` on `table`; 0 when the table does not exist (an app behind that migration). */
async function countIf(
  table: string,
  q: (k: Knex.QueryBuilder) => Knex.QueryBuilder = (k) => k
): Promise<number> {
  if (!(await hasTable(table))) return 0
  const row = (await q(db(table)).count({ n: '*' }).first()) as { n?: unknown } | undefined
  return num(row?.n)
}

// ─── Blockers ────────────────────────────────────────────────────────────────────────────

/**
 * GitLab sync with connections (a warning since 0.3.215; the Hub blocks a target before it). On a
 * shared deployment the server's ISSUE_TRACKERS is not applied and the app's own stored switch
 * (under this process's instance key) decides, so the detail says what changes:
 *   - on only by the server's ISSUE_TRACKERS=on: switch it on again after the move;
 *   - off only by the server's ISSUE_TRACKERS=off while its own switch is on: sync would START
 *     after the move and write to the real GitLab projects (review I-2): store its switch off first;
 *   - on by its own switch under a custom NIVARO_INSTANCE: a target with another instance key
 *     reads the switch as off (review m-6).
 */
async function issueTrackers(): Promise<string | null> {
  const { storedTrackersSwitch, trackersFeature } = await import('../trackers/feature.js')
  const { perAppJobs } = await import('../deployment-mode.js')
  const f = await trackersFeature()
  const envDecides = f.source === 'env' && !perAppJobs()
  const startsAfter = envDecides && !f.enabled && (await storedTrackersSwitch()) === true
  if (!f.enabled && !startsAfter) return null
  const n = await countIf('nivaro_tracker_connections')
  if (n === 0) return null
  const conns = plural(n, 'connection', 'connections')
  if (startsAfter)
    return `GitLab issue sync is off only by the server's ISSUE_TRACKERS=off and its own switch is on, so on the shared deployment it starts syncing ${conns} to GitLab. Store its switch off first (PUT /api/trackers/feature {"enabled": false} is allowed while the server keeps it off)`
  const on = `GitLab issue sync is on with ${conns}`
  if (envDecides)
    return `${on}, switched on by the server's ISSUE_TRACKERS setting; switch it on again on the Issue trackers tab after the move`
  const { instanceKey } = await import('../instance-key.js')
  const key = instanceKey()
  return !perAppJobs() && key !== 'production'
    ? `${on}; its switch is stored for instance '${key.slice(0, 40)}', so a deployment with another NIVARO_INSTANCE reads it as off: switch it on again after the move if so`
    : on
}

async function execScriptFlows(): Promise<string | null> {
  if (!(await hasTable('nivaro_flow_operations')) || !(await hasTable('nivaro_flows'))) return null
  const row = (await db('nivaro_flow_operations as o')
    .join('nivaro_flows as f', 'f.id', 'o.flow')
    .where('o.type', 'exec-script')
    .where('f.status', 'active')
    .countDistinct({ n: 'o.flow' })
    .first()) as { n?: unknown } | undefined
  const n = num(row?.n)
  return n > 0 ? `${plural(n, 'active flow runs', 'active flows run')} a script step` : null
}

function sqlite(): string | null {
  return config.DB_CLIENT === 'sqlite'
    ? "This app's database is SQLite, a file on its own server"
    : null
}

function envObjectStorage(): string | null {
  const p = (process.env.STORAGE_PROVIDER ?? 'local').trim().toLowerCase() || 'local'
  return p === 'local'
    ? null
    : `Files are stored by the server's ${p === 's3' ? 'S3' : p === 'azure' ? 'Azure' : 'object'} storage setting; a move copies only files on local storage`
}

// ─── Warnings ────────────────────────────────────────────────────────────────────────────
// A detail follows its title in the move plan ("<title>: <detail>", the title saying how it is on
// a shared deployment), so it says what THIS app does today, never "… is on" (E2E B M1).

const DIRECTORY_GRAPH_COLUMNS = [
  'directory_graph_tenant_id',
  'directory_graph_client_id',
  'directory_graph_client_secret'
] as const

/**
 * Directory sync on with the server's own Microsoft app registration (env GRAPH_*, else the OIDC
 * sign-in app: graph-directory.ts credentials() everywhere but shared) and no complete one saved
 * in Settings (migration 554): on a shared deployment the app reads only its saved one.
 */
async function directoryEnvCredentials(): Promise<string | null> {
  if (!(await db.schema.hasColumn('nivaro_settings', 'directory_sync_enabled'))) return null
  const { envGraphCredentials } = await import('../graph-directory.js')
  const env = envGraphCredentials()
  if (!env.tenant || !env.clientId || !env.secret) return null
  const saved: string[] = []
  for (const col of DIRECTORY_GRAPH_COLUMNS)
    if (await db.schema.hasColumn('nivaro_settings', col)) saved.push(col)
  const row = (await db('nivaro_settings')
    .orderBy('id', 'asc')
    .first('directory_sync_enabled', ...saved)) as Record<string, unknown> | undefined
  if (!row?.directory_sync_enabled) return null
  const complete =
    saved.length === DIRECTORY_GRAPH_COLUMNS.length &&
    saved.every((c) => typeof row[c] === 'string' && (row[c] as string).trim() !== '')
  return complete
    ? null
    : "This app reads the directory with the server's Microsoft app; save its own app registration in Settings before the move"
}

/**
 * The bot is on with an env family (TEAMS_BOT_* / MICROSOFT_APP_*) or the sign-in app, or its
 * saved bot is on only through env TEAMS_BOT=on (its own saved switch is not): on a shared
 * deployment an app's bot is only the one it saved in Settings, switched on by its own switch
 * (teams-bot/config.ts ignores TEAMS_BOT=on there).
 */
async function teamsBotEnvCredentials(): Promise<string | null> {
  const { getTeamsBotConfig } = await import('../teams-bot/config.js')
  const c = await getTeamsBotConfig()
  if (!c.enabled) return null
  const detail =
    "This app's bot is set by the server environment; save the bot in Settings before the move"
  if (c.source === 'env' || c.source === 'sign_in_app') return detail
  if ((process.env.TEAMS_BOT ?? '').trim().toLowerCase() !== 'on') return null
  if (!(await db.schema.hasColumn('nivaro_settings', 'teams_bot_enabled'))) return detail
  const row = (await db('nivaro_settings').orderBy('id', 'asc').first('teams_bot_enabled')) as
    | { teams_bot_enabled?: unknown }
    | undefined
  const savedOn = row?.teams_bot_enabled === true || row?.teams_bot_enabled === 1
  return savedOn ? null : detail
}

/** Phones on the relay sent with the env relay key (it beats a stored one): on a shared
 *  deployment the env key is never read, so the app connects its own relay. A phone on the app's
 *  own Expo build (`expo:`) is sent to Expo directly, without the relay. */
async function pushRelayEnv(): Promise<string | null> {
  const { envRelayKey, RELAY_PREFIX } = await import('../push-relay.js')
  if (!envRelayKey()) return null
  const n = await countIf('nivaro_push_subscriptions', (q) =>
    q.where('endpoint', 'like', `${RELAY_PREFIX}%`)
  )
  return n > 0
    ? "Phones get alerts through the server's relay key; connect this app's own relay in Settings after the move"
    : null
}

/** NIVARO_SETTINGS_OVERRIDES keys this app uses that a shared deployment never applies (there it
 *  is the deployment's, so only its test switches and environment label apply). Names only. */
async function settingsEnvOverrides(): Promise<string | null> {
  const { perAppJobs } = await import('../deployment-mode.js')
  if (perAppJobs()) return null // already on shared: these keys are not used here either
  const { envKeyAppliesOnShared, envOverrideKeys } = await import('../settings-overrides.js')
  const lost = envOverrideKeys()
    .filter((k) => !envKeyAppliesOnShared(k))
    .sort()
  if (lost.length === 0) return null
  const shown = lost.slice(0, 6).join(', ')
  const more = lost.length > 6 ? ` and ${lost.length - 6} more` : ''
  return `NIVARO_SETTINGS_OVERRIDES sets ${shown}${more}; a shared deployment does not apply them`
}

async function huddleTurn(): Promise<string | null> {
  const { getHuddleSettings, sfuConfigured } = await import('../huddle-settings.js')
  const s = await getHuddleSettings()
  const parts = [
    s.turn_urls.length > 0 && plural(s.turn_urls.length, 'TURN server', 'TURN servers'),
    sfuConfigured(s) && 'a media server'
  ].filter(Boolean)
  return parts.length ? `Huddles use ${parts.join(' and ')} set for this app` : null
}

async function envSmtp(): Promise<string | null> {
  if (!(process.env.SMTP_HOST ?? '').trim()) return null
  const row = (await db('nivaro_settings').first('smtp_host')) as
    | { smtp_host?: unknown }
    | undefined
  return String(row?.smtp_host ?? '').trim()
    ? null
    : "Mail is sent with the server's SMTP setting, not one saved in Settings"
}

async function sessionReplays(): Promise<string | null> {
  const n = await countIf('nivaro_session_recordings')
  return n > 0 ? `${plural(n, 'session replay stays', 'session replays stay')} behind` : null
}

async function helpVideoRenders(): Promise<string | null> {
  const n = await countIf('nivaro_help_videos')
  return n > 0
    ? `${plural(n, 'help video', 'help videos')}; a render waiting at a restart is redone on the next publish`
    : null
}

const CHECKS: Array<[SharedReadinessCode, () => Promise<string | null> | string | null]> = [
  ['ISSUE_TRACKERS', issueTrackers],
  ['EXEC_SCRIPT_FLOWS', execScriptFlows],
  ['SQLITE', sqlite],
  ['ENV_OBJECT_STORAGE', envObjectStorage],
  ['DIRECTORY_ENV_CREDENTIALS', directoryEnvCredentials],
  ['TEAMS_BOT_ENV_CREDENTIALS', teamsBotEnvCredentials],
  ['PUSH_RELAY_ENV', pushRelayEnv],
  ['SETTINGS_ENV_OVERRIDES', settingsEnvOverrides],
  ['HUDDLE_TURN', huddleTurn],
  ['ENV_SMTP', envSmtp],
  ['SESSION_REPLAYS', sessionReplays],
  ['HELP_VIDEO_RENDERS', helpVideoRenders]
]

async function codes(): Promise<SharedReadinessItem[]> {
  const results = await Promise.all(
    CHECKS.map(async ([code, check]) => {
      const level = SHARED_READINESS_BLOCKERS.includes(code) ? 'blocker' : 'warning'
      try {
        const detail = await check()
        return detail ? { code, level, detail } : null
      } catch {
        return level === 'blocker' ? { code, level, detail: COULD_NOT_CHECK } : null
      }
    })
  )
  return results.filter((r): r is SharedReadinessItem => r !== null)
}

// ─── Facts the move plan compares ─────────────────────────────────────────────────────────

function keyFp(): string | null {
  const k = (process.env.ENCRYPTION_KEY ?? '').trim()
  return APP_KEY_RE.test(k) ? keyFingerprint(k) : null
}

/** The sign-in issuer as the Hub compares it (Decision 13): services/db-identity.ts. */
export { oidcIdentity }

async function signinHub(): Promise<boolean> {
  try {
    const { hubSigninConfig } = await import('../hub-signin/config.js')
    return hubSigninConfig() !== null
  } catch {
    return false
  }
}

async function dbIdentity(): Promise<string | null> {
  const engine = config.DB_MARIADB ? 'mariadb' : String(config.DB_CLIENT)
  // Which server and database the app's own connection really reached: services/db-identity.ts.
  const sql = dbIdentitySql(engine)
  if (!sql) return null // SQLite: a file, no server identity
  try {
    const [r] = rawRows<{ s: unknown; p: unknown; d: unknown }>(await db.raw(sql))
    return formatDbIdentity(engine, r, {
      server: String(config.DB_HOST ?? ''),
      port: config.DB_PORT ?? DB_IDENTITY_DEFAULT_PORT[engine as DbIdentityEngine] ?? null,
      database: String(config.DB_DATABASE ?? '')
    })
  } catch {
    return null
  }
}

/** Work in flight that a move must wait out (the same choices as the deployment link status).
 *  A read error throws (the route answers 503): a report that cannot see work must not say
 *  "idle". */
async function busyCounts(): Promise<SharedReadiness['busy']> {
  const [imports, exports, renders] = await Promise.all([
    countIf('nivaro_import_jobs', (q) => q.whereIn('status', ['pending', 'processing'])),
    // services/export-runs.ts EXPORT_JOB_PREFIX
    countIf('nivaro_job_runs', (q) =>
      q.where('status', 'running').where('job_id', 'like', 'bg-export:%')
    ),
    countIf('nivaro_help_video_versions', (q) =>
      q.whereIn('render_status', ['queued', 'rendering'])
    )
  ])
  return { imports, exports, renders }
}

async function fileCounts(): Promise<SharedReadiness['files']> {
  if (!(await hasTable('nivaro_files'))) return { count: 0, bytes: 0, local: 0 }
  const all = (await db('nivaro_files').count({ n: '*' }).sum({ b: 'filesize' }).first()) as
    | { n?: unknown; b?: unknown }
    | undefined
  // Objects on the env-driven provider (a null provider is a row from before the column).
  const local = (await db('nivaro_files')
    .where((q) => q.whereNull('storage_provider').orWhere('storage_provider', 'local'))
    .count({ n: '*' })
    .first()) as { n?: unknown } | undefined
  const objects = await objectStorageCounts()
  return {
    count: num(all?.n),
    bytes: num(all?.b),
    local: num(local?.n),
    ...(objects ? { objects } : {})
  }
}

async function loadedExtensions(): Promise<Record<string, string>> {
  try {
    const { extensionRegistry } = await import('../../extensions/loader.js')
    const out: Record<string, string> = {}
    for (const [id, e] of extensionRegistry) {
      if (e.status === 'loaded' && e.enabled) out[id] = e.manifest?.version ?? ''
    }
    return out
  } catch {
    return {}
  }
}

export async function computeSharedReadiness(): Promise<SharedReadiness> {
  const [list, signin_hub, db_identity, busy, files, extensions] = await Promise.all([
    codes(),
    signinHub(),
    dbIdentity(),
    busyCounts(),
    fileCounts(),
    loadedExtensions()
  ])
  return {
    codes: list,
    key_fp: keyFp(),
    oidc: oidcIdentity(config.OIDC_ISSUER),
    signin_hub,
    db_identity,
    busy,
    files,
    version: NIVARO_VERSION,
    extensions
  }
}
