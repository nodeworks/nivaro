import type {
  ListPage,
  Observed,
  OpResult,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import { ACCESS_APP } from './access.js'
import { accountPath, cfCall, checkId, joinId, nextCursor, pageOf, splitId } from './client.js'
import {
  arr,
  asObj,
  FULL_CAPS,
  ok,
  type PlanCfg,
  planGeneric,
  str,
  type TypeImpl
} from './common.js'
import { includedEstimate } from './pricing.js'

/**
 * Cloudflare Tunnel (remotely managed, `config_src: cloudflare`):
 *
 *  - `cloudflare.tunnel`        the tunnel. Outputs `tunnel_token` (secret → a stack secret the
 *                               cloudflared container reads), `tunnel_id` and `cname_target`
 *                               (`<id>.cfargotunnel.com`, what a proxied CNAME points at). The
 *                               token can be read again, so it is not once-only.
 *  - `cloudflare.tunnel_route`  one public hostname → origin service rule in the tunnel's ingress
 *                               list. The whole list is read, changed and written back (the
 *                               catch-all stays last); the Hub never touches rules it does not own.
 *
 * A route does not create DNS: the hostname's CNAME to `cname_target` is a `cloudflare.dns_record`.
 * Locally managed tunnels (config in a file on the host) are listed and observed but their routes
 * cannot be managed from here (`TUNNEL_LOCAL`).
 */

export const TUNNEL = 'cloudflare.tunnel'
export const TUNNEL_ROUTE = 'cloudflare.tunnel_route'

const HOST_RE =
  '^(\\*\\.)?[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)+$'
const SERVICE_RE =
  '^(https?://[^\\s]+|tcp://[^\\s]+|ssh://[^\\s]+|rdp://[^\\s]+|unix:[^\\s]+|http_status:\\d{3})$'
const RAW_TCP = /^(tcp|ssh|rdp):\/\//i

/** Services that must never be exposed without an admin's say: raw TCP, unix sockets, local targets. */
export function sensitiveService(service: string): boolean {
  const s = service.trim()
  if (RAW_TCP.test(s) || /^unix:/i.test(s)) return true
  let host = ''
  try {
    host = new URL(s).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  if (host === 'localhost' || host.endsWith('.localhost') || host === '0.0.0.0') return true
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host)
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])]
    return (
      a === 127 ||
      a === 10 ||
      a === 0 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    )
  }
  if (host.includes(':'))
    return (
      host === '::1' ||
      host === '::' ||
      /^f[cd]/.test(host) ||
      /^fe[89ab]/.test(host) ||
      host.startsWith('::ffff:')
    )
  return false
}

/** True when an Access application's hostname covers the tunnel hostname. */
export function accessCovers(domain: string, hostname: string): boolean {
  const d = domain.split('/')[0].toLowerCase()
  const h = hostname.toLowerCase()
  return d === h || (d.startsWith('*.') && h.endsWith(d.slice(1)))
}

export const tunnelSpec: ResourceTypeSpec = {
  key: TUNNEL,
  label: 'Cloudflare tunnel',
  scope: 'app',
  fields: [
    {
      key: 'name',
      label: 'Name',
      kind: 'string',
      required: true,
      pattern: '^[A-Za-z0-9][A-Za-z0-9 ._-]{0,99}$'
    },
    { key: 'status', label: 'Status', kind: 'string', readOnly: true },
    { key: 'config_src', label: 'Managed', kind: 'string', readOnly: true }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: true,
  refs: [],
  risk(op): RiskFlag[] {
    if (op.kind === 'delete' || op.kind === 'replace') return ['destructive', 'downtime']
    return []
  },
  outputs: [
    { key: 'tunnel_token', label: 'Tunnel token', secret: true },
    { key: 'tunnel_id', label: 'Tunnel id', secret: false },
    { key: 'cname_target', label: 'CNAME target', secret: false }
  ],
  estimate: includedEstimate('Cloudflare Tunnel is free.')
}

export const tunnelRouteSpec: ResourceTypeSpec = {
  key: TUNNEL_ROUTE,
  label: 'Tunnel public hostname',
  scope: 'app',
  nameField: 'hostname',
  fields: [
    {
      key: 'tunnel',
      label: 'Tunnel',
      kind: 'ref',
      refType: TUNNEL,
      required: true,
      replaceOnChange: true
    },
    {
      key: 'hostname',
      label: 'Public hostname',
      kind: 'string',
      required: true,
      replaceOnChange: true,
      pattern: HOST_RE,
      help: 'The name people use, like app.example.com. Its DNS record is a separate resource.'
    },
    {
      key: 'service',
      label: 'Service',
      kind: 'string',
      required: true,
      pattern: SERVICE_RE,
      help: 'Where the tunnel sends it, like http://app:3055 or http_status:404.'
    },
    {
      key: 'access_application',
      label: 'Guarded by Access application',
      kind: 'ref',
      refType: ACCESS_APP,
      help: 'The Hub-managed Access application that guards this hostname. Without one, the hostname is open to the internet and a Hub admin approves it.'
    }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: true,
  refs: [
    { field: 'tunnel', type: TUNNEL, required: true },
    { field: 'access_application', type: ACCESS_APP, required: false }
  ],
  risk(op, desired): RiskFlag[] {
    if (op.kind === 'noop') return []
    const flags = new Set<RiskFlag>()
    if (op.kind === 'update' || op.kind === 'delete' || op.kind === 'replace') flags.add('downtime')
    if (op.kind === 'delete' || op.kind === 'replace') flags.add('destructive')
    if (op.kind === 'create' || op.kind === 'update' || op.kind === 'replace') {
      const service = String(desired?.fields.service ?? '')
      // A public hostname is open to the internet unless a Hub-managed Access application guards
      // it (the `access_application` ref, whose hostname apply checks). Raw TCP / SSH / RDP,
      // unix sockets and loopback, link-local or private targets are always flagged.
      const guarded = typeof desired?.refs.access_application === 'string'
      if (!guarded || sensitiveService(service)) flags.add('public_exposure')
    }
    return [...flags]
  },
  estimate: includedEstimate('Cloudflare Tunnel is free.')
}

// ── Tunnels ──

interface RawTunnel {
  id: string
  name: string
  status?: string
  config_src?: string
  deleted_at?: string | null
  connections?: unknown[]
  token?: string
}

function observedTunnel(raw: RawTunnel, accountId: string): Observed | null {
  if (!raw?.id || raw.deleted_at) return null
  return {
    type: TUNNEL,
    externalId: raw.id,
    name: str(raw.name),
    fields: {
      name: str(raw.name),
      status: str(raw.status),
      config_src: str(raw.config_src) ?? 'local'
    },
    tags: {},
    status: str(raw.status),
    url: `https://one.dash.cloudflare.com/${accountId}/networks/tunnels`
  }
}

async function getTunnel(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const res = await cfCall<RawTunnel>(
    ctx,
    'GET',
    `${accountPath(ctx)}/cfd_tunnel/${checkId(id, 'tunnel id')}`,
    { allow: [404] }
  )
  if (res.status === 404 || !res.result) return null
  return observedTunnel(res.result, String(ctx.config.accountId))
}

async function tunnelToken(ctx: ProviderContext, id: string): Promise<string> {
  const res = await cfCall<string>(
    ctx,
    'GET',
    `${accountPath(ctx)}/cfd_tunnel/${checkId(id, 'tunnel id')}/token`
  )
  if (typeof res.result !== 'string' || !res.result)
    throw new ProviderError('PROVIDER_REJECTED', 'Cloudflare did not return the tunnel token.')
  return res.result
}

function tunnelOutputs(id: string, token: string): Record<string, string> {
  return { tunnel_token: token, tunnel_id: id, cname_target: `${id}.cfargotunnel.com` }
}

async function findTunnelByName(ctx: ProviderContext, name: string): Promise<Observed | null> {
  const res = await cfCall<RawTunnel[]>(ctx, 'GET', `${accountPath(ctx)}/cfd_tunnel`, {
    query: { name, is_deleted: false, per_page: 50 }
  })
  const hit = arr(res.result).find((t) => asObj(t).name === name) as RawTunnel | undefined
  return hit ? observedTunnel(hit, String(ctx.config.accountId)) : null
}

const tunnelCfg: PlanCfg = {
  spec: tunnelSpec,
  writable: ['name'],
  nameOf: (f, o) => String(f.name ?? o?.name ?? ''),
  createHint: 'a tunnel with the same name that the Hub did not create is refused: adopt it instead'
}

export const tunnelImpl: TypeImpl = {
  spec: tunnelSpec,
  permissions: [
    {
      need: 'read Cloudflare Tunnels',
      group: 'Cloudflare Tunnel Write',
      async probe(ctx) {
        await cfCall(ctx, 'GET', `${accountPath(ctx)}/cfd_tunnel`, {
          query: { per_page: 1, is_deleted: false }
        })
        return true
      }
    }
  ],
  observe: (ctx, id) => getTunnel(ctx, id),
  async list(ctx, cursor): Promise<ListPage> {
    const page = pageOf(cursor)
    const res = await cfCall<RawTunnel[]>(ctx, 'GET', `${accountPath(ctx)}/cfd_tunnel`, {
      query: { is_deleted: false, page, per_page: 50 }
    })
    const items = arr(res.result)
      .map((t) => observedTunnel(t as RawTunnel, String(ctx.config.accountId)))
      .filter((o): o is Observed => !!o)
    return { items, cursor: nextCursor(res.info, page) }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const name = str(desired.fields.name)
    return name ? findTunnelByName(ctx, name) : null
  },
  plan: (_ctx, desired, observed) => planGeneric(tunnelCfg, desired, observed),
  async readOutputs(ctx, externalId) {
    const id = checkId(externalId, 'tunnel id')
    return tunnelOutputs(id, await tunnelToken(ctx, id))
  },
  async apply(ctx, op, desired): Promise<OpResult> {
    const base = `${accountPath(ctx)}/cfd_tunnel`
    switch (op.kind) {
      case 'noop':
        return ok(op.externalId ? await getTunnel(ctx, op.externalId) : null, op.externalId, 200)
      case 'create': {
        if (!desired) throw new ProviderError('INVALID', 'A create needs the wanted values.')
        const name = str(desired.fields.name)
        if (!name) throw new ProviderError('INVALID', 'A tunnel needs a name.')
        if (desired.externalId) {
          const existing = await getTunnel(ctx, desired.externalId)
          if (existing) {
            const id = existing.externalId
            return ok(existing, id, 200, tunnelOutputs(id, await tunnelToken(ctx, id)))
          }
        } else {
          const clash = await findTunnelByName(ctx, name)
          if (clash)
            throw new ProviderError(
              'ALREADY_EXISTS',
              `A tunnel named ${name} already exists in this Cloudflare account and was not created by the Hub. Adopt it instead of creating it.`,
              { status: 409 }
            )
        }
        const res = await cfCall<RawTunnel>(ctx, 'POST', base, {
          body: { name, config_src: 'cloudflare' }
        })
        const id = String(res.result?.id ?? '')
        if (!id)
          throw new ProviderError('PROVIDER_REJECTED', 'Cloudflare did not return a tunnel id.')
        const token =
          typeof res.result.token === 'string' && res.result.token
            ? res.result.token
            : await tunnelToken(ctx, id)
        return ok(
          observedTunnel(res.result, String(ctx.config.accountId)),
          id,
          res.status,
          tunnelOutputs(id, token)
        )
      }
      case 'update': {
        if (!op.externalId || !desired)
          throw new ProviderError('INVALID', 'An update needs a tunnel.')
        const id = checkId(op.externalId, 'tunnel id')
        const current = await getTunnel(ctx, id)
        if (!current)
          throw new ProviderError('NOT_FOUND', 'The tunnel no longer exists at Cloudflare.', {
            status: 404
          })
        const name = str(desired.fields.name)
        if (!name || name === current.fields.name) return ok(current, id, 200)
        const res = await cfCall<RawTunnel>(ctx, 'PATCH', `${base}/${id}`, { body: { name } })
        return ok(observedTunnel(res.result, String(ctx.config.accountId)), id, res.status)
      }
      case 'delete': {
        if (!op.externalId) throw new ProviderError('INVALID', 'A delete needs a tunnel id.')
        const id = checkId(op.externalId, 'tunnel id')
        const current = await getTunnel(ctx, id)
        if (!current) return ok(null, id, 404)
        if (current.status === 'healthy' || current.status === 'degraded')
          throw new ProviderError(
            'TUNNEL_IN_USE',
            'The tunnel is connected right now. Stop the cloudflared containers that use it, then delete it.',
            { status: 409 }
          )
        const res = await cfCall(ctx, 'DELETE', `${base}/${id}`, { allow: [404] })
        return ok(null, id, res.status)
      }
      default:
        throw new ProviderError(
          'UNSUPPORTED',
          'A tunnel is changed by name only; anything else is a new tunnel.'
        )
    }
  }
}

// ── Public hostnames (the tunnel's ingress list) ──

interface Ingress {
  hostname?: string
  service: string
  path?: string
  originRequest?: unknown
}

interface TunnelConfig {
  config: Record<string, unknown>
  ingress: Ingress[]
}

async function readConfig(ctx: ProviderContext, tunnelId: string): Promise<TunnelConfig | null> {
  const tunnel = await getTunnel(ctx, tunnelId)
  if (!tunnel) return null
  if (tunnel.fields.config_src !== 'cloudflare')
    throw new ProviderError(
      'TUNNEL_LOCAL',
      'This tunnel is configured by a file on its host, not by Cloudflare. Its public hostnames cannot be managed here.'
    )
  const res = await cfCall<{ config?: Record<string, unknown> | null }>(
    ctx,
    'GET',
    `${accountPath(ctx)}/cfd_tunnel/${checkId(tunnelId, 'tunnel id')}/configurations`,
    { allow: [404] }
  )
  const config = asObj(res.result?.config)
  return { config, ingress: arr(config.ingress).map((r) => asObj(r) as unknown as Ingress) }
}

async function assertGuard(
  ctx: ProviderContext,
  guard: string | string[] | null | undefined,
  hostname: string
): Promise<void> {
  if (typeof guard !== 'string') return
  const app = await cfCall<{ domain?: string }>(
    ctx,
    'GET',
    `${accountPath(ctx)}/access/apps/${checkId(guard, 'application id')}`,
    { allow: [404] }
  )
  if (!app.result?.domain || !accessCovers(String(app.result.domain), hostname))
    throw new ProviderError(
      'ACCESS_NOT_COVERING',
      `The Access application does not guard ${hostname}. Point it at that hostname or drop the guard.`
    )
}

const isCatchAll = (r: Ingress) => !r.hostname

async function writeConfig(
  ctx: ProviderContext,
  tunnelId: string,
  current: TunnelConfig,
  rules: Ingress[]
): Promise<void> {
  const catchAll = current.ingress.find(isCatchAll) ?? { service: 'http_status:404' }
  await cfCall(
    ctx,
    'PUT',
    `${accountPath(ctx)}/cfd_tunnel/${checkId(tunnelId, 'tunnel id')}/configurations`,
    { body: { config: { ...current.config, ingress: [...rules, catchAll] } } }
  )
}

function observedRoute(tunnelId: string, rule: Ingress, accountId: string): Observed {
  return {
    type: TUNNEL_ROUTE,
    externalId: joinId(tunnelId, String(rule.hostname)),
    name: String(rule.hostname),
    fields: { tunnel: tunnelId, hostname: String(rule.hostname), service: String(rule.service) },
    tags: {},
    url: `https://one.dash.cloudflare.com/${accountId}/networks/tunnels`
  }
}

const routeCfg: PlanCfg = {
  spec: tunnelRouteSpec,
  writable: ['tunnel', 'hostname', 'service'],
  replaceOn: ['tunnel', 'hostname'],
  nameOf: (f, o) => String(f.hostname ?? o?.name ?? ''),
  createHint:
    'a rule for the same hostname that the Hub did not create is refused: adopt it instead'
}

export const tunnelRouteImpl: TypeImpl = {
  spec: tunnelRouteSpec,
  permissions: [
    {
      need: 'read tunnel configuration',
      group: 'Cloudflare Tunnel Write',
      async probe(ctx) {
        const res = await cfCall<RawTunnel[]>(ctx, 'GET', `${accountPath(ctx)}/cfd_tunnel`, {
          query: { per_page: 1, is_deleted: false }
        })
        const t = arr(res.result)[0] as RawTunnel | undefined
        if (!t) return null
        await cfCall(
          ctx,
          'GET',
          `${accountPath(ctx)}/cfd_tunnel/${checkId(t.id, 'tunnel id')}/configurations`,
          { allow: [404] }
        )
        return true
      }
    }
  ],
  async observe(ctx, externalId) {
    const ids = splitId(externalId)
    if (!ids) return null
    const cfg = await readConfig(ctx, ids[0])
    const rule = cfg?.ingress.find((r) => r.hostname === ids[1])
    return rule ? observedRoute(ids[0], rule, String(ctx.config.accountId)) : null
  },
  async list(ctx, cursor): Promise<ListPage> {
    // One tunnel per page; a locally managed tunnel has no rules the Hub can read.
    const page = pageOf(cursor)
    const res = await cfCall<RawTunnel[]>(ctx, 'GET', `${accountPath(ctx)}/cfd_tunnel`, {
      query: { is_deleted: false, page, per_page: 20 }
    })
    const items: Observed[] = []
    for (const t of arr(res.result) as RawTunnel[]) {
      if (t.deleted_at || t.config_src !== 'cloudflare') continue
      const cfg = await readConfig(ctx, t.id)
      for (const r of cfg?.ingress ?? [])
        if (!isCatchAll(r)) items.push(observedRoute(t.id, r, String(ctx.config.accountId)))
    }
    return { items, cursor: nextCursor(res.info, page) }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const tunnelId = desired.refs.tunnel
    const hostname = str(desired.fields.hostname)
    if (typeof tunnelId !== 'string' || !hostname) return null
    const cfg = await readConfig(ctx, tunnelId)
    const rule = cfg?.ingress.find((r) => r.hostname === hostname)
    return rule ? observedRoute(tunnelId, rule, String(ctx.config.accountId)) : null
  },
  plan: (_ctx, desired, observed) => planGeneric(routeCfg, desired, observed),
  async apply(ctx, op, desired): Promise<OpResult> {
    const accountId = String(ctx.config.accountId)
    const remove = async (externalId: string): Promise<OpResult> => {
      const ids = splitId(externalId)
      if (!ids) throw new ProviderError('BAD_ID', 'The rule to remove is not known.')
      const cfg = await readConfig(ctx, ids[0])
      if (!cfg?.ingress.some((r) => r.hostname === ids[1])) return ok(null, externalId, 200)
      await writeConfig(
        ctx,
        ids[0],
        cfg,
        cfg.ingress.filter((r) => !isCatchAll(r) && r.hostname !== ids[1])
      )
      return ok(null, externalId, 200)
    }
    const add = async (): Promise<OpResult> => {
      const tunnelId = desired?.refs.tunnel
      const hostname = str(desired?.fields.hostname)
      const service = str(desired?.fields.service)
      if (typeof tunnelId !== 'string')
        throw new ProviderError(
          'REF_UNRESOLVED',
          'The tunnel this hostname is for is not created yet.'
        )
      if (!hostname || !service)
        throw new ProviderError('INVALID', 'A public hostname needs a hostname and a service.')
      await assertGuard(ctx, desired?.refs.access_application, hostname)
      const cfg = await readConfig(ctx, tunnelId)
      if (!cfg)
        throw new ProviderError('NOT_FOUND', 'The tunnel no longer exists.', { status: 404 })
      const externalId = joinId(tunnelId, hostname)
      const rules = cfg.ingress.filter((r) => !isCatchAll(r))
      const existing = rules.find((r) => r.hostname === hostname)
      if (existing) {
        if (!desired?.externalId)
          throw new ProviderError(
            'ALREADY_EXISTS',
            `The tunnel already has a rule for ${hostname} that the Hub did not create. Adopt it instead of creating it.`,
            { status: 409 }
          )
        if (existing.service === service)
          return ok(observedRoute(tunnelId, existing, accountId), externalId, 200)
      }
      const next = existing
        ? rules.map((r) => (r.hostname === hostname ? { ...r, service } : r))
        : [...rules, { hostname, service }]
      await writeConfig(ctx, tunnelId, cfg, next)
      return ok(observedRoute(tunnelId, { hostname, service }, accountId), externalId, 200)
    }
    switch (op.kind) {
      case 'noop':
        return ok(
          op.externalId ? await tunnelRouteImpl.observe(ctx, op.externalId) : null,
          op.externalId,
          200
        )
      case 'create':
        return add()
      case 'update': {
        if (!op.externalId || !desired)
          throw new ProviderError('INVALID', 'An update needs a rule.')
        const ids = splitId(op.externalId)
        if (!ids) throw new ProviderError('BAD_ID', 'The rule to change is not known.')
        const cfg = await readConfig(ctx, ids[0])
        if (!cfg)
          throw new ProviderError('NOT_FOUND', 'The tunnel no longer exists.', { status: 404 })
        const service = str(desired.fields.service)
        if (!service) throw new ProviderError('INVALID', 'A rule needs a service.')
        await assertGuard(ctx, desired.refs.access_application, ids[1])
        const rules = cfg.ingress.filter((r) => !isCatchAll(r))
        const have = rules.find((r) => r.hostname === ids[1])
        if (!have) return add()
        if (have.service === service)
          return ok(observedRoute(ids[0], have, accountId), op.externalId, 200)
        await writeConfig(
          ctx,
          ids[0],
          cfg,
          rules.map((r) => (r.hostname === ids[1] ? { ...r, service } : r))
        )
        return ok(observedRoute(ids[0], { ...have, service }, accountId), op.externalId, 200)
      }
      case 'delete':
        return remove(String(op.externalId ?? ''))
      case 'replace':
        if (op.externalId) await remove(op.externalId)
        return add()
      default:
        throw new ProviderError('INVALID', `Unknown operation ${String(op.kind)}.`)
    }
  }
}
