import { createHash, randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { runInBackgroundPool } from '../db/pool-context.js'
import { sqlDialect } from '../db/sql-dialect.js'
import { fitSqliteWriteValues } from '../db/sqlite-values.js'
import { assertSafeUrl, safeFetch } from '../lib/ssrf.js'
import { requireAdmin } from '../middleware/authenticate.js'
import { fieldLabel } from '../services/access-words.js'
import { logActivity } from '../services/activity.js'
import { activityGroupKey, withActivityScope } from '../services/activity-scope.js'
import { getFields } from '../services/collections.js'
import { selectInChunks, whereInList } from '../services/db-batch.js'
import { importRowErrorText } from '../services/db-refusal-labels.js'
import { importDuplicateScan } from '../services/duplicate-check.js'
import { contentDisposition } from '../services/help-video-download.js'
import {
  coerceImportRow,
  coercesImportType,
  type ImportFieldType,
  ImportValueError
} from '../services/import-coerce.js'
import {
  asImportRedis,
  enqueueImportJob,
  forgetImportJob,
  importJobLeaseKey,
  importLeaseMs,
  LEASE_RENEW_MS
} from '../services/import-handoff.js'
import {
  currentLinks,
  type ImportLinkField,
  ImportLinkResolver,
  importLinkFields,
  sameLinks,
  writeLinksRaw
} from '../services/import-links.js'
import {
  ambiguousMatchText,
  describeMatch,
  matchKindOf,
  matchSetupProblem,
  parseMatchFields,
  storeMatchFields
} from '../services/import-match.js'
import { ImportMatchIndex, MATCH_PREFETCH_CHUNK } from '../services/import-match-index.js'
import { columnShapes, createOne, updateOne } from '../services/items.js'
import { announceRawWrites, BULK_CAP } from '../services/raw-write-announcer.js'
import { tenantScopedRoom } from '../services/tenant-rooms.js'
import type { User } from '../types.js'

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
  // Batch view (#128): the ids the run created, mined from the rollback
  // capture (capped — the client builds an id-in filter from them). csv_data
  // and the raw rollback blob stay server-side.
  const rb = parseJson<{ created?: Array<{ id: unknown }> }>(job.rollback_data as string)
  const createdIds = (rb?.created ?? [])
    .map((c) => c.id)
    .filter((v) => v != null)
    .slice(0, 500)
  const { csv_data: _csv, rollback_data: _rb, ...rest } = job
  return {
    ...rest,
    column_map: parseJson(job.column_map),
    match_fields: parseMatchFields(job.id_field),
    errors: parseJson(job.errors),
    through_items: !!job.through_items,
    created_ids: createdIds
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

    const res = await safeFetch(currentUrl, {
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

/** SQLite stores any value in any column: a raw row is converted or refused as SQL Server's
 *  own conversion would (db/sqlite-values.ts) — 'not a date' in a date column fails the row with
 *  "A value does not match its field's type" there too. Other databases convert by themselves. */
async function fitRawWriteForSqlite(
  collection: string,
  rowData: Record<string, unknown>
): Promise<void> {
  if (sqlDialect(db) !== 'sqlite') return
  fitSqliteWriteValues(rowData, await columnShapes(collection))
}

/** Insert and get the new id back. OUTPUT fails on tables with triggers —
 *  fall back to a plain insert with an unknown id (rollback skips it and
 *  says so, rather than guessing which row was ours). */
async function insertReturningId(
  collection: string,
  rowData: Record<string, unknown>
): Promise<unknown> {
  await fitRawWriteForSqlite(collection, rowData)
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

// Column cleanup presets (#212): per-column normalization applied as values
// leave the sheet — trim, casing, and empty-string -> null.
function applyColumnTransform(v: unknown, t: string | undefined): unknown {
  if (v == null || typeof v !== 'string' || !t) return v
  switch (t) {
    case 'trim':
      return v.trim()
    case 'upper':
      return v.trim().toUpperCase()
    case 'lower':
      return v.trim().toLowerCase()
    case 'title':
      return v
        .trim()
        .toLowerCase()
        .replace(/\b\w/g, (c) => c.toUpperCase())
    case 'null_empty':
      return v.trim() === '' ? null : v
    default:
      return v
  }
}

/** Does a stored value already equal what the file carries? Empty and null
 *  agree; numbers compare as numbers, dates by instant or calendar day. */
function sameCell(was: unknown, next: unknown): boolean {
  const empty = (x: unknown) => x == null || (typeof x === 'string' && x.trim() === '')
  if (empty(was) && empty(next)) return true
  if (empty(was) || empty(next)) return false
  const text = String(next).trim()
  if (was instanceof Date) {
    const d = new Date(text)
    return (
      (!Number.isNaN(d.getTime()) && d.getTime() === was.getTime()) ||
      text.slice(0, 10) === was.toISOString().slice(0, 10)
    )
  }
  if (typeof was === 'boolean') {
    const t = text.toLowerCase()
    return was ? t === 'true' || t === '1' : t === 'false' || t === '0'
  }
  if (typeof was === 'number') return Number(text) === was
  return String(was).trim() === text
}

/**
 * A collection-import job's progress (`import:progress:<id>`): to the job creator's own room and
 * the tenant's admin watch room (`watch:imports`, administrators only) — never to every socket
 * (H14: a plain io.emit reached every tenant's sockets, unauthenticated ones included).
 */
export function emitJobProgress(
  app: FastifyInstance,
  creatorId: unknown,
  jobId: string,
  data: object
): void {
  try {
    const io = (app as unknown as { io?: import('socket.io').Server }).io
    if (!io) return
    let target = io.to(tenantScopedRoom('watch:imports'))
    if (creatorId != null && creatorId !== '') target = target.to(`user:${String(creatorId)}`)
    target.emit(`import:progress:${jobId}`, data)
  } catch {
    /* progress is decoration */
  }
}

/** Ids kept per action; one past BULK_CAP means "more than 100" → a collection-wide notice. */
export const IMPORT_IDS_KEPT = BULK_CAP + 1

/** Remember an id for the end-of-job notice without holding every id of a big import. */
export function keepImportId(list: unknown[], id: unknown): void {
  if (list.length < IMPORT_IDS_KEPT) list.push(id)
}

/** What a default-mode (raw) import wrote — announced once at the end (S1/S2 realtime gaps). */
export interface RawImportTouched {
  collection: string | null
  created: unknown[]
  /** An insert whose id could not be read back (triggered table): the whole collection changed. */
  unknownCreate: boolean
  updated: unknown[]
  fields: Set<string>
}

/**
 * S2 (realtime gaps 2026-11-17): a default-mode CSV import writes rows raw, so open lists,
 * queues, widgets and rollups never heard about them. One announcement per action at the end
 * of the job (and of a failed job — the rows it wrote before failing are real); more than 100
 * ids (at most 101 are kept) fold into one "records in this collection changed" event. Through-items imports announce
 * per row from the items service and touch nothing here. Exported for tests.
 */
export function announceImportWrites(t: RawImportTouched, source: string): void {
  if (!t.collection) return
  const ids = (list: unknown[]) =>
    list.filter((v) => v != null && String(v) !== '') as Array<string | number>
  const created = ids(t.created)
  if (created.length || t.unknownCreate)
    void announceRawWrites(
      t.collection,
      t.unknownCreate || created.length > BULK_CAP ? null : created,
      {
        action: 'create',
        source,
        noticeOnly: true
      }
    )
  const updated = ids(t.updated)
  if (updated.length)
    void announceRawWrites(t.collection, updated.length > BULK_CAP ? null : updated, {
      action: 'update',
      changed_fields: [...t.fields],
      source,
      noticeOnly: true
    })
}

/**
 * Early stop (EFP prod 2026-11-19: 86,575 rows, every one refused, nothing could stop it): when
 * this many rows have run and not one was created, updated or skipped, the file is wrong — the
 * job stops `failed` with IMPORT_EARLY_FAIL_NOTE first in its errors.
 */
export const IMPORT_EARLY_FAIL_ROWS = 200
export const IMPORT_EARLY_FAIL_NOTE = `Stopped after the first ${IMPORT_EARLY_FAIL_ROWS} rows all failed. Fix the file and import it again.`
/** Row errors kept on a job (error_rows still counts every one). */
export const IMPORT_ERRORS_KEPT = 1000
/** Progress (and the stop check that rides it) is written every this many rows… */
const PROGRESS_EVERY_ROWS = 10
/** …or after this long, whichever comes first; so is the error list while it grows. */
const PROGRESS_EVERY_MS = 2000

/** Rows read and matched together (one candidate read per chunk, services/import-match-index.ts). */
export const IMPORT_ROW_CHUNK = 500
/** What the run wrote (rollback_data) rides the progress write at most this often. */
const ROLLBACK_EVERY_MS = 5000

/** Statuses a job can still be stopped in. */
export const STOPPABLE_JOB_STATUSES = ['pending', 'processing'] as const

/**
 * Take a pending job for this process: one guarded `pending → processing` update, so two
 * drainers never run one job and a job cancelled while it waited never starts.
 */
export async function claimImportJob(jobId: string): Promise<boolean> {
  const n = await db('nivaro_import_jobs')
    .where({ id: jobId, status: 'pending' })
    .update({ status: 'processing', started_at: new Date() })
  return Number(n) === 1
}

/** The mapped number / yes-no fields of a collection, for value coercion (import-coerce.ts). */
export async function importFieldTypes(
  collection: string,
  fields: string[],
  skip: ReadonlySet<string> = new Set()
): Promise<Map<string, ImportFieldType>> {
  const out = new Map<string, ImportFieldType>()
  const wanted = new Set(fields)
  const all = await getFields(collection).catch(() => [])
  for (const f of all) {
    if (!wanted.has(f.field) || skip.has(f.field) || !coercesImportType(f.type)) continue
    const own = (f as { label?: unknown }).label
    out.set(f.field, {
      type: f.type,
      label: typeof own === 'string' && own.trim() ? own.trim() : fieldLabel(f.field)
    })
  }
  return out
}

/** field → the label a person knows it by, for row errors. */
export async function importFieldLabels(collection: string): Promise<(field: string) => string> {
  const labels = new Map<string, string>()
  for (const f of await getFields(collection).catch(() => [])) {
    const own = (f as { label?: unknown }).label
    if (typeof own === 'string' && own.trim()) labels.set(f.field, own.trim())
  }
  return (field) => fieldLabel(field, labels)
}

/** A link to several records has no column to match on: refuse it before any row runs. */
export function assertMatchFieldsUsable(
  fields: string[],
  linkFields: ReadonlyMap<string, ImportLinkField>
): void {
  for (const f of fields)
    if (linkFields.get(f)?.kind === 'm2m')
      throw new Error(
        `${fieldLabel(f)} links several records, so it cannot be a match field — pick fields that hold one value`
      )
}

/**
 * The index the run, the preview and row repair match existing records through
 * (services/import-match-index.ts); null without match fields. Each field's kind decides how its
 * values compare (import-match.ts MatchKind): links and the id as ids, number fields as numbers.
 */
export async function openMatchIndex(
  collection: string,
  matchFields: string[],
  linkFields: ReadonlyMap<string, ImportLinkField>
): Promise<ImportMatchIndex | null> {
  if (matchFields.length === 0) return null
  const types = new Map(
    (await getFields(collection).catch(() => [])).map((f) => [f.field, f.type] as const)
  )
  return ImportMatchIndex.open(
    collection,
    matchFields,
    matchFields.map((f) => matchKindOf(f, types.get(f), linkFields.get(f)?.kind === 'm2o'))
  )
}

/** Minimal Redis surface for a running job's lease (services/import-handoff.ts). */
interface LeaseRedis {
  set(key: string, value: string, ex: 'EX', seconds: number): Promise<unknown>
  del?(key: string): Promise<unknown>
}

function leaseRedis(app: FastifyInstance): LeaseRedis | null {
  if (process.env.CLOUD_META_DB_URL) return null
  const r = (app as unknown as { redis?: Partial<LeaseRedis> }).redis
  return r && typeof r.set === 'function' ? (r as LeaseRedis) : null
}

/**
 * Run a job this process claimed, with its lease kept alive while it runs: a Redis key renewed
 * every LEASE_RENEW_MS that a drainer reads to tell a live run from one whose process died
 * (services/collection-import-worker.ts). The job's activity rows are one burst, written by
 * this import (migration 516), on the background pool (#1321).
 */
export async function runClaimedImportJob(jobId: string, app: FastifyInstance): Promise<void> {
  const head = (await db('nivaro_import_jobs')
    .where({ id: jobId })
    .first('file_name', 'created_by')) as
    | { file_name?: string | null; created_by?: string | null }
    | undefined
  const r = leaseRedis(app)
  const key = importJobLeaseKey(jobId)
  const ttl = Math.ceil(importLeaseMs() / 1000)
  const renew = () => void r?.set(key, String(Date.now()), 'EX', ttl).catch(() => null)
  renew()
  const lease = r ? setInterval(renew, LEASE_RENEW_MS) : null
  lease?.unref?.()
  try {
    await withActivityScope(
      {
        group_key: activityGroupKey('import_job', jobId),
        actor: {
          kind: 'import',
          id: jobId,
          name: head?.file_name ?? 'CSV import',
          on_behalf_of: head?.created_by ? String(head.created_by) : null
        }
      },
      () => runInBackgroundPool(() => runImportJob(jobId, app))
    )
  } finally {
    if (lease) clearInterval(lease)
    await r?.del?.(key).catch(() => 0)
    await forgetImportJob(asImportRedis((app as unknown as { redis?: unknown }).redis), jobId)
  }
}

/** Claim and run in one go (cloud mode, where a job runs on the tenant process that took it). */
export async function processImportJob(jobId: string, app: FastifyInstance): Promise<void> {
  if (!(await claimImportJob(jobId))) return
  await runClaimedImportJob(jobId, app)
}

/** The row loop of a claimed job. Exported for tests; production goes through runClaimedImportJob. */
export async function runImportJob(jobId: string, app: FastifyInstance): Promise<void> {
  const touched: RawImportTouched = {
    collection: null,
    created: [],
    unknownCreate: false,
    updated: [],
    fields: new Set()
  }
  let created = 0
  let updated = 0
  let skipped = 0
  let errorRows = 0
  let processed = 0
  const errors: { row: number; error: string }[] = []
  // Rollback capture: created row ids, and for overwrites the PRIOR values
  // of exactly the fields the import touched — enough to undo, no more.
  const rbCreated: Array<{ id: unknown }> = []
  const rbUpdated: Array<{ key_field: string; key: unknown; prior: Record<string, unknown> }> = []
  const counters = () => ({
    processed_rows: processed,
    created_rows: created,
    updated_rows: updated,
    skipped_rows: skipped,
    error_rows: errorRows
  })
  const rollbackJson = () => JSON.stringify({ created: rbCreated, updated: rbUpdated })
  try {
    const job = await db('nivaro_import_jobs').where({ id: jobId }).first()
    if (job?.status !== 'processing') return

    const csvData = job.csv_data as string
    // Normalise line endings
    const lines = csvData
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n')
      .split('\n')
      .filter((l: string) => l.trim())

    if (lines.length < 1) {
      await db('nivaro_import_jobs')
        .where({ id: jobId, status: 'processing' })
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
    const transforms = parseJson<Record<string, string>>(job.transforms) ?? {}
    const collection = job.collection as string
    if (/^nivaro_/i.test(collection)) {
      throw new Error(`Cannot import into system table: ${collection}`)
    }

    // Existing records are matched on every match field together (services/import-match.ts).
    // Re-checked here (a job stored before the check, or by an old process): a match field no
    // column fills reads blank on every row.
    const matchFields = parseMatchFields(job.id_field)
    const setup = matchSetupProblem({
      matchFields,
      columnMap,
      strategy: 'skip' // the no-match confirm was the upload's to ask; only the mapping is re-checked
    })
    if (setup) throw new Error(setup.error)

    // The loop has begun: from here rows may be written. Lease recovery re-runs a lost job only
    // when this mark is absent (services/collection-import-worker.ts) — never a half-done file.
    await db('nivaro_import_jobs').where({ id: jobId }).update({ total_rows: dataLines.length })

    const emitProgress = (data: object) => emitJobProgress(app, job.created_by, jobId, data)

    // #748 — opt-in per job: rows go through the items service (field rules,
    // validation, hooks, revisions, activity attributed to whoever queued the
    // job) instead of raw inserts. Unchanged fields are not re-written.
    const throughItems = !!job.through_items
    const actor = throughItems
      ? ((await db('nivaro_users').where('id', job.created_by).first()) as User | undefined)
      : undefined
    if (throughItems && !actor)
      throw new Error('This job writes as whoever queued it, and that user no longer exists')
    const stamp = `import:CSV ${String(job.file_name ?? 'file').replace(/:/g, ' ')}:job-${jobId}`

    // Relation columns: a cell names the related record(s) by id or label; an M2M cell
    // may list several, comma-separated (services/import-links.ts).
    const mappedFields = Object.values(columnMap).filter(Boolean)
    const linkFields = await importLinkFields(collection, mappedFields)
    const linkResolver = new ImportLinkResolver()
    const headerOf = new Map(Object.entries(columnMap).map(([csv, f]) => [f, csv]))
    // Number and yes/no cells become their field's type before the write (import-coerce.ts).
    const fieldTypes = await importFieldTypes(collection, mappedFields, new Set(linkFields.keys()))
    assertMatchFieldsUsable(matchFields, linkFields)
    const index = await openMatchIndex(collection, matchFields, linkFields)
    const labelOf = await importFieldLabels(collection)
    const strategy = job.duplicate_strategy as string

    const insertRow = async (
      rowData: Record<string, unknown>,
      links: Map<ImportLinkField, string[]>
    ) => {
      if (!actor) {
        const id = await insertReturningId(collection, rowData)
        touched.collection = collection
        if (id == null) touched.unknownCreate = true
        else keepImportId(touched.created, id)
        if (links.size > 0 && id == null)
          throw new Error('The record was created but its id could not be read to link it')
        for (const [lf, ids] of links) await writeLinksRaw(lf, id, ids, false)
        return id
      }
      const payload: Record<string, unknown> = { ...rowData, _change_reason: stamp }
      for (const [lf, ids] of links) payload[lf.field] = ids
      const made = (await createOne(actor, collection, payload)) as {
        id?: unknown
      } | null
      return made?.id ?? null
    }

    /** One file row, read and resolved; `error` = it fails before any write. */
    interface Prepared {
      i: number
      rowData: Record<string, unknown>
      fileCells: Record<string, unknown>
      links: Map<ImportLinkField, string[]>
      match: unknown[]
      error?: unknown
    }
    const prepare = async (i: number): Promise<Prepared> => {
      // Outside the try: a refused row's error names the file's own values.
      const p: Prepared = { i, rowData: {}, fileCells: {}, links: new Map(), match: [] }
      try {
        const values = parseCSVLine(dataLines[i])
        for (const [csvCol, fieldName] of Object.entries(columnMap)) {
          if (!fieldName) continue
          const colIdx = headers.indexOf(csvCol)
          if (colIdx >= 0) {
            p.rowData[fieldName] = applyColumnTransform(values[colIdx] ?? null, transforms[csvCol])
          }
        }
        coerceImportRow(p.rowData, fieldTypes)
        // The file's own cells for the match fields, before names become ids (row errors).
        for (const f of matchFields) p.fileCells[f] = p.rowData[f]
        // Relation cells → ids; M2M sets leave rowData (no column of their own).
        for (const [field, lf] of linkFields) {
          if (!(field in p.rowData)) continue
          const resolved = await linkResolver.resolve(lf, p.rowData[field], headerOf.get(field))
          if (lf.kind === 'm2o') p.rowData[field] = resolved
          else {
            p.links.set(lf, resolved as string[])
            delete p.rowData[field]
          }
        }
        p.match = matchFields.map((f) => p.rowData[f])
      } catch (err) {
        p.error = err
      }
      return p
    }

    const writeRow = async (p: Prepared) => {
      if (p.error) throw p.error
      const { rowData, links } = p
      if (!index?.usable(p.match)) {
        const id = await insertRow(rowData, links)
        rbCreated.push({ id })
        created++
        index?.note(id, p.match)
        return
      }
      const found = await index.lookup(p.match)
      if (found.length > 1)
        throw new Error(ambiguousMatchText(describeMatch(matchFields, p.fileCells, labelOf)))
      const existing = found[0]
        ? ((await db(collection).where({ id: found[0] }).first()) as Record<string, unknown>)
        : undefined
      if (!existing) {
        const id = await insertRow(rowData, links)
        rbCreated.push({ id })
        created++
        index.note(id, p.match)
        return
      }
      if (strategy !== 'overwrite' && strategy !== 'merge') {
        skipped++
        return
      }
      const prior: Record<string, unknown> = {}
      for (const k of Object.keys(rowData)) prior[k] = existing[k]
      // Links: overwrite = exactly the file's list; merge = the file's added to the
      // record's own. The prior set is kept for rollback.
      const existingId = existing.id
      const linkSets = new Map<ImportLinkField, string[]>()
      for (const [lf, ids] of links) {
        const now = await currentLinks(lf, existingId)
        const want = strategy === 'overwrite' ? ids : [...new Set([...now, ...ids])]
        if (sameLinks(now, want)) continue
        linkSets.set(lf, want)
        prior[lf.field] = { set: now }
      }
      if (actor) {
        // Only fields that actually differ; an unchanged row writes nothing.
        const patch: Record<string, unknown> = {}
        for (const [k, v] of Object.entries(rowData)) {
          if (!sameCell(existing[k], v)) patch[k] = v
        }
        for (const [lf, want] of linkSets) patch[lf.field] = { set: want }
        if (Object.keys(patch).length === 0) {
          skipped++
          return
        }
        await updateOne(actor, collection, String(existingId), {
          ...patch,
          _change_reason: stamp
        })
      } else {
        await fitRawWriteForSqlite(collection, rowData)
        await db(collection).where({ id: existingId }).update(rowData)
        touched.collection = collection
        keepImportId(touched.updated, existingId)
        for (const k of Object.keys(rowData)) touched.fields.add(k)
        for (const lf of linkSets.keys()) touched.fields.add(lf.field)
        for (const [lf, want] of linkSets) await writeLinksRaw(lf, existingId, want, true)
      }
      // Rollback finds the record again by its id, whatever it was matched on.
      rbUpdated.push({ key_field: 'id', key: existingId, prior })
      updated++
    }

    // Why the loop ended early, if it did: the job is no longer `processing` here (cancelled,
    // failed by a drainer that judged its process gone, or deleted) — or the first rows all failed.
    let stopped: 'lost' | 'early-fail' | null = null
    let lastWrite = Date.now()
    let errorsWritten = 0
    let lastErrorsWrite = 0
    let rollbackWritten = 0
    let lastRollbackWrite = 0

    for (let start = 0; start < dataLines.length && !stopped; start += IMPORT_ROW_CHUNK) {
      // Read and resolve a chunk, then read every record it may match in a few statements
      // (services/import-match-index.ts) instead of one lookup per row.
      const chunk: Prepared[] = []
      for (let i = start; i < Math.min(start + IMPORT_ROW_CHUNK, dataLines.length); i++)
        chunk.push(await prepare(i))
      await index?.prefetch(chunk.filter((p) => !p.error).map((p) => p.match))

      for (const p of chunk) {
        const i = p.i
        try {
          await writeRow(p)
        } catch (err) {
          errorRows++
          // A plain sentence per row, in the collection's field labels and with the
          // file's own value — never the statement or a constraint name.
          const text = await importRowErrorText(err, collection, p.rowData).catch(() =>
            String((err as Error)?.message ?? err)
          )
          if (errors.length < IMPORT_ERRORS_KEPT)
            errors.push({ row: i + 2, error: text.slice(0, 300) })
        }
        processed = i + 1

        if (processed === IMPORT_EARLY_FAIL_ROWS && created + updated + skipped === 0) {
          stopped = 'early-fail'
          break
        }

        // Progress every 10 rows, on the last row, or after PROGRESS_EVERY_MS. The write is
        // guarded on `processing`: when it touches nothing the job was cancelled (from any
        // replica), failed by a drainer, or deleted, and the loop stops. The errors so far ride
        // along (every 2 s) and what the run wrote (every 5 s), so a killed job keeps both and
        // can still be rolled back.
        const last = i === dataLines.length - 1
        const now = Date.now()
        if (i % PROGRESS_EVERY_ROWS === 0 || last || now - lastWrite >= PROGRESS_EVERY_MS) {
          const patch: Record<string, unknown> = counters()
          if (
            errors.length !== errorsWritten &&
            (last || now - lastErrorsWrite >= PROGRESS_EVERY_MS)
          ) {
            patch.errors = JSON.stringify(errors)
            errorsWritten = errors.length
            lastErrorsWrite = now
          }
          const wrote = rbCreated.length + rbUpdated.length
          if (wrote !== rollbackWritten && (last || now - lastRollbackWrite >= ROLLBACK_EVERY_MS)) {
            patch.rollback_data = rollbackJson()
            rollbackWritten = wrote
            lastRollbackWrite = now
          }
          const n = await db('nivaro_import_jobs')
            .where({ id: jobId, status: 'processing' })
            .update(patch)
          lastWrite = Date.now()
          if (Number(n) !== 1) {
            stopped = 'lost'
            break
          }
          emitProgress({
            jobId,
            processed,
            total: dataLines.length,
            created,
            updated,
            skipped,
            errors: errorRows
          })
        }
      }
    }

    // What the run wrote, whatever ended it: a cancelled or failed run can be rolled back too.
    const outcome = {
      rollback_data: rollbackJson(),
      ...counters()
    }
    const summary = `created ${created}, updated ${updated}, skipped ${skipped}, errors ${errorRows}`
    let finalStatus: 'complete' | 'failed' | null = null
    if (stopped === 'early-fail') {
      const n = await db('nivaro_import_jobs')
        .where({ id: jobId, status: 'processing' })
        .update({
          ...outcome,
          status: 'failed',
          completed_at: new Date(),
          errors: JSON.stringify([{ row: 0, error: IMPORT_EARLY_FAIL_NOTE }, ...errors])
        })
      if (Number(n) === 1) finalStatus = 'failed'
      else stopped = 'lost'
    } else if (!stopped) {
      const n = await db('nivaro_import_jobs')
        .where({ id: jobId, status: 'processing' })
        .update({
          ...outcome,
          status: 'complete',
          completed_at: new Date(),
          errors: JSON.stringify(errors)
        })
      if (Number(n) === 1) finalStatus = 'complete'
      else stopped = 'lost'
    }
    if (stopped === 'lost') {
      // The job left `processing` under this run. Each later write matches the status it read,
      // so it never overwrites what another process decided.
      const now = (await db('nivaro_import_jobs').where({ id: jobId }).first('status')) as
        | { status?: string }
        | undefined
      if (now?.status === 'cancelled') {
        // A person pressed Stop: keep their status, record what this run did.
        await db('nivaro_import_jobs')
          .where({ id: jobId, status: 'cancelled' })
          .update({ ...outcome, errors: JSON.stringify(errors) })
        emitProgress({ jobId, cancelled: true, created, updated, skipped, errors: errorRows })
        await logActivity({
          action: 'import-stopped',
          user: (job.created_by as string | null) ?? null,
          collection,
          item: String(jobId),
          comment: `stopped after ${processed} rows: ${summary}`
        })
      } else if (now?.status === 'failed') {
        // A drainer judged this run's process gone and failed the job with its own note: add
        // what the run wrote (so it can be rolled back), never replace that note.
        await db('nivaro_import_jobs').where({ id: jobId, status: 'failed' }).update(outcome)
        app.log.warn(
          { jobId, processed },
          'collection import: the job was failed by another process while this run was writing'
        )
      }
    } else if (finalStatus === 'failed') {
      emitProgress({ jobId, failed: true, error: true })
      await logActivity({
        action: 'import-failed',
        user: (job.created_by as string | null) ?? null,
        collection,
        item: String(jobId),
        comment: IMPORT_EARLY_FAIL_NOTE
      })
    } else if (finalStatus === 'complete') {
      emitProgress({ jobId, done: true, created, updated, skipped, errors: errorRows })
      await logActivity({
        action: 'import-complete',
        user: (job.created_by as string | null) ?? null,
        collection,
        item: String(jobId),
        comment: summary
      })
    }
    // rt6 #19 — a catalog / price / stock import tells the owners of open records it touched.
    if (created + updated > 0) {
      const { noteCatalogChange } = await import('../services/catalog-impact.js')
      noteCatalogChange(collection, null)
    }
  } catch (err) {
    await db('nivaro_import_jobs')
      .where({ id: jobId, status: 'processing' })
      .update({
        status: 'failed',
        completed_at: new Date(),
        rollback_data: rollbackJson(),
        ...counters(),
        errors: JSON.stringify([{ row: 0, error: (err as Error).message }, ...errors])
      })
    const failedJob = await db('nivaro_import_jobs').where({ id: jobId }).first()
    // The failure text stays behind the authenticated job routes (it can quote SQL).
    emitJobProgress(app, failedJob?.created_by, jobId, { jobId, failed: true, error: true })

    await logActivity({
      action: 'import-failed',
      user: (failedJob?.created_by as string | null) ?? null,
      collection: (failedJob?.collection as string) ?? undefined,
      item: String(jobId),
      comment: (err as Error).message.slice(0, 200)
    })
  } finally {
    announceImportWrites(touched, `import:job-${jobId}`)
  }
}

// ─── Job creation (shared by POST / and POST /from-url) ──────────────────────

interface CreateJobInput {
  collection: string
  csv_data: string
  column_map?: Record<string, string>
  transforms?: Record<string, string>
  duplicate_strategy?: string
  /** One or more match fields: a name, a comma list or an array (services/import-match.ts). */
  id_field?: unknown
  file_name?: string
  created_by: string | null
  /** #748 — write through the items service (rules, validation, history). */
  through_items?: boolean
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
      id_field: storeMatchFields(input.id_field),
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
    transforms: input.transforms ? JSON.stringify(input.transforms) : null,
    column_map: input.column_map ? JSON.stringify(input.column_map) : null,
    duplicate_strategy: input.duplicate_strategy ?? 'skip',
    id_field: storeMatchFields(input.id_field),
    ...(input.through_items ? { through_items: true } : {}),
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
  handOffImportJob(app, id)
  return job
}

/**
 * Who runs a stored `pending` job. Self-hosted: never the web process that took the upload — the
 * job goes on the import hand-off and the importer (or whoever drains per importDrainMode, the
 * same rules as staged imports) claims and runs it (services/collection-import-worker.ts). The
 * list entry + kick are best effort: drainers also read pending rows from the database.
 * Cloud mode has no drainers: the tenant process that took the job runs it, as before.
 */
function handOffImportJob(app: FastifyInstance, id: string): void {
  if (process.env.CLOUD_META_DB_URL) {
    // Fire-and-forget, on the background connection pool (#1321).
    void processImportJob(id, app).catch((err) =>
      app.log.error({ err, jobId: id }, 'collection import failed to run')
    )
    return
  }
  void enqueueImportJob(asImportRedis((app as unknown as { redis?: unknown }).redis), id).catch(
    () => false
  )
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
   * Mirrors processImportJob's matching logic exactly (same match fields, all equal,
   * same strategy semantics) without writing a row, so the numbers on the
   * confirm step are the numbers the import will produce. Classifications:
   *
   *   new        — no match field, every match value empty, or no existing match
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
        match_fields: parseMatchFields(row.id_field),
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
      match_fields?: string[] | string | null
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
    const matchFields = parseMatchFields(body.match_fields ?? body.id_field)
    const strategy = body.duplicate_strategy ?? 'skip'
    const setup = matchSetupProblem({ matchFields, columnMap, strategy: 'skip' })
    if (setup) return reply.code(400).send(setup)

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
    // The file's own cells for the match fields, before names become ids (shown in diffs).
    const fileCells = mapped.map((r) => Object.fromEntries(matchFields.map((f) => [f, r[f]])))

    // Relation cells resolve exactly as the run will: names → ids, an M2M list → a set
    // compared with the record's links. A name that matches nothing is reported here.
    const linkFields = await importLinkFields(
      collection,
      Object.values(columnMap).filter(Boolean)
    ).catch(() => new Map<string, ImportLinkField>())
    const headerOf = new Map(Object.entries(columnMap).map(([csv, f]) => [f, csv]))
    const linkResolver = new ImportLinkResolver()
    const linkProblems: Array<{ row: number; error: string }> = []
    let linkErrorRows = 0
    const linkErrorRowSet = new Set<number>()
    const rowLinks: Array<Map<string, string[]>> = []
    for (let i = 0; i < mapped.length; i++) {
      const rowData = mapped[i]
      const links = new Map<string, string[]>()
      rowLinks.push(links)
      let bad = false
      for (const [field, lf] of linkFields) {
        if (!(field in rowData)) continue
        try {
          const resolved = await linkResolver.resolve(lf, rowData[field], headerOf.get(field))
          if (lf.kind === 'm2o') rowData[field] = resolved
          else links.set(field, resolved as string[])
        } catch (err) {
          bad = true
          if (linkProblems.length < 50)
            linkProblems.push({ row: i + 2, error: (err as Error).message.slice(0, 300) })
        }
        if (lf.kind === 'm2m') delete rowData[field]
      }
      if (bad) {
        linkErrorRows++
        linkErrorRowSet.add(i)
      }
    }
    try {
      assertMatchFieldsUsable(matchFields, linkFields)
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message })
    }
    const m2mFields = [...linkFields.values()].filter((lf) => lf.kind === 'm2m')

    // Number and yes/no cells read exactly as the run will read them (import-coerce.ts): a
    // cell the run would refuse is reported here, and its row counts as an error, not a write.
    const fieldTypes = await importFieldTypes(
      collection,
      Object.values(columnMap).filter(Boolean),
      new Set(linkFields.keys())
    )
    const valueProblems: Array<{ row: number; error: string }> = []
    const valueErrorRows = new Set<number>()
    if (fieldTypes.size > 0) {
      for (let i = 0; i < mapped.length; i++) {
        try {
          coerceImportRow(mapped[i], fieldTypes)
        } catch (err) {
          if (!(err instanceof ImportValueError)) throw err
          valueErrorRows.add(i)
          if (valueProblems.length < 50) valueProblems.push({ row: i + 2, error: err.message })
        }
      }
    }

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

    // Rows the import would CREATE (no match field, an empty id, or no match): the
    // duplicate scan below asks whether each copies an existing record's label.
    const createRows: number[] = []
    // Rows the run will refuse anyway (a value or a link it cannot read) are not classified.
    const refused = (i: number) => valueErrorRows.has(i) || linkErrorRowSet.has(i)
    let ambiguous = 0
    const matchOf = mapped.map((r) => matchFields.map((f) => r[f]))
    if (matchFields.length === 0) {
      for (let i = 0; i < mapped.length; i++) {
        if (refused(i)) continue
        newCount++
        createRows.push(i)
      }
    } else {
      // The run's own matcher (services/import-match-index.ts): candidates read in batches —
      // the per-row lookup would make previewing a 5k file 5k round trips — and keyed by the
      // same rule, so the preview and the run agree on every row.
      const mappedFields = [...new Set(Object.values(columnMap).filter(Boolean))].filter(
        (f) => linkFields.get(f)?.kind !== 'm2m'
      )
      const index = (await openMatchIndex(collection, matchFields, linkFields)) as ImportMatchIndex
      const usable = (i: number) => !refused(i) && index.usable(matchOf[i])
      const candidates = new Map<number, string[]>()
      let existingRows: Array<Record<string, unknown>> = []
      try {
        await index.prefetch(matchOf.filter((_m, i) => usable(i)))
        for (let i = 0; i < matchOf.length; i++)
          if (usable(i)) candidates.set(i, await index.lookup(matchOf[i]))
        const ids = [
          ...new Set([...candidates.values()].filter((c) => c.length === 1).map((c) => c[0]))
        ]
        existingRows = await selectInChunks(ids, MATCH_PREFETCH_CHUNK, (chunk) =>
          whereInList(db(collection), 'id', chunk).select([
            ...new Set(['id', ...matchFields, ...mappedFields])
          ])
        )
      } catch (err) {
        return reply
          .code(400)
          .send({ error: `Could not read ${collection}: ${(err as Error).message.slice(0, 200)}` })
      }
      const existingById = new Map(existingRows.map((r) => [String(r.id), r]))
      // Each matched record's current links, one read per M2M field.
      const linksNow = new Map<string, Map<string, string[]>>()
      for (const lf of m2mFields) {
        const byParent = new Map<string, string[]>()
        linksNow.set(lf.field, byParent)
        const parents = existingRows.map((r) => String(r.id))
        const rows = (await selectInChunks(parents, 1000, (chunk) =>
          db(lf.junction as string)
            .whereIn(lf.fkToParent as string, chunk)
            .select({ p: lf.fkToParent as string, o: lf.fkToOther as string })
        )) as Array<{ p: unknown; o: unknown }>
        for (const r of rows) {
          if (r.o == null) continue
          const list = byParent.get(String(r.p)) ?? []
          list.push(String(r.o))
          byParent.set(String(r.p), list)
        }
      }

      // The same match key twice WITHIN the file — ambiguous, always a conflict.
      const keyOf = (i: number) => index.keyOf(matchOf[i])
      const seenInFile = new Map<string, number>()
      mapped.forEach((_r, i) => {
        if (!usable(i)) return
        seenInFile.set(keyOf(i), (seenInFile.get(keyOf(i)) ?? 0) + 1)
      })
      const shownKey = (i: number) =>
        matchFields
          .map((f) => {
            const v = fileCells[i][f]
            return v == null || String(v).trim() === '' ? '—' : String(v).trim()
          })
          .join(' · ')
      const labelOf = await importFieldLabels(collection)

      const dupReported = new Set<string>()
      mapped.forEach((rowData, i) => {
        if (refused(i)) return
        if (!usable(i)) {
          newCount++
          createRows.push(i)
          return
        }
        const key = keyOf(i)
        const idStr = shownKey(i)
        if ((seenInFile.get(key) ?? 0) > 1 && !dupReported.has(key)) {
          dupReported.add(key)
          conflicts++
          if (diffs.length < 50) {
            diffs.push({
              row: i + 2,
              id: idStr,
              kind: 'conflict',
              reason: `${matchFields.length > 1 ? 'these match values appear' : 'this value appears'} ${seenInFile.get(key)} times in the file — last row wins`,
              fields: []
            })
          }
          return
        }
        if (dupReported.has(key)) return // counted once per duplicated key

        const found = candidates.get(i) ?? []
        if (found.length > 1) {
          ambiguous++
          if (diffs.length < 50) {
            diffs.push({
              row: i + 2,
              id: idStr,
              kind: 'conflict',
              reason: ambiguousMatchText(describeMatch(matchFields, fileCells[i], labelOf)),
              fields: []
            })
          }
          return
        }
        const existing = found.length === 1 ? existingById.get(found[0]) : undefined
        if (!existing) {
          newCount++
          createRows.push(i)
          return
        }
        const fieldDiffs: Array<{ field: string; old: unknown; new: unknown }> = []
        for (const f of mappedFields) {
          if (matchFields.includes(f)) continue
          if (!(f in rowData)) continue
          if (!same(existing[f], rowData[f])) {
            fieldDiffs.push({ field: f, old: existing[f] ?? null, new: rowData[f] ?? null })
            fieldChangeCounts[f] = (fieldChangeCounts[f] ?? 0) + 1
          }
        }
        for (const [f, ids] of rowLinks[i]) {
          const now = linksNow.get(f)?.get(String(existing.id)) ?? []
          const want = strategy === 'overwrite' ? ids : [...new Set([...now, ...ids])]
          if (!sameLinks(now, want)) {
            fieldDiffs.push({ field: f, old: now.join(', '), new: want.join(', ') })
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

    // New rows that copy an existing record (or an earlier row of the file) on the
    // collection's duplicate-check fields (services/duplicate-check.ts).
    const duplicates = await importDuplicateScan(
      collection,
      createRows.map((i) => ({ row: i + 2, values: mapped[i] }))
    ).catch(() => null)

    return reply.send({
      data: {
        total: mapped.length,
        truncated,
        new: newCount,
        duplicates,
        unchanged,
        changed,
        conflicts,
        field_change_counts: fieldChangeCounts,
        diffs,
        link_error_rows: linkErrorRows,
        link_problems: linkProblems,
        value_error_rows: valueErrorRows.size,
        value_problems: valueProblems,
        /** Rows two or more existing records match: each fails in the run. */
        ambiguous,
        match_fields: matchFields
      }
    })
  })

  app.post('/', async (req, reply) => {
    const body = req.body as {
      collection?: string
      csv_data?: string
      column_map?: Record<string, string>
      duplicate_strategy?: string
      id_field?: string | string[]
      match_fields?: string[] | string
      file_name?: string
      through_items?: boolean
      /** Overwrite / merge with no match field: the person confirmed every row is created. */
      confirm_no_match?: boolean
    }

    const { collection, csv_data, column_map, duplicate_strategy, file_name } = body
    const id_field = body.match_fields ?? body.id_field

    if (!collection) return reply.code(400).send({ error: 'collection is required' })
    if (!csv_data) return reply.code(400).send({ error: 'csv_data is required' })
    const setup = matchSetupProblem({
      matchFields: parseMatchFields(id_field),
      columnMap: column_map,
      strategy: duplicate_strategy,
      confirmNoMatch: body.confirm_no_match === true
    })
    if (setup) return reply.code(400).send(setup)

    const job = await createImportJob(
      {
        collection,
        csv_data,
        column_map,
        duplicate_strategy,
        id_field,
        file_name,
        through_items: body.through_items === true,
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
      id_field?: string | string[]
      match_fields?: string[] | string
      through_items?: boolean
      file_name?: string
      confirm_no_match?: boolean
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
    const setup = matchSetupProblem({
      matchFields: parseMatchFields(body.match_fields ?? body.id_field),
      columnMap: body.column_map,
      strategy: body.duplicate_strategy,
      confirmNoMatch: body.confirm_no_match === true
    })
    if (setup) return reply.code(400).send(setup)

    const job = await createImportJob(
      {
        collection: body.collection,
        csv_data: fetched.csv,
        column_map: body.column_map,
        duplicate_strategy: body.duplicate_strategy,
        id_field: body.match_fields ?? body.id_field,
        through_items: body.through_items === true,
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
  // Failed-row repair (#152): the failed rows, mapped through the job's
  // column map + transforms, editable client-side and resubmitted one by one
  // through the ITEMS service (POST /imports/:id/repair-row).
  app.get('/:id/failed-rows', async (req, reply) => {
    const job = await db('nivaro_import_jobs')
      .where({ id: (req.params as { id: string }).id })
      .first()
    if (!job) return reply.code(404).send({ error: 'Import job not found' })
    const errors = parseJson<Array<{ row: number; error: string }>>(job.errors) ?? []
    if (errors.length === 0) return reply.send({ data: [] })
    const lines = String(job.csv_data ?? '')
      .split(/\r?\n/)
      .filter((l) => l.trim())
    if (lines.length < 2) return reply.send({ data: [] })
    const headers = parseCSVLine(lines[0])
    const columnMap = parseJson<Record<string, string>>(job.column_map) ?? {}
    const transforms = parseJson<Record<string, string>>(job.transforms) ?? {}
    const out: Array<{ row: number; error: string; values: Record<string, unknown> }> = []
    for (const e of errors.slice(0, 200)) {
      // errors store 1-based sheet rows (header = row 1)
      const line = lines[e.row - 1]
      if (!line) continue
      const values = parseCSVLine(line)
      const rowData: Record<string, unknown> = {}
      for (const [csvCol, fieldName] of Object.entries(columnMap)) {
        if (!fieldName) continue
        const idx = headers.indexOf(csvCol)
        if (idx >= 0)
          rowData[fieldName] = applyColumnTransform(values[idx] ?? null, transforms[csvCol])
      }
      out.push({ row: e.row, error: e.error, values: rowData })
    }
    return reply.send({ data: out, collection: job.collection })
  })

  // Resubmit one repaired row through the items service — hooks/validation/
  // RLS apply exactly like any create.
  app.post('/:id/repair-row', async (req, reply) => {
    const job = await db('nivaro_import_jobs')
      .where({ id: (req.params as { id: string }).id })
      .first()
    if (!job) return reply.code(404).send({ error: 'Import job not found' })
    const collection = String(job.collection)
    if (/^nivaro_/i.test(collection)) return reply.code(403).send({ error: 'System table' })
    const values = (req.body as { values?: Record<string, unknown> })?.values
    if (!values || typeof values !== 'object') {
      return reply.code(400).send({ error: 'values is required' })
    }
    try {
      const matchFields = parseMatchFields(job.id_field)
      // Relation cells name records the way the file did ("Cran, HQ Funded").
      const linkFields = await importLinkFields(collection, [
        ...new Set([...Object.keys(values), ...matchFields])
      ])
      assertMatchFieldsUsable(matchFields, linkFields)
      const resolver = new ImportLinkResolver()
      const payload: Record<string, unknown> = { ...values }
      // The same number / yes-no reading the run does (a refusal is a 422 sentence).
      coerceImportRow(
        payload,
        await importFieldTypes(collection, Object.keys(values), new Set(linkFields.keys()))
      )
      for (const [field, lf] of linkFields) {
        const v = payload[field]
        if (v == null || typeof v !== 'string') continue
        payload[field] = await resolver.resolve(lf, v)
      }
      // The job's own matching: a repaired row updates the record it matches, exactly as the
      // run would have — never a second copy of it (services/import-match-index.ts).
      const index = await openMatchIndex(collection, matchFields, linkFields)
      const tuple = matchFields.map((f) => payload[f])
      if (index?.usable(tuple)) {
        const found = await index.lookup(tuple)
        if (found.length > 1) {
          const labelOf = await importFieldLabels(collection)
          return reply.code(409).send({
            error: ambiguousMatchText(describeMatch(matchFields, values, labelOf)),
            code: 'AMBIGUOUS_MATCH'
          })
        }
        if (found.length === 1) {
          if (job.duplicate_strategy !== 'overwrite' && job.duplicate_strategy !== 'merge')
            return reply.send({ data: { id: found[0] }, outcome: 'skipped' })
          const updated = await updateOne(req.user!, collection, found[0], payload, req)
          return reply.send({ data: updated, outcome: 'updated' })
        }
      }
      const created = await createOne(req.user!, collection, payload, req)
      return reply.send({ data: created, outcome: 'created' })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 422
      return reply
        .code(status)
        .send({ error: err instanceof Error ? err.message : 'Create failed' })
    }
  })

  /**
   * Stop a pending or running import. One guarded update flips it to `cancelled`, so it works
   * whichever replica runs the job, and for a job whose process is gone (left `processing` by a
   * restart): the loop re-reads the status with every progress write and stops, writing what it
   * did so far (rollback works on it). A queued job never starts.
   */
  app.post('/:id/cancel', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await db('nivaro_import_jobs')
      .where({ id })
      .first('id', 'status', 'collection', 'created_by')
    if (!job) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && job.created_by !== req.user?.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const n = await db('nivaro_import_jobs')
      .where({ id })
      .whereIn('status', [...STOPPABLE_JOB_STATUSES])
      .update({ status: 'cancelled', completed_at: new Date() })
    if (Number(n) !== 1) {
      const now = await db('nivaro_import_jobs').where({ id }).first('status')
      return reply.code(409).send({
        error: `This import has already ${now?.status === 'failed' ? 'failed' : now?.status === 'cancelled' ? 'been stopped' : 'finished'} — there is nothing to stop`,
        code: 'IMPORT_NOT_RUNNING',
        status: now?.status ?? null
      })
    }
    await forgetImportJob(asImportRedis((app as unknown as { redis?: unknown }).redis), id)
    emitJobProgress(app, job.created_by, id, { jobId: id, cancelled: true })
    await logActivity({
      action: 'import-cancel',
      user: req.user?.id,
      collection: 'nivaro_import_jobs',
      item: id,
      comment: `${job.collection} (was ${job.status})`,
      req
    })
    const fresh = await db('nivaro_import_jobs').where({ id }).first()
    return reply.send({ data: formatJob(fresh ?? { ...job, status: 'cancelled' }) })
  })

  /** The uploaded file as it was stored, for the job's creator or an administrator. */
  app.get('/:id/file', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await db('nivaro_import_jobs')
      .where({ id })
      .first('id', 'file_name', 'csv_data', 'created_by')
    if (!job) return reply.code(404).send({ error: 'Not found' })
    if (!req.isAdmin && job.created_by !== req.user?.id) {
      return reply.code(403).send({ error: 'Forbidden' })
    }
    const csv = typeof job.csv_data === 'string' ? job.csv_data : ''
    if (!csv) return reply.code(404).send({ error: 'This import has no stored file' })
    const name = String(job.file_name ?? '').trim() || 'import.csv'
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', contentDisposition(name))
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'private, no-store')
      .send(csv)
  })

  app.post('/:id/rollback', async (req, reply) => {
    const { id } = req.params as { id: string }
    const job = await db('nivaro_import_jobs').where({ id }).first()
    if (!job) return reply.code(404).send({ error: 'Import not found' })
    // A cancelled or failed run rolls back what it wrote before it stopped (the run records
    // that as it goes, so even a job whose process died can be undone).
    if (!['complete', 'cancelled', 'failed'].includes(String(job.status)))
      return reply.code(400).send({ error: 'A running import cannot roll back — stop it first' })
    if (job.rolled_back_at) return reply.code(400).send({ error: 'Already rolled back' })
    const rb = parseJson<{
      created?: Array<{ id: unknown }>
      updated?: Array<{ key_field: string; key: unknown; prior: Record<string, unknown> }>
    }>(job.rollback_data)
    if (!rb) {
      return reply.code(400).send({
        error:
          job.status === 'cancelled' || job.status === 'failed'
            ? 'Nothing was recorded to undo: this import stopped before it wrote anything, or before it could save what it wrote'
            : 'This import predates rollback capture — nothing recorded to undo'
      })
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
    // M2M links the import wrote: a created record's junction rows go before the record
    // (a delete does not remove them), an overwritten record's prior set comes back.
    const rbLinkFields = await importLinkFields(
      collection,
      Object.values(parseJson<Record<string, string>>(job.column_map) ?? {}).filter(Boolean)
    ).catch(() => new Map<string, ImportLinkField>())
    void (async () => {
      let deleted = 0
      let restored = 0
      let skippedRows = 0
      // S2: a raw restore (default-mode import) is announced once; keys are by the import's key
      // field, not id, so the event says "records in this collection changed".
      let rawRestored = false
      const rawRestoredFields = new Set<string>()
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
            for (const lf of rbLinkFields.values())
              if (lf.kind === 'm2m') await writeLinksRaw(lf, c.id, [], true)
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
          if (job.through_items) {
            // The import wrote through the items service; the undo does too, so
            // the record's history shows both.
            const rec = (await db(collection)
              .where({ [u.key_field]: u.key })
              .first('id')) as { id: unknown } | undefined
            if (!rec) throw new Error('record no longer exists')
            const { updateOne: update } = await import('../services/items.js')
            await update(user, collection, String(rec.id), {
              ...u.prior,
              _change_reason: `Import rollback (job ${id})`
            })
          } else {
            const plain: Record<string, unknown> = {}
            const linkPrior: Array<[ImportLinkField, string[]]> = []
            for (const [k, v] of Object.entries(u.prior)) {
              const lf = rbLinkFields.get(k)
              if (lf?.kind === 'm2m') {
                const set = (v as { set?: unknown[] } | null)?.set
                if (Array.isArray(set)) linkPrior.push([lf, set.map(String)])
              } else plain[k] = v
            }
            if (Object.keys(plain).length > 0) {
              await db(collection)
                .where({ [u.key_field]: u.key })
                .update(plain)
              rawRestored = true
              for (const k of Object.keys(plain)) rawRestoredFields.add(k)
            }
            if (linkPrior.length > 0) {
              const rec = (await db(collection)
                .where({ [u.key_field]: u.key })
                .first('id')) as { id: unknown } | undefined
              if (!rec) throw new Error('record no longer exists')
              for (const [lf, set] of linkPrior) await writeLinksRaw(lf, rec.id, set, true)
              rawRestored = true
              for (const [lf] of linkPrior) rawRestoredFields.add(lf.field)
            }
          }
          restored++
        } catch (err) {
          failures.push(`restore ${u.key}: ${err instanceof Error ? err.message : String(err)}`)
        }
        done++
        if (done % 25 === 0) run.progress({ done, total })
      }
      if (rawRestored)
        void announceRawWrites(collection, null, {
          action: 'update',
          changed_fields: [...rawRestoredFields],
          source: `import-rollback:job-${id}`,
          noticeOnly: true
        })
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

    if (!['complete', 'failed', 'cancelled'].includes(String(job.status))) {
      return reply
        .code(400)
        .send({ error: 'Cannot delete a job that is still running — stop it first' })
    }

    await db('nivaro_import_jobs').where({ id }).delete()
    await forgetImportJob(asImportRedis((app as unknown as { redis?: unknown }).redis), id)
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
