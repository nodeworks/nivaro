import type { HubEnvironmentRow } from '../promote-types.js'

/**
 * Env rules for a Docker stack (Hub phase 4): which keys a stack's settings may hold, and where
 * its database settings come from. Pure: no I/O.
 *
 * The Hub agent (packages/hub-agent/src/spec.ts `forbiddenEnvKey`) refuses a StackSpec carrying
 * any key below as env, as a secret (Nivaro reads /run/secrets/X in place of env X) or as
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
  runtime_keys: ['PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP'] as readonly string[],
  runtime_prefixes: ['LD_', 'OPENSSL_', 'SSL_CERT_'] as readonly string[],
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
  /** Every env key the agent sets itself (REDIS_URL only while redis is bundled). */
  agent_set_env_keys: [
    'NIVARO_ROLE',
    'REDIS_URL',
    'STORAGE_LOCAL_ROOT',
    ...ROLE_ENV_KEYS
  ] as readonly string[],
  redis_url_allowed_when: 'external',
  file_suffix: '_FILE'
} as const

type RedisMode = 'bundled' | 'external' | string

function agentForbiddenBase(k: string, redis: RedisMode): boolean {
  const r = AGENT_ENV_RULES
  if (r.runtime_keys.includes(k)) return true
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
  if (agentForbiddenBase(key, redis)) return true
  const suffix = AGENT_ENV_RULES.file_suffix
  return key.endsWith(suffix) && agentForbiddenBase(key.slice(0, -suffix.length), redis)
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

/** A plain setting whose name says it holds a credential (SECRET_IN_SETTINGS). */
export const SECRET_LIKE_KEY_RE = /(secret|token|pass|key|credential|auth)/i

/**
 * The database env of a stack (Decision 17 seam). Phase 4: the DB_* keys of the plain settings
 * (DB_PASSWORD is a secret and rides the spec's secrets).
 * merge: phase 3 — when `env.db_ref` names a phase-3 database record, answer that record's
 * connection here instead (keep its password out of env: secrets only).
 */
export function databaseEnvFor(
  _env: HubEnvironmentRow,
  settings: Record<string, string>
): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(settings)) if (k.startsWith('DB_')) out[k] = v
  return out
}
