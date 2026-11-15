import { createHash } from 'node:crypto'
import type { Redis } from 'ioredis'
import { db } from '../db/index.js'
import { currentTenantKey } from './tenant-rooms.js'

/**
 * File processing status (rt3 #17). After an upload, a file is worked on in the background:
 *
 * - `thumbnail` — raster images: the chip's thumbnail rendition is made once, into the same
 *   cache the on-demand `/files/:id/transform` route serves from (`transformCacheKey`), so the
 *   chip never waits on a full-size original.
 * - `text` — documents the extractor reads (PDF, Word, Excel, CSV, text, mail, HTML): the text
 *   is read once (bounded like Ask AI's own reader) and kept beside the renditions
 *   (`transforms/<id>/text.json`), so Ask AI's record files reuse it instead of reading again.
 *   A replace or delete drops it with the renditions (deleteTransforms).
 *
 * No virus scan or PDF page render exists in core, so neither is a step.
 *
 * While a file is worked on its status is `processing`; the file chip shows "Processing…" and
 * updates in place when it ends. The end is announced as `file:processed {file}` in the record
 * room of every record the file is attached to — only that record's viewers hear it (rooms are
 * joined after a read check) — and the payload is the file id only. Status lives in Redis for
 * other replicas (tenant-keyed), with a per-process copy; it expires on its own.
 */

export type FileStep = 'thumbnail' | 'text'
export type FileProcessingStatus = 'processing' | 'ready' | 'failed'

export interface FileProcessingState {
  status: FileProcessingStatus
  steps: FileStep[]
  started_at: string
  finished_at?: string
}

export const STATUS_TTL_S = 30 * 60
/** Files worked on at once per process; the rest wait their turn. */
export const PROCESS_CONCURRENCY = 2
/** The chip thumbnail rendition (2x the largest chip). */
export const CHIP_THUMB = { width: 160, height: 160, fit: 'cover', format: 'webp', quality: 80 } as const

const RASTER = /^image\/(jpeg|jpg|png|webp|gif|avif|tiff)$/i
const TEXT_EXT = /\.(pdf|docx|xlsx|xls|xlsm|csv|txt|md|eml|html?)$/i
const TEXT_TYPES = /^(application\/pdf|text\/)/i

export interface TransformParams {
  width?: number
  height?: number
  fit: 'cover' | 'contain'
  format: 'webp' | 'jpeg' | 'png'
  quality: number
}

/** Where a transform rendition is cached. One definition for the route and the processor. */
export function transformCacheKey(fileId: string, p: TransformParams): string {
  const hash = createHash('sha1')
    .update(
      `w=${p.width ?? ''}&h=${p.height ?? ''}&fit=${p.fit}&format=${p.format}&q=${p.quality}`
    )
    .digest('hex')
    .slice(0, 16)
  return `transforms/${String(fileId).toLowerCase()}/${hash}.${p.format}`
}

/** Where a document's extracted text is kept (dropped with the renditions). */
export function extractCacheKey(fileId: string): string {
  return `transforms/${String(fileId).toLowerCase()}/text.json`
}

/** What a file needs done after upload (empty = nothing; it is ready at once). */
export function processingPlan(file: {
  type?: string | null
  filename_download?: string | null
  filesize?: number | string | null
}): FileStep[] {
  const steps: FileStep[] = []
  const type = String(file.type ?? '')
  const name = String(file.filename_download ?? '')
  if (RASTER.test(type)) steps.push('thumbnail')
  else if (TEXT_EXT.test(name) || TEXT_TYPES.test(type)) steps.push('text')
  return steps
}

// ── Status store ─────────────────────────────────────────────────────────────

const memory = new Map<string, { state: FileProcessingState; exp: number }>()
const keyOf = (fileId: string, tenant = currentTenantKey()) =>
  `${tenant}:${String(fileId).toLowerCase()}`

async function redis(): Promise<Redis | null> {
  try {
    const { getApp } = await import('./io-holder.js')
    return ((getApp() as { redis?: Redis } | null)?.redis ?? null) as Redis | null
  } catch {
    return null
  }
}

async function writeState(fileId: string, state: FileProcessingState): Promise<void> {
  const key = keyOf(fileId)
  memory.set(key, { state, exp: Date.now() + STATUS_TTL_S * 1000 })
  if (memory.size > 2000)
    for (const [k, v] of memory) if (v.exp < Date.now()) memory.delete(k)
  const r = await redis()
  if (!r) return
  await r.set(`nvr:fileproc:${key}`, JSON.stringify(state), 'EX', STATUS_TTL_S).catch(() => null)
}

/** Status per file id (absent = nothing running or known: the file is as it is). */
export async function readProcessingStates(
  fileIds: string[]
): Promise<Record<string, FileProcessingState>> {
  const out: Record<string, FileProcessingState> = {}
  const ids = [...new Set(fileIds.map(String))]
  const r = await redis()
  if (r && ids.length > 0) {
    const raw = await r.mget(...ids.map((id) => `nvr:fileproc:${keyOf(id)}`)).catch(() => null)
    raw?.forEach((v, i) => {
      if (!v) return
      try {
        out[ids[i]] = JSON.parse(v) as FileProcessingState
      } catch {
        /* unreadable — treated as unknown */
      }
    })
  }
  for (const id of ids) {
    if (out[id]) continue
    const hit = memory.get(keyOf(id))
    if (hit && hit.exp >= Date.now()) out[id] = hit.state
  }
  return out
}

// ── Runner ───────────────────────────────────────────────────────────────────

let running = 0
const waiting: Array<() => void> = []

async function slot<T>(fn: () => Promise<T>): Promise<T> {
  if (running >= PROCESS_CONCURRENCY) await new Promise<void>((res) => waiting.push(res))
  running++
  try {
    return await fn()
  } finally {
    running--
    waiting.shift()?.()
  }
}

export interface ProcessDeps {
  read(file: StoredFileLike): Promise<Buffer>
  put(key: string, body: Buffer, type: string): Promise<unknown>
  thumbnail(buffer: Buffer): Promise<Buffer>
  extract(buffer: Buffer, name: string, type: string | null): Promise<unknown>
  announce(fileId: string): Promise<void>
}

export interface StoredFileLike {
  id: string
  type?: string | null
  filename_download?: string | null
  filename_disk?: string | null
  filesize?: number | string | null
}

const defaultDeps: ProcessDeps = {
  async read(file) {
    const { readFileBuffer } = await import('./files.js')
    return readFileBuffer(file as Parameters<typeof readFileBuffer>[0])
  },
  async put(key, body, type) {
    const { getStorage } = await import('./storage/index.js')
    return getStorage().put(key, body, type)
  },
  async thumbnail(buffer) {
    const { default: sharp } = await import('sharp')
    return sharp(buffer)
      .resize({ width: CHIP_THUMB.width, height: CHIP_THUMB.height, fit: CHIP_THUMB.fit })
      .webp({ quality: CHIP_THUMB.quality })
      .toBuffer()
  },
  async extract(buffer, name, type) {
    const { extractForAsk } = await import('./ai-ask-extract.js')
    return extractForAsk(buffer, name, type)
  },
  announce: announceFileProcessed
}

/**
 * Work one file through its steps and record the outcome. Never throws: a failed step leaves
 * the file usable exactly as before (the thumbnail is made on demand, the text read on demand).
 */
export async function processFile(
  file: StoredFileLike,
  deps: ProcessDeps = defaultDeps
): Promise<FileProcessingState | null> {
  const steps = processingPlan(file)
  if (steps.length === 0) return null
  const started = new Date().toISOString()
  await writeState(file.id, { status: 'processing', steps, started_at: started })
  let ok = true
  await slot(async () => {
    let buffer: Buffer
    try {
      buffer = await deps.read(file)
    } catch {
      ok = false
      return
    }
    for (const step of steps) {
      try {
        if (step === 'thumbnail') {
          const thumb = await deps.thumbnail(buffer)
          await deps.put(transformCacheKey(file.id, CHIP_THUMB), thumb, 'image/webp')
        } else {
          const doc = await deps.extract(
            buffer,
            String(file.filename_download ?? 'document'),
            file.type ?? null
          )
          await deps.put(
            extractCacheKey(file.id),
            Buffer.from(JSON.stringify(doc)),
            'application/json'
          )
        }
      } catch {
        ok = false
      }
    }
  })
  const done: FileProcessingState = {
    status: ok ? 'ready' : 'failed',
    steps,
    started_at: started,
    finished_at: new Date().toISOString()
  }
  await writeState(file.id, done)
  await deps.announce(file.id).catch(() => {})
  return done
}

/** Start processing in the background (upload routes call this; it returns at once). */
export function startFileProcessing(file: StoredFileLike): void {
  if (processingPlan(file).length === 0) return
  // Mark it processing before the upload answers, so the first status read already says so.
  void writeState(file.id, {
    status: 'processing',
    steps: processingPlan(file),
    started_at: new Date().toISOString()
  })
    .then(async () => {
      const { runInBackgroundPool } = await import('../db/pool-context.js')
      setImmediate(() => {
        void runInBackgroundPool(() => processFile(file)).catch(() => {})
      })
    })
    .catch(() => {})
}

/** A document's extracted text kept by the processor, or null (not processed / replaced). */
export async function cachedExtract<T = unknown>(fileId: string): Promise<T | null> {
  try {
    const { getStorage } = await import('./storage/index.js')
    const raw = await getStorage().get(extractCacheKey(fileId))
    if (!raw) return null
    return JSON.parse(Buffer.from(raw).toString('utf8')) as T
  } catch {
    return null
  }
}

/**
 * Tell the viewers of every record holding this file that it is ready: the record room of the
 * row itself (a direct file field) or of the parent a link table hangs it on. Ids only.
 */
export async function announceFileProcessed(fileId: string): Promise<void> {
  const { getFileRefColumns } = await import('./file-usage.js')
  const { getRelations } = await import('./collections.js')
  const { emitRecordEvent } = await import('./record-events.js')
  const refs = await getFileRefColumns().catch(() => [])
  for (const ref of refs) {
    if (/^(nivaro_|directus_)/i.test(ref.table)) continue
    const rels = (await getRelations(ref.table).catch(() => [])) as Array<{
      many_collection: string
      many_field: string
      one_collection: string | null
      junction_field?: string | null
    }>
    // A link table: the leg whose junction partner is this file column names the parent.
    const parentLeg = rels.find(
      (r) => r.many_collection === ref.table && r.junction_field === ref.column && r.one_collection
    )
    const rows = (await db(ref.table)
      .where(ref.column, fileId)
      .limit(20)
      .select(parentLeg ? parentLeg.many_field : 'id')
      .catch(() => [])) as Array<Record<string, unknown>>
    for (const row of rows) {
      const owner = parentLeg ? row[parentLeg.many_field] : row.id
      if (owner == null || owner === '') continue
      emitRecordEvent(parentLeg ? parentLeg.one_collection : ref.table, String(owner), 'file:processed', {
        file: String(fileId)
      })
    }
  }
}

/** Tests only. */
export function resetFileProcessingForTests(): void {
  memory.clear()
  running = 0
  waiting.length = 0
}
