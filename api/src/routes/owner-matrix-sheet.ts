import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { markConfigRead } from '../services/config-live.js'
import { readSpreadsheet } from '../services/import-spreadsheet.js'
import { announceOwnerChange, ownerChangeBaseline } from '../services/owner-change-live.js'
import {
  buildOwnerSheetWorkbook,
  type OwnerSheetContext,
  opsEmpty,
  planHash,
  planOwnerSheet,
  SHEET_NAME,
  type SheetPlan,
  valuesToLookUp
} from '../services/owner-matrix-sheet.js'
import {
  applyOwnerSheetOps,
  loadOwnerSheetContext,
  OwnerSheetStaleError
} from '../services/owner-matrix-sheet-db.js'
import { snapshotOwnerMatrixVersion } from '../services/owner-matrix-versions.js'
import { bustOwnerGroupCache } from '../services/pipeline-engine.js'
import { buildXlsx } from '../services/xlsx-writer.js'

/**
 * Owner matrix as a spreadsheet (idea 29), admin only:
 *   GET  /api/pipelines/:id/owner-matrix/sheet            → the .xlsx
 *   POST /api/pipelines/:id/owner-matrix/sheet/preview    (multipart file) → the plan
 *   POST /api/pipelines/:id/owner-matrix/sheet/apply?hash= (the same file) → writes it
 * Preview writes nothing. Apply recomputes the plan from the file against the
 * live matrix and writes only when its hash is the previewed one (409 when
 * the matrix or the file changed), in one transaction, after storing an
 * owner-matrix version (the undo).
 */

const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Read the whole Owners sheet: one big template carries 5,000+ groups. */
const ROW_CAP = 20_000
const MAX_ACTIVITY_ROWS = 500

/** The collections this pipeline is bound to — the owners an apply can move. Null = unknown
 *  (the announcement then covers every pipeline-bound collection). */
async function boundCollections(templateId: string): Promise<string[] | null> {
  try {
    const rows = (await db('nivaro_workflow_bindings')
      .where({ template: templateId })
      .select('collection')) as Array<{ collection: string | null }>
    const out = [...new Set(rows.map((r) => r.collection).filter((c): c is string => !!c))]
    return out.length ? out : null
  } catch {
    return null
  }
}

type Loaded = OwnerSheetContext & { lookUp: (w: Map<string, string[]>) => Promise<void> }

async function readUpload(
  req: FastifyRequest,
  reply: FastifyReply
): Promise<{ buffer: Buffer; filename: string } | null> {
  let part: Awaited<ReturnType<FastifyRequest['file']>>
  try {
    part = await req.file()
  } catch {
    reply.code(400).send({ error: 'Choose a spreadsheet to upload.', code: 'NO_FILE' })
    return null
  }
  if (!part) {
    reply.code(400).send({ error: 'Choose a spreadsheet to upload.', code: 'NO_FILE' })
    return null
  }
  const buffer = await part.toBuffer()
  if (buffer.length > MAX_FILE_BYTES) {
    reply.code(413).send({ error: 'The file is larger than 25 MB.', code: 'FILE_TOO_LARGE' })
    return null
  }
  return { buffer, filename: part.filename || 'owners.xlsx' }
}

/** The upload → the plan against the live matrix (+ its hash). */
export async function planFromUpload(
  ctx: Loaded,
  buffer: Buffer,
  filename: string
): Promise<{ plan: SheetPlan; hash: string } | { error: string }> {
  const read = readSpreadsheet(
    buffer,
    filename,
    { sheet_match: SHEET_NAME, header_row: 1, file_types: ['xlsx', 'xlsm', 'xls', 'csv'] },
    { rowCap: ROW_CAP }
  )
  const hard = read.issues.find((i) => i.severity === 'error' && read.rows.length === 0)
  if (hard && !read.columns?.length) return { error: hard.message }
  const columns = read.columns ?? Object.keys(read.rows[0] ?? {})
  const wanted = valuesToLookUp(ctx, read.rows, columns)
  if (wanted.size) await ctx.lookUp(wanted)
  const plan = planOwnerSheet(
    ctx,
    read.rows,
    columns,
    read.issues.filter((i) => !(i.severity === 'error' && /no data rows/i.test(i.message)))
  )
  return { plan, hash: planHash(ctx.matrixHash, plan.ops) }
}

function previewBody(plan: SheetPlan, hash: string) {
  const { ops: _ops, ...rest } = plan
  return { ...rest, plan_hash: hash, nothing_to_do: opsEmpty(plan.ops) }
}

export async function ownerMatrixSheetRoutes(app: FastifyInstance): Promise<void> {
  app.get('/:id/owner-matrix/sheet', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const ctx = await loadOwnerSheetContext(id)
    if (!ctx) return reply.code(404).send({ error: 'Pipeline not found', code: 'NOT_FOUND' })
    const file = buildXlsx(buildOwnerSheetWorkbook(ctx))
    const safe = ctx.template.name.replace(/[^A-Za-z0-9 _-]+/g, '').trim() || 'pipeline'
    return reply
      .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('Content-Disposition', `attachment; filename="${safe} - owner matrix.xlsx"`)
      .header('Cache-Control', 'no-store')
      .send(file)
  })

  app.post('/:id/owner-matrix/sheet/preview', { preHandler: requireAdmin }, async (req, reply) => {
    markConfigRead(req)
    const { id } = req.params as { id: string }
    const upload = await readUpload(req, reply)
    if (!upload) return reply
    const ctx = await loadOwnerSheetContext(id)
    if (!ctx) return reply.code(404).send({ error: 'Pipeline not found', code: 'NOT_FOUND' })
    const out = await planFromUpload(ctx, upload.buffer, upload.filename)
    if ('error' in out) return reply.code(422).send({ error: out.error, code: 'UNREADABLE' })
    return reply.send({ data: previewBody(out.plan, out.hash) })
  })

  app.post('/:id/owner-matrix/sheet/apply', { preHandler: requireAdmin }, async (req, reply) => {
    const { id } = req.params as { id: string }
    const { hash } = req.query as { hash?: string }
    if (!hash || !/^[a-f0-9]{64}$/.test(hash))
      return reply.code(400).send({ error: 'Preview the file first.', code: 'NO_PREVIEW' })
    const upload = await readUpload(req, reply)
    if (!upload) return reply
    const ctx = await loadOwnerSheetContext(id)
    if (!ctx) return reply.code(404).send({ error: 'Pipeline not found', code: 'NOT_FOUND' })
    const out = await planFromUpload(ctx, upload.buffer, upload.filename)
    if ('error' in out) return reply.code(422).send({ error: out.error, code: 'UNREADABLE' })
    const { plan } = out
    if (out.hash !== hash)
      return reply.code(409).send({
        error:
          'The owner matrix changed since this preview. Check the changes again before applying.',
        code: 'OWNER_SHEET_STALE',
        data: previewBody(plan, out.hash)
      })
    if (plan.errors > 0)
      return reply.code(422).send({
        error: 'Fix the problems in the file first.',
        code: 'OWNER_SHEET_PROBLEMS',
        data: previewBody(plan, out.hash)
      })
    if (opsEmpty(plan.ops)) return reply.send({ data: { applied: false, version: null } })

    // The undo: the matrix as it is now, stored as an owner-matrix version.
    const version = await snapshotOwnerMatrixVersion(
      id,
      req.user?.id,
      'before spreadsheet upload',
      { force: true, logger: req.log }
    )
    // Open record pages, queue Owners rows, owner chips and coverage hear the new owners: the
    // owners of the records open now are remembered first, so the per-record answer is exact.
    const collections = await boundCollections(id)
    await ownerChangeBaseline().catch(() => 0)
    let result: Awaited<ReturnType<typeof applyOwnerSheetOps>>
    try {
      result = await applyOwnerSheetOps(id, ctx.matrixHash, plan.ops)
    } catch (err) {
      if (err instanceof OwnerSheetStaleError)
        return reply.code(409).send({
          error:
            'The owner matrix changed while applying. Nothing was changed — check the changes again.',
          code: 'OWNER_SHEET_STALE'
        })
      throw err
    } finally {
      bustOwnerGroupCache()
    }
    announceOwnerChange({
      collections: collections ?? undefined,
      reason: 'owner-matrix-sheet'
    })

    const c = plan.counts
    await logActivity({
      action: 'owner-matrix-sheet-apply',
      collection: 'nivaro_workflow_templates',
      item: id,
      user: req.user?.id,
      req,
      comment: `Owner matrix spreadsheet "${upload.filename}": ${c.groups_added} group(s) added, ${c.groups_removed} removed, ${c.groups_changed} changed; ${c.people_added} person/people added, ${c.people_removed} removed`
    })
    const newId = new Map(result.inserted.map((x) => [x.row, x.id]))
    let logged = 0
    for (const step of plan.steps)
      for (const ch of step.changes) {
        if (logged++ >= MAX_ACTIVITY_ROWS) break
        const people = [
          ...ch.people_added.map((p) => `+${p.name}`),
          ...ch.people_removed.map((p) => `−${p.name}`)
        ]
        await logActivity({
          action: ch.kind === 'added' ? 'create' : ch.kind === 'removed' ? 'delete' : 'update',
          collection: 'nivaro_pipeline_owner_groups',
          item: ch.group_id ?? (ch.row != null ? newId.get(ch.row) : undefined),
          user: req.user?.id,
          req,
          comment: `spreadsheet upload · ${step.state_label} · ${ch.label}${people.length ? ` · ${people.slice(0, 20).join(', ')}${people.length > 20 ? '…' : ''}` : ''}`
        })
      }
    return reply.send({ data: { applied: true, version, ...result, counts: plan.counts } })
  })
}
