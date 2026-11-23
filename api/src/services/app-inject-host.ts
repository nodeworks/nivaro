import { getTenantId, tenantOrigin } from '../db/tenant-context.js'
import { isMultiTenant } from './deployment-mode.js'
import { getTenantRegistry } from './tenancy/registry.js'

/**
 * An extension's in-process call (`ctx.app.inject`) on a multi-tenant deployment (Nivaro Cloud,
 * a Hub shared deployment). The tenant hook resolves the app from the request's Host, and
 * light-my-request sends `localhost:80` when the caller names none — so a call made inside an
 * app (a route, a hook, a per-app cron run) that carries only an Authorization header, as most
 * extension calls do, reached no app (404) or, where an app is served at localhost, the wrong
 * one. Inside an app, a call with no Host of its own is sent to the current app's host.
 * Self-hosted, and outside any app, the call goes as it was written.
 */

/** The current app's host (`name[:port]`), or null outside any app / self-hosted. */
export async function currentAppHost(): Promise<string | null> {
  if (!isMultiTenant()) return null
  const origin = tenantOrigin()
  if (origin) {
    try {
      return new URL(origin).host
    } catch {
      /* fall through to the registry */
    }
  }
  const id = getTenantId()
  if (!id) return null
  const t = await getTenantRegistry()
    ?.byId?.(id)
    .catch(() => null)
  const name = t?.hostnames?.[0]
  if (!name) return null
  const port = t?.originPorts?.[name]
  return port ? `${name}:${port}` : name
}

function hasHost(headers: Record<string, unknown> | undefined): boolean {
  if (!headers) return false
  return Object.keys(headers).some((k) => k.toLowerCase() === 'host' && headers[k] != null)
}

/** `inject` options with the current app's Host added when the caller set none. */
export async function withAppHost(opts: unknown): Promise<unknown> {
  if (opts == null || (typeof opts !== 'string' && typeof opts !== 'object')) return opts
  const o = (typeof opts === 'string' ? { url: opts } : opts) as {
    headers?: Record<string, unknown>
  }
  if (hasHost(o.headers)) return opts
  const host = await currentAppHost()
  if (!host) return opts
  return { ...o, headers: { ...(o.headers ?? {}), host } }
}

/**
 * Wraps an `inject` so a promise-form call inside an app reaches that app. The callback form and
 * the chain form (`inject()` with no options) are passed through unchanged.
 */
export function appInject<F extends (...args: never[]) => unknown>(inject: F): F {
  const call = inject as unknown as (...a: unknown[]) => unknown
  return ((...args: unknown[]) => {
    if (args.length !== 1 || args[0] === undefined || !isMultiTenant()) return call(...args)
    return withAppHost(args[0]).then((o) => call(o))
  }) as unknown as F
}
