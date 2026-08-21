import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { selectInChunks } from '../services/db-batch.js'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseJson<T>(value: unknown): T | null {
  if (value == null) return null
  if (typeof value !== 'string') return value as T
  try {
    return JSON.parse(value) as T
  } catch {
    return null
  }
}

function formatJob(job: Record<string, unknown>) {
  return {
    ...job,
    column_map: parseJson(job.column_map),
    errors: parseJson(job.errors)
  }
}

// Simple CSV line parser — handles quoted fields with embedded commas/newlines
function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      // Handle escaped double-quote ("")
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

// ─── Remote CSV fetching ──────────────────────────────────────────────────────

const MAX_CSV_BYTES = 25 * 1024 * 1024 // 25MB
const ALLOWED_CONTENT_TYPES = ['text/csv', 'application/csv', 'text/plain']
const MAX_REDIRECTS = 3

/**
 * Fetches a remote CSV with SSRF guarding (assertSafeUrl on the URL and on every
 * redirect target), a 30s timeout, a content-type allowlist, and a streamed 25MB cap.
 */
async function fetchRemoteCsv(rawUrl: string): Promise<{ csv: string; fileName: string }> {
  let currentUrl = rawUrl

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    await assertSafeUrl(currentUrl)

    const res = await fetch(currentUrl, {
      redirect: 'manual',
      signal: AbortSignal.timeout(30_000),
      headers: { accept: 'text/csv, application/csv, text/plain' }
    })

    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location')
      if (!loc) throw new Error('Redirect response without a Location header')
      if (hop === MAX_REDIRECTS) throw new Error('Too many redirects')
      currentUrl = new URL(loc, currentUrl).toString()
      continue
    }

    if (!res.ok) {
      throw new Error(`Remote server responded with ${res.status}`)
    }

    const contentType = (res.headers.get('content-type') ?? '').split(';')[0].trim().toLowerCase()
    if (contentType && !ALLOWED_CONTENT_TYPES.includes(contentType)) {
      throw new Error(`Unsupported content type: ${contentType} (expected CSV or plain text)`)
    }

    const declaredLength = Number(res.headers.get('content-length') ?? 0)
    if (declaredLength > MAX_CSV_BYTES) {
      throw new Error('File exceeds the 25MB limit')
    }

    // Stream the body with a hard byte cap
    if (!res.body) throw new Error('Remote response had no body')
    const reader = res.body.getReader()
    const chunks: Uint8Array[] = []
    let received = 0
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      received += value.byteLength
      if (received > MAX_CSV_BYTES) {
        await reader.cancel().catch(() => {})
        throw new Error('File exceeds the 25MB limit')
      }
      chunks.push(value)
    }
    const csv = Buffer.concat(chunks).toString('utf8')

    // Derive a file name from the final URL path
    let fileName = 'remote.csv'
    try {
      const last = new URL(currentUrl).pathname.split('/').filter(Boolean).pop()
      if (last) fileName = decodeURIComponent(last)
    } catch {
      /* keep default */
    }
    if (!/\.csv$/i.test(fileName)) fileName = `${fileName}.csv`

    return { csv, fileName }
  }

  throw new Error('Too many redirects')
}

// ─── Background processor ─────────────────────────────────────────────────────

/** Insert and get the new id back. OUTPUT fails on tables with triggers —
 *  fall back to a plain insert with an unknown id (rollback skips it and
 *  says so, rather than guessing which row was ours). */
async function insertReturningId(collection: string, rowData: Record<string, unknown>): Promise<unknown> {
  try {
    const [row] = await db(collection).insert(rowData).returning('id')
    return typeof row === 'object' ? (row as { id: unknown }).id : row
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/OUTPUT|trigger/i.test(msg)) {
      await db(collection).insert(rowData)
      return null
    }
    throw err
  }
}

async function processImportJob(jobId: string, app: FastifyInstance) {
  try {
    await db('nivaro_import_jobs').where({ id: jobId }).update({
      status: 'processing',
      started_at: new Date()
    })

    const job = await db('nivaro_import_jobs').where({ id: jobId }).first()
    if (!job) return

    const csvData = job.csv_data as string
    // Normalise line endings
    const lines = csvData
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .filter((l: string) => l.trim())

    if (lines.length < 1) {
      await db('nivaro_import_jobs')
        .where({ id: jobId })
        .update({
          status: 'failed',
          completed_at: new Date(),
          errors: JSON.stringify([{ row: 0, error: 'CSV has no header row' }])
        })
      return
    }

    const headers = parseCSVLine(lines[0])
    const dataLines = lines.slice(1).filter((l: string) => l.trim())
    const columnMap = parseJson<Record<string, string>>(job.column_map) ?? {}

    await db('nivaro_import_jobs').where({ id: jobId }).update({ total_rows: dataLines.length })

    const emitProgress = (data: object) => {
      if ((app as unknown as { io?: { emit: (event: string, data: object) => void } }).io) {
        ;(app as unknown as { io: { emit: (event: string, data: object) => void } }).io.emit(
          `import:progress:${jobId}`,
          data
        )
      }
    }

    let created = 0
    let updated = 0
    let skipped = 0
    let errorRows = 0
    const errors: { row: number; error: string }[] = []
    // Rollback capture: created row ids, and for overwrites the PRIOR values
    // of exactly the fields the import touched — enough to undo, no more.
    const rbCreated: Array<{ id: unknown }> = []
    const rbUpdated: Array<{ key_field: string; key: unknown; prior: Record<string, unknown> }> = []

    for (let i = 0; i < dataLines.length; i++) {
      try {
        const values = parseCSVLine(dataLines[i])
        const rowData: Record<string, unknown> = {}

        for (const [csvCol, fieldName] of Object.entries(columnMap)) {
          if (!fieldName) continue
          const colIdx = headers.indexOf(csvCol)
          if (colIdx >= 0) {
            rowData[fieldName] = values[colIdx] ?? null
          }
        }

        const collection = job.collection as string
        if (/^nivaro_/i.test(collection)) {
          throw new Error(`Cannot import into system table: ${collection}`)
        }
        const idField = job.id_field as string | null
        const strategy = job.duplicate_strategy as string

        if (idField && rowData[idField]) {
          const existing = await db(collection)
            .where({ [idField]: rowData[idField] })
            .first()
          if (existing) {
            if (strategy === 'skip') {
              skipped++
            } else if (strategy === 'overwrite' || strategy === 'merge') {
              const prior: Record<string, unknown> = {}
              for (const k of Object.keys(rowData)) prior[k] = (existing as Record<string, unknown>)[k]
              await db(collection)
                .where({ [idField]: rowData[idField] })
                .update(rowData)
              rbUpdated.push({ key_field: idField, key: rowData[idField], prior })
              updated++
            } else {
              skipped++
            }
          } else {
            rbCreated.push({ id: await insertReturningId(collection, rowData) })
            created++
          }
        } else {
          rbCreated.push({ id: await insertReturningId(collection, rowData) })
          created++
        }
      } catch (err) {
        errorRows++
        errors.push({ row: i + 2, error: (err as Error).message.slice(0, 200) })
      }

      // Update progress every 10 rows or on last row
      if (i % 10 === 0 || i === dataLines.length - 1) {
        await db('nivaro_import_jobs')
          .where({ id: jobId })
          .update({
            processed_rows: i + 1,
            created_rows: created,
            updated_rows: updated,
            skipped_rows: skipped,
            error_rows: errorRows
          })
        emitProgress({
          jobId,
          processed: i + 1,
          total: dataLines.length,
          created,
          updated,
          skipped,
          errors: errorRows
        })
      }
    }

    await db('nivaro_import_jobs')
      .where({ id: jobId })
      .update({
        status: 'complete',
        completed_at: new Date(),
        rollback_data: JSON.stringify({ created: rbCreated, updated: rbUpdated }),
        errors: JSON.stringify(errors),
        processed_rows: dataLines.length,
        created_rows: created,
        updated_rows: updated,
        skipped_rows: skipped,
        error_rows: errorRows
      })

    emitProgress({ jobId, done: true, created, updated, skipped, errors: errorRows })

    await logActivity({
      action: 'import-complete',
      user: (job.created_by as string | null) ?? null,
      collection: job.collection as string,
      item: String(jobId),
      comment: `created ${created}, updated ${updated}, skipped ${skipped}, errors ${errorRows}`
    })
  } catch (err) {
    await db('nivaro_import_jobs')
      .where({ id: jobId })
      .update({
        status: 'failed',
        completed_at: new Date(),
        errors: JSON.stringify([{ row: 0, error: (err as Error).message }])
      })
    if ((app as unknown as { io?: { emit: (event: string, data: object) => void } }).io) {
      ;(app as unknown as { io: { emit: (event: string, data: object) => void } }).io.emit(
        `import:progress:${jobId}`,
        { jobId, failed: true, error: (err as Error).message }
      )
    }

    const failedJob = await db('nivaro_import_jobs').where({ id: jobId }).first()
    await logActivity({
      action: 'import-failed',
      user: (failedJob?.created_by as string | null) ?? null,
      collection: (failedJob?.collection as string) ?? undefined,
      item: String(jobId),
      comment: (err as Error).message.slice(0, 200)
    })
  }
}

// ─── Job creation (shared by POST / and POST /from-url) ──────────────────────

interface CreateJobInput {
  collection: string
  csv_data: string
  column_map?: Record<string, string>
  duplicate_strategy?: string
  id_field?: string
  file_name?: string
  created_by: string | null
}

/** Header signature for mapping memory: sorted + lowercased so column order
 *  (which re-exports shuffle freely) never splits one shape into two. */
function headerSignature(headers: string[]): string {
  return createHash('sha256')
    .update(
      headers
        .map((h) => h.trim().toLowerCase())
        .sort()
        .join('\u0001')
    )
    .digest('hex')
}

/** Remember this import's mapping for the next same-shaped file — creation
 *  IS the save, so the wizard never needs an explicit "save mapping" step.
 *  Best-effort: memory must never block an import. */
async function rememberMapping(input: CreateJobInput): Promise<void> {
  try {
    if (!input.column_map || Object.keys(input.column_map).length === 0) return
    const firstLine = String(input.csv_data).split(/\r?\n/)[0] ?? ''
    const headers = parseCSVLine(firstLine)
    if (headers.length === 0) return
    const hash = headerSignature(headers)
    const row = {
      headers: JSON.stringify(headers),
      column_map: JSON.stringify(input.column_map),
      id_field: input.id_field ?? null,
      duplicate_strategy: input.duplicate_strategy ?? null,
      updated_by: input.created_by,
      updated_at: new Date()
    }
    const updated = await db('nivaro_import_mappings')
      .where({ collection: input.collection, header_hash: hash })
      .update(row)
    if (!updated) {
      await db('nivaro_import_mappings').insert({
        collection: input.collection,
        header_hash: hash,
        ...row
      })
    }
  } catch {
    /* memory is a convenience, never a failure */
  }
}

async function createImportJob(input: CreateJobInput, app: FastifyInstance) {
  const id = randomUUID()
  void rememberMapping(input)

  await db('nivaro_import_jobs').insert({
    id,
    collection: input.collection,
    file_name: input.file_name ?? 'import.csv',
    csv_data: input.csv_data,
    column_map: input.column_map ? JSON.stringify(input.column_map) : null,
    duplicate_strategy: input.duplicate_strategy ?? 'skip',
    id_field: input.id_field ?? null,
    status: 'pending',
    processed_rows: 0,
    created_rows: 0,
    updated_rows: 0,
    skipped_rows: 0,
    error_rows: 0,
    created_by: input.created_by,
    created_at: new Date()
  })

  const job = await db('nivaro_import_jobs').where({ id }).first()

  // Fire-and-forget
  processImportJob(id, app).catch(console.error)

  return job
}

// ─── Routes ───────────────────────────────────────────────────────────────────

export async function importsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', requireAdmin)

  // GET / — list import jobs
  app.get('/', async (req, reply) => {
    let query = db('nivaro_import_jobs').orderBy('created_at', 'desc')

    if (!req.isAdmin) {
      query = query.where({ created_by: req.user?.id })
    }

    const rows = await query
    return reply.send({ data: rows.map(formatJob) })
  })

  // GET /:id — get single job
  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await db('nivaro_import_jobs').where({ id }).first()

    if (!job) return reply.code(404).send({ error: 'Not found' })

    // Gate: own or admin
    if (!req.isAdmin && job.created_by !== req.user?.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    return reply.send({ data: formatJob(job) })
  })

  // POST / — create import job and kick off processing
  /**
   * Diff preview — "42 new, 7 changed, 2 conflicts" BEFORE anything commits.
   *
   * Mirrors processImportJob's matching logic exactly (same id_field lookup,
   * same strategy semantics) without writing a row, so the numbers on the
   * confirm step are the numbers the import will produce. Classifications:
   *
   *   new        — no id_field, empty id value, or no existing match
   *   unchanged  — match exists and every mapped value already agrees
   *   changed    — match exists, values differ, strategy will update it
   *   conflict   — one of two shapes an operator must LOOK at:
   *                  · match exists + values differ + strategy is `skip` —
   *                    the file carries data that will be silently dropped
   *                  · the same id appears on multiple file rows — last write
   *                    wins and the file is ambiguous about which that is
   *
   * Values compare as trimmed strings with a numeric-equality fallback
   * ("100.0" vs 100 is not a change). Field-level old→new diffs return for
   * the first 50 changed/conflicted rows.
   */
  /** Mapping memory lookup: "have we mapped this file shape before?" The
   *  wizard calls it right after parsing headers and auto-applies a hit. */
  app.post('/mappings/lookup', async (req, reply) => {
    const body = req.body as { collection?: string; headers?: string[] }
    const collection = String(body?.collection ?? '')
    const headers = Array.isArray(body?.headers) ? body.headers.map(String) : []
    if (!collection || headers.length === 0) {
      return reply.code(400).send({ error: 'collection and headers are required' })
    }
    const row = await db('nivaro_import_mappings')
      .where({ collection, header_hash: headerSignature(headers) })
      .first()
    if (!row) return reply.send({ data: null })
    return reply.send({
      data: {
        column_map: JSON.parse(String(row.column_map)) as Record<string, string>,
        id_field: row.id_field ?? null,
        duplicate_strategy: row.duplicate_strategy ?? null,
        updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null
      }
    })
  })

  app.post('/preview', async (req, reply) => {
    const body = req.body as {
      collection?: string
      csv_data?: string
      column_map?: Record<string, string>
      id_field?: string | null
      duplicate_strategy?: string
    }
    const collection = String(body.collection ?? '')
    if (!collection || /^nivaro_/i.test(collection) || !/^[A-Za-z_][\w]*$/.test(collection)) {
      return reply.code(400).send({ error: 'Invalid collection' })
    }
    if (!body.csv_data) return reply.code(400).send({ error: 'csv_data is required' })

    const lines = String(body.csv_data)
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .filter((l) => l.trim())
    if (lines.length < 2) {
      return reply.code(400).send({ error: 'CSV needs a header row and at least one data row' })
    }

    const headers = parseCSVLine(lines[0])
    const PREVIEW_CAP = 5000
    const dataLines = lines.slice(1)
    const truncated = dataLines.length > PREVIEW_CAP
    const scanned = dataLines.slice(0, PREVIEW_CAP)
    const columnMap = body.column_map ?? {}
    const idField = body.id_field || null
    const strategy = body.duplicate_strategy ?? 'skip'

    // Map every row once.
    const mapped: Array<Record<string, unknown>> = scanned.map((line) => {
      const values = parseCSVLine(line)
      const rowData: Record<string, unknown> = {}
      for (const [csvCol, fieldName] of Object.entries(columnMap)) {
        if (!fieldName) continue
        const colIdx = headers.indexOf(csvCol)
        if (colIdx >= 0) rowData[fieldName] = values[colIdx] ?? null
      }
      return rowData
    })

    const same = (a: unknown, b: unknown): boolean => {
      const as = String(a ?? '').trim()
      const bs = String(b ?? '').trim()
      if (as === bs) return true
      const an = Number(as)
      const bn = Number(bs)
      return as !== '' && bs !== '' && Number.isFinite(an) && Number.isFinite(bn) && an === bn
    }

    let newCount = 0
    let unchanged = 0
    let changed = 0
    let conflicts = 0
    const fieldChangeCounts: Record<string, number> = {}
    const diffs: Array<{
      row: number
      id: string
      kind: 'changed' | 'conflict'
      reason?: string
      fields: Array<{ field: string; old: unknown; new: unknown }>
    }> = []

    if (!idField) {
      newCount = mapped.length
    } else {
      // Batch-fetch every existing match in chunks — the per-row lookup the
      // real import does would make previewing a 5k file 5k round trips.
      const idValues = mapped
        .map((r) => r[idField])
        .filter((v) => v != null && String(v).trim() !== '')
        .map((v) => String(v))
      const distinct = [...new Set(idValues)]
      const mappedFields = [...new Set(Object.values(columnMap).filter(Boolean))]
      let existingRows: Array<Record<string, unknown>> = []
      try {
        existingRows = await selectInChunks(distinct, 1000, (chunk) =>
          db(collection)
            .whereIn(idField, chunk)
            .select([...new Set([idField, ...mappedFields])])
        )
      } catch (err) {
        return reply
          .code(400)
          .send({ error: `Could not read ${collection}: ${(err as Error).message.slice(0, 200)}` })
      }
      const existingById = new Map(existingRows.map((r) => [String(r[idField]), r]))

      // Duplicate ids WITHIN the file — ambiguous, always a conflict.
      const seenInFile = new Map<string, number>()
      for (const v of idValues) seenInFile.set(v, (seenInFile.get(v) ?? 0) + 1)

      const dupReported = new Set<string>()
      mapped.forEach((rowData, i) => {
        const idVal = rowData[idField]
        const idStr = idVal == null ? '' : String(idVal).trim()
        if (!idStr) {
          newCount++
          return
        }
        if ((seenInFile.get(idStr) ?? 0) > 1 && !dupReported.has(idStr)) {
          dupReported.add(idStr)
          conflicts++
          if (diffs.length < 50) {
            diffs.push({
              row: i + 2,
              id: idStr,
              kind: 'conflict',
              reason: `id appears ${seenInFile.get(idStr)} times in the file — last row wins`,
              fields: []
            })
          }
          return
        }
        if (dupReported.has(idStr)) return // counted once per duplicated id

        const existing = existingById.get(idStr)
        if (!existing) {
          newCount++
          return
        }
        const fieldDiffs: Array<{ field: string; old: unknown; new: unknown }> = []
        for (const f of mappedFields) {
          if (f === idField) continue
          if (!(f in rowData)) continue
          if (!same(existing[f], rowData[f])) {
            fieldDiffs.push({ field: f, old: existing[f] ?? null, new: rowData[f] ?? null })
            fieldChangeCounts[f] = (fieldChangeCounts[f] ?? 0) + 1
          }
        }
        if (fieldDiffs.length === 0) {
          unchanged++
          return
        }
        if (strategy === 'skip') {
          // The file disagrees with the database and the strategy will DROP
          // the file's version — the one outcome worth a hard look.
          conflicts++
          if (diffs.length < 50) {
            diffs.push({
              row: i + 2,
              id: idStr,
              kind: 'conflict',
              reason: 'record exists and differs — strategy "skip" discards these values',
              fields: fieldDiffs
            })
          }
        } else {
          changed++
          if (diffs.length < 50) {
            diffs.push({ row: i + 2, id: idStr, kind: 'changed', fields: fieldDiffs })
          }
        }
      })
    }

    return reply.send({
      data: {
        total: mapped.length,
        truncated,
        new: newCount,
        unchanged,
        changed,
        conflicts,
        field_change_counts: fieldChangeCounts,
        diffs
      }
    })
  })

  app.post('/', async (req, reply) => {
    const body = req.body as {
      collection?: string
      csv_data?: string
      column_map?: Record<string, string>
      duplicate_strategy?: string
      id_field?: string
      file_name?: string
    }

    const { collection, csv_data, column_map, duplicate_strategy, id_field, file_name } = body

    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    if (!csv_data) return reply.code(400).send({ error: 'csv_data is required' })

    const job = await createImportJob(
      {
        collection,
        csv_data,
        column_map,
        duplicate_strategy,
        id_field,
        file_name,
        created_by: req.user?.id ?? null
      },
      app
    )

    await logActivity({
      action: 'import-create',
      user: req.user?.id,
      collection,
      item: String(job.id),
      req
    })

    return reply.code(201).send({ data: formatJob(job) })
  })

  // POST /from-url — fetch a remote CSV server-side, then continue like POST /.
  // With { preview: true } the CSV is fetched and returned without creating a job
  // (used by the wizard to load remote data into the mapping steps).
  app.post('/from-url', async (req, reply) => {
    const body = req.body as {
      url?: string
      preview?: boolean
      collection?: string
      column_map?: Record<string, string>
      duplicate_strategy?: string
      id_field?: string
      file_name?: string
    }

    const { url } = body
    if (!url) return reply.code(400).send({ error: 'url is required' })

    let fetched: { csv: string; fileName: string }
    try {
      fetched = await fetchRemoteCsv(url)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }

    if (!fetched.csv.trim()) {
      return reply.code(400).send({ error: 'Fetched file is empty' })
    }

    const fileName = body.file_name ?? fetched.fileName

    if (body.preview) {
      return reply.send({ data: { csv_data: fetched.csv, file_name: fileName } })
    }

    if (!body.collection) return reply.code(400).send({ error: 'collection is required' })

    const job = await createImportJob(
      {
        collection: body.collection,
        csv_data: fetched.csv,
        column_map: body.column_map,
        duplicate_strategy: body.duplicate_strategy,
        id_field: body.id_field,
        file_name: fileName,
        created_by: req.user?.id ?? null
      },
      app
    )

    await logActivity({
      action: 'import-create',
      user: req.user?.id,
      collection: body.collection,
      item: String(job.id),
      req
    })

    return reply.code(201).send({ data: formatJob(job) })
  })

  // DELETE /:id — delete completed or failed job
  /** Roll back a COMPLETED import: created rows deleted through the items
   *  service (revisions + trash apply, so even the rollback is recoverable),
   *  overwritten rows restored to their captured prior values via the same
   *  raw path the import wrote with. One-shot per job. */
  app.post('/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await db('nivaro_import_jobs').where({ id }).first()
    if (!job) return reply.code(404).send({ error: 'Import not found' })
    if (job.status !== 'complete') return reply.code(400).send({ error: 'Only completed imports can roll back' })
    if (job.rolled_back_at) return reply.code(400).send({ error: 'Already rolled back' })
    const rb = parseJson<{
      created?: Array<{ id: unknown }>
      updated?: Array<{ key_field: string; key: unknown; prior: Record<string, unknown> }>
    }>(job.rollback_data)
    if (!rb) {
      return reply.code(400).send({ error: 'This import predates rollback capture — nothing recorded to undo' })
    }
    const collection = String(job.collection)
    const { startJobRun } = await import('../services/job-runs.js')
    const run = await startJobRun('backfill', `import-rollback:${id}`, {
      label: 'Import rollback',
      triggeredBy: req.user?.id ?? null
    })
    // Mark first so a concurrent second click can't double-run.
    await db('nivaro_import_jobs')
      .where({ id })
      .update({ rolled_back_at: new Date(), rolled_back_by: req.user?.id ?? null })

    const user = req.user!
    void (async () => {
      let deleted = 0
      let restored = 0
      let skippedRows = 0
      const failures: string[] = []
      const createdList = rb.created ?? []
      const updatedList = rb.updated ?? []
      const total = createdList.length + updatedList.length
      let done = 0
      for (const c of createdList) {
        if (c.id == null) {
          skippedRows++
        } else {
          try {
            const { deleteOne } = await import('../services/items.js')
            await deleteOne(user, collection, String(c.id))
            deleted++
          } catch (err) {
            failures.push(`delete ${c.id}: ${err instanceof Error ? err.message : String(err)}`)
          }
        }
        done++
        if (done % 25 === 0) run.progress({ done, total })
      }
      for (const u of updatedList) {
        try {
          await db(collection)
            .where({ [u.key_field]: u.key })
            .update(u.prior)
          restored++
        } catch (err) {
          failures.push(`restore ${u.key}: ${err instanceof Error ? err.message : String(err)}`)
        }
        done++
        if (done % 25 === 0) run.progress({ done, total })
      }
      const summary = `${deleted} deleted (to trash), ${restored} restored${skippedRows ? `, ${skippedRows} unknown-id skipped` : ''}${failures.length ? `, ${failures.length} FAILED — ${failures.slice(0, 3).join('; ').slice(0, 300)}` : ''}`
      if (failures.length > 0 && deleted + restored === 0) await run.fail(summary)
      else await run.complete(summary)
      await logActivity({
        action: 'import-rollback',
        user: user.id,
        collection,
        item: String(id),
        comment: summary.slice(0, 300)
      })
    })()
    return reply.code(202).send({
      data: {
        job_run_id: run.id,
        total: (rb.created?.length ?? 0) + (rb.updated?.length ?? 0)
      }
    })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await db('nivaro_import_jobs').where({ id }).first()

    if (!job) return reply.code(404).send({ error: 'Not found' })

    if (!req.isAdmin && job.created_by !== req.user?.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }

    if (job.status !== 'complete' && job.status !== 'failed') {
      return reply.code(400).send({ error: 'Cannot delete a job that is still running' })
    }

    await db('nivaro_import_jobs').where({ id }).delete()
    await logActivity({
      action: 'delete',
      user: req.user?.id,
      collection: 'nivaro_import_jobs',
      item: id,
      comment: `${job.collection} (${job.status})`,
      req
    })
    return reply.code(204).send()
  })
}
