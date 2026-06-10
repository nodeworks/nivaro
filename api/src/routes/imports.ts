import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { assertSafeUrl } from '../lib/ssrf.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'

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
              await db(collection)
                .where({ [idField]: rowData[idField] })
                .update(rowData)
              updated++
            } else {
              skipped++
            }
          } else {
            await db(collection).insert(rowData)
            created++
          }
        } else {
          await db(collection).insert(rowData)
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

async function createImportJob(input: CreateJobInput, app: FastifyInstance) {
  const id = randomUUID()

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
    return reply.code(204).send()
  })
}
