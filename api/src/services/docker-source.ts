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
 * never blanks the others (forEachDockerHost reports its error). Off in cloud mode: a tenant never
 * sees the operator's hosts.
 */

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
  '/swarm',
  '/networks',
  '/volumes',
  '/images/json',
  '/secrets',
  '/configs'
]

function allowedPath(path: string): boolean {
  if (!path.startsWith('/') || path.includes('..')) return false
  if (path.startsWith('/containers/') && path !== '/containers/json')
    return /^\/containers\/[A-Za-z0-9_.-]+\/json$/.test(path)
  return ALLOWED.some((p) => path === p || path.startsWith(`${p}/`) || path.startsWith(`${p}?`))
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
  const full = buildPath(path, opts.query)
  const key = `${host.name}|${full}`
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
    const value = (await res.json()) as T
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
