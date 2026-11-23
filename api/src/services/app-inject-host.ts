import type { FastifyInstance } from 'fastify'
import { getTenantId, tenantOrigin } from '../db/tenant-context.js'
import { tenantSource } from './deployment-mode.js'
import { getTenantRegistry } from './tenancy/registry.js'

/**
 * In-process calls on a Hub shared deployment. The tenant hook resolves the app from the
 * request's Host, and light-my-request sends `localhost:80` when the caller names none — so a call
 * made inside an app (an extension's `ctx.app.inject`, core's `req.server.inject` in
 * callAsCaller, any Fastify instance's `.inject`) that carries only an Authorization header or a
 * cookie reached no app (404), or, where an app is served at localhost, ANOTHER app with the
 * caller's credential (copies of one app share static tokens). `installAppInject` wraps the root
 * instance's inject once at boot — every child scope and `req.server` inherits it — so that,
 * inside an app, a call with no Host, `authority` or absolute URL of its own is sent to the
 * current app's host. Self-hosted and Nivaro Cloud never install it (Cloud forwards its tenant
 * host itself), and outside any app the call goes as written.
 */

const WRAPPED = Symbol('nivaro.appInject')

function hubShared(): boolean {
  return tenantSource() === 'hub'
}

/** The current app's host (`name[:port]`), or null outside any app / off a Hub shared
 *  deployment. The verified origin of the request or job first, else the first hostname the Hub
 *  lists for the app (+ its port). */
export async function currentAppHost(): Promise<string | null> {
  if (!hubShared()) return null
  const id = getTenantId()
  if (!id) return null
  const origin = tenantOrigin()
  if (origin) {
    try {
      return new URL(origin).host
    } catch {
      /* fall through to the registry */
    }
  }
  const t = await getTenantRegistry()
    ?.byId?.(id)
    .catch(() => null)
  const name = t?.hostnames?.[0]
  if (!name) return null
  const port = t?.originPorts?.[name]
  return port ? `${name}:${port}` : name
}

const ABSOLUTE = /^(?:[a-z][a-z0-9+.-]*:)?\/\//i

/** The caller already named where the call goes: a Host header, an `authority`, or an absolute
 *  URL (string, or light-my-request's `{ hostname | host }` object). */
function namesHost(o: Record<string, unknown>): boolean {
  if (typeof o.authority === 'string' && o.authority) return true
  const url = o.url ?? o.path
  if (typeof url === 'string' && ABSOLUTE.test(url)) return true
  if (url && typeof url === 'object') {
    const u = url as { hostname?: unknown; host?: unknown }
    if (u.hostname || u.host) return true
  }
  const headers = o.headers as Record<string, unknown> | undefined
  return (
    !!headers && Object.keys(headers).some((k) => k.toLowerCase() === 'host' && headers[k] != null)
  )
}

/** `inject` options with the current app's Host added when the caller named no host. */
export async function withAppHost(opts: unknown): Promise<unknown> {
  if (opts == null || (typeof opts !== 'string' && typeof opts !== 'object')) return opts
  const o = (typeof opts === 'string' ? { url: opts } : opts) as Record<string, unknown>
  if (namesHost(o)) return opts
  const host = await currentAppHost()
  if (!host) return opts
  return { ...o, headers: { ...((o.headers as Record<string, unknown>) ?? {}), host } }
}

type InjectFn = (...args: unknown[]) => unknown

/**
 * Wraps an `inject`: the promise form and the callback form inside an app get the app's host.
 * The wrapper calls the original with the instance it is called on (`this`): a child scope's
 * inject keeps its own `ready` (avvio's, bound to the child), so an inject awaited inside a
 * plugin's register before listen waits for that scope only, never the whole boot. In the
 * callback form any error — the host lookup, or a synchronous throw from the original — reaches
 * the callback, never an unhandled rejection. The chain form (`inject()` with no options, then
 * `.get(url)…`) is passed through unchanged — nothing in core or the shipped extensions uses it.
 */
export function appInject<F extends (...args: never[]) => unknown>(inject: F): F {
  const original = inject as unknown as InjectFn
  return function (this: unknown, ...args: unknown[]) {
    const call = (...a: unknown[]) => original.apply(this, a)
    const [opts, cb] = args
    if (opts === undefined || !hubShared() || !getTenantId()) return call(...args)
    if (typeof cb === 'function') {
      let called = false
      const done = (err: unknown, res?: unknown) => {
        if (called) return
        called = true
        ;(cb as (e: unknown, r?: unknown) => void)(err, res)
      }
      withAppHost(opts)
        .then((o) => call(o, done))
        .catch((err) => done(err))
      return undefined
    }
    return withAppHost(opts).then((o) => call(o))
  } as unknown as F
}

/** Installs the wrapper on the root instance (boot, Hub shared deployments only). Idempotent. The
 *  original stays unbound: each instance (root, child scope, req.server) calls it as itself. */
export function installAppInject(app: FastifyInstance): void {
  if (!hubShared()) return
  const a = app as unknown as { inject: InjectFn; [WRAPPED]?: true }
  if (a[WRAPPED]) return
  a.inject = appInject(a.inject)
  a[WRAPPED] = true
}
