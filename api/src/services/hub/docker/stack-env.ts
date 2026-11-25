import type { HubEnvironmentRow } from '../promote-types.js'
import { KNOWN_ENV_KEYS } from './known-env.js'

/**
 * Env rules for a Docker stack (Hub phase 4): which keys a stack's settings may hold, and where
 * its database settings come from. Pure: no I/O.
 *
 * The Hub agent (packages/hub-agent/src/spec.ts `forbiddenEnvKey`) refuses a StackSpec carrying
 * any key below as env or as a secret (Nivaro reads /run/secrets/X in place of env X), and every
 * `<KEY>_FILE`. The Hub refuses the same keys when settings are SAVED, so a stored row never
 * renders into a spec the agent answers 400. `AGENT_ENV_RULES` mirrors the agent's list exactly;
 * the API never imports the agent package, so hub-stack-env-rules.guard.test.ts pins this copy to
 * test/fixtures/hub-agent-env-rules.json and that fixture to the agent's source.
 */

/** Env and secret keys (also the file name under /run/secrets): the agent's ENV_KEY_RE. */
export const ENV_KEY_RE = /^[A-Z][A-Z0-9_]{0,63}$/

/** The agent's role env keys: only a role's own `env` may carry them. */
export const ROLE_ENV_KEYS: readonly string[] = [
  'SOCKETS',
  'CRON_TICKS',
  'IMPORT_WORKER',
  'MEDIA_WORKER',
  'VIDEO_RENDER'
]

/** Copy of the agent's deny-list (see the file comment). Change it only with the agent's. */
export const AGENT_ENV_RULES = {
  /**
   * Runtime keys (ruling P4-20: a spec never chooses a program to run, or what a program reads
   * as code): the programs Nivaro runs and what they read (FFMPEG_PATH, FFPROBE_PATH, FFREPORT,
   * CHROMIUM_FLAGS, CHROMIUM_USER_FLAGS; PUPPETEER_* and HELP_VIDEO_WHISPER_* below), and
   * SAMBA_SERVER_PATH — a path spliced into a BULK INSERT statement, not a binary.
   */
  runtime_keys: [
    'PATH',
    'HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
    'FFMPEG_PATH',
    'FFPROBE_PATH',
    'FFREPORT',
    'CHROMIUM_FLAGS',
    'CHROMIUM_USER_FLAGS',
    'SAMBA_SERVER_PATH',
    // glibc / GLib / GTK module paths a child loads code from (ruling P4-23).
    'GCONV_PATH',
    'LOCPATH',
    'GIO_MODULE_DIR',
    'GTK_PATH',
    'GIO_EXTRA_MODULES',
    'GTK_MODULES',
    'GDK_PIXBUF_MODULEDIR',
    'GLIBC_TUNABLES',
    'QT_PLUGIN_PATH',
    // interpreter and toolkit search paths (ruling P4-23)
    'PYTHONPATH',
    'CLASSPATH',
    'PERL5LIB',
    'GDK_PIXBUF_MODULE_FILE',
    'XDG_DATA_DIRS'
  ] as readonly string[],
  runtime_prefixes: [
    'LD_',
    'OPENSSL_',
    'SSL_CERT_',
    'PUPPETEER_',
    'HELP_VIDEO_WHISPER_',
    // Library loader paths Chromium / ffmpeg / Mesa read (ruling P4-22); LD_ covers LD_PRELOAD,
    // LD_LIBRARY_PATH and LD_AUDIT.
    'VK_',
    '__EGL_',
    'LIBGL_',
    // VA-API, Mesa, GBM, VDPAU, OpenCL and GStreamer loaders (ruling P4-23).
    'LIBVA_',
    'MESA_',
    'GBM_',
    'VDPAU_',
    'OCL_ICD_',
    'GST_PLUGIN_',
    // the macOS dynamic loader (DYLD_INSERT_LIBRARIES, DYLD_LIBRARY_PATH)
    'DYLD_'
  ] as readonly string[],
  node_prefix: 'NODE_',
  node_allowed: ['NODE_ENV'] as readonly string[],
  nivaro_prefix: 'NIVARO_',
  nivaro_allowed: [
    'NIVARO_ENVIRONMENT',
    'NIVARO_INSTANCE',
    'NIVARO_EXPECTED_DB',
    'NIVARO_HEAP_FROM_CGROUP'
  ] as readonly string[],
  role_env_keys: ROLE_ENV_KEYS,
  /** Ruling X-2: the deployment's mode and identity belong to the Hub (phase 6), never a stack. */
  hub_owned_keys: ['HUB_SHARED_DEPLOYMENT', 'HUB_DEPLOYMENT_TOKEN'] as readonly string[],
  /** Ruling X-2: credentials a spec carries only as a secret, never as env. */
  secret_only_keys: ['HUB_TOKEN', 'HUB_CLIENT_SECRET'] as readonly string[],
  /** Every env key the agent sets itself (REDIS_URL only while redis is bundled). */
  agent_set_env_keys: [
    'NIVARO_ROLE',
    'REDIS_URL',
    'STORAGE_LOCAL_ROOT',
    ...ROLE_ENV_KEYS
  ] as readonly string[],
  redis_url_allowed_when: 'external',
  file_suffix: '_FILE',
  /**
   * Every `<KEY>_FILE` is refused, whatever KEY is: Nivaro reads X_FILE as "read X from this
   * path", and a stack never needs one (secrets are mounted at /run/secrets/<KEY>, read by
   * Nivaro itself). MAIL_FROM_FILE=/run/secrets/ENCRYPTION_KEY would copy one secret into another.
   */
  every_file_key_forbidden: true
} as const

type RedisMode = 'bundled' | 'external' | string

function agentForbiddenBase(k: string, redis: RedisMode): boolean {
  const r = AGENT_ENV_RULES
  if (r.runtime_keys.includes(k)) return true
  if (r.hub_owned_keys.includes(k)) return true
  if (r.runtime_prefixes.some((p) => k.startsWith(p))) return true
  if (k.startsWith(r.node_prefix) && !r.node_allowed.includes(k)) return true
  if (k.startsWith(r.nivaro_prefix) && !r.nivaro_allowed.includes(k)) return true
  if (r.agent_set_env_keys.includes(k)) {
    return !(k === 'REDIS_URL' && redis === r.redis_url_allowed_when)
  }
  return false
}

/** Exactly the agent's `forbiddenEnvKey`: a key a StackSpec may not carry as env or secret. */
export function agentRefusesEnvKey(key: string, redis: RedisMode): boolean {
  if (AGENT_ENV_RULES.every_file_key_forbidden && key.endsWith(AGENT_ENV_RULES.file_suffix))
    return true
  return agentForbiddenBase(key, redis)
}

/** Exactly the agent's SECRET_ONLY_KEYS test: a key a spec may carry as a secret, never as env. */
export function secretOnlyEnvKey(key: string): boolean {
  return AGENT_ENV_RULES.secret_only_keys.includes(key)
}

/**
 * The allow-list (ruling P4-23). A stack may set only a key the Nivaro app reads (KNOWN_ENV_KEYS,
 * generated from api/src by scripts/hub-known-env.mts; the agent ships the same list) or a key
 * under one of the agent's HUB_AGENT_ENV_PREFIXES (GET /v1/health `env_prefixes`). The deny rules
 * above stay as a second layer: a key is accepted only when allowed AND not refused.
 */
const KNOWN_ENV = new Set(KNOWN_ENV_KEYS)

/** One HUB_AGENT_ENV_PREFIXES entry, as the agent's config accepts it (`EFP_`, `EFP_OPS_`). */
export const ENV_PREFIX_RE = /^[A-Z][A-Z0-9]*(_[A-Z0-9]+)*_$/

/**
 * Exactly the agent's `operatorPrefixConflict`: a prefix of a deny key (GIO_ vs GIO_MODULE_DIR,
 * GTK_ vs GTK_PATH), or a prefix of, or prefixed by, a deny prefix (GST_ vs GST_PLUGIN_). A
 * prefix that only starts with an exact deny key (TEMPLATE_, PATHWAY_) is fine. Such a prefix
 * never counts here (and the agent refuses to start with one).
 */
export function operatorPrefixConflict(prefix: string): boolean {
  const r = AGENT_ENV_RULES
  const keys = [...r.runtime_keys, ...r.agent_set_env_keys, ...r.hub_owned_keys]
  const prefixes = [...r.runtime_prefixes, r.node_prefix, r.nivaro_prefix]
  return (
    keys.some((k) => k.startsWith(prefix)) ||
    prefixes.some((d) => d.startsWith(prefix) || prefix.startsWith(d))
  )
}

/** A key the Nivaro app reads (the generated list). */
export const knownEnvKey = (key: string): boolean => KNOWN_ENV.has(key)

/** Exactly the agent's `allowedEnvKey`: a known key, or one under an operator prefix. */
export function allowedEnvKey(key: string, prefixes: readonly string[] = []): boolean {
  return KNOWN_ENV.has(key) || prefixes.some((p) => key.startsWith(p))
}

/** Exactly the agent's `acceptedEnvKey`: allowed AND not refused by the deny rules. */
export function agentAcceptsEnvKey(
  key: string,
  redis: RedisMode,
  prefixes: readonly string[] = []
): boolean {
  return allowedEnvKey(key, prefixes) && !agentRefusesEnvKey(key, redis)
}

/**
 * What the Hub knows of the agent's HUB_AGENT_ENV_PREFIXES. `known: false` = no prefix counts
 * (fail closed): the agent was not reached (`unreachable`), or it answers no `env_prefixes` at
 * all — an agent from before P4-23 (`old_agent`).
 */
export interface AgentEnvPrefixRead {
  prefixes: readonly string[]
  known: boolean
  reason?: 'unreachable' | 'old_agent'
}

/**
 * The agent's `env_prefixes` from GET /v1/health (null = not reached). Only well-formed entries
 * that do not overlap the deny rules count; a garbled one is dropped.
 */
export function agentEnvPrefixes(
  health: { env_prefixes?: unknown } | null | undefined
): AgentEnvPrefixRead {
  if (!health) return { prefixes: [], known: false, reason: 'unreachable' }
  const raw = health.env_prefixes
  if (!Array.isArray(raw)) return { prefixes: [], known: false, reason: 'old_agent' }
  const prefixes = raw.filter(
    (p): p is string => typeof p === 'string' && ENV_PREFIX_RE.test(p) && !operatorPrefixConflict(p)
  )
  return { prefixes, known: true }
}

/**
 * Keys the Hub renderer sets itself (renderStackSpec), plus PORT: the agent routes and publishes
 * the app on 3055, so a stack that moved its listener would never answer.
 */
export const RENDERER_ENV_KEYS: readonly string[] = [
  'PUBLIC_URL',
  'ADMIN_URL',
  'NIVARO_ENVIRONMENT',
  'MIGRATION_SAFE_MODE',
  'NODE_ENV',
  'HUB_URL',
  'HUB_TOKEN',
  'PORT'
]

/**
 * A key a stack's settings may not hold, as a plain setting or as a secret (RESERVED_SETTING):
 * everything the agent refuses, every key the renderer owns, and every `<KEY>_FILE` (a path inside
 * the container; secrets reach /run/secrets through the agent, never through a settings path).
 */
export function reservedSettingKey(key: string, redis: RedisMode): boolean {
  if (agentRefusesEnvKey(key, redis)) return true
  if (RENDERER_ENV_KEYS.includes(key)) return true
  return key.endsWith(AGENT_ENV_RULES.file_suffix)
}

/**
 * Env keys the renderer fills with a default when the settings leave them unset. A secret may not
 * carry one: the default would land in env next to it and the agent refuses a key that is both.
 */
export const RENDERER_DEFAULT_ENV_KEYS: readonly string[] = ['TRUST_PROXY']

/**
 * Copy of the agent's ONE_LINE_KEYS (spec.ts): values Nivaro writes as one line of smbclient's
 * auth file. A CR or LF would add a line of its own, so both sides refuse it (SETTING_INVALID).
 */
export const ONE_LINE_KEYS: readonly string[] = ['SAMBA_USER', 'SAMBA_PASS', 'SAMBA_WORKGROUP']

/** A value the agent would refuse for this key because it spans lines. */
export function multiLineRefused(key: string, value: string): boolean {
  return ONE_LINE_KEYS.includes(key) && /[\r\n]/.test(value)
}

/** A plain setting whose name says it holds a credential (SECRET_IN_SETTINGS). */
export const SECRET_LIKE_KEY_RE = /(secret|token|pass|key|credential|auth)/i

/** The database part of a stack: env (visible in `docker service inspect`) and secrets. */
export interface DatabaseEnv {
  env: Record<string, string>
  /** Every credential (DB_PASSWORD): mounted at /run/secrets, never in env. */
  secrets: Record<string, string>
}

const isDbKey = (k: string) => k.startsWith('DB_')

/**
 * A phase 3 database record, opened by the run (services/hub/db openDatabaseConnection): the
 * engine as DB_CLIENT and the whole connection, password included, as the DB_URL Nivaro reads.
 */
export interface DatabaseRecordEnv {
  client: string
  url: string
  /** Hub gap sqlite: a SQLite record's file inside the container (the app's own app-db folder of
   *  the uploads volume); DB_DATABASE, and no DB_URL. */
  file?: string
}

/** Where a SQLite app's file sits in a Docker stack (the uploads volume, its own folder). */
export function sqliteStackFile(tenantId: string, file: string): string {
  return `/app/uploads/app-db/${tenantId}/${file}`
}

/** The database row id an environment's db_ref names (`hub-db:<id>`, phase 3), or null. */
export function databaseRecordId(dbRef: unknown): number | null {
  const m = /^hub-db:(\d+)$/.exec(String(dbRef ?? ''))
  return m ? Number(m[1]) : null
}

/**
 * The database env of a stack (Decision 17 seam, ruling P4-13). When the environment's db_ref
 * names a phase 3 database record, that record wins: DB_CLIENT as env, DB_URL (with the password)
 * as a secret, never in env; the DB_* stack settings are not used. Otherwise phase 4: the DB_*
 * keys of the plain settings as env, the DB_* keys of the opened secrets (DB_PASSWORD) as
 * secrets. A DB_* key that looks like a credential always goes to secrets, whichever map it came
 * from.
 */
export function databaseEnvFor(
  _env: HubEnvironmentRow,
  settings: Record<string, string>,
  secrets: Record<string, string>,
  record: DatabaseRecordEnv | null = null
): DatabaseEnv {
  if (record?.client === 'sqlite' && record.file)
    return { env: { DB_CLIENT: 'sqlite', DB_DATABASE: record.file }, secrets: {} }
  if (record) return { env: { DB_CLIENT: record.client }, secrets: { DB_URL: record.url } }
  const out: DatabaseEnv = { env: {}, secrets: {} }
  for (const [k, v] of Object.entries(settings)) {
    if (!isDbKey(k)) continue
    if (SECRET_LIKE_KEY_RE.test(k)) out.secrets[k] = v
    else out.env[k] = v
  }
  for (const [k, v] of Object.entries(secrets)) if (isDbKey(k)) out.secrets[k] = v
  return out
}

/** True for the keys databaseEnvFor answers (the renderer takes them from there only). */
export const databaseKey = isDbKey
