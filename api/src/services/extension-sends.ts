import { db } from '../db/index.js'
import { REQUESTED_VIA, type RequestedVia } from './erp-submission-status.js'
import { answerByFor, checkFailedReason, unansweredHold } from './erp-unanswered.js'

/**
 * `ctx.integrations.beginSend / finishSend / holdSend`: the write-ahead and the unanswered-send
 * guard (erp-unanswered.ts) for an extension that calls a partner itself instead of through a
 * transition action. The same row, the same `sending` status and the same guard the core
 * erp_submit path uses, so a send an extension made shows, holds and settles exactly like one a
 * transition made:
 *
 *   holdSend   → a sentence when the push must wait (an earlier send of it has no answer, or
 *                the earlier sends could not be read — `checkFailed`: the caller decides whether
 *                not knowing means wait; an order-creating send waits)
 *   beginSend  → the row, `sending`, answer_by = now + THIS call's timeout + the margin
 *   finishSend → the answer written onto that row (a failed finish leaves it `sending`)
 */

export interface BeginSendInput {
  collection: string
  item: string | number
  /** External API name or id. */
  api: string | number
  endpointPath: string
  /** The request as rendered (body-secret placeholders, never values). */
  body: Record<string, unknown>
  /** The timeout the call is made with: decides when the row stops reading in flight. */
  timeoutMs: number
  /** An order-creating push: the stale-send alert ranks it highest. */
  blocking?: boolean
  requestedBy?: string | null
  /** transition | auto-transition | flow | item-action | retry | resend | cron | api */
  requestedVia?: string | null
}

export interface FinishSendInput {
  collection: string
  item: string | number
  api: string | number
  status: 'pending' | 'accepted' | 'failed'
  error: string | null
  response?: unknown
  httpStatus?: number | null
  externalRef?: string | null
  /** For the activity line ("Fusion requisition push → api:7 (accepted)"). */
  source?: string
}

export interface HoldSendInput {
  collection: string
  item: string | number
  api: string | number
  endpointPath: string
  /** The move this push belongs to, named in the "still being sent" sentence. */
  moveLabel?: string | null
}

async function apiOf(api: string | number): Promise<{ id: number; name: string } | null> {
  try {
    const row = (await db('nivaro_external_apis')
      .where(typeof api === 'number' ? { id: api } : { name: api })
      .first('id', 'name')) as { id: number; name: string } | undefined
    return row ? { id: Number(row.id), name: row.name } : null
  } catch {
    return null
  }
}

const via = (v: string | null | undefined): RequestedVia | null =>
  v && (REQUESTED_VIA as readonly string[]).includes(v) ? (v as RequestedVia) : null

export function extensionSendMembers() {
  return {
    beginSend: async (o: BeginSendInput): Promise<number | null> => {
      const api = await apiOf(o.api)
      if (!api) return null
      const { beginSubmission } = await import('./workflow-actions.js')
      return beginSubmission({
        collection: o.collection,
        item: String(o.item),
        externalApi: api.id,
        endpointPath: o.endpointPath,
        body: o.body,
        answerBy: answerByFor(new Date(), Math.max(0, Number(o.timeoutMs) || 0)),
        who: { by: o.requestedBy ?? null, via: via(o.requestedVia) },
        blocking: o.blocking === true
      })
    },
    finishSend: async (id: number, o: FinishSendInput): Promise<boolean> => {
      const api = await apiOf(o.api)
      if (!api) return false
      const { finishSubmission } = await import('./workflow-actions.js')
      return finishSubmission(id, {
        collection: o.collection,
        item: String(o.item),
        externalApi: api.id,
        status: o.status,
        error: o.error,
        responseBody: o.response,
        httpStatus: o.httpStatus ?? null,
        externalRef: o.externalRef ?? null,
        source: o.source
      })
    },
    holdSend: async (
      o: HoldSendInput
    ): Promise<{ reason: string; stale: boolean | null; checkFailed: boolean } | null> => {
      const api = await apiOf(o.api)
      if (!api) {
        return { reason: checkFailedReason(String(o.api)), stale: null, checkFailed: true }
      }
      const hold = await unansweredHold({
        collection: o.collection,
        item: String(o.item),
        apiId: api.id,
        endpointPath: o.endpointPath,
        moveLabel: o.moveLabel ?? null
      })
      return hold
        ? { reason: hold.reason, stale: hold.send?.stale ?? null, checkFailed: hold.checkFailed }
        : null
    }
  }
}
