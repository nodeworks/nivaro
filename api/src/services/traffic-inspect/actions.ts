// api/src/services/traffic-inspect/actions.ts
/**
 * Traffic Map drill-down, group "actions" (Task 8). Registers the `notebook` inspect source — a
 * saved investigation (#1212): its title, notes, the saved stack and the context captured when it
 * was saved. The Explain / issue / chat / export / live-tail actions are client side or extra
 * routes (routes/traffic-map-extras/inspect-actions.ts).
 */
import type { FastifyRequest } from 'fastify'
import { registerInspectSource } from '../traffic-inspect.js'
import { canEditInvestigation, INVESTIGATION_ID_RE } from './actions-logic.js'
import { getInvestigation, type InvestigationRecord, investigationsReady } from './actions-store.js'

export interface InvestigationDetail extends Omit<InvestigationRecord, 'context'> {
  /** The captured context as parsed JSON; null when none was saved or it no longer parses. */
  context: unknown | null
  context_bytes: number
  can_edit: boolean
}

/** The record as the panel and GET /investigations/:id see it. */
export function investigationDetail(
  rec: InvestigationRecord,
  req: Pick<FastifyRequest, 'user' | 'isAdmin'>
): InvestigationDetail {
  let context: unknown | null = null
  if (rec.context) {
    try {
      context = JSON.parse(rec.context)
    } catch {
      context = null
    }
  }
  return {
    ...rec,
    context,
    context_bytes: rec.context?.length ?? 0,
    can_edit: canEditInvestigation(rec, req.user?.id ?? null, !!req.isAdmin)
  }
}

registerInspectSource({
  kind: 'notebook',
  validId: (id) => INVESTIGATION_ID_RE.test(id),
  async peek(id) {
    if (!(await investigationsReady())) return null
    const rec = await getInvestigation(id)
    if (!rec) return null
    const levels = rec.stack ? rec.stack.split('/').length : 0
    return {
      title: rec.title,
      lines: [
        `${levels} level${levels === 1 ? '' : 's'} saved`,
        `Saved by ${rec.created_by_name ?? 'someone'} · updated ${rec.updated_at.slice(0, 16).replace('T', ' ')} UTC`
      ],
      at: rec.updated_at
    }
  },
  async detail(id, ctx) {
    if (!(await investigationsReady())) return null
    const rec = await getInvestigation(id)
    return rec ? investigationDetail(rec, ctx.req) : null
  }
})
