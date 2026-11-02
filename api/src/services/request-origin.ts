import type { FastifyRequest } from 'fastify'
import { tenantOrigin } from '../db/tenant-context.js'

/**
 * The origin a request arrived on. Cloud: the tenant's (its subdomain or custom domain, as the
 * tenant middleware resolved it). Self-hosted: the request's protocol + host as Fastify reads
 * them — X-Forwarded-Proto / X-Forwarded-Host count only from a proxy TRUST_PROXY trusts
 * (lib/trust-proxy.ts). Default ports are dropped (`http://a:80` → `http://a`).
 */
export function requestOrigin(req: FastifyRequest): string {
  const tenant = tenantOrigin()
  if (tenant) return tenant
  const proto = req.protocol === 'https' ? 'https' : 'http'
  const host = String(req.host ?? '').split(',')[0].trim()
  try {
    return new URL(`${proto}://${host}`).origin
  } catch {
    return `${proto}://localhost`
  }
}
