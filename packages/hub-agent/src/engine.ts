/**
 * The Docker Engine client. It may make only the calls in ENGINE_RULES;
 * anything else throws EngineForbiddenError before any I/O. No exec, attach,
 * logs, start, build, commit, plugins, /swarm or node calls exist here, so no
 * caller (and no bug in a caller) can reach them.
 *
 * Every rule is a method + path pattern AND an allow-list of query keys and
 * values (no query unless the rule names it): the Engine reads options such as
 * `rollback=previous`, `force` or an archive `path` from the query, so an
 * unchecked query would walk around every body check.
 *
 * Write bodies get a second check (defence in depth behind the StackSpec
 * validator): images only from the allow-list and pinned by digest; no
 * privileges, added capabilities, sysctls, runtimes or plugins; bind mounts
 * only read-only under the extension root; volumes only `nvh_` ones with the
 * configured driver and options (never a driver bind of a host path);
 * networks only `nvh_` ones or the edge network, overlay only; published
 * ports only inside the configured range; a created container has no
 * HostConfig at all (it is only ever read through /archive, never started).
 */
import http from 'node:http'
import path from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { type AgentConfig, PINNED_IMAGE_RE } from './config.js'

export const ENGINE_API_PREFIX = '/v1.44'

export type EngineMethod = 'GET' | 'POST' | 'DELETE'

/** One Engine object id or name: services, secrets, networks, volumes, containers. */
const ID = '[A-Za-z0-9][A-Za-z0-9_.-]{0,254}'
/** An image reference for inspect: repo[:tag] or repo@sha256:<hex>. */
const REF = '[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})?'

/** Prefix of every object name the agent creates. */
export const HUB_NAME_PREFIX = 'nvh_'

type QueryValue = string | number | boolean
type QueryRule = Readonly<Record<string, (v: QueryValue) => boolean>>

const isString = (v: QueryValue) => typeof v === 'string'
const isBool = (v: QueryValue) =>
  v === true || v === false || v === 'true' || v === 'false' || v === '1' || v === '0'
const isVersion = (v: QueryValue) =>
  (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ||
  (typeof v === 'string' && /^[0-9]{1,18}$/.test(v))

const NO_QUERY: QueryRule = Object.freeze({})
const FILTERS: QueryRule = Object.freeze({ filters: isString })

export type EngineRule = Readonly<{
  method: EngineMethod
  re: RegExp
  query: QueryRule
  /** The caller may send X-Registry-Auth. */
  registryAuth?: true
}>

export const ENGINE_RULES: ReadonlyArray<EngineRule> = Object.freeze([
  { method: 'GET', re: /^\/version$/, query: NO_QUERY },
  { method: 'GET', re: /^\/info$/, query: NO_QUERY },
  { method: 'GET', re: /^\/services$/, query: FILTERS },
  { method: 'GET', re: new RegExp(`^/services/${ID}$`), query: NO_QUERY },
  { method: 'GET', re: /^\/tasks$/, query: FILTERS },
  { method: 'GET', re: /^\/networks$/, query: NO_QUERY },
  { method: 'GET', re: /^\/secrets$/, query: NO_QUERY },
  { method: 'GET', re: /^\/volumes$/, query: NO_QUERY },
  { method: 'GET', re: new RegExp(`^/images/${REF}/json$`), query: NO_QUERY },
  {
    method: 'GET',
    re: new RegExp(`^/containers/${ID}/archive$`),
    query: Object.freeze({ path: (v: QueryValue) => v === '/extension' })
  },
  { method: 'POST', re: /^\/services\/create$/, query: NO_QUERY, registryAuth: true },
  {
    method: 'POST',
    re: new RegExp(`^/services/${ID}/update$`),
    query: Object.freeze({
      version: isVersion,
      registryAuthFrom: (v: QueryValue) => v === 'spec' || v === 'previous-spec'
    }),
    registryAuth: true
  },
  { method: 'POST', re: /^\/networks\/create$/, query: NO_QUERY },
  { method: 'POST', re: /^\/secrets\/create$/, query: NO_QUERY },
  { method: 'POST', re: /^\/volumes\/create$/, query: NO_QUERY },
  {
    method: 'POST',
    re: /^\/images\/create$/,
    query: Object.freeze({ fromImage: isString, tag: isString }),
    registryAuth: true
  },
  { method: 'POST', re: /^\/containers\/create$/, query: NO_QUERY },
  { method: 'DELETE', re: new RegExp(`^/services/${ID}$`), query: NO_QUERY },
  { method: 'DELETE', re: new RegExp(`^/secrets/${ID}$`), query: NO_QUERY },
  { method: 'DELETE', re: new RegExp(`^/networks/${ID}$`), query: NO_QUERY },
  { method: 'DELETE', re: new RegExp(`^/volumes/${ID}$`), query: NO_QUERY },
  {
    method: 'DELETE',
    re: new RegExp(`^/containers/${ID}$`),
    query: Object.freeze({ force: isBool })
  }
] as EngineRule[])

/** The method + path pairs (the query rules live in ENGINE_RULES). */
export const ENGINE_ALLOWED: ReadonlyArray<[EngineMethod, RegExp]> = Object.freeze(
  ENGINE_RULES.map((r) => [r.method, r.re] as [EngineMethod, RegExp])
)

export class EngineForbiddenError extends Error {
  readonly code = 'ENGINE_FORBIDDEN'
  constructor(reason: string) {
    super(`Engine call refused: ${reason}`)
    this.name = 'EngineForbiddenError'
  }
}

export class EngineError extends Error {
  readonly code: 'ENGINE_UNREACHABLE' | 'ENGINE_TIMEOUT' | 'ENGINE_RESPONSE_TOO_LARGE'
  constructor(code: EngineError['code']) {
    super(code)
    this.name = 'EngineError'
    this.code = code
  }
}

export type Transport = (
  options: http.RequestOptions,
  onResponse: (res: http.IncomingMessage) => void
) => http.ClientRequest

export type EngineCallOptions = {
  body?: unknown
  query?: Record<string, QueryValue | undefined>
  headers?: Record<string, string>
  /** Default 60 s. Image pulls pass more. */
  timeoutMs?: number
}

export interface Engine {
  call<T = unknown>(
    method: EngineMethod,
    path: string,
    opts?: EngineCallOptions
  ): Promise<{ status: number; body: T }>
  /** Same allow-list; the response is handed over unread (container archives). */
  stream(
    method: EngineMethod,
    path: string,
    opts?: EngineCallOptions
  ): Promise<{ status: number; stream: http.IncomingMessage }>
}

/** JSON answers above this are refused (lists of a big swarm stay far below). */
const MAX_JSON_BYTES = 32 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function refuse(reason: string): never {
  throw new EngineForbiddenError(reason)
}

function findRule(method: string, p: string): EngineRule {
  if (typeof p !== 'string' || !p.startsWith('/')) refuse('path must start with /')
  // Only plain characters: no %-escapes, query, fragment, backslash or space.
  if (!/^[A-Za-z0-9._/:@-]+$/.test(p)) refuse('path characters')
  const segments = p.slice(1).split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..')) refuse('path segments')
  const rule = ENGINE_RULES.find((r) => r.method === method && r.re.test(p))
  if (!rule) refuse('not on the allow-list')
  return rule
}

function checkQuery(rule: EngineRule, query: EngineCallOptions['query']): void {
  if (query === undefined) return
  if (!isPlainObject(query)) refuse('query')
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined) continue
    const ok = Object.hasOwn(rule.query, k) ? rule.query[k] : undefined
    if (!ok?.(v)) refuse(`query key ${k}`)
  }
}

function checkHeaders(rule: EngineRule, opts: EngineCallOptions): void {
  for (const k of Object.keys(opts.headers ?? {})) {
    if (k.toLowerCase() !== 'x-registry-auth' || !rule.registryAuth) refuse('header')
  }
}

function lowerHeaders(opts: EngineCallOptions): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) out[k.toLowerCase()] = String(v)
  return out
}

function allowedImage(cfg: AgentConfig, image: unknown): boolean {
  if (typeof image !== 'string') return false
  if (cfg.redisImage && image === cfg.redisImage) return true
  const m = PINNED_IMAGE_RE.exec(image)
  return !!m && cfg.images.includes(m[1])
}

function hubName(v: unknown): boolean {
  return typeof v === 'string' && v.startsWith(HUB_NAME_PREFIX) && v.length > HUB_NAME_PREFIX.length
}

function insideRoot(root: string, source: unknown): boolean {
  if (typeof source !== 'string' || !source.startsWith('/')) return false
  const resolved = path.posix.normalize(source)
  if (resolved !== source.replace(/\/+$/, '')) return false
  const base = root.endsWith('/') ? root : `${root}/`
  return resolved.startsWith(base)
}

function checkMount(cfg: AgentConfig, m: unknown): void {
  if (!isPlainObject(m)) refuse('service mount')
  if (m.Type === 'volume') {
    if (!hubName(m.Source)) refuse('volume mount source')
    if (m.BindOptions !== undefined || m.TmpfsOptions !== undefined) refuse('volume mount options')
    if (m.VolumeOptions !== undefined) {
      if (!isPlainObject(m.VolumeOptions)) refuse('volume options')
      // A driver config can turn a "volume" into a bind of any host path.
      if (m.VolumeOptions.DriverConfig !== undefined) refuse('volume DriverConfig')
    }
    return
  }
  if (m.Type === 'tmpfs') {
    if (m.BindOptions !== undefined || m.VolumeOptions !== undefined) refuse('tmpfs mount options')
    return
  }
  if (m.Type === 'bind') {
    if (m.ReadOnly !== true || !insideRoot(cfg.extensionsHostRoot, m.Source))
      refuse('bind mount source')
    if (m.VolumeOptions !== undefined || m.TmpfsOptions !== undefined) refuse('bind mount options')
    if (m.BindOptions !== undefined) {
      if (!isPlainObject(m.BindOptions)) refuse('bind options')
      if (m.BindOptions.Propagation !== undefined) refuse('bind Propagation')
      if (m.BindOptions.ReadOnlyNonRecursive !== undefined) refuse('bind ReadOnlyNonRecursive')
    }
    return
  }
  refuse('service mount type')
}

function checkNetworkTargets(cfg: AgentConfig, nets: unknown): void {
  if (nets === undefined) return
  if (!Array.isArray(nets)) refuse('service networks')
  for (const n of nets) {
    // Names only: the Engine also resolves ids and id prefixes, so a deny-list
    // of names cannot hold. Only our own networks and the edge network.
    if (
      !isPlainObject(n) ||
      !(hubName(n.Target) || (cfg.edgeNetwork !== '' && n.Target === cfg.edgeNetwork))
    ) {
      refuse('service network')
    }
  }
}

function checkEndpoint(cfg: AgentConfig, ep: unknown): void {
  if (ep === undefined) return
  if (!isPlainObject(ep)) refuse('endpoint spec')
  const ports = ep.Ports ?? []
  if (!Array.isArray(ports)) refuse('endpoint ports')
  if (ports.length === 0) return
  const range = cfg.edge === 'publish' ? cfg.publishPorts : null
  if (!range) refuse('published ports')
  for (const p of ports) {
    if (
      !isPlainObject(p) ||
      typeof p.PublishedPort !== 'number' ||
      !Number.isInteger(p.PublishedPort) ||
      p.PublishedPort < range[0] ||
      p.PublishedPort > range[1] ||
      (p.Protocol !== undefined && p.Protocol !== 'tcp')
    ) {
      refuse('published port')
    }
  }
}

function checkServiceBody(cfg: AgentConfig, body: Record<string, unknown>): void {
  const task = body.TaskTemplate
  if (!isPlainObject(task)) refuse('service without TaskTemplate')
  if (task.PluginSpec !== undefined) refuse('service PluginSpec')
  if (task.Runtime !== undefined && task.Runtime !== '' && task.Runtime !== 'container')
    refuse('service Runtime')
  const spec = task.ContainerSpec
  if (!isPlainObject(spec)) refuse('service without ContainerSpec')
  if (!allowedImage(cfg, spec.Image)) refuse('service image')
  for (const k of ['Privileges', 'CapabilityAdd', 'Sysctls', 'Isolation']) {
    if (spec[k] !== undefined) refuse(`service ${k}`)
  }
  const mounts = spec.Mounts ?? []
  if (!Array.isArray(mounts)) refuse('service mounts')
  for (const m of mounts) checkMount(cfg, m)
  checkNetworkTargets(cfg, task.Networks)
  checkNetworkTargets(cfg, body.Networks)
  checkEndpoint(cfg, body.EndpointSpec)
}

function checkVolumeCreate(cfg: AgentConfig, body: Record<string, unknown>): void {
  for (const k of Object.keys(body)) {
    if (!['Name', 'Driver', 'DriverOpts', 'Labels'].includes(k)) refuse(`volume ${k}`)
  }
  if (!hubName(body.Name)) refuse('volume name')
  if (body.Driver !== cfg.volumeDriver) refuse('volume driver')
  if (!isDeepStrictEqual(body.DriverOpts ?? {}, cfg.volumeOpts)) refuse('volume driver options')
}

function checkNetworkCreate(body: Record<string, unknown>): void {
  if (!hubName(body.Name)) refuse('network name')
  if (body.Driver !== 'overlay') refuse('network driver')
  for (const k of ['Ingress', 'ConfigFrom', 'ConfigOnly']) {
    if (body[k] !== undefined) refuse(`network ${k}`)
  }
}

function checkSecretCreate(body: Record<string, unknown>): void {
  if (!hubName(body.Name)) refuse('secret name')
  if (body.Driver !== undefined) refuse('secret Driver')
  if (body.Templating !== undefined) refuse('secret Templating')
}

function checkBody(
  cfg: AgentConfig,
  method: EngineMethod,
  p: string,
  opts: EngineCallOptions
): void {
  if (method !== 'POST') {
    if (opts.body !== undefined) refuse('body on a non-POST call')
    return
  }
  if (p === '/images/create') {
    if (opts.body !== undefined) refuse('pull body')
    const from = opts.query?.fromImage
    const tag = opts.query?.tag
    if (typeof from !== 'string') refuse('pull without fromImage')
    const ref =
      tag === undefined
        ? from
        : typeof tag === 'string' && tag.startsWith('sha256:')
          ? `${from}@${tag}`
          : null
    if (!ref || !allowedImage(cfg, ref)) refuse('pull image')
    return
  }
  const body = opts.body
  if (!isPlainObject(body)) refuse('POST body must be an object')
  if (p === '/services/create' || /^\/services\/[^/]+\/update$/.test(p)) checkServiceBody(cfg, body)
  else if (p === '/volumes/create') checkVolumeCreate(cfg, body)
  else if (p === '/networks/create') checkNetworkCreate(body)
  else if (p === '/secrets/create') checkSecretCreate(body)
  else if (p === '/containers/create') {
    if (!allowedImage(cfg, body.Image)) refuse('container image')
    const hc = body.HostConfig
    if (hc !== undefined && !(isPlainObject(hc) && Object.keys(hc).length === 0)) {
      refuse('container HostConfig')
    }
  }
}

/** Throws EngineForbiddenError when the call is not allowed. Pure; does no I/O. */
export function checkEngineCall(
  cfg: AgentConfig,
  method: string,
  p: string,
  opts: EngineCallOptions = {}
): void {
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE') refuse('method')
  const rule = findRule(method, p)
  checkQuery(rule, opts.query)
  checkHeaders(rule, opts)
  checkBody(cfg, method, p, opts)
}

function buildQuery(q: EngineCallOptions['query']): string {
  if (!q) return ''
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries(q)) if (v !== undefined) params.append(k, String(v))
  const s = params.toString()
  return s ? `?${s}` : ''
}

const defaultTransport: Transport = (options, onResponse) => http.request(options, onResponse)

export function createEngine(cfg: AgentConfig, transport: Transport = defaultTransport): Engine {
  function open(
    method: EngineMethod,
    p: string,
    opts: EngineCallOptions
  ): Promise<{ res: http.IncomingMessage; req: http.ClientRequest }> {
    // Every check runs before the transport is touched.
    checkEngineCall(cfg, method, p, opts)
    const headers = lowerHeaders(opts)
    const payload = opts.body === undefined ? undefined : Buffer.from(JSON.stringify(opts.body))
    if (payload) {
      headers['content-type'] = 'application/json'
      headers['content-length'] = String(payload.length)
    }
    const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    return new Promise((resolve, reject) => {
      let settled = false
      const fail = (err: Error) => {
        if (settled) return
        settled = true
        reject(err)
      }
      const req = transport(
        {
          socketPath: cfg.socket,
          method,
          path: `${ENGINE_API_PREFIX}${p}${buildQuery(opts.query)}`,
          headers: { host: 'docker', ...headers }
        },
        (res) => {
          if (settled) {
            res.resume()
            return
          }
          settled = true
          resolve({ res, req })
        }
      )
      req.setTimeout(timeoutMs, () => {
        fail(new EngineError('ENGINE_TIMEOUT'))
        req.destroy()
      })
      req.on('error', (err: NodeJS.ErrnoException) => {
        fail(new EngineError(err.code === 'ETIMEDOUT' ? 'ENGINE_TIMEOUT' : 'ENGINE_UNREACHABLE'))
      })
      if (payload) req.write(payload)
      req.end()
    })
  }

  return {
    async call<T>(method: EngineMethod, p: string, opts: EngineCallOptions = {}) {
      const { res, req } = await open(method, p, opts)
      const chunks: Buffer[] = []
      let size = 0
      await new Promise<void>((resolve, reject) => {
        res.on('data', (c: Buffer) => {
          size += c.length
          if (size > MAX_JSON_BYTES) {
            req.destroy()
            reject(new EngineError('ENGINE_RESPONSE_TOO_LARGE'))
            return
          }
          chunks.push(c)
        })
        res.on('end', resolve)
        res.on('error', () => reject(new EngineError('ENGINE_UNREACHABLE')))
        res.on('aborted', () => reject(new EngineError('ENGINE_UNREACHABLE')))
      })
      const text = Buffer.concat(chunks).toString('utf8')
      let body: unknown = text
      if (text && /json/i.test(String(res.headers['content-type'] ?? ''))) {
        try {
          body = JSON.parse(text)
        } catch {
          // An image pull answers a stream of JSON lines; the raw text is kept.
          body = text
        }
      } else if (!text) {
        body = null
      }
      return { status: res.statusCode ?? 0, body: body as T }
    },

    async stream(method: EngineMethod, p: string, opts: EngineCallOptions = {}) {
      const { res } = await open(method, p, opts)
      return { status: res.statusCode ?? 0, stream: res }
    }
  }
}
