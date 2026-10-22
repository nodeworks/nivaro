/**
 * Read-only Docker Engine API source for the Infrastructure page.
 *
 * Nivaro never mounts the Docker socket. A deployment runs a socket proxy that allows GET only
 * (tecnativa/docker-socket-proxy with POST=0 and the read sections switched on) on an internal
 * network, and names it here:
 *
 *   DOCKER_HOSTS=staging=http://docker-proxy:2375,production=http://10.0.0.5:2375
 *   DOCKER_API_URL=http://docker-proxy:2375        (one host, named after TELEMETRY_STORE_ENV or 'local')
 *   DOCKER_API_TOKEN=                               (optional bearer, for a proxy behind an auth gateway)
 *   DOCKER_API_TIMEOUT_MS=5000
 *
 * Every read is a GET to an allowlisted path, cached briefly per host + path, and one host failing
 * never blanks the others (forEachDockerHost reports its error). Every answer goes through
 * sanitizeDockerValue before it is cached or returned, so no caller can hand environment
 * variables, join tokens or credential-looking labels and arguments to the browser. Off in cloud
 * mode: a tenant never sees the operator's hosts.
 */

import { createHash, createHmac } from 'node:crypto'

export interface DockerHost {
  name: string
  url: string
}

export class DockerUnavailableError extends Error {
  constructor(
    message: string,
    readonly host: string,
    readonly status: number | null = null
  ) {
    super(message)
    this.name = 'DockerUnavailableError'
  }
}

const cloud = () => !!process.env.CLOUD_META_DB_URL
const DEFAULT_TIMEOUT_MS = 5000
const DEFAULT_CACHE_MS = 15_000

/** Read sections of the Engine API this module may call (prefix match after the version segment). */
const ALLOWED = [
  '/_ping',
  '/version',
  '/info',
  '/system/df',
  '/containers/json',
  '/containers/', // /containers/{id}/json only — checked below
  '/services',
  '/tasks',
  '/nodes',
  '/networks',
  '/volumes',
  '/images/json',
  // Never '/swarm' (its JoinTokens are a cluster takeover; the cluster settings come from /info)
  // and never '/configs' (Spec.Data holds the config's contents, which often carry credentials).
  '/secrets'
]

function allowedPath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('..')) return false
  if (path.startsWith('/containers/') && path !== '/containers/json')
    return /^\/containers\/[A-Za-z0-9_.-]+\/json$/.test(path)
  return ALLOWED.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))
}

/** Keys removed wherever they appear. */
const DROP_KEYS = new Set(['Env', 'JoinTokens', 'UnlockKey'])
/** Label keys and argument flags whose VALUE is masked. */
const SECRETISH = /(secret|token|pass|key|credential|auth)/i
const MASK = '***'
/** Argument vectors (container Cmd / Entrypoint, service Args / Command). */
const ARG_KEYS = new Set(['Cmd', 'Args', 'Entrypoint', 'Command'])

/** `--password=x` → `--password=***`, and the word after `--password` / `-p`-style secret flags. */
export function maskArgs(args: string[]): string[] {
  const out: string[] = []
  let maskNext = false
  for (const a of args) {
    if (maskNext) {
      out.push(MASK)
      maskNext = false
      continue
    }
    const eq = /^(-{1,2}[^=\s]+)=(.*)$/.exec(a)
    if (eq && SECRETISH.test(eq[1])) {
      out.push(`${eq[1]}=${MASK}`)
      continue
    }
    // KEY=value style arguments (e.g. `env DB_PASSWORD=x cmd`).
    const kv = /^([A-Za-z_][A-Za-z0-9_.-]*)=(.*)$/.exec(a)
    if (kv && SECRETISH.test(kv[1])) {
      out.push(`${kv[1]}=${MASK}`)
      continue
    }
    if (/^-{1,2}[A-Za-z]/.test(a) && SECRETISH.test(a)) maskNext = true
    out.push(a)
  }
  return out
}

/** `https://user:token@host/…` → `https://***@host/…` (CI often bakes a job token into URLs). */
export const stripUrlCredentials = (s: string): string =>
  s.replace(/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, '$1***@')

/** A one-line command (container summary `Command`): masked word by word. */
export function maskCommandLine(cmd: string): string {
  return maskArgs(cmd.split(/\s+/).filter(Boolean)).join(' ')
}

/**
 * Deep copy of an Engine answer without what must never leave the API: `Env` anywhere, swarm
 * `JoinTokens` / `UnlockKey`, `Spec.Data` (config / secret contents), credential-looking label and
 * log-driver option values (key kept, value masked), secret flag values in commands, and the
 * user:password part of any URL.
 */
export function sanitizeDockerValue(value: unknown, parentKey = ''): unknown {
  if (Array.isArray(value)) {
    if (ARG_KEYS.has(parentKey) && value.every((v) => typeof v === 'string'))
      return maskArgs(value as string[])
    return value.map((v) => sanitizeDockerValue(v, parentKey))
  }
  if (typeof value === 'string')
    return stripUrlCredentials(parentKey === 'Command' ? maskCommandLine(value) : value)
  if (!value || typeof value !== 'object') return value
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (DROP_KEYS.has(k)) continue
    if (k === 'Data' && parentKey === 'Spec') continue
    if (k === 'Labels' && v && typeof v === 'object' && !Array.isArray(v)) {
      const labels: Record<string, unknown> = {}
      for (const [lk, lv] of Object.entries(v as Record<string, unknown>))
        labels[lk] = SECRETISH.test(lk) ? MASK : sanitizeDockerValue(lv, lk)
      out[k] = labels
      continue
    }
    // Log driver options carry credentials for remote drivers (splunk-token, awslogs keys…).
    if (k === 'LogConfig' && v && typeof v === 'object' && !Array.isArray(v)) {
      const lc = sanitizeDockerValue(v, k) as Record<string, unknown>
      if (lc.Config && typeof lc.Config === 'object' && !Array.isArray(lc.Config))
        lc.Config = Object.fromEntries(
          Object.entries(lc.Config as Record<string, unknown>).map(([ck, cv]) => [
            ck,
            SECRETISH.test(ck) ? MASK : cv
          ])
        )
      out[k] = lc
      continue
    }
    out[k] = sanitizeDockerValue(v, k)
  }
  return out
}

// ── Environment digests (#2798 stack drift) ──────────────────────────────────
//
// The drift detector must notice an env change without ever holding a secret. `digestEnv` turns
// a service's `Env` array into a KEY → value map in which every value that looks secret (by its
// key, URL credentials, or a long token-like value) is replaced by a keyed hash. The hash key is
// this deployment's SESSION_SECRET, so a stored hash cannot be brute-forced offline from the
// database alone. Only the drift paths ask for this (`env: 'digest'` on a /services read, or
// `sanitizeServiceSpec` on a posted inspect object); everything else still drops `Env` outright.

/** Env keys whose value is never kept in clear. */
const ENV_SECRET_KEY =
  /(secret|token|pass|key|credential|auth|dsn|private|cookie|signing|salt|cert)/i
/** A long unbroken token-like value (API keys, JWTs, base64 blobs) is hashed whatever its key. */
const TOKENISH = /^[A-Za-z0-9+/=_.-]{32,}$/
export const ENV_HASH_PREFIX = 'hmac:'

function envHashKey(): string {
  return process.env.SESSION_SECRET || 'nivaro-env-digest'
}

/** Which hash key the digests were made with (a short fingerprint, never the key). */
export function envDigestKeyId(): string {
  return createHash('sha256').update(envHashKey()).digest('hex').slice(0, 8)
}

/** True when this env value is kept only as a hash. */
export function envValueIsSecret(key: string, value: string): boolean {
  if (ENV_SECRET_KEY.test(key)) return true
  if (/\b[a-z][a-z0-9+.-]*:\/\/[^\s/@]+@/i.test(value)) return true
  return TOKENISH.test(value) && /\d/.test(value) && /[A-Za-z]/.test(value)
}

/** `['A=1', 'DB_PASSWORD=x']` → `{ A: '1', DB_PASSWORD: 'hmac:…' }` (later duplicates win). */
export function digestEnv(env: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (!Array.isArray(env)) return out
  for (const raw of env) {
    if (typeof raw !== 'string') continue
    const eq = raw.indexOf('=')
    const key = (eq < 0 ? raw : raw.slice(0, eq)).trim()
    if (!key || key.length > 200) continue
    const value = eq < 0 ? '' : raw.slice(eq + 1)
    out[key] = envValueIsSecret(key, value)
      ? `${ENV_HASH_PREFIX}${createHmac('sha256', envHashKey()).update(value).digest('hex').slice(0, 32)}`
      : value.slice(0, 2000)
  }
  return out
}

/**
 * One service object (a `docker service inspect` entry, from the Engine or posted by a deploy
 * script) through the central sanitizer, with each `Env` block replaced by its digest map under
 * `EnvDigest` (secret values hashed). The rest is exactly what `sanitizeDockerValue` returns.
 */
export function sanitizeServiceSpec(value: unknown): unknown {
  return digestEnvBlocks(value, '')
}

const SPEC_CONTAINERS = new Set(['Spec', 'PreviousSpec', 'TaskTemplate', 'ContainerSpec'])

function digestEnvBlocks(value: unknown, parentKey: string): unknown {
  if (Array.isArray(value)) return value.map((v) => digestEnvBlocks(v, parentKey))
  if (!value || typeof value !== 'object') return sanitizeDockerValue(value, parentKey)
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (k === 'Env') {
      out.EnvDigest = digestEnv(v)
      continue
    }
    if (SPEC_CONTAINERS.has(k)) {
      out[k] = digestEnvBlocks(v, k)
      continue
    }
    // Every other key goes through the sanitizer exactly as a plain read would (dropped keys
    // stay dropped; labels, log config and arguments keep their masking).
    const one = sanitizeDockerValue({ [k]: v }, parentKey) as Record<string, unknown>
    if (k in one) out[k] = one[k]
  }
  return out
}

function cleanUrl(raw: string): string | null {
  const url = raw.trim().replace(/\/+$/, '')
  return /^https?:\/\/[^\s]+$/i.test(url) ? url : null
}

/** The configured hosts, in configuration order. Empty when not configured or in cloud mode. */
export function dockerHosts(): DockerHost[] {
  if (cloud()) return []
  const list = process.env.DOCKER_HOSTS?.trim()
  if (list) {
    const out: DockerHost[] = []
    for (const part of list.split(',')) {
      const eq = part.indexOf('=')
      if (eq <= 0) continue
      const name = part.slice(0, eq).trim()
      const url = cleanUrl(part.slice(eq + 1))
      if (name && url && /^[A-Za-z0-9_.-]{1,40}$/.test(name) && !out.some((h) => h.name === name))
        out.push({ name, url })
    }
    return out
  }
  const one = cleanUrl(process.env.DOCKER_API_URL ?? '')
  if (!one) return []
  return [{ name: process.env.TELEMETRY_STORE_ENV?.trim() || 'local', url: one }]
}

export const dockerConfigured = (): boolean => dockerHosts().length > 0

function timeoutMs(): number {
  const t = Number(process.env.DOCKER_API_TIMEOUT_MS)
  return Number.isFinite(t) && t >= 500 ? Math.min(t, 60_000) : DEFAULT_TIMEOUT_MS
}

type DockerFetch = (url: string, init: RequestInit) => Promise<Response>
let fetchImpl: DockerFetch = (url, init) => fetch(url, init)
export function setDockerFetchForTests(f: DockerFetch | null): void {
  fetchImpl = f ?? ((url, init) => fetch(url, init))
  cache.clear()
}

const cache = new Map<string, { at: number; value: unknown }>()
const inflight = new Map<string, Promise<unknown>>()

export function clearDockerCache(): void {
  cache.clear()
}

export interface DockerGetOptions {
  /** Query parameters; objects (e.g. `filters`) are JSON-encoded as the Engine API expects. */
  query?: Record<string, string | number | boolean | object | undefined>
  /** How long a result is reused (default 15 s; 0 = always fresh). */
  cacheMs?: number
  /**
   * 'digest' (only on /services) keeps each service's env as a KEY → value map with secret
   * values hashed (`EnvDigest`, see digestEnv) — for the drift detector. Default: Env dropped.
   */
  env?: 'drop' | 'digest'
}

function buildPath(path: string, query?: DockerGetOptions['query']): string {
  if (!query) return path
  const qs = new URLSearchParams()
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v))
  }
  const s = qs.toString()
  return s ? `${path}?${s}` : path
}

/** One GET against one host. Throws DockerUnavailableError on refusal, timeout or a non-2xx. */
export async function dockerGet<T = unknown>(
  host: DockerHost,
  path: string,
  opts: DockerGetOptions = {}
): Promise<T> {
  if (!allowedPath(path)) throw new DockerUnavailableError(`Path not allowed: ${path}`, host.name)
  const digest = opts.env === 'digest'
  if (digest && !(path === '/services' || path.startsWith('/services/')))
    throw new DockerUnavailableError(`Env digests are only read from /services`, host.name)
  const full = buildPath(path, opts.query)
  const key = `${host.name}|${digest ? 'env:' : ''}${full}`
  const ttl = opts.cacheMs ?? DEFAULT_CACHE_MS
  const hit = cache.get(key)
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return hit.value as T
  const running = inflight.get(key)
  if (running) return running as Promise<T>

  const p = (async () => {
    const headers: Record<string, string> = { accept: 'application/json' }
    const token = process.env.DOCKER_API_TOKEN?.trim()
    if (token) headers.authorization = `Bearer ${token}`
    let res: Response
    try {
      res = await fetchImpl(`${host.url}${full}`, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(timeoutMs())
      })
    } catch (err) {
      const msg =
        (err as Error)?.name === 'TimeoutError' ? 'timed out' : String((err as Error)?.message)
      throw new DockerUnavailableError(`Docker on ${host.name} did not answer (${msg})`, host.name)
    }
    if (!res.ok) {
      // A socket proxy answers 403 for a section it does not allow.
      const why = res.status === 403 ? 'section not enabled on the proxy' : `HTTP ${res.status}`
      throw new DockerUnavailableError(
        `Docker on ${host.name} refused ${path} (${why})`,
        host.name,
        res.status
      )
    }
    // Sanitized BEFORE the cache, so no cached copy ever holds what was stripped.
    const body = await res.json()
    const value = (digest ? sanitizeServiceSpec(body) : sanitizeDockerValue(body)) as T
    cache.set(key, { at: Date.now(), value })
    if (cache.size > 2000) cache.delete(cache.keys().next().value as string)
    return value
  })()
  inflight.set(key, p)
  try {
    return (await p) as T
  } finally {
    inflight.delete(key)
  }
}

export interface PerHost<T> {
  host: string
  data: T | null
  error: string | null
}

/** Runs `fn` against every configured host in parallel; a failing host reports its error. */
export async function forEachDockerHost<T>(
  fn: (host: DockerHost) => Promise<T>
): Promise<PerHost<T>[]> {
  return Promise.all(
    dockerHosts().map(async (host) => {
      try {
        return { host: host.name, data: await fn(host), error: null }
      } catch (err) {
        return { host: host.name, data: null, error: String((err as Error)?.message ?? err) }
      }
    })
  )
}

export function dockerHostByName(name: string | undefined): DockerHost | null {
  if (!name) return null
  return dockerHosts().find((h) => h.name === name) ?? null
}

/** Compose / stack ownership labels, read the same way everywhere. */
export function ownerOf(labels: Record<string, string> | null | undefined): {
  stack: string | null
  service: string | null
  compose_project: string | null
  compose_service: string | null
} {
  const l = labels ?? {}
  return {
    stack: l['com.docker.stack.namespace'] ?? null,
    service: l['com.docker.swarm.service.name'] ?? null,
    compose_project: l['com.docker.compose.project'] ?? null,
    compose_service: l['com.docker.compose.service'] ?? null
  }
}
