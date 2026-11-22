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
import { type AgentConfig, PINNED_IMAGE_RE, volumeOptsSafe } from './config.js'
import { LABEL_MANAGED, LABEL_NAMESPACE } from './names.js'

export const ENGINE_API_PREFIX = '/v1.44'

export type EngineMethod = 'GET' | 'POST' | 'DELETE'

/** One Engine object id or name: services, secrets, networks, volumes, containers. */
const ID = '[A-Za-z0-9][A-Za-z0-9_.-]{0,254}'
/** An image reference for inspect: repo[:tag] or repo@sha256:<hex>. */
const REF = '[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})?'

/** Prefix of every object name the agent creates. */
export const HUB_NAME_PREFIX = 'nvh_'

/**
 * Ownership as the guard can see it (defence in depth behind the stack
 * operations' own checks). Every name the agent writes or deletes is one of
 * these shapes, so the stack it belongs to can be read off the name, and the
 * body's labels must name the same stack. Objects are always addressed by
 * NAME on write and delete paths (never by id), so the guard can judge them.
 * A stack name holds no `_`, so `nvh_a_X` can never belong to stack `a-b`.
 */
const STACK_PART = '[a-z][a-z0-9-]{0,40}'
/** `<stack>_<role>`: every service the agent creates. */
export const HUB_SERVICE_NAME_RE = new RegExp(
  `^(${STACK_PART})_(all|web|worker|realtime|importer|redis)$`
)
/** `nvh_<stack>` (network) or `nvh_<stack>_<rest>` (secrets, volumes, containers). */
export const HUB_OBJECT_NAME_RE = new RegExp(`^nvh_(${STACK_PART})(?:_[A-Za-z0-9_.@-]+)?$`)
/** The never-started container an extension image is read from. */
export const HUB_UNPACK_NAME_RE = new RegExp(`^nvh_(${STACK_PART})_unpack_[a-f0-9]{8,32}$`)
export const LABEL_UNPACK = 'nivaro.hub.unpack'
/** Docker object ids: what a secret reference carries next to its name. */
const OBJECT_ID_RE = /^[A-Za-z0-9]{1,64}$/

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
    re: new RegExp(`^/containers/nvh_${STACK_PART}_unpack_[a-f0-9]{8,32}/archive$`),
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
  {
    method: 'POST',
    re: /^\/containers\/create$/,
    query: Object.freeze({
      name: (v: QueryValue) => typeof v === 'string' && HUB_UNPACK_NAME_RE.test(v)
    })
  },
  { method: 'DELETE', re: new RegExp(`^/services/${ID}$`), query: NO_QUERY },
  { method: 'DELETE', re: new RegExp(`^/secrets/${ID}$`), query: NO_QUERY },
  { method: 'DELETE', re: new RegExp(`^/networks/${ID}$`), query: NO_QUERY },
  { method: 'DELETE', re: new RegExp(`^/volumes/${ID}$`), query: NO_QUERY },
  {
    method: 'DELETE',
    re: new RegExp(`^/containers/nvh_${STACK_PART}_unpack_[a-f0-9]{8,32}$`),
    // v: the anonymous volumes an extension image may declare go with its container.
    query: Object.freeze({ force: isBool, v: isBool })
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

/** The stack an `nvh_` object name belongs to, or null. */
function objectStack(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = HUB_OBJECT_NAME_RE.exec(v)
  return m ? m[1] : null
}

/** Labels that mark an object as the agent's own, for this stack. */
function ownedBy(labels: unknown, stack: string): boolean {
  return isPlainObject(labels) && labels[LABEL_MANAGED] === '1' && labels[LABEL_NAMESPACE] === stack
}

function insideRoot(root: string, source: unknown): boolean {
  if (typeof source !== 'string' || !source.startsWith('/')) return false
  const resolved = path.posix.normalize(source)
  if (resolved !== source.replace(/\/+$/, '')) return false
  const base = root.endsWith('/') ? root : `${root}/`
  return resolved.startsWith(base)
}

/**
 * A volume mount may carry a DriverConfig only when it is exactly the agent's
 * configured driver and options (checked safe at start and again here): any
 * other driver config can turn a "volume" into a bind of a host path. Swarm
 * needs it to create the volume the same way on every node a task lands on.
 */
function driverConfigOk(cfg: AgentConfig, dc: unknown): boolean {
  if (!isPlainObject(dc)) return false
  if (Object.keys(dc).some((k) => k !== 'Name' && k !== 'Options')) return false
  if (dc.Name !== cfg.volumeDriver) return false
  const opts = dc.Options ?? {}
  return isPlainObject(opts) && volumeOptsSafe(opts) && isDeepStrictEqual(opts, cfg.volumeOpts)
}

function checkMount(cfg: AgentConfig, stack: string, m: unknown): void {
  if (!isPlainObject(m)) refuse('service mount')
  if (m.Type === 'volume') {
    if (!hubName(m.Source) || objectStack(m.Source) !== stack || m.Source === `nvh_${stack}`)
      refuse('volume mount source')
    if (m.BindOptions !== undefined || m.TmpfsOptions !== undefined) refuse('volume mount options')
    if (m.VolumeOptions !== undefined) {
      if (!isPlainObject(m.VolumeOptions)) refuse('volume options')
      if (
        m.VolumeOptions.DriverConfig !== undefined &&
        !driverConfigOk(cfg, m.VolumeOptions.DriverConfig)
      )
        refuse('volume DriverConfig')
    }
    return
  }
  if (m.Type === 'tmpfs') {
    if (m.BindOptions !== undefined || m.VolumeOptions !== undefined) refuse('tmpfs mount options')
    return
  }
  if (m.Type === 'bind') {
    const stackRoot = `${cfg.extensionsHostRoot.replace(/\/+$/, '')}/${stack}`
    if (m.ReadOnly !== true || !insideRoot(stackRoot, m.Source)) refuse('bind mount source')
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

function checkNetworkTargets(cfg: AgentConfig, stack: string, nets: unknown): void {
  if (nets === undefined) return
  if (!Array.isArray(nets)) refuse('service networks')
  for (const n of nets) {
    // Names only: the Engine also resolves ids and id prefixes, so a deny-list
    // of names cannot hold. Only this stack's network and the edge network.
    if (
      !isPlainObject(n) ||
      !(n.Target === `nvh_${stack}` || (cfg.edgeNetwork !== '' && n.Target === cfg.edgeNetwork))
    ) {
      refuse('service network')
    }
  }
}

/** Secret references only by this stack's own `nvh_<stack>_` names; no configs at all. */
function checkSecretRefs(stack: string, spec: Record<string, unknown>): void {
  if (spec.Configs !== undefined && !(Array.isArray(spec.Configs) && spec.Configs.length === 0))
    refuse('service Configs')
  const refs = spec.Secrets ?? []
  if (!Array.isArray(refs)) refuse('service secrets')
  for (const r of refs) {
    if (
      !isPlainObject(r) ||
      typeof r.SecretID !== 'string' ||
      !OBJECT_ID_RE.test(r.SecretID) ||
      objectStack(r.SecretName) !== stack ||
      r.SecretName === `nvh_${stack}`
    ) {
      refuse('service secret reference')
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

function checkServiceBody(cfg: AgentConfig, p: string, body: Record<string, unknown>): void {
  const named = typeof body.Name === 'string' ? HUB_SERVICE_NAME_RE.exec(body.Name) : null
  if (!named) refuse('service name')
  const stack = named[1]
  // An update names its target by name, and it must be the body's own.
  const target = /^\/services\/([^/]+)\/update$/.exec(p)
  if (target && target[1] !== body.Name) refuse('service update target')
  if (!ownedBy(body.Labels, stack)) refuse('service labels')
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
  if (!ownedBy(spec.Labels, stack)) refuse('container labels')
  checkSecretRefs(stack, spec)
  const mounts = spec.Mounts ?? []
  if (!Array.isArray(mounts)) refuse('service mounts')
  for (const m of mounts) checkMount(cfg, stack, m)
  checkNetworkTargets(cfg, stack, task.Networks)
  checkNetworkTargets(cfg, stack, body.Networks)
  checkEndpoint(cfg, body.EndpointSpec)
}

function checkVolumeCreate(cfg: AgentConfig, body: Record<string, unknown>): void {
  for (const k of Object.keys(body)) {
    if (!['Name', 'Driver', 'DriverOpts', 'Labels'].includes(k)) refuse(`volume ${k}`)
  }
  const stack = objectStack(body.Name)
  if (!stack || body.Name === `nvh_${stack}`) refuse('volume name')
  if (!ownedBy(body.Labels, stack)) refuse('volume labels')
  if (body.Driver !== cfg.volumeDriver) refuse('volume driver')
  const opts = body.DriverOpts ?? {}
  if (!isPlainObject(opts) || !volumeOptsSafe(opts)) refuse('volume driver options')
  if (!isDeepStrictEqual(opts, cfg.volumeOpts)) refuse('volume driver options')
}

function checkNetworkCreate(body: Record<string, unknown>): void {
  const stack = objectStack(body.Name)
  // A stack has exactly one network: nvh_<stack>.
  if (!stack || body.Name !== `nvh_${stack}`) refuse('network name')
  if (!ownedBy(body.Labels, stack)) refuse('network labels')
  if (body.Driver !== 'overlay') refuse('network driver')
  if (body.Attachable !== undefined && body.Attachable !== false) refuse('network Attachable')
  for (const k of ['Ingress', 'ConfigFrom', 'ConfigOnly']) {
    if (body[k] !== undefined) refuse(`network ${k}`)
  }
}

function checkSecretCreate(body: Record<string, unknown>): void {
  const stack = objectStack(body.Name)
  if (!stack || body.Name === `nvh_${stack}`) refuse('secret name')
  if (!ownedBy(body.Labels, stack)) refuse('secret labels')
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
    checkTarget(method, p)
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
  if (p === '/services/create' || /^\/services\/[^/]+\/update$/.test(p))
    checkServiceBody(cfg, p, body)
  else if (p === '/volumes/create') checkVolumeCreate(cfg, body)
  else if (p === '/networks/create') checkNetworkCreate(body)
  else if (p === '/secrets/create') checkSecretCreate(body)
  else if (p === '/containers/create') {
    const named = HUB_UNPACK_NAME_RE.exec(String(opts.query?.name ?? ''))
    if (!named) refuse('container name')
    const labels = body.Labels
    if (
      !isPlainObject(labels) ||
      labels[LABEL_MANAGED] !== '1' ||
      labels[LABEL_UNPACK] !== named[1]
    )
      refuse('container labels')
    if (!allowedImage(cfg, body.Image)) refuse('container image')
    const hc = body.HostConfig
    if (hc !== undefined && !(isPlainObject(hc) && Object.keys(hc).length === 0)) {
      refuse('container HostConfig')
    }
  }
}

/**
 * DELETE (and the archive read) name their object by NAME, and only names the
 * agent gives: `<stack>_<role>` services, `nvh_` secrets, networks and
 * volumes, `nvh_<stack>_unpack_` containers. An id, or a name like `efp_db`,
 * never reaches the Engine.
 */
function checkTarget(method: EngineMethod, p: string): void {
  const m = /^\/(services|secrets|networks|volumes|containers)\/([^/]+)(\/archive)?$/.exec(p)
  if (!m) return
  const [, kind, target, archive] = m
  if (method === 'GET' && !archive) return
  if (kind === 'services') {
    if (!HUB_SERVICE_NAME_RE.test(target)) refuse('service target')
  } else if (kind === 'containers') {
    if (!HUB_UNPACK_NAME_RE.test(target)) refuse('container target')
  } else if (!objectStack(target)) refuse(`${kind} target`)
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

/** A read the ownership guard makes before a write (through the same allow-list). */
export type OwnershipRead = (path: string) => Promise<{ status: number; body: unknown }>

/**
 * The stateful half of the guard. The pure check sees only a name, and a
 * name like `efp_web` has the right shape; so before an update or delete is
 * forwarded, the object's CURRENT labels are read and must say
 * `nivaro.hub.managed=1` with the namespace the name names:
 * - POST /services/<n>/update, DELETE /services/<n>: GET /services/<n>;
 * - DELETE /secrets|networks|volumes/<n>: the list, found by exact name;
 * - DELETE /containers/<n> and its archive: only a container this engine
 *   created itself (the extension unpack container), still alive.
 * An object that is not there answers a plain 404 without being forwarded.
 */
export class OwnershipGuard {
  private readonly created = new Set<string>()

  async check(
    read: OwnershipRead,
    method: EngineMethod,
    p: string
  ): Promise<'forward' | 'missing'> {
    const svc = /^\/services\/([^/]+)(\/update)?$/.exec(p)
    if (svc && (method === 'DELETE' || (method === 'POST' && svc[2]))) {
      const name = svc[1]
      const stack = HUB_SERVICE_NAME_RE.exec(name)?.[1]
      if (!stack) refuse('service target')
      const r = await read(`/services/${name}`)
      if (r.status === 404) return 'missing'
      const spec = isPlainObject(r.body) ? r.body.Spec : undefined
      if (
        r.status !== 200 ||
        !isPlainObject(spec) ||
        spec.Name !== name ||
        !ownedBy(spec.Labels, stack)
      )
        refuse('service not owned')
      return 'forward'
    }
    const obj = /^\/(secrets|networks|volumes)\/([^/]+)$/.exec(p)
    if (obj && method === 'DELETE') {
      const [, kind, name] = obj
      const stack = objectStack(name)
      if (!stack) refuse(`${kind} target`)
      const r = await read(`/${kind}`)
      const rows = kind === 'volumes' ? (isPlainObject(r.body) ? r.body.Volumes : null) : r.body
      if (r.status !== 200) refuse(`${kind} not readable`)
      if (rows === null || rows === undefined) return 'missing'
      if (!Array.isArray(rows)) refuse(`${kind} not readable`)
      const nameOf = (x: unknown) =>
        isPlainObject(x)
          ? kind === 'secrets'
            ? isPlainObject(x.Spec)
              ? x.Spec.Name
              : undefined
            : x.Name
          : undefined
      const hits = rows.filter((x) => nameOf(x) === name)
      if (hits.length === 0) return 'missing'
      for (const hit of hits) {
        const labels = kind === 'secrets' ? hit.Spec?.Labels : hit.Labels
        if (!ownedBy(labels, stack)) refuse(`${kind} not owned`)
      }
      return 'forward'
    }
    const ctr = /^\/containers\/([^/]+)(\/archive)?$/.exec(p)
    if (ctr && (method === 'DELETE' || ctr[2])) {
      if (!this.created.has(ctr[1])) refuse('container not created by this agent')
    }
    return 'forward'
  }

  /** After a forwarded call: remember the unpack containers this engine made and still has. */
  note(method: EngineMethod, p: string, opts: EngineCallOptions, status: number): void {
    const ok = status >= 200 && status < 300
    if (method === 'POST' && p === '/containers/create' && ok) {
      this.created.add(String(opts.query?.name))
    }
    const ctr = /^\/containers\/([^/]+)$/.exec(p)
    if (method === 'DELETE' && ctr && (ok || status === 404)) this.created.delete(ctr[1])
  }
}

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

  async function rawCall<T>(method: EngineMethod, p: string, opts: EngineCallOptions = {}) {
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
  }

  const guard = new OwnershipGuard()
  const read: OwnershipRead = (path) => rawCall('GET', path)

  return {
    async call<T>(method: EngineMethod, p: string, opts: EngineCallOptions = {}) {
      // The pure check first: nothing, not even the ownership read, happens for a refused call.
      checkEngineCall(cfg, method, p, opts)
      if ((await guard.check(read, method, p)) === 'missing') {
        return { status: 404, body: { message: 'not found' } as T }
      }
      const r = await rawCall<T>(method, p, opts)
      guard.note(method, p, opts, r.status)
      return r
    },

    async stream(method: EngineMethod, p: string, opts: EngineCallOptions = {}) {
      checkEngineCall(cfg, method, p, opts)
      if ((await guard.check(read, method, p)) === 'missing') refuse('stream target missing')
      const { res } = await open(method, p, opts)
      return { status: res.statusCode ?? 0, stream: res }
    }
  }
}
