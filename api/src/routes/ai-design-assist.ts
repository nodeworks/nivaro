import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import {
  type AssistContext,
  bundleFromBody,
  completeFor,
  loadAssistContext
} from '../services/ai-design/layout-assist-context.js'
import { checkLayoutChange } from '../services/ai-design/layout-change-check.js'
import { suggestEntryOrder } from '../services/ai-design/layout-entry-order.js'
import { reviewMeaning } from '../services/ai-design/layout-meaning.js'
import type { LayoutFinding } from '../services/ai-design/layout-review.js'
import { checkSensitiveFields, SENSITIVE_NOTE } from '../services/ai-design/layout-sensitive.js'
import { AiUnavailableError } from '../services/ai-design/model.js'
import { loadLayoutBundle } from '../services/layout-ops.js'
import type { LayoutBundle } from '../services/layout-ops-apply.js'

/**
 * Layout editor AI assists (#2684 #2686 #2687 #2688 #2689) under
 * /ai-design/layouts/:id/… — registered inside aiDesignRoutes, so admin-only.
 * Every route PROPOSES: answers carry warnings or change sets (layout ops)
 * the editor applies through its draft; nothing here writes a layout. A
 * route that needs the model answers 503 when AI is not set up.
 *
 * The editor may send its draft (`bundle`, unsaved changes included) so the
 * proposal fits what the admin is looking at; it is only read, and the ops
 * are checked again by the ops twin when the draft applies and saves them.
 */

const unavailable = () => new AiUnavailableError().message

const aiFailed = (what: string, err: unknown) =>
  `The AI could not ${what}: ${(err as Error).message}`.slice(0, 400)

async function layoutAndContext(
  id: number
): Promise<{ stored: LayoutBundle; ctx: AssistContext } | null> {
  const stored = await loadLayoutBundle(db, id)
  if (!stored) return null
  return { stored, ctx: await loadAssistContext(String(stored.layout.collection)) }
}

/** The review's extra AI pass (#2686 #2687): help text vs behaviour, same-meaning fields. */
export async function meaningPass(
  bundle: LayoutBundle | null,
  ai: boolean
): Promise<{ findings: LayoutFinding[]; dropped: number; error: string | null }> {
  if (!bundle || !ai) return { findings: [], dropped: 0, error: null }
  const complete = await completeFor('chat')
  if (!complete) return { findings: [], dropped: 0, error: null }
  const ctx = await loadAssistContext(String(bundle.layout.collection))
  return reviewMeaning(bundle, ctx, complete)
}

export function registerLayoutAssistRoutes(app: FastifyInstance): void {
  // ── AI check of a change before / as it is saved (#2684) ───────────────────
  app.post<{ Params: { id: string }; Body: { before?: unknown; after?: unknown } }>(
    '/layouts/:id/check-changes',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const loaded = await layoutAndContext(id)
      if (!loaded) return reply.code(404).send({ error: 'Layout not found' })
      const { stored, ctx } = loaded
      const after = bundleFromBody(req.body?.after, stored.layout)
      if (!after) return reply.code(400).send({ error: 'after must be the layout as it is now' })
      const before =
        req.body?.before == null ? stored : bundleFromBody(req.body.before, stored.layout)
      if (!before) return reply.code(400).send({ error: 'before must be a layout' })
      const complete = await completeFor('chat')
      if (!complete) return reply.code(503).send({ error: unavailable() })
      try {
        return reply.send({ data: await checkLayoutChange(before, after, ctx, complete) })
      } catch (err) {
        return reply.code(502).send({ error: aiFailed('check the change', err) })
      }
    }
  )

  // ── Natural entry order per section (#2688) ────────────────────────────────
  app.post<{ Params: { id: string }; Body: { bundle?: unknown } }>(
    '/layouts/:id/entry-order',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const loaded = await layoutAndContext(id)
      if (!loaded) return reply.code(404).send({ error: 'Layout not found' })
      const complete = await completeFor('chat')
      if (!complete) return reply.code(503).send({ error: unavailable() })
      const bundle = bundleFromBody(req.body?.bundle, loaded.stored.layout) ?? loaded.stored
      try {
        return reply.send({ data: await suggestEntryOrder(bundle, loaded.ctx, complete) })
      } catch (err) {
        return reply.code(502).send({ error: aiFailed('suggest an order', err) })
      }
    }
  )

  // ── Sensitive fields seen by broad roles (#2689) — advice only ─────────────
  app.post<{ Params: { id: string }; Body: { bundle?: unknown } }>(
    '/layouts/:id/sensitive',
    async (req, reply) => {
      const id = Number(req.params.id)
      if (!Number.isFinite(id)) return reply.code(400).send({ error: 'Invalid layout id' })
      const loaded = await layoutAndContext(id)
      if (!loaded) return reply.code(404).send({ error: 'Layout not found' })
      const complete = await completeFor('chat')
      if (!complete) return reply.code(503).send({ error: unavailable() })
      const bundle = bundleFromBody(req.body?.bundle, loaded.stored.layout) ?? loaded.stored
      const { collectionFieldAccess } = await import('../services/layout-field-access.js')
      const access = await collectionFieldAccess(loaded.ctx.collection)
      try {
        const result = await checkSensitiveFields(bundle, loaded.ctx, access, complete)
        return reply.send({ data: { ...result, note: SENSITIVE_NOTE } })
      } catch (err) {
        return reply.code(502).send({ error: aiFailed('classify the fields', err) })
      }
    }
  )
}
