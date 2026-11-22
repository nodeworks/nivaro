// The StackSpec: the only thing the Hub may ask the agent to run. The schema
// is CLOSED — any field not listed here is refused — because it is the safety
// line between the Hub and the Docker host: no binds, no privileged mode, no
// capabilities, no host network, no images outside the allow-list.
// Pure: no I/O. Answers never echo a value, only field paths and codes.
import { Buffer } from 'node:buffer'
import { ENV_KEY_RE } from './names.js'

export type Role = 'all' | 'web' | 'worker' | 'realtime' | 'importer'

export type RoleSpec = {
  role: Role
  replicas: number
  cpus?: number
  memory_mb?: number
  env?: Record<string, string>
}

export type StackSpec = {
  owner: { app: string } | { shared: string }
  environment: string
  image: string
  roles: RoleSpec[]
  env: Record<string, string>
  secrets: Record<string, string>
  hostnames: string[]
  redis: 'bundled' | 'external'
  extensions: Record<string, string>
  publish_port?: number
}

/** The part of AgentConfig validation reads (a full AgentConfig satisfies it). */
export type SpecConfig = {
  images: readonly string[]
  edge: 'traefik' | 'publish'
  hostSuffixes: readonly string[]
  publishPorts: readonly [number, number] | null
  redisImage: string | null
}

export type FieldCode =
  | 'UNKNOWN_FIELD'
  | 'REQUIRED'
  | 'BAD_KEY'
  | 'IMAGE_NOT_ALLOWED'
  | 'IMAGE_NOT_PINNED'
  | 'ENV_FORBIDDEN'
  | 'ROLE_BAD'
  | 'REPLICAS_BAD'
  | 'LIMIT_BAD'
  | 'HOSTNAME_NOT_ALLOWED'
  | 'TOO_MANY'
  | 'TOO_LONG'
  | 'PORT_NOT_ALLOWED'
  | 'REDIS_NOT_CONFIGURED'
  | 'EXTENSION_ID_BAD'

export type FieldError = { field: string; code: FieldCode }

export type SpecResult = { ok: true; spec: StackSpec } | { ok: false; fields: FieldError[] }

/** owner.app / owner.shared / environment. */
export const OWNER_KEY_RE = /^[a-z][a-z0-9-]{1,62}$/
export const EXTENSION_ID_RE = /^[a-z0-9][a-z0-9-]{0,62}$/
export const ROLES: readonly Role[] = ['all', 'web', 'worker', 'realtime', 'importer']
export const ROLE_ENV_KEYS: readonly string[] = [
  'SOCKETS',
  'CRON_TICKS',
  'IMPORT_WORKER',
  'MEDIA_WORKER',
  'VIDEO_RENDER'
]

const TOP_FIELDS = new Set([
  'owner',
  'environment',
  'image',
  'roles',
  'env',
  'secrets',
  'hostnames',
  'redis',
  'extensions',
  'publish_port'
])
const ROLE_FIELDS = new Set(['role', 'replicas', 'cpus', 'memory_mb', 'env'])

const MAX_REPLICAS = 10
const MAX_TOTAL_REPLICAS = 30
const MAX_ENV = 200
const MAX_SECRETS = 50
const MAX_HOSTNAMES = 10
const MAX_EXTENSIONS = 20
const MAX_ENV_BYTES = 4096
const MAX_SECRET_BYTES = 65536

/**
 * Keys a spec may never set (env, role env, or as a secret file, which
 * Nivaro reads in place of the env value): they change how the process loads
 * code, which user it runs as, where secrets come from, or what the agent
 * itself sets per role. `<KEY>_FILE` is refused for each, since Nivaro reads
 * X from the file X_FILE names.
 */
const FORBIDDEN_KEYS = new Set([
  'NODE_OPTIONS',
  'NODE_PATH',
  'PATH',
  'HOME',
  'NIVARO_RUN_AS',
  'NIVARO_SECRETS_DIR',
  'NIVARO_ROLE'
])

function forbiddenKey(key: string, redis: unknown): boolean {
  const k = key.endsWith('_FILE') ? key.slice(0, -5) : key
  if (FORBIDDEN_KEYS.has(k) || k.startsWith('LD_')) return true
  if (k === 'REDIS_URL' && redis !== 'external') return true
  return false
}

/** `<repo>@sha256:<64 lowercase hex>`; repo in the Docker reference grammar. */
const PINNED_RE =
  /^([a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*(?:\.[a-z0-9-]+)*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:(?:[._]|__|-+)[a-z0-9]+)*)*)@sha256:[0-9a-f]{64}$/

function repoOf(ref: string): string {
  const at = ref.indexOf('@')
  const noDigest = at === -1 ? ref : ref.slice(0, at)
  const slash = noDigest.lastIndexOf('/')
  const colon = noDigest.lastIndexOf(':')
  return colon > slash ? noDigest.slice(0, colon) : noDigest
}

function imageCode(ref: unknown, allowed: readonly string[]): FieldCode | null {
  if (typeof ref !== 'string') return 'REQUIRED'
  const pinned = PINNED_RE.exec(ref)
  if (pinned) return allowed.includes(pinned[1]) ? null : 'IMAGE_NOT_ALLOWED'
  return allowed.includes(repoOf(ref)) ? 'IMAGE_NOT_PINNED' : 'IMAGE_NOT_ALLOWED'
}

const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function isDnsName(h: string): boolean {
  if (h.length > 253) return false
  const labels = h.split('.')
  return labels.length >= 2 && labels.every((l) => DNS_LABEL_RE.test(l))
}

function underSuffix(h: string, suffixes: readonly string[]): boolean {
  return suffixes.some((s) => {
    const suffix = s.startsWith('.') ? s.toLowerCase() : `.${s.toLowerCase()}`
    return suffix.length > 1 && h.length > suffix.length && h.endsWith(suffix)
  })
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return false
  const proto = Object.getPrototypeOf(v)
  return proto === Object.prototype || proto === null
}

const own = (o: Record<string, unknown>) => Object.keys(o)
const bytes = (s: string) => Buffer.byteLength(s, 'utf8')

export function validateStackSpec(body: unknown, cfg: SpecConfig): SpecResult {
  const errs: FieldError[] = []
  const bad = (field: string, code: FieldCode) => errs.push({ field, code })

  if (!isPlainObject(body)) return { ok: false, fields: [{ field: '', code: 'REQUIRED' }] }

  for (const k of own(body)) if (!TOP_FIELDS.has(k)) bad(k, 'UNKNOWN_FIELD')
  const has = (k: string) => Object.hasOwn(body, k)

  // owner
  let owner: StackSpec['owner'] | null = null
  if (!isPlainObject(body.owner)) bad('owner', 'REQUIRED')
  else {
    const o = body.owner
    const keys = own(o)
    const which = keys.includes('app') ? 'app' : keys.includes('shared') ? 'shared' : null
    if (!which) bad('owner', 'REQUIRED')
    for (const k of keys) if (k !== which) bad(`owner.${k}`, 'UNKNOWN_FIELD')
    if (which) {
      const v = o[which]
      if (typeof v !== 'string' || !OWNER_KEY_RE.test(v)) bad(`owner.${which}`, 'BAD_KEY')
      else owner = which === 'app' ? { app: v } : { shared: v }
    }
  }

  // environment
  if (!has('environment')) bad('environment', 'REQUIRED')
  else if (typeof body.environment !== 'string' || !OWNER_KEY_RE.test(body.environment)) {
    bad('environment', 'BAD_KEY')
  }

  // image
  if (!has('image')) bad('image', 'REQUIRED')
  else {
    const c = imageCode(body.image, cfg.images)
    if (c) bad('image', c)
  }

  // redis (read before env: REDIS_URL is forbidden only when bundled)
  const redis = body.redis
  if (redis !== 'bundled' && redis !== 'external') bad('redis', 'REQUIRED')
  else if (redis === 'bundled' && !cfg.redisImage) bad('redis', 'REDIS_NOT_CONFIGURED')

  // secrets
  const secrets: Record<string, string> = {}
  if (!isPlainObject(body.secrets)) bad('secrets', 'REQUIRED')
  else {
    const keys = own(body.secrets)
    if (keys.length > MAX_SECRETS) bad('secrets', 'TOO_MANY')
    for (const k of keys) {
      const v = body.secrets[k]
      const f = `secrets.${k}`
      if (!ENV_KEY_RE.test(k)) bad(f, 'BAD_KEY')
      else if (forbiddenKey(k, redis)) bad(f, 'ENV_FORBIDDEN')
      else if (typeof v !== 'string') bad(f, 'REQUIRED')
      else if (bytes(v) > MAX_SECRET_BYTES) bad(f, 'TOO_LONG')
      else secrets[k] = v
    }
  }

  // env
  const env: Record<string, string> = {}
  if (!isPlainObject(body.env)) bad('env', 'REQUIRED')
  else {
    const keys = own(body.env)
    if (keys.length > MAX_ENV) bad('env', 'TOO_MANY')
    const secretKeys = isPlainObject(body.secrets) ? own(body.secrets) : []
    for (const k of keys) {
      const v = body.env[k]
      const f = `env.${k}`
      if (!ENV_KEY_RE.test(k)) bad(f, 'BAD_KEY')
      else if (forbiddenKey(k, redis) || secretKeys.includes(k)) bad(f, 'ENV_FORBIDDEN')
      else if (typeof v !== 'string') bad(f, 'REQUIRED')
      else if (bytes(v) > MAX_ENV_BYTES) bad(f, 'TOO_LONG')
      else env[k] = v
    }
  }

  // roles
  const roles: RoleSpec[] = []
  let hasWeb = false
  if (!Array.isArray(body.roles) || body.roles.length === 0) bad('roles', 'REQUIRED')
  else {
    const seen = new Set<string>()
    let total = 0
    body.roles.forEach((r: unknown, i: number) => {
      const p = `roles[${i}]`
      if (!isPlainObject(r)) {
        bad(p, 'REQUIRED')
        return
      }
      for (const k of own(r)) if (!ROLE_FIELDS.has(k)) bad(`${p}.${k}`, 'UNKNOWN_FIELD')
      const role = r.role
      let okRole = false
      if (typeof role !== 'string' || !(ROLES as readonly string[]).includes(role)) {
        bad(`${p}.role`, 'ROLE_BAD')
      } else if (seen.has(role)) bad(`${p}.role`, 'ROLE_BAD')
      else {
        seen.add(role)
        okRole = true
      }
      const replicas = r.replicas
      const okReplicas =
        typeof replicas === 'number' &&
        Number.isInteger(replicas) &&
        replicas >= 0 &&
        replicas <= MAX_REPLICAS
      if (!okReplicas) bad(`${p}.replicas`, 'REPLICAS_BAD')
      else total += replicas as number

      const out: RoleSpec = { role: role as Role, replicas: replicas as number }
      if (Object.hasOwn(r, 'cpus')) {
        const c = r.cpus
        if (typeof c !== 'number' || !Number.isFinite(c) || c < 0.1 || c > 16) {
          bad(`${p}.cpus`, 'LIMIT_BAD')
        } else out.cpus = c
      }
      if (Object.hasOwn(r, 'memory_mb')) {
        const m = r.memory_mb
        if (typeof m !== 'number' || !Number.isInteger(m) || m < 128 || m > 65536) {
          bad(`${p}.memory_mb`, 'LIMIT_BAD')
        } else out.memory_mb = m
      }
      if (Object.hasOwn(r, 'env')) {
        if (!isPlainObject(r.env)) bad(`${p}.env`, 'REQUIRED')
        else {
          const renv: Record<string, string> = {}
          for (const k of own(r.env)) {
            const v = r.env[k]
            const f = `${p}.env.${k}`
            if (!ENV_KEY_RE.test(k)) bad(f, 'BAD_KEY')
            else if (!ROLE_ENV_KEYS.includes(k)) bad(f, 'ENV_FORBIDDEN')
            else if (typeof v !== 'string') bad(f, 'REQUIRED')
            else if (bytes(v) > MAX_ENV_BYTES) bad(f, 'TOO_LONG')
            else renv[k] = v
          }
          out.env = renv
        }
      }
      if (okRole && (role === 'web' || role === 'all')) hasWeb = true
      roles.push(out)
    })
    if (seen.has('all') && body.roles.length > 1) bad('roles', 'ROLE_BAD')
    if (total > MAX_TOTAL_REPLICAS) bad('roles', 'REPLICAS_BAD')
  }

  // hostnames
  const hostnames: string[] = []
  if (!Array.isArray(body.hostnames)) bad('hostnames', 'REQUIRED')
  else {
    if (body.hostnames.length > MAX_HOSTNAMES) bad('hostnames', 'TOO_MANY')
    if (cfg.edge === 'traefik' && body.hostnames.length === 0) bad('hostnames', 'REQUIRED')
    body.hostnames.forEach((h: unknown, i: number) => {
      const f = `hostnames[${i}]`
      if (typeof h !== 'string' || !isDnsName(h)) bad(f, 'HOSTNAME_NOT_ALLOWED')
      else if (cfg.edge === 'traefik' && !underSuffix(h, cfg.hostSuffixes)) {
        bad(f, 'HOSTNAME_NOT_ALLOWED')
      } else if (hostnames.includes(h)) bad(f, 'HOSTNAME_NOT_ALLOWED')
      else hostnames.push(h)
    })
  }

  // extensions
  const extensions: Record<string, string> = {}
  if (!isPlainObject(body.extensions)) bad('extensions', 'REQUIRED')
  else {
    const keys = own(body.extensions)
    if (keys.length > MAX_EXTENSIONS) bad('extensions', 'TOO_MANY')
    for (const id of keys) {
      const f = `extensions.${id}`
      if (!EXTENSION_ID_RE.test(id)) {
        bad(f, 'EXTENSION_ID_BAD')
        continue
      }
      const c = imageCode(body.extensions[id], cfg.images)
      if (c) bad(f, c)
      else extensions[id] = body.extensions[id] as string
    }
  }

  // publish_port
  let publishPort: number | undefined
  if (has('publish_port')) {
    const port = body.publish_port
    const range = cfg.publishPorts
    if (
      cfg.edge !== 'publish' ||
      !range ||
      typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < range[0] ||
      port > range[1]
    ) {
      bad('publish_port', 'PORT_NOT_ALLOWED')
    } else publishPort = port
  } else if (cfg.edge === 'publish' && hasWeb) bad('publish_port', 'REQUIRED')

  if (errs.length > 0 || !owner) return { ok: false, fields: errs }

  const spec: StackSpec = {
    owner,
    environment: body.environment as string,
    image: body.image as string,
    roles,
    env,
    secrets,
    hostnames,
    redis: redis as StackSpec['redis'],
    extensions
  }
  if (publishPort !== undefined) spec.publish_port = publishPort
  return { ok: true, spec }
}
