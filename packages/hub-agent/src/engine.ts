/**
 * The Docker Engine client. It may make only the calls in ENGINE_ALLOWED;
 * anything else throws EngineForbiddenError before any I/O. No exec, attach,
 * logs, start, build, commit, plugins, /swarm or node calls exist here, so no
 * caller (and no bug in a caller) can reach them.
 *
 * On top of the method + path list, write bodies get a second check (defence
 * in depth behind the StackSpec validator): images only from the allow-list
 * and pinned by digest, no privileges / added capabilities / sysctls, bind
 * mounts only read-only under the extension root, no host network, and a
 * created container has no HostConfig at all (it is only ever read through
 * /archive, never started).
 */
import http from 'node:http'
import path from 'node:path'
import { type AgentConfig, PINNED_IMAGE_RE } from './config.js'

export const ENGINE_API_PREFIX = '/v1.44'

export type EngineMethod = 'GET' | 'POST' | 'DELETE'

/** One Engine object id or name: services, secrets, networks, volumes, containers. */
const ID = '[A-Za-z0-9][A-Za-z0-9_.-]{0,254}'
/** An image reference for inspect: repo[:tag] or repo@sha256:<hex>. */
const REF = '[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_.-]{1,128}|@sha256:[a-f0-9]{64})?'

export const ENGINE_ALLOWED: ReadonlyArray<[EngineMethod, RegExp]> = Object.freeze([
  ['GET', /^\/version$/],
  ['GET', /^\/info$/],
  ['GET', /^\/services$/],
  ['GET', new RegExp(`^/services/${ID}$`)],
  ['GET', /^\/tasks$/],
  ['GET', /^\/networks$/],
  ['GET', /^\/secrets$/],
  ['GET', /^\/volumes$/],
  ['GET', new RegExp(`^/images/${REF}/json$`)],
  ['GET', new RegExp(`^/containers/${ID}/archive$`)],
  ['POST', /^\/services\/create$/],
  ['POST', new RegExp(`^/services/${ID}/update$`)],
  ['POST', /^\/networks\/create$/],
  ['POST', /^\/secrets\/create$/],
  ['POST', /^\/volumes\/create$/],
  ['POST', /^\/images\/create$/],
  ['POST', /^\/containers\/create$/],
  ['DELETE', new RegExp(`^/services/${ID}$`)],
  ['DELETE', new RegExp(`^/secrets/${ID}$`)],
  ['DELETE', new RegExp(`^/networks/${ID}$`)],
  ['DELETE', new RegExp(`^/volumes/${ID}$`)],
  ['DELETE', new RegExp(`^/containers/${ID}$`)]
] as Array<[EngineMethod, RegExp]>)

/** Headers a caller may add. Everything else (Host, Content-Length …) is the client's. */
const ALLOWED_HEADERS = new Set(['x-registry-auth'])

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
  query?: Record<string, string | number | boolean | undefined>
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

function checkPath(method: string, p: string): void {
  if (typeof p !== 'string' || !p.startsWith('/'))
    throw new EngineForbiddenError('path must start with /')
  // Only plain characters: no %-escapes, query, fragment, backslash or space.
  if (!/^[A-Za-z0-9._/:@-]+$/.test(p)) throw new EngineForbiddenError('path characters')
  const segments = p.slice(1).split('/')
  if (segments.some((s) => s === '' || s === '.' || s === '..'))
    throw new EngineForbiddenError('path segments')
  if (!ENGINE_ALLOWED.some(([m, re]) => m === method && re.test(p))) {
    throw new EngineForbiddenError('not on the allow-list')
  }
}

function allowedImage(cfg: AgentConfig, image: unknown): boolean {
  if (typeof image !== 'string') return false
  if (cfg.redisImage && image === cfg.redisImage) return true
  const m = PINNED_IMAGE_RE.exec(image)
  return !!m && cfg.images.includes(m[1])
}

function insideRoot(root: string, source: unknown): boolean {
  if (typeof source !== 'string' || !source.startsWith('/')) return false
  const resolved = path.posix.normalize(source)
  if (resolved !== source.replace(/\/+$/, '')) return false
  const base = root.endsWith('/') ? root : `${root}/`
  return resolved.startsWith(base)
}

function checkServiceBody(cfg: AgentConfig, body: Record<string, unknown>): void {
  const task = body.TaskTemplate
  if (!isPlainObject(task)) throw new EngineForbiddenError('service without TaskTemplate')
  const spec = task.ContainerSpec
  if (!isPlainObject(spec)) throw new EngineForbiddenError('service without ContainerSpec')
  if (!allowedImage(cfg, spec.Image)) throw new EngineForbiddenError('service image')
  for (const k of ['Privileges', 'CapabilityAdd', 'Sysctls', 'Isolation']) {
    if (spec[k] !== undefined) throw new EngineForbiddenError(`service ${k}`)
  }
  const mounts = spec.Mounts ?? []
  if (!Array.isArray(mounts)) throw new EngineForbiddenError('service mounts')
  for (const m of mounts) {
    if (!isPlainObject(m)) throw new EngineForbiddenError('service mount')
    if (m.Type === 'volume' || m.Type === 'tmpfs') continue
    if (m.Type === 'bind' && m.ReadOnly === true && insideRoot(cfg.extensionsHostRoot, m.Source))
      continue
    throw new EngineForbiddenError('service mount type or source')
  }
  for (const nets of [task.Networks, body.Networks]) {
    if (nets === undefined) continue
    if (!Array.isArray(nets)) throw new EngineForbiddenError('service networks')
    for (const n of nets) {
      if (
        !isPlainObject(n) ||
        n.Target === 'host' ||
        n.Target === 'bridge' ||
        n.Target === 'none'
      ) {
        throw new EngineForbiddenError('service network')
      }
    }
  }
}

function checkBody(
  cfg: AgentConfig,
  method: EngineMethod,
  p: string,
  opts: EngineCallOptions
): void {
  if (method !== 'POST') {
    if (opts.body !== undefined) throw new EngineForbiddenError('body on a non-POST call')
    return
  }
  if (p === '/images/create') {
    if (opts.body !== undefined) throw new EngineForbiddenError('pull body')
    const from = opts.query?.fromImage
    const tag = opts.query?.tag
    if (typeof from !== 'string') throw new EngineForbiddenError('pull without fromImage')
    const ref =
      tag === undefined
        ? from
        : typeof tag === 'string' && tag.startsWith('sha256:')
          ? `${from}@${tag}`
          : null
    if (!ref || !allowedImage(cfg, ref)) throw new EngineForbiddenError('pull image')
    return
  }
  if (!isPlainObject(opts.body)) throw new EngineForbiddenError('POST body must be an object')
  if (p === '/services/create' || /^\/services\/[^/]+\/update$/.test(p))
    checkServiceBody(cfg, opts.body)
  if (p === '/containers/create') {
    if (!allowedImage(cfg, opts.body.Image)) throw new EngineForbiddenError('container image')
    const hc = opts.body.HostConfig
    if (hc !== undefined && !(isPlainObject(hc) && Object.keys(hc).length === 0)) {
      throw new EngineForbiddenError('container HostConfig')
    }
  }
}

function checkHeaders(opts: EngineCallOptions): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [k, v] of Object.entries(opts.headers ?? {})) {
    if (!ALLOWED_HEADERS.has(k.toLowerCase())) throw new EngineForbiddenError('header')
    out[k.toLowerCase()] = String(v)
  }
  return out
}

/** Throws EngineForbiddenError when the call is not allowed. Pure; does no I/O. */
export function checkEngineCall(
  cfg: AgentConfig,
  method: string,
  p: string,
  opts: EngineCallOptions = {}
): void {
  if (method !== 'GET' && method !== 'POST' && method !== 'DELETE')
    throw new EngineForbiddenError('method')
  checkPath(method, p)
  checkBody(cfg, method, p, opts)
  checkHeaders(opts)
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
    const headers = checkHeaders(opts)
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
