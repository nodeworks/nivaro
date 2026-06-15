import type { FastifyInstance } from 'fastify'
import { authenticate } from '../../middleware/authenticate.js'
import { getMetaDb } from '../../middleware/tenant.js'
import { getTenantId } from '../../db/tenant-context.js'
import { db } from '../../db/index.js'

const GATEWAY_URL = process.env.GATEWAY_URL
const internalSecret =
  process.env.GATEWAY_INTERNAL_SECRET ?? process.env.NIVARO_PROVISION_SECRET ?? ''

async function gatewayFetch(path: string, opts?: RequestInit) {
  if (!GATEWAY_URL) throw Object.assign(new Error('GATEWAY_URL not set'), { statusCode: 503 })
  const res = await fetch(`${GATEWAY_URL}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${internalSecret}`,
      ...(opts?.headers ?? {})
    }
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw Object.assign(new Error(`Gateway error ${res.status}: ${body}`), {
      statusCode: res.status >= 500 ? 502 : res.status
    })
  }
  return res.json() as Promise<unknown>
}

export async function cloudBillingRoutes(app: FastifyInstance): Promise<void> {
  const metaDb = getMetaDb()

  // ── GET /api/cloud/account/info ─────────────────────────────────────────────
  app.get('/cloud/account/info', { onRequest: [authenticate] }, async (_req, reply) => {
    try {
      const tenantId = getTenantId()
      if (!tenantId) return reply.code(400).send({ error: 'No tenant context' })

      const [tenant, billing] = await Promise.all([
        metaDb('cloud_tenants').where({ id: tenantId }).first(),
        metaDb('cloud_billing').where({ tenant_id: tenantId }).first()
      ])

      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' })

      return {
        id: tenant.id,
        name: tenant.name,
        slug: tenant.slug,
        plan: tenant.plan,
        status: tenant.status,
        email: tenant.admin_email,
        limits: {
          records: tenant.record_limit ?? null,
          users: tenant.user_limit ?? null,
          workspaces: tenant.workspace_limit ?? null,
          storage_gb: tenant.storage_limit_gb ?? null
        },
        subscription: billing
          ? {
              stripe_status: billing.status,
              current_period_end: billing.current_period_end
            }
          : null
      }
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  // ── GET /api/cloud/account/usage ────────────────────────────────────────────
  app.get('/cloud/account/usage', { onRequest: [authenticate] }, async (_req, reply) => {
    try {
      const tenantId = getTenantId()
      if (!tenantId) return reply.code(400).send({ error: 'No tenant context' })

      const [tenant, snapshot] = await Promise.all([
        metaDb('cloud_tenants').where({ id: tenantId }).first(),
        metaDb('cloud_usage_snapshots')
          .where({ tenant_id: tenantId })
          .orderBy('snapshot_date', 'desc')
          .first()
      ])

      if (!tenant) return reply.code(404).send({ error: 'Tenant not found' })

      const usedRecords = (snapshot?.record_count as number) ?? 0
      const usedStorageBytes = (snapshot?.storage_bytes as number) ?? 0
      const usedStorageGb = usedStorageBytes / (1024 * 1024 * 1024)
      const usedApiCalls = (snapshot?.api_calls as number) ?? 0
      const limitRecords = (tenant.record_limit as number | null) ?? null
      const limitUsers = (tenant.user_limit as number | null) ?? null
      const limitStorageGb = (tenant.storage_limit_gb as number | null) ?? null

      // Count active users from tenant DB (db proxy resolves to tenant connection in cloud mode)
      let usedUsers = 0
      try {
        const row = await db('nivaro_users').count('id as n').first()
        usedUsers = Number((row as Record<string, unknown>)?.n ?? 0)
      } catch { /* ignore — tenant db may not be ready */ }

      return {
        records: {
          used: usedRecords,
          limit: limitRecords,
          pct: limitRecords ? Math.round((usedRecords / limitRecords) * 100) : null
        },
        storage_gb: {
          used: Math.round(usedStorageGb * 1000) / 1000,
          limit: limitStorageGb,
          pct: limitStorageGb ? Math.round((usedStorageGb / limitStorageGb) * 100) : null
        },
        api_calls: { used: usedApiCalls, limit: null },
        users: { used: usedUsers, limit: limitUsers },
        snapshot_date: (snapshot?.snapshot_date as string) ?? null
      }
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 500).send({ error: e.message })
    }
  })

  // ── GET /api/cloud/account/billing ──────────────────────────────────────────
  app.get('/cloud/account/billing', { onRequest: [authenticate] }, async (_req, reply) => {
    try {
      const tenantId = getTenantId()
      if (!tenantId) return reply.code(400).send({ error: 'No tenant context' })
      const data = await gatewayFetch(`/control/stripe/tenant/${tenantId}/subscription`)
      return data
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 502).send({ error: e.message })
    }
  })

  // ── GET /api/cloud/account/invoices ─────────────────────────────────────────
  app.get('/cloud/account/invoices', { onRequest: [authenticate] }, async (req, reply) => {
    try {
      const tenantId = getTenantId()
      if (!tenantId) return reply.code(400).send({ error: 'No tenant context' })
      const { limit = '20', starting_after } = req.query as Record<string, string>
      const qs = new URLSearchParams({ limit: String(limit) })
      if (starting_after) qs.set('starting_after', starting_after)
      const data = await gatewayFetch(`/control/stripe/tenant/${tenantId}/invoices?${qs}`)
      return data
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 502).send({ error: e.message })
    }
  })

  // ── GET /api/cloud/account/plans ────────────────────────────────────────────
  app.get('/cloud/account/plans', { onRequest: [authenticate] }, async (_req, reply) => {
    try {
      const data = await gatewayFetch('/control/plans/public')
      return data
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 502).send({ error: e.message })
    }
  })

  // ── POST /api/cloud/account/portal ──────────────────────────────────────────
  app.post('/cloud/account/portal', { onRequest: [authenticate] }, async (req, reply) => {
    try {
      const tenantId = getTenantId()
      if (!tenantId) return reply.code(400).send({ error: 'No tenant context' })
      const { return_url } = (req.body as Record<string, string>) ?? {}
      const data = await gatewayFetch(`/control/stripe/tenant/${tenantId}/portal-session`, {
        method: 'POST',
        body: JSON.stringify({ return_url })
      })
      return data
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 502).send({ error: e.message })
    }
  })

  // ── POST /api/cloud/account/upgrade ─────────────────────────────────────────
  app.post('/cloud/account/upgrade', { onRequest: [authenticate] }, async (req, reply) => {
    try {
      const tenantId = getTenantId()
      if (!tenantId) return reply.code(400).send({ error: 'No tenant context' })
      const { price_id, success_url, cancel_url } = (req.body as Record<string, string>) ?? {}
      if (!price_id) return reply.code(400).send({ error: 'price_id required' })
      const data = await gatewayFetch(`/control/stripe/tenant/${tenantId}/checkout-session`, {
        method: 'POST',
        body: JSON.stringify({ price_id, success_url, cancel_url })
      })
      return data
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string }
      return reply.code(e.statusCode ?? 502).send({ error: e.message })
    }
  })
}
