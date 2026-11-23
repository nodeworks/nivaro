import { Buffer } from 'node:buffer'
import { randomBytes } from 'node:crypto'
import { sessionSecretProblem } from '../../../auth/secret-policy.js'
import { db } from '../../../db/index.js'
import { parseJson } from '../../pipeline-engine.js'
import type { Validation } from '../drivers.js'
import { hubTokenColumns } from '../link-token.js'
import type { HubEnvironmentRow } from '../promote-types.js'
import { HUB_MASK, HubSecretError, nextSecret, openSecret, sealSecret } from '../secrets.js'
import type { DockerDriverConfig } from './driver-config.js'
import { environmentNames } from './render-spec.js'
import {
  type AgentEnvPrefixRead,
  allowedEnvKey,
  ENV_KEY_RE,
  knownEnvKey,
  multiLineRefused,
  RENDERER_DEFAULT_ENV_KEYS,
  RENDERER_ENV_KEYS,
  reservedSettingKey,
  SECRET_LIKE_KEY_RE,
  secretOnlyEnvKey
} from './stack-env.js'
import { STACK_SIZES, type StackSize } from './templates.js'

/**
 * Per-environment Docker stack settings (Hub phase 4, nivaro_hub_stack_settings, migration 546):
 * size, Redis mode, publish port, plain settings (env) and the secrets — ONE sealed JSON object.
 *
 * Secrets never leave this module in plain text except through `openStackSecrets`, which only
 * the deploy step calls, inside the call that sends the spec to the agent. Answers mask them,
 * refusals name keys only, and a validated row carries them sealed. SESSION_SECRET and
 * ENCRYPTION_KEY are generated on first save, the environment's hub token too when it has none;
 * a save never regenerates one that exists, neither may be cleared, and replacing one needs an
 * explicit `rotate`.
 */

export type { StackSize } from './templates.js'
export type StackRedis = 'bundled' | 'external'

export interface StackSettingsRow {
  environment_id: number
  size: StackSize
  redis: StackRedis
  publish_port: number | null
  /** Plain settings (env): never a credential (SECRET_IN_SETTINGS). */
  settings: Record<string, string>
  /** One sealed JSON object of KEY → per-key sealed value, or null. */
  secrets: string | null
}

/** What a save writes: the row's fields, secrets merged and sealed. */
export type StackSettingsFields = Omit<StackSettingsRow, 'environment_id'>

export interface StackSettingsInput {
  fields: StackSettingsFields
  /** extension id → <repo>@sha256:<64 hex>; undefined = leave the environment's pins alone. */
  extension_pins: Record<string, string> | undefined
}

export interface PublicStackSettings {
  environment_id: number
  size: StackSize
  redis: StackRedis
  publish_port: number | null
  settings: Record<string, string>
  /** Every stored secret key, each as the mask. */
  secrets: Record<string, string>
  /** Set when the stored secrets cannot be opened (wrong ENCRYPTION_KEY): keys unknown. */
  secrets_error?: string
}

const TABLE = 'nivaro_hub_stack_settings'
const ENVS = 'nivaro_hub_environments'

/** Generated on first save, never regenerated, never cleared. */
export const GENERATED_SECRET_KEYS = ['SESSION_SECRET', 'ENCRYPTION_KEY'] as const

/** The DB_CLIENT values Nivaro boots with (config.ts). */
export const DB_CLIENTS = ['mssql', 'pg', 'mysql2', 'mariadb', 'sqlite'] as const

/**
 * Caps that keep a rendered spec inside the agent's (≤ 200 env keys, ≤ 50 secrets, 4 KB / 64 KB
 * values): the renderer adds RENDERER_ENV_KEYS + TRUST_PROXY to env and HUB_TOKEN to secrets.
 */
const MAX_SETTINGS = 200 - RENDERER_ENV_KEYS.length - 1
const MAX_SECRETS = 49
const MAX_SETTING_BYTES = 4096
const MAX_SECRET_BYTES = 65536
const MAX_EXTENSIONS = 20

const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
/** `<repo>@sha256:<64 lowercase hex>`, the repo in the Docker reference grammar (the agent's). */
/** An extension image pinned by digest: `<repo>@sha256:<64 hex>` (shared deployments use it too). */
export const PINNED_RE =
  /^([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)@sha256:[0-9a-f]{64}$/

const HEX64_RE = /^[0-9a-fA-F]{64}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

/** Caller text echoed in a refusal: at most 64 characters (keys only, never values). */
const echo = (k: string) => (k.length > 64 ? `${k.slice(0, 64)}…` : k)

/** A string map from stored JSON; keys outside the env-key rule (`__proto__` too) are dropped. */
function stringMap(raw: unknown): Record<string, string> {
  const v = typeof raw === 'string' ? parseJson(raw) : raw
  const out: Record<string, string> = {}
  if (!isPlainObject(v)) return out
  for (const [k, x] of Object.entries(v)) {
    if (typeof x === 'string' && ENV_KEY_RE.test(k)) out[k] = x
  }
  return out
}

export function stackSettingsFromRow(r: Record<string, unknown>): StackSettingsRow {
  const size = String(r.size ?? 'small') as StackSize
  return {
    environment_id: Number(r.environment_id),
    size: STACK_SIZES.includes(size) ? size : 'small',
    redis: r.redis === 'external' ? 'external' : 'bundled',
    publish_port: r.publish_port == null ? null : Number(r.publish_port),
    settings: stringMap(r.settings),
    secrets: r.secrets == null || r.secrets === '' ? null : String(r.secrets)
  }
}

export async function readStackSettings(envId: number): Promise<StackSettingsRow | null> {
  const row = await db(TABLE).where({ environment_id: envId }).first()
  return row ? stackSettingsFromRow(row) : null
}

/**
 * The secrets column is ONE sealed JSON object whose values are each sealed again (sealSecret):
 * KEY → sealed value. Merging works on the per-key sealed values with secrets.ts `nextSecret`,
 * so a plaintext value exists only in the call that sets it and in openStackSecrets.
 */
type SealedMap = Record<string, string>

function openSealedMap(blob: string | null): SealedMap {
  return stringMap(openSecret(blob))
}

function sealMap(map: SealedMap): string | null {
  const keys = Object.keys(map).sort()
  if (keys.length === 0) return null
  const sorted: SealedMap = {}
  for (const k of keys) sorted[k] = map[k]
  return sealSecret(JSON.stringify(sorted))
}

/**
 * The stack's secrets in plain text. Only the deploy step calls this, inside the call that sends
 * the spec; the answer must never be logged, stored or returned. Throws HubSecretError (code
 * only, no value) when the column cannot be opened.
 */
export function openStackSecrets(
  row: Pick<StackSettingsRow, 'secrets'> | null
): Record<string, string> {
  if (!row) return {}
  const out: Record<string, string> = {}
  for (const [k, sealed] of Object.entries(openSealedMap(row.secrets))) {
    const v = openSecret(sealed)
    if (v !== null) out[k] = v
  }
  return out
}

/** The row for an answer: every secret as the mask. */
export function publicStackSettings(row: StackSettingsRow | null): PublicStackSettings | null {
  if (!row) return null
  const out: PublicStackSettings = {
    environment_id: row.environment_id,
    size: row.size,
    redis: row.redis,
    publish_port: row.publish_port,
    settings: { ...row.settings },
    secrets: {}
  }
  try {
    for (const k of Object.keys(openSealedMap(row.secrets)).sort()) out.secrets[k] = HUB_MASK
  } catch (err) {
    out.secrets_error = err instanceof HubSecretError ? err.code : 'HUB_SECRET_UNREADABLE'
  }
  return out
}

/**
 * (Twin of RefusalField in admin/src/pages/hub/docker/stack-api.ts: keep them in step.)
 * The one entry a refusal is about (ruling P4-24): a kind and, for a named entry, its key. Never
 * a value; a key longer than 64 characters is left out.
 */
export type RefusalField = {
  kind: 'setting' | 'secret' | 'extension_pin' | 'size' | 'redis' | 'publish_port'
  key?: string
}
type Fail = { ok: false; code: string; message: string; field?: RefusalField }
const fail = (code: string, message: string, field?: RefusalField): Fail =>
  field ? { ok: false, code, message, field } : { ok: false, code, message }
const named = (kind: 'setting' | 'secret' | 'extension_pin', k: string): RefusalField =>
  k.length <= 64 ? { kind, key: k } : { kind }
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

/** Only mask characters (whitespace around them allowed) but not the exact mask: a pasted mask. */
const MASK_CHAR = HUB_MASK[0]
function looksLikeMask(v: string): boolean {
  const t = v.trim()
  return t.length > 0 && [...t].every((c) => c === MASK_CHAR)
}

const redisNote = (k: string, redis: StackRedis) =>
  k === 'REDIS_URL' && redis === 'bundled'
    ? 'the bundled Redis sets REDIS_URL; choose external Redis to set your own'
    : 'runtime, file-path, role and Hub-owned keys are set by the Hub or the agent'

/** A redis:// URL carrying a user name or password. */
function urlHasUserinfo(v: string): boolean {
  try {
    const u = new URL(v.trim())
    return !!(u.username || u.password)
  } catch {
    return /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*@/i.test(v.trim())
  }
}

/**
 * The agent's HUB_AGENT_ENV_PREFIXES as the Hub knows them (ruling P4-23). `known: false` = no
 * prefix counts (fail closed): the agent was not reached, or it is too old to report them.
 */
export type EnvAllow = AgentEnvPrefixRead

const NO_PREFIXES: EnvAllow = { prefixes: [], known: true }

const UNKNOWN_NOTE: Record<NonNullable<EnvAllow['reason']>, string> = {
  unreachable: ' (the Hub could not reach the agent to read its prefixes, so none count right now)',
  old_agent:
    ' (this agent does not report its prefixes: upgrade the Hub agent, then save again; until then none count)'
}

/** SETTING_INVALID for a key outside the allow-list: names the key and how to allow it. */
function notAllowed(k: string, what: 'setting' | 'secret', allow: EnvAllow): Fail | null {
  if (allowedEnvKey(k, allow.prefixes)) return null
  const unknown = allow.known ? '' : UNKNOWN_NOTE[allow.reason ?? 'unreachable']
  return fail(
    'SETTING_INVALID',
    `${k} is not a Nivaro ${what}: Nivaro does not read it. To allow it, add its prefix to HUB_AGENT_ENV_PREFIXES on the agent${unknown}.`,
    named(what, k)
  )
}

/** A key's place in a stack: null = fine as a plain setting. */
function settingKeyProblem(k: string, redis: StackRedis, allow: EnvAllow): Fail | null {
  if (!ENV_KEY_RE.test(k)) {
    return fail(
      'BAD_KEY',
      `Setting "${echo(k)}" is not a valid name (A–Z, 0–9 and _, up to 64).`,
      named('setting', k)
    )
  }
  if (reservedSettingKey(k, redis)) {
    return fail(
      'RESERVED_SETTING',
      `${k} cannot be a stack setting (${redisNote(k, redis)}).`,
      named('setting', k)
    )
  }
  // Ruling X-2: a credential that may only ever be a secret (the agent refuses it as env).
  if (secretOnlyEnvKey(k)) {
    return fail(
      'SECRET_IN_SETTINGS',
      `${k} can only be a secret, never a plain setting.`,
      named('setting', k)
    )
  }
  // An unknown key gets the allow-list answer first: storing it as a secret would not help.
  const outside = notAllowed(k, 'setting', allow)
  if (outside) return outside
  if (SECRET_LIKE_KEY_RE.test(k)) {
    return fail(
      'SECRET_IN_SETTINGS',
      `${k} looks like a credential: store it as a secret.`,
      named('setting', k)
    )
  }
  return null
}

function settingValueProblem(k: string, v: unknown): Fail | null {
  const field = named('setting', k)
  if (typeof v !== 'string') return fail('BAD_VALUE', `Setting ${k} must be text.`, field)
  if (bytes(v) > MAX_SETTING_BYTES) {
    return fail('BAD_VALUE', `Setting ${k} is longer than 4 KB.`, field)
  }
  if (multiLineRefused(k, v)) {
    return fail('SETTING_INVALID', `Setting ${k} must be one line (no line breaks).`, field)
  }
  if (looksLikeMask(v)) {
    return fail('BAD_VALUE', `Setting ${k} holds the mask (••••••), not a value.`, field)
  }
  if (k === 'REDIS_URL' && urlHasUserinfo(v)) {
    return fail(
      'SECRET_IN_SETTINGS',
      'REDIS_URL carries a user name or password: store it as the secret REDIS_URL instead.',
      field
    )
  }
  return null
}

function secretKeyProblem(k: string, redis: StackRedis, allow: EnvAllow): Fail | null {
  if (!ENV_KEY_RE.test(k)) {
    return fail(
      'BAD_KEY',
      `Secret "${echo(k)}" is not a valid name (A–Z, 0–9 and _, up to 64).`,
      named('secret', k)
    )
  }
  if (reservedSettingKey(k, redis) || RENDERER_DEFAULT_ENV_KEYS.includes(k)) {
    return fail(
      'RESERVED_SETTING',
      `${k} cannot be a stack secret (${redisNote(k, redis)}).`,
      named('secret', k)
    )
  }
  return notAllowed(k, 'secret', allow)
}

const keysOf = (v: unknown): string[] => (isPlainObject(v) ? Object.keys(v) : [])

/**
 * The agent's prefixes, read only when some key of the save is outside the known list (a save
 * of known keys never waits on the agent). A loader that answers null or throws, or no loader,
 * = the agent was not reached; then no prefix counts.
 */
async function envAllowFor(
  b: Record<string, unknown>,
  existing: StackSettingsRow | null,
  load: (() => Promise<AgentEnvPrefixRead | null>) | undefined
): Promise<EnvAllow> {
  let stored: string[] = []
  try {
    stored = Object.keys(openSealedMap(existing?.secrets ?? null))
  } catch {
    // Unreadable stored secrets fail later with their own code.
  }
  const keys = [
    ...keysOf(b.settings),
    ...keysOf(b.secrets),
    ...Object.keys(existing?.settings ?? {}),
    ...stored
  ]
  if (!keys.some((k) => ENV_KEY_RE.test(k) && !knownEnvKey(k))) return NO_PREFIXES
  let read: AgentEnvPrefixRead | null = null
  try {
    read = load ? await load() : null
  } catch {
    read = null
  }
  return read ?? { prefixes: [], known: false, reason: 'unreachable' }
}

/** A new value for a secret, or why not. Messages never carry the value. */
function secretValueProblem(k: string, v: string): Fail | null {
  const field = named('secret', k)
  if (bytes(v) > MAX_SECRET_BYTES) {
    return fail('BAD_VALUE', `Secret ${k} is longer than 64 KB.`, field)
  }
  if (multiLineRefused(k, v)) {
    return fail('SETTING_INVALID', `Secret ${k} must be one line (no line breaks).`, field)
  }
  if (looksLikeMask(v)) return fail('BAD_VALUE', `Secret ${k} holds a mask, not a value.`, field)
  if (k === 'SESSION_SECRET' && sessionSecretProblem(v)) {
    return fail(
      'BAD_VALUE',
      'SESSION_SECRET must be at least 32 random characters (openssl rand -hex 32), or leave it to be generated.',
      field
    )
  }
  if (k === 'ENCRYPTION_KEY' && !HEX64_RE.test(v)) {
    return fail(
      'BAD_VALUE',
      'ENCRYPTION_KEY must be 64 hex characters (openssl rand -hex 32), or leave it to be generated.',
      field
    )
  }
  return null
}

const isGenerated = (k: string) => (GENERATED_SECRET_KEYS as readonly string[]).includes(k)

/**
 * A stack settings save over the stored row (`existing`, null on first save). `settings`, when
 * sent, replaces the plain map; `secrets` merges per key with secrets.ts `nextSecret` (the mask
 * keeps, '' / null clears, text sets); `extension_pins`, when sent, replaces the environment's
 * pins. Replacing a stored SESSION_SECRET / ENCRYPTION_KEY needs `rotate: ['<KEY>']` in the body
 * (a new ENCRYPTION_KEY makes the stack's encrypted data unreadable). Every key is checked against
 * the redis mode the save ends with (a switch to bundled refuses a stored REDIS_URL).
 * Refusal codes: BAD_SIZE, BAD_REDIS, BAD_KEY, BAD_VALUE, SETTING_INVALID (a line break in a
 * one-line key, or a key outside the allow-list: neither a key Nivaro reads nor under the agent's
 * HUB_AGENT_ENV_PREFIXES, ruling P4-23), SECRET_IN_SETTINGS, RESERVED_SETTING,
 * SECRET_REQUIRED, BAD_DB_CLIENT, SQLITE_ONE_PROCESS, BAD_PUBLISH_PORT, BAD_EXTENSION_PIN.
 */
export async function validateStackSettings(
  body: unknown,
  existing: StackSettingsRow | null,
  // `driver` / `env`: part of the Task 7 interface (hostnames are hostnameRefusals' job, run by
  // the planner + routes). `envPrefixes`: reads the agent's HUB_AGENT_ENV_PREFIXES (GET
  // /v1/health, stack-env agentEnvPrefixes), null when not reached — called at most once, only
  // when a key is outside the known list; absent = no prefixes (ruling P4-23).
  ctx: {
    driver: DockerDriverConfig
    env: HubEnvironmentRow
    envPrefixes?: () => Promise<AgentEnvPrefixRead | null>
  }
): Promise<Validation<StackSettingsInput>> {
  const b = isPlainObject(body) ? body : {}
  const allow = await envAllowFor(b, existing, ctx.envPrefixes)

  const size = (b.size !== undefined ? b.size : (existing?.size ?? 'small')) as StackSize
  if (typeof size !== 'string' || !STACK_SIZES.includes(size)) {
    return fail('BAD_SIZE', 'size must be small, medium or large.', { kind: 'size' })
  }
  const redis = (b.redis !== undefined ? b.redis : (existing?.redis ?? 'bundled')) as StackRedis
  if (redis !== 'bundled' && redis !== 'external') {
    return fail('BAD_REDIS', 'redis must be bundled or external.', { kind: 'redis' })
  }

  let publishPort = existing?.publish_port ?? null
  if (b.publish_port !== undefined) {
    const p = b.publish_port
    if (p === null) publishPort = null
    else if (typeof p === 'number' && Number.isInteger(p) && p >= 1 && p <= 65535) publishPort = p
    else {
      return fail('BAD_PUBLISH_PORT', 'publish_port must be a port number (1–65535) or null.', {
        kind: 'publish_port'
      })
    }
  }

  let rotate: string[] = []
  if (b.rotate !== undefined && b.rotate !== null) {
    if (
      !Array.isArray(b.rotate) ||
      !b.rotate.every((k) => typeof k === 'string' && isGenerated(k))
    ) {
      return fail('BAD_KEY', `rotate lists only ${GENERATED_SECRET_KEYS.join(' / ')}.`, {
        kind: 'secret'
      })
    }
    rotate = b.rotate as string[]
  }

  // Plain settings: replaced as a whole when sent.
  let settings: Record<string, string> = { ...(existing?.settings ?? {}) }
  if (b.settings !== undefined) {
    const sent = b.settings ?? {}
    if (!isPlainObject(sent)) {
      return fail('BAD_KEY', 'settings must be an object of NAME: value.', { kind: 'setting' })
    }
    settings = {}
    for (const [k, v] of Object.entries(sent)) {
      const bad = settingKeyProblem(k, redis, allow) ?? settingValueProblem(k, v)
      if (bad) return bad
      settings[k] = v as string
    }
  }
  if (Object.keys(settings).length > MAX_SETTINGS) {
    return fail('BAD_VALUE', `A stack holds at most ${MAX_SETTINGS} settings.`, { kind: 'setting' })
  }
  for (const [k, v] of Object.entries(settings)) {
    const bad = settingKeyProblem(k, redis, allow) ?? settingValueProblem(k, v)
    if (bad) return bad
  }

  // Secrets: merged per key; the column is sealed again only when secrets were sent.
  let sealed = existing?.secrets ?? null
  let secretKeys: string[]
  try {
    const map = openSealedMap(existing?.secrets ?? null)
    if (b.secrets !== undefined && b.secrets !== null) {
      if (!isPlainObject(b.secrets)) {
        return fail('BAD_KEY', 'secrets must be an object of NAME: value.', { kind: 'secret' })
      }
      for (const [k, v] of Object.entries(b.secrets)) {
        const stored = map[k] ?? null
        if (v === HUB_MASK) {
          if (!ENV_KEY_RE.test(k)) return secretKeyProblem(k, redis, allow) as Fail
          continue
        }
        if (v === null || v === '') {
          if (isGenerated(k)) {
            return fail(
              'SECRET_REQUIRED',
              `${k} cannot be cleared: the stack's data depends on it.`,
              named('secret', k)
            )
          }
          delete map[k]
          continue
        }
        const bad = secretKeyProblem(k, redis, allow)
        if (bad) return bad
        if (typeof v !== 'string') {
          return fail('BAD_VALUE', `Secret ${k} must be text.`, named('secret', k))
        }
        const badValue = secretValueProblem(k, v)
        if (badValue) return badValue
        if (isGenerated(k) && stored && !rotate.includes(k) && openSecret(stored) !== v) {
          return fail(
            'SECRET_REQUIRED',
            `${k} is already set: replacing it needs rotate: ['${k}']${k === 'ENCRYPTION_KEY' ? ' (data encrypted with the old key becomes unreadable)' : ''}.`,
            named('secret', k)
          )
        }
        const next = nextSecret(v, stored)
        if (next === null) delete map[k]
        else map[k] = next
      }
      sealed = sealMap(map)
    }
    secretKeys = Object.keys(map)
  } catch (err) {
    if (err instanceof HubSecretError) return fail(err.code, err.message)
    throw err
  }
  if (secretKeys.length > MAX_SECRETS) {
    return fail('BAD_VALUE', `A stack holds at most ${MAX_SECRETS} secrets.`, { kind: 'secret' })
  }
  for (const k of secretKeys) {
    const bad = secretKeyProblem(k, redis, allow)
    if (bad) return bad
    if (Object.hasOwn(settings, k)) {
      return fail('BAD_KEY', `${k} is both a setting and a secret: keep one.`, named('secret', k))
    }
  }

  const client = settings.DB_CLIENT
  if (client !== undefined && !(DB_CLIENTS as readonly string[]).includes(client)) {
    return fail('BAD_DB_CLIENT', `DB_CLIENT must be one of ${DB_CLIENTS.join(', ')}.`, {
      kind: 'setting',
      key: 'DB_CLIENT'
    })
  }
  if (client === 'sqlite' && size !== 'small') {
    return fail(
      'SQLITE_ONE_PROCESS',
      'SQLite is one file one process can write: use size small, or a database server.',
      { kind: 'size' }
    )
  }

  let extensionPins: Record<string, string> | undefined
  if (b.extension_pins !== undefined) {
    const pins = b.extension_pins ?? {}
    if (!isPlainObject(pins)) {
      return fail(
        'BAD_EXTENSION_PIN',
        'extension_pins must be an object of id: image@sha256:digest.',
        { kind: 'extension_pin' }
      )
    }
    const ids = Object.keys(pins)
    if (ids.length > MAX_EXTENSIONS) {
      return fail('BAD_EXTENSION_PIN', `A stack takes at most ${MAX_EXTENSIONS} extensions.`, {
        kind: 'extension_pin'
      })
    }
    extensionPins = {}
    for (const id of ids) {
      if (!EXTENSION_ID_RE.test(id)) {
        return fail(
          'BAD_EXTENSION_PIN',
          `Extension id "${echo(id)}" must be lower-case a–z, 0–9 and -.`,
          named('extension_pin', id)
        )
      }
      const ref = pins[id]
      if (typeof ref !== 'string' || !PINNED_RE.test(ref)) {
        return fail(
          'BAD_EXTENSION_PIN',
          `Extension ${id} must be pinned as <repo>@sha256:<64 hex> (a tag is not enough).`,
          named('extension_pin', id)
        )
      }
      extensionPins[id] = ref
    }
  }

  return {
    ok: true,
    row: {
      fields: { size, redis, publish_port: publishPort, settings, secrets: sealed },
      extension_pins: extensionPins
    }
  }
}

const newSecret = () => randomBytes(32).toString('hex')

/** A unique-index violation on any of the five engines. */
function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: unknown; errno?: unknown; number?: unknown; message?: unknown }
  if (e?.code === '23505' || e?.code === 'ER_DUP_ENTRY' || e?.code === 'SQLITE_CONSTRAINT_UNIQUE')
    return true
  if (e?.number === 2627 || e?.number === 2601 || e?.errno === 1062) return true
  return /unique|duplicate/i.test(String(e?.message ?? ''))
}

async function writeStackSettings(
  envId: number,
  fields: StackSettingsFields,
  extensionPins: Record<string, string> | undefined,
  hubToken: { hub_token: string | null; hub_token_lookup: string | null } | null
): Promise<void> {
  await db.transaction(async (trx) => {
    const stored = await trx(TABLE).where({ environment_id: envId }).first('id', 'secrets')
    const map = openSealedMap(fields.secrets)
    let generated = false
    for (const k of GENERATED_SECRET_KEYS) {
      if (map[k]) continue
      // A concurrent first save stored one meanwhile: keep it, never a second value.
      const kept = stored ? openSealedMap((stored.secrets as string | null) ?? null)[k] : undefined
      map[k] = kept || sealSecret(newSecret())
      generated = true
    }
    const values = {
      size: fields.size,
      redis: fields.redis,
      publish_port: fields.publish_port,
      settings: JSON.stringify(fields.settings),
      secrets: generated ? sealMap(map) : fields.secrets,
      updated_at: new Date()
    }
    if (stored) await trx(TABLE).where({ id: stored.id }).update(values)
    else await trx(TABLE).insert({ environment_id: envId, ...values, created_at: new Date() })

    if (hubToken) {
      await trx(ENVS)
        .where({ id: envId })
        .where((q) => q.whereNull('hub_token').orWhere('hub_token', ''))
        .update({ ...hubToken, updated_at: new Date() })
    }
    if (extensionPins !== undefined) {
      await trx(ENVS)
        .where({ id: envId })
        .update({ extension_pins: JSON.stringify(extensionPins), updated_at: new Date() })
    }
  })
}

/**
 * Stores a validated save. SESSION_SECRET / ENCRYPTION_KEY missing from the fields come from the
 * stored row when it has them (a concurrent first save), else are generated (32 random bytes,
 * hex); the environment gets a sealed hub token when it has none. `extensionPins`, when given,
 * replaces nivaro_hub_environments.extension_pins. Two first saves at once: the second one's
 * insert hits the unique index and is retried once as an update.
 */
export async function saveStackSettings(
  envId: number,
  fields: StackSettingsFields,
  extensionPins?: Record<string, string>
): Promise<StackSettingsRow> {
  const env = (await db(ENVS).where({ id: envId }).first('id', 'hub_token')) as
    | { id: number; hub_token: string | null }
    | undefined
  // Phase 3 merge: HubSecretError carries only sealed-secret codes now; an environment deleted
  // under the save is a plain 404.
  if (!env)
    throw Object.assign(new Error('No such environment.'), { statusCode: 404, code: 'NOT_FOUND' })
  // Ruling X-4: sealed with its app-link lookup (link-token.ts hubTokenColumns).
  const hubToken = env.hub_token ? null : hubTokenColumns(newSecret())

  try {
    await writeStackSettings(envId, fields, extensionPins, hubToken)
  } catch (err) {
    if (!isUniqueViolation(err)) throw err
    await writeStackSettings(envId, fields, extensionPins, hubToken)
  }
  const saved = await readStackSettings(envId)
  if (!saved) throw new Error('stack settings vanished after save')
  return saved
}

/**
 * Ruling P6-43 (a), round 1b: sets ONE sealed stack secret to `value` through the same sealed
 * path a Stack panel save uses (per-key sealSecret, one sealed map, saveStackSettings), keeping
 * every other field and secret. Nothing is deployed. Answers whether it changed anything (false
 * when the environment has no stack settings or already holds that value). Never logs a value.
 */
export async function setStackSecret(envId: number, name: string, value: string): Promise<boolean> {
  const existing = await readStackSettings(envId)
  if (!existing) return false
  const map = openSealedMap(existing.secrets)
  if (map[name] && openSecret(map[name]) === value) return false
  map[name] = sealSecret(value)
  await saveStackSettings(envId, {
    size: existing.size,
    redis: existing.redis,
    publish_port: existing.publish_port,
    settings: existing.settings,
    secrets: sealMap(map)
  })
  return true
}

/** Every name the OTHER Hub environments claim (their base_url hosts and hostnames). */
export async function otherEnvironmentNames(envId: number): Promise<Set<string>> {
  const rows = (await db(ENVS)
    .whereNot({ id: envId })
    .select('id', 'base_url', 'hostnames')) as Array<Record<string, unknown>>
  const out = new Set<string>()
  for (const r of rows) {
    const raw = typeof r.hostnames === 'string' ? parseJson(r.hostnames) : r.hostnames
    const hostnames = Array.isArray(raw)
      ? raw.filter((h): h is string => typeof h === 'string')
      : []
    for (const n of environmentNames({ base_url: String(r.base_url), hostnames })) out.add(n)
  }
  return out
}

/**
 * What a deploy still needs before it can run (names only): DB_CLIENT; for a database server
 * DB_HOST, DB_DATABASE, DB_USER and the secret DB_PASSWORD; for SQLite DB_DATABASE (its file);
 * SESSION_SECRET and ENCRYPTION_KEY; REDIS_URL (setting or secret) with external Redis.
 */
export function missingSettings(
  row: StackSettingsRow | null,
  opened: Record<string, string>,
  opts: { databaseRecord?: boolean } = {}
): string[] {
  const s = row?.settings ?? {}
  const has = (k: string) => !!s[k]?.trim()
  const out: string[] = []
  // A phase 3 database record supplies the whole connection (stack-env databaseEnvFor): the
  // DB_* settings are not used then.
  if (!opts.databaseRecord) {
    if (!has('DB_CLIENT')) out.push('DB_CLIENT')
    if (s.DB_CLIENT === 'sqlite') {
      if (!has('DB_DATABASE')) out.push('DB_DATABASE')
    } else {
      for (const k of ['DB_HOST', 'DB_DATABASE', 'DB_USER']) if (!has(k)) out.push(k)
      if (!opened.DB_PASSWORD) out.push('DB_PASSWORD')
    }
  }
  for (const k of GENERATED_SECRET_KEYS) if (!opened[k]) out.push(k)
  if (row?.redis === 'external' && !has('REDIS_URL') && !opened.REDIS_URL) out.push('REDIS_URL')
  return out
}
