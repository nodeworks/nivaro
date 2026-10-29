import type { FastifyInstance, FastifyReply } from 'fastify'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { findRole, LayoutAssistError } from '../services/ai-design/layout-explain-field.js'
import { fieldLabel, groupName, loadLayoutFacts } from '../services/ai-design/layout-facts.js'
import { markConfigRead } from '../services/config-live.js'
import { renderFormImage } from '../services/form-image.js'
import { computeFormState, FormStateError, publicFormState } from '../services/form-state.js'
import { isFormLayout, layoutHealth, lintLayout, mergeInherited } from '../services/layout-lint.js'
import { withReadGate } from '../services/read-gate.js'

/**
 * Form tools under /collection-layouts (the MCP form tools, #3216–#3218):
 *
 *   POST /collection-layouts/form-state   {collection, item?, layout_id?, values?, role?, viewport?}
 *        which fields the resolved form shows, requires and locks — as the
 *        caller (role: administrators only). services/form-state.ts.
 *   POST /collection-layouts/render-form  {…same, theme?, show_hidden?}
 *        a PNG of that form (base64 in JSON), values only where the caller
 *        and the judged role may read them. services/form-image.ts; Chromium
 *        through htmlToPng (local, else the render peer).
 *   GET  /collection-layouts/:id/lint     the editor's lint findings and
 *        health score for the SAVED layout (admin; the same lintLayout twin
 *        the editor runs on its draft).
 *
 * The POSTs are reads (markConfigRead): a config-route POST would otherwise
 * flush metadata caches and push config:update to every open form.
 */

type Body = {
  collection?: unknown
  item?: unknown
  layout_id?: unknown
  values?: unknown
  role?: unknown
  viewport?: unknown
  theme?: unknown
  show_hidden?: unknown
}

const MAX_LINT_FINDINGS = 200

function sendError(reply: FastifyReply, err: unknown) {
  if (err instanceof FormStateError || err instanceof LayoutAssistError)
    return reply.code(err.statusCode).send({ error: err.message })
  const e = err as { statusCode?: number; code?: string; message?: string }
  if (e?.code && /^RENDER_/.test(e.code))
    return reply.code(e.statusCode ?? 503).send({ error: e.message, code: e.code })
  throw err
}

/** The role to judge as: administrators only (a non-admin never learns role names). */
async function roleOf(raw: unknown, isAdmin: boolean) {
  if (raw == null || raw === '') return null
  if (!isAdmin)
    throw new FormStateError(403, 'Only administrators can look at a form as another role')
  return findRole(raw)
}

async function optionsOf(req: { body: unknown; isAdmin?: boolean; workspaceId?: string | null }) {
  const b = (req.body ?? {}) as Body
  const lid = Number(b.layout_id)
  return {
    collection: String(b.collection ?? ''),
    item: b.item == null || b.item === '' ? null : String(b.item),
    layoutId: Number.isFinite(lid) && lid > 0 ? lid : null,
    values:
      b.values && typeof b.values === 'object' && !Array.isArray(b.values)
        ? (b.values as Record<string, unknown>)
        : {},
    role: await roleOf(b.role, !!req.isAdmin),
    viewport: b.viewport === 'phone' ? ('phone' as const) : null,
    workspaceId: req.workspaceId ?? null
  }
}

export async function formToolsRoutes(app: FastifyInstance) {
  app.post('/form-state', { preHandler: authenticate }, async (req, reply) => {
    markConfigRead(req)
    try {
      const opts = await optionsOf(req)
      const state = await computeFormState(req.user!, !!req.isAdmin, opts)
      return reply.send({ data: publicFormState(state) })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.post('/render-form', { preHandler: authenticate }, async (req, reply) => {
    markConfigRead(req)
    try {
      const opts = await optionsOf(req)
      const b = (req.body ?? {}) as Body
      // A browser render is an expensive read: it waits its turn like a cold report.
      const img = await withReadGate(
        String(req.user?.id ?? ''),
        () =>
          renderFormImage(req.user!, !!req.isAdmin, {
            ...opts,
            theme: b.theme === 'dark' ? 'dark' : 'light',
            showHidden: b.show_hidden === true
          }),
        { label: 'render-form' }
      )
      const s = img.state
      return reply.send({
        data: {
          mime: 'image/png',
          base64: img.png.toString('base64'),
          bytes: img.png.length,
          width: img.width,
          collection: s.collection,
          record: s.record,
          as: s.as,
          layout: s.layout,
          can_update: s.can_update,
          summary: s.summary
        }
      })
    } catch (err) {
      return sendError(reply, err)
    }
  })

  app.get<{ Params: { id: string } }>(
    '/:id/lint',
    { preHandler: requireAdmin },
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id) || id <= 0)
        return reply.code(404).send({ error: 'Layout not found' })
      const facts = await loadLayoutFacts(id)
      if (!facts) return reply.code(404).send({ error: 'Layout not found' })
      const layout = facts.bundle.layout
      if (!isFormLayout(layout as Record<string, unknown>))
        return reply.code(400).send({ error: 'Only record forms (grouped layouts) are linted' })
      const input = mergeInherited(facts.bundle, facts.parent)
      const findings = lintLayout(input, facts.ctx)
      const health = layoutHealth(input, findings)
      const count = (sev: string) => findings.filter((f) => f.severity === sev).length
      const named = { groups: [...facts.bundle.groups, ...(facts.parent?.groups ?? [])] }
      const where = (t: (typeof findings)[number]['target']) =>
        t.kind === 'field'
          ? `${fieldLabel(facts, t.field)} in ${groupName(named, t.group_key)}`
          : t.kind === 'group'
            ? groupName(named, t.key)
            : 'the form'
      return reply.send({
        data: {
          layout: {
            id,
            name: String(layout.name ?? id),
            collection: String(layout.collection)
          },
          score: health.score,
          costs: health.costs,
          counts: { error: count('error'), warn: count('warn'), info: count('info') },
          findings: findings.slice(0, MAX_LINT_FINDINGS).map((f) => ({
            id: f.id,
            rule: f.rule,
            severity: f.severity,
            where: where(f.target),
            target: f.target,
            message: f.message,
            ...(f.fix ? { fix: { label: f.fix.label, ops: f.fix.ops } } : {})
          })),
          ...(findings.length > MAX_LINT_FINDINGS
            ? { truncated: true, total: findings.length }
            : {})
        }
      })
    }
  )
}
