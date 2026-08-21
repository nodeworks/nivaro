import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { startJobRun } from '../services/job-runs.js'

/**
 * Admin find & replace (#41): cross-record value replacement on one column,
 * with a full hit preview before anything writes. Apply goes through
 * updateOne per record — revisions, hooks, validation and computed fields all
 * fire, so every replacement is attributable and reversible like any other
 * edit. Large sets run as a background job (poll /job-runs).
 */

const COLLECTION_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

interface FindReplaceBody {
  collection?: string
  field?: string
  find?: string
  replace?: string
  mode?: 'exact' | 'contains'
}

async function resolveHits(b: Required<Pick<FindReplaceBody, 'collection' | 'field' | 'find' | 'mode'>>, cap: number) {
  const like = `%${b.find.replace(/[%_[]/g, (c) => `[${c}]`)}%`
  let q = db(b.collection).select('id', b.field).limit(cap)
  q = b.mode === 'exact' ? q.where(b.field, b.find) : q.where(b.field, 'like', like)
  return (await q) as Array<Record<string, unknown>>
}

function newValue(old: string, find: string, replace: string, mode: 'exact' | 'contains'): string {
  return mode === 'exact' ? replace : old.split(find).join(replace)
}

export async function findReplaceRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', requireAdmin)

  const validate = async (b: FindReplaceBody): Promise<string | null> => {
    if (!b.collection || !COLLECTION_RE.test(b.collection) || /^nivaro_/i.test(b.collection)) {
      return 'Invalid collection'
    }
    if (!b.field || !COLLECTION_RE.test(b.field) || b.field.toLowerCase() === 'id') {
      return 'Invalid field'
    }
    if (!b.find) return 'find is required'
    if (b.replace === undefined) return 'replace is required'
    const col = await db('information_schema.columns')
      .where({ table_name: b.collection, column_name: b.field })
      .first('data_type')
    if (!col) return `${b.collection}.${b.field} is not a physical column`
    if (!/char|text/i.test(String((col as { data_type: string }).data_type))) {
      return 'Find & replace works on text columns only'
    }
    return null
  }

  app.post('/preview', async (req, reply) => {
    const b = req.body as FindReplaceBody
    const err = await validate(b)
    if (err) return reply.code(400).send({ error: err })
    const mode = b.mode === 'exact' ? 'exact' : 'contains'
    const rows = await resolveHits(
      { collection: b.collection!, field: b.field!, find: b.find!, mode },
      2001
    )
    return {
      data: {
        total: Math.min(rows.length, 2000),
        truncated: rows.length > 2000,
        samples: rows.slice(0, 50).map((r) => ({
          id: r.id,
          old: String(r[b.field!] ?? ''),
          new: newValue(String(r[b.field!] ?? ''), b.find!, String(b.replace ?? ''), mode)
        }))
      }
    }
  })

  app.post('/apply', async (req, reply) => {
    const b = req.body as FindReplaceBody
    const err = await validate(b)
    if (err) return reply.code(400).send({ error: err })
    const mode = b.mode === 'exact' ? 'exact' : 'contains'
    const rows = await resolveHits(
      { collection: b.collection!, field: b.field!, find: b.find!, mode },
      2001
    )
    if (rows.length > 2000) {
      return reply.code(400).send({ error: 'Over 2,000 matches — narrow the find value first' })
    }
    const userId = req.user!.id
    const run = await startJobRun('cron', 'find-replace', { triggeredBy: userId })
    await logActivity({
      action: 'find-replace',
      user: userId,
      collection: b.collection,
      comment: `${rows.length} record(s): "${b.find}" → "${b.replace}" on ${b.field}`.slice(0, 300),
      req
    })
    // Fire-and-forget — updateOne per record is deliberately sequential
    // (revisions + hooks per row); the page polls the job run for progress.
    void (async () => {
      const { updateOne } = await import('../services/items.js')
      const user = req.user!
      let done = 0
      let failed = 0
      for (const r of rows) {
        try {
          await updateOne(user, b.collection!, String(r.id), {
            [b.field!]: newValue(String(r[b.field!] ?? ''), b.find!, String(b.replace ?? ''), mode)
          })
          done++
        } catch {
          failed++
        }
        if ((done + failed) % 25 === 0) run.progress({ done, failed, total: rows.length })
      }
      const summary = `${done}/${rows.length} replaced${failed ? `, ${failed} failed` : ''}`
      if (failed > 0 && done === 0) await run.fail(summary)
      else await run.complete(summary)
    })()
    return reply.code(202).send({ data: { queued: rows.length, run_id: run.id } })
  })
}
