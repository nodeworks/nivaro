import type { FastifyRequest } from 'fastify'
import { config } from '../config.js'
import { tenantOrigin } from '../db/tenant-context.js'
import { mcpPublicOrigin } from './mcp-config.js'

/** This instance's configured addresses: PUBLIC_URL, ADMIN_URL, MCP_PUBLIC_URL, APP_URLS. */
function configuredOrigins(): string[] {
  // MCP_PUBLIC_URL's origin first: the MCP host always answers it (a same-host scheme tie,
  // PUBLIC_URL http://h vs MCP_PUBLIC_URL https://h, is https).
  const raw = [
    mcpPublicOrigin(),
    config.PUBLIC_URL,
    config.ADMIN_URL,
    process.env.MCP_PUBLIC_URL,
    ...String(config.APP_URLS ?? '').split(',')
  ]
  const out: string[] = []
  for (const r of raw) {
    const v = r?.trim()
    if (!v) continue
    try {
      const o = new URL(v).origin
      if (o !== 'null' && !out.includes(o)) out.push(o)
    } catch {
      // not a URL: not an address
    }
  }
  return out
}

/** `host` (a request's Host, maybe with a port) is `origin`'s host, default ports aside. */
function hostIs(origin: string, host: string): boolean {
  try {
    const u = new URL(origin)
    return new URL(`${u.protocol}//${host}`).host === u.host
  } catch {
    return false
  }
}

/**
 * The issuer for a request — the OAuth `iss` every client gets (phone apps and MCP clients), and
 * the discovery document's `issuer` on that host, so the two always agree.
 *
 *  - Cloud: the tenant's verified origin (its own subdomain or active custom domain), else its
 *    canonical origin (db/tenant-context.ts).
 *  - Self-hosted: the configured address (MCP_PUBLIC_URL first, then PUBLIC_URL, ADMIN_URL, APP_URLS) whose
 *    host is the request's host — as Fastify reads it, so a forwarded host counts only from a
 *    proxy TRUST_PROXY trusts — else MCP_PUBLIC_URL's origin (mcpPublicOrigin). An internal host
 *    behind an untrusted proxy is never named.
 */
export function requestIssuer(req: FastifyRequest): string {
  if (process.env.CLOUD_META_DB_URL) return tenantOrigin() ?? mcpPublicOrigin()
  const host = String(req.host ?? '')
    .split(',')[0]
    .trim()
    .toLowerCase()
  if (host) for (const o of configuredOrigins()) if (hostIs(o, host)) return o
  return mcpPublicOrigin()
}
