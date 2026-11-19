import { db } from '../../db/index.js'
import { runInBackgroundPool } from '../../db/pool-context.js'
import { tenantState } from '../ai-tenant-state.js'
import { callLogColumnsSupported } from './columns.js'
import { questionOf, toolsOf } from './transcript.js'

/**
 * Rows logged before migration 539 carry no `question` / `tools`. The first
 * read of the call log in a process starts this once (per tenant): it reads
 * those rows newest first in small batches on the background pool, reads the
 * question and the tool names out of the stored bodies, and writes them back
 * ('' = the call carried no question). The log keeps 30 days, so the work is
 * bounded; a crash simply leaves the rest for the next process.
 */

const BATCH = 100
const MAX_ROWS = 20_000

const state = tenantState<{ running: boolean; done: boolean }>(() => ({
  running: false,
  done: false
}))

export function backfillStatus(): { running: boolean; done: boolean } {
  const s = state()
  return { running: s.running, done: s.done }
}

/** Fire and forget: fill question/tools on older rows. Never throws. */
export function startCallLogBackfill(): void {
  const st = state()
  if (st.running || st.done) return
  st.running = true
  void runInBackgroundPool(async () => {
    try {
      if (!(await callLogColumnsSupported())) return
      let seen = 0
      let beforeId: number | null = null
      while (seen < MAX_ROWS) {
        const q = db('nivaro_ai_calls')
          .whereNull('question')
          .orderBy('id', 'desc')
          .limit(BATCH)
          .select('id', 'request', 'response')
        if (beforeId != null) q.where('id', '<', beforeId)
        const rows = (await q) as Array<{
          id: number | string
          request: string | null
          response: string | null
        }>
        if (!rows.length) break
        for (const r of rows) {
          await db('nivaro_ai_calls')
            .where({ id: r.id })
            .update({ question: questionOf(r.request), tools: toolsOf(r.response) })
        }
        seen += rows.length
        beforeId = Number(rows[rows.length - 1].id)
        await new Promise((res) => setImmediate(res))
      }
      st.done = true
    } catch {
      // the next process tries again
    } finally {
      st.running = false
    }
  })
}
