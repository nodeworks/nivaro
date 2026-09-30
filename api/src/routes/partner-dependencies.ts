import type { FastifyInstance } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { registerReadinessCheck } from '../services/readiness.js'

/**
 * Partner dependency map (#608) — admin only, prefix /api/partner-dependencies.
 *
 *   GET /                         every caller, summarised (?days=14)
 *   GET /check                    break + deprecation findings (?days, ?people=1)
 *   GET /field/:collection/:field callers that use one field
 *   GET /:key                     one caller's map (key = `key:<id>` | `user:<uuid>`)
 *   GET /:key/openapi.json        OpenAPI subset (?download=1 → attachment)
 *   GET /:key/schema.graphql      GraphQL SDL subset (?download=1 → attachment)
 */
let readinessRegistered = false

const daysOf = (raw: unknown) => {
  const n = Number(raw)
  return Number.isFinite(n) && n > 0 ? Math.min(30, Math.floor(n)) : 14
}

const fileSafe = (s: string) =>
  s.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'caller'

export async function partnerDependencyRoutes(app: FastifyInstance) {
  if (!readinessRegistered) {
    readinessRegistered = true
    registerReadinessCheck({
      id: 'partner-dependencies',
      label: 'Partner integrations still find the fields they use',
      group: 'Integrations',
      description:
        'Every field an API key or machine account read or wrote in the logged window still exists; fields they use that are deprecated are listed.',
      run: async () => {
        const { checkDependencies } = await import('../services/partner-dependencies.js')
        const r = await checkDependencies()
        if (r.callers === 0)
          return { status: 'skip', detail: `No partner calls in the last ${r.days} days.` }
        const breaks = r.findings.filter((f) => f.severity === 'break')
        const deps = r.findings.filter((f) => f.severity === 'deprecated')
        if (breaks.length === 0 && deps.length === 0)
          return {
            status: 'pass',
            detail: `${r.callers} partner(s), ${r.fields} used field(s) — all present.`
          }
        return {
          status: 'warn',
          detail: `${breaks.length} missing and ${deps.length} deprecated field use(s) across ${r.callers} partner(s).`,
          blockers: [...breaks, ...deps].slice(0, 25).map((f) => f.message)
        }
      }
    })
  }

  app.get('/', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { days?: string; fresh?: string }
    const { dependencyMap } = await import('../services/partner-dependencies.js')
    const map = await dependencyMap(daysOf(q.days), { fresh: q.fresh === '1' })
    return {
      data: map.callers.map((c) => ({
        key: c.key,
        kind: c.kind,
        label: c.label,
        partner: c.partner,
        account_kind: c.account_kind,
        calls: c.calls,
        last_seen: c.last_seen,
        collections: c.collections.length,
        fields: c.collections.reduce((s, x) => s + x.read.length + x.written.length, 0),
        operations: c.operations.length,
        endpoints: c.endpoints.length
      })),
      days: map.days,
      generated_at: map.generated_at,
      truncated: map.truncated
    }
  })

  app.get('/check', { preHandler: requireAdmin }, async (req) => {
    const q = req.query as { days?: string; people?: string }
    const { checkDependencies } = await import('../services/partner-dependencies.js')
    return {
      data: await checkDependencies({ days: daysOf(q.days), includePeople: q.people === '1' })
    }
  })

  app.get<{ Params: { collection: string; field: string } }>(
    '/field/:collection/:field',
    { preHandler: requireAdmin },
    async (req) => {
      const { callersUsingField } = await import('../services/partner-dependencies.js')
      return {
        data: await callersUsingField(
          req.params.collection,
          req.params.field,
          daysOf((req.query as { days?: string }).days)
        )
      }
    }
  )

  app.get<{ Params: { key: string } }>(
    '/:key',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { callerDependencies } = await import('../services/partner-dependencies.js')
      const q = req.query as { days?: string }
      const dep = await callerDependencies(req.params.key, daysOf(q.days))
      if (!dep)
        return reply.code(404).send({ error: 'No logged calls from this caller in the window' })
      return { data: dep }
    }
  )

  app.get<{ Params: { key: string } }>(
    '/:key/openapi.json',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { callerDependencies, openApiSubset } = await import(
        '../services/partner-dependencies.js'
      )
      const q = req.query as { days?: string; download?: string }
      const dep = await callerDependencies(req.params.key, daysOf(q.days))
      if (!dep)
        return reply.code(404).send({ error: 'No logged calls from this caller in the window' })
      const spec = await openApiSubset(dep)
      const filename = `${fileSafe(dep.label)}.openapi.json`
      if (q.download === '1') {
        reply.header('content-disposition', `attachment; filename="${filename}"`)
        return reply.type('application/json').send(JSON.stringify(spec, null, 2))
      }
      return { data: { filename, content: JSON.stringify(spec, null, 2) } }
    }
  )

  app.get<{ Params: { key: string } }>(
    '/:key/schema.graphql',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const { callerDependencies, graphqlSdlSubset } = await import(
        '../services/partner-dependencies.js'
      )
      const q = req.query as { days?: string; download?: string }
      const dep = await callerDependencies(req.params.key, daysOf(q.days))
      if (!dep)
        return reply.code(404).send({ error: 'No logged calls from this caller in the window' })
      const sdl = await graphqlSdlSubset(dep)
      const filename = `${fileSafe(dep.label)}.graphql`
      if (q.download === '1') {
        reply.header('content-disposition', `attachment; filename="${filename}"`)
        return reply.type('text/plain; charset=utf-8').send(sdl)
      }
      return { data: { filename, content: sdl } }
    }
  )
}
