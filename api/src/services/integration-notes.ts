/**
 * The record's own history answers "did they get it".
 *
 * Every obligation resolution becomes a read-only entry in the Notes thread,
 * beside transition comments and change reasons — so the question is answered
 * where it is asked, rather than in a second table nobody opens.
 *
 * A `superseded` row renders nothing: it says the record moved on, which the
 * thread already shows by other means, and a line per supersession would
 * bury the ones that matter.
 *
 * Registered one provider per collection with `relatedNoteRegistry` — the
 * mechanism `services/record-notes.ts` already documents as carrying MACHINE
 * events "by design", so these entries bypass the human-note filter without
 * any flag of their own; `user` stays null on every entry, the interface's
 * own marker for "not a person".
 */
import { db } from '../db/index.js'
import { relatedNoteRegistry } from '../extensions/related-notes.js'
import type { RelatedNoteEntry } from '../extensions/related-notes.js'
import { getObligationKind } from './integration-obligations.js'

const THREAD_CAP = 40

interface LedgerRow {
  id: number
  api: string
  kind: string
  outcome: string
  reason: string | null
  trigger: string
  due_at: Date
  resolved_at: Date | null
}

/** One ledger row in the thread's words. '' means "do not render". */
export function obligationNoteText(row: {
  api: string
  kind: string
  outcome: string
  reason: string | null
  trigger: string
}): string {
  const tail = row.reason ? ` — ${row.reason}` : ''
  switch (row.outcome) {
    case 'sent':
      return `${row.api} told (${row.kind})${tail}`
    case 'pending':
      return `${row.api} sent (${row.kind}) — awaiting acknowledgement`
    case 'skipped':
      return `${row.api} not told (${row.kind})${tail}`
    case 'failed':
      return `${row.api} send failed (${row.kind})${tail}`
    case 'missing':
      return `${row.api} was never told (${row.kind})${tail}`
    case 'overdue':
      return `${row.api} still has not got this (${row.kind})${tail}`
    default:
      return ''
  }
}

function statusOf(outcome: string): 'ok' | 'error' | 'info' {
  if (outcome === 'sent') return 'ok'
  if (outcome === 'failed' || outcome === 'missing' || outcome === 'overdue') return 'error'
  return 'info'
}

/**
 * Register one provider per collection that has obligation kinds. Called
 * from server.ts onReady, AFTER extensions load, so the collection list is
 * built from whatever actually registered — an install with no obligation
 * kinds registers no providers and behaves exactly as it did before this
 * file existed.
 */
export function registerIntegrationNoteSources(collections: string[]): void {
  for (const collection of [...new Set(collections)]) {
    const id = `integrations:${collection}`
    if (relatedNoteRegistry.get(id)) continue
    relatedNoteRegistry.register({
      id,
      collection,
      label: 'Integrations',
      load: async (item: string): Promise<RelatedNoteEntry[]> => {
        // Rides ix_integration_obligations_record (collection, item, kind, id
        // DESC) — order by id, same shape as the per-record ledger route.
        const rows = (await db('nivaro_integration_obligations')
          .where({ collection, item: String(item) })
          .whereNot({ outcome: 'superseded' })
          .orderBy('id', 'desc')
          .limit(THREAD_CAP)
          .select(
            'id',
            'api',
            'kind',
            'outcome',
            'reason',
            'trigger',
            'due_at',
            'resolved_at'
          )) as LedgerRow[]
        return rows
          .map((r) => {
            // The kind by its REGISTERED label, never the raw key — the
            // ledger stores the machine key, the thread wants the name.
            const kindLabel = getObligationKind(r.api, r.kind)?.label ?? r.kind
            return {
              id: r.id,
              label: r.api,
              text: obligationNoteText({ ...r, kind: kindLabel }),
              user: null,
              created_at: r.resolved_at ?? r.due_at,
              context: `via ${r.trigger}`,
              status: statusOf(r.outcome)
            }
          })
          .filter((e) => e.text !== '')
      }
    })
  }
}
