import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import mime from 'mime-types'
import sharp from 'sharp'
import { db } from '../db/index.js'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { findOrphanFiles, getFileUsage } from '../services/file-usage.js'
import {
  createPresignedFile,
  deleteFile,
  getFile,
  listFiles,
  readFileBuffer,
  reportFileBandwidth,
  updateFileMeta,
  uploadFile
} from '../services/files.js'
import { getStorage } from '../services/storage/index.js'
import {
  bustStorageDriverCache,
  normalizeDriverName,
  readStorageSettings,
  testStorageDriver
} from '../services/storage-drivers.js'

function contentDisposition(filename: string, mode: 'inline' | 'attachment' = 'inline'): string {
  const ascii = filename.replace(/[^\x20-\x7E]/g, '_')
  const encoded = encodeURIComponent(filename)
  if (ascii === filename) return `${mode}; filename="${ascii}"`
  return `${mode}; filename="${ascii}"; filename*=UTF-8''${encoded}`
}

const MAX_DIMENSION = 4000
const TRANSFORM_FORMATS = ['webp', 'jpeg', 'png'] as const
type TransformFormat = (typeof TRANSFORM_FORMATS)[number]

export async function filesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const q = req.query as {
      folder?: string
      limit?: string
      offset?: string
      search?: string
      filter?: string
      tag?: string
    }
    // Support the items-style `filter={"id":{"_in":[...]}}` shape the shared
    // file fields send to batch-resolve metadata for a known id set.
    let ids: string[] | undefined
    if (q.filter) {
      try {
        const parsed = JSON.parse(q.filter) as { id?: { _in?: unknown[]; _eq?: unknown } }
        if (Array.isArray(parsed?.id?._in)) ids = parsed.id._in.map(String)
        else if (parsed?.id?._eq != null) ids = [String(parsed.id._eq)]
      } catch {
        /* malformed filter — ignore */
      }
    }
    const result = await listFiles({
      folder: q.folder,
      limit: Number(q.limit ?? 50),
      offset: Number(q.offset ?? 0),
      search: q.search,
      ids,
      tag: q.tag
    })
    return reply.send(result)
  })

  /** Batch dead-link check for whatever the user is looking at: stats each
   *  file against the storage provider NOW, persists the verdict on the row
   *  (missing_at set/cleared), and returns it. Cap 100 per call. */
  app.post('/verify', async (req, reply) => {
    const body = req.body as { ids?: unknown[] }
    const ids = (Array.isArray(body?.ids) ? body.ids : []).map(String).slice(0, 100)
    if (ids.length === 0) return reply.code(400).send({ error: 'ids[] is required' })
    const { verifyFiles } = await import('../services/file-integrity.js')
    const verdicts = await verifyFiles(ids)
    return reply.send({
      data: Object.fromEntries(verdicts.map((v) => [v.id, { missing: v.missing }]))
    })
  })

  app.post('/upload', async (req, reply) => {
    const multipart = await req.file()
    if (!multipart) return reply.code(400).send({ error: 'No file provided' })
    const folder = (req.query as Record<string, string>).folder
    const file = await uploadFile(req.user!, multipart, folder)
    await logActivity({
      action: 'create',
      collection: 'nivaro_files',
      item: String(file.id),
      user: req.user?.id,
      req
    })
    return reply.code(201).send({ data: file })
  })

  // Presigned direct upload (s3/azure providers only). Creates the file record
  // and returns a presigned PUT url the client uploads the bytes to.
  app.post('/presign', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { filename?: string; type?: string; folder?: string }
    if (!body.filename) return reply.code(400).send({ error: 'filename is required' })
    try {
      const { file, uploadUrl } = await createPresignedFile(req.user!, {
        filename: body.filename,
        type: body.type,
        folder: body.folder
      })
      await logActivity({
        action: 'create',
        collection: 'nivaro_files',
        item: String(file.id),
        user: req.user?.id,
        req
      })
      return reply.code(201).send({ data: file, upload_url: uploadUrl })
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode ?? 500
      if (status === 400) return reply.code(400).send({ error: (err as Error).message })
      throw err
    }
  })

  // ─── Storage driver config (#527) ──────────────────────────────────────────
  // Settings for where NEW uploads land (local disk / S3-compatible / Azure
  // Blob). Lives here rather than the settings PATCH so secrets get the
  // masked-resubmit-preserves treatment and saves bust the driver cache.

  const STORAGE_MASK = '••••••'
  const STORAGE_SECRET_KEYS = new Set(['secret_access_key', 'account_key'])

  function maskStorageConfig(cfg: Record<string, unknown> | null): Record<string, unknown> | null {
    if (!cfg) return null
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(cfg)) {
      out[k] = STORAGE_SECRET_KEYS.has(k) && v ? STORAGE_MASK : v
    }
    return out
  }

  app.get('/storage-config', { preHandler: requireAdmin }, async (_req, reply) => {
    const { driver, config } = await readStorageSettings()
    return reply.send({ data: { driver, config: maskStorageConfig(config) } })
  })

  app.put('/storage-config', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { driver?: string; config?: Record<string, unknown> | null }
    const driver = normalizeDriverName(body.driver)
    if (body.driver && !['local', 's3', 'azure-blob', 'azure'].includes(String(body.driver))) {
      return reply.code(400).send({ error: 'driver must be local, s3 or azure-blob' })
    }

    // Masked-resubmit-preserves: a secret field carrying the mask keeps the
    // stored value (external-apis precedent).
    const { config: stored } = await readStorageSettings()
    let config: Record<string, unknown> | null = null
    if (body.config && typeof body.config === 'object' && !Array.isArray(body.config)) {
      config = {}
      for (const [k, v] of Object.entries(body.config)) {
        if (STORAGE_SECRET_KEYS.has(k) && v === STORAGE_MASK) {
          config[k] = stored?.[k] ?? null
        } else {
          config[k] = v
        }
      }
    }

    await db('nivaro_settings')
      .where({ id: 1 })
      .update({
        storage_driver: driver,
        storage_config: config ? JSON.stringify(config) : null
      })
    bustStorageDriverCache()
    await logActivity({
      action: 'storage-config-update',
      user: req.user?.id,
      collection: 'nivaro_settings',
      item: '1',
      comment: `storage driver → ${driver}`,
      req
    })
    return reply.send({ data: { driver, config: maskStorageConfig(config) } })
  })

  /** Probe write+read+delete against a candidate config (body) or, with no
   *  body, the currently saved one. Returns {ok} / {ok:false, error} — never
   *  a 500 for a bad bucket. */
  app.post('/storage-test', { preHandler: requireAdmin }, async (req, reply) => {
    const body = (req.body ?? {}) as { driver?: string; config?: Record<string, unknown> | null }
    let driver = normalizeDriverName(body.driver)
    let config = body.config ?? null
    const { driver: storedDriver, config: storedConfig } = await readStorageSettings()
    if (!body.driver) {
      driver = storedDriver
      config = storedConfig
    } else if (config) {
      // Fill masked secrets from the stored config so "Test connection" works
      // without retyping the secret.
      const merged: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(config)) {
        merged[k] =
          STORAGE_SECRET_KEYS.has(k) && v === STORAGE_MASK ? (storedConfig?.[k] ?? null) : v
      }
      config = merged
    }
    const result = await testStorageDriver(driver, config)
    return reply.send({ data: result })
  })

  // Where is this file referenced? FK-driven scan — see services/file-usage.ts
  app.get('/:id/usage', async (req, reply) => {
    const { id } = req.params as { id: string }
    const file = await getFile(id)
    if (!file) return reply.code(404).send({ error: 'Not found' })
    const usage = await getFileUsage(id)
    return reply.send({ data: usage })
  })

  // Files referenced by nothing — deletion candidates (admin only)
  // File usage counts (#200): "used on N records" per file, batched for the
  // browser's visible page (FK-driven, same scan as single-file usage).
  app.post('/usage/counts', async (req, reply) => {
    const ids = (
      Array.isArray((req.body as { ids?: unknown[] })?.ids)
        ? (req.body as { ids: unknown[] }).ids
        : []
    )
      .map(String)
      .slice(0, 100)
    if (ids.length === 0) return reply.code(400).send({ error: 'ids[] is required' })
    const { getFileRefColumns } = await import('../services/file-usage.js')
    const refs = await getFileRefColumns()
    const counts = new Map<string, number>(ids.map((id) => [id, 0]))
    for (const ref of refs) {
      try {
        const rows = (await db(ref.table)
          .whereIn(ref.column, ids)
          .select(ref.column)
          .count({ n: '*' })
          .groupBy(ref.column)) as Array<Record<string, unknown>>
        for (const r of rows) {
          const key = String(r[ref.column])
          counts.set(key, (counts.get(key) ?? 0) + Number(r.n ?? 0))
        }
      } catch {
        /* one surface contributes zero */
      }
    }
    return reply.send({ data: Object.fromEntries(counts) })
  })

  app.get('/usage/orphans', { preHandler: requireAdmin }, async (req, reply) => {
    const q = req.query as { limit?: string; offset?: string }
    const result = await findOrphanFiles({
      limit: Number(q.limit ?? 50),
      offset: Number(q.offset ?? 0)
    })
    return reply.send(result)
  })

  app.get('/:id/meta', async (req, reply) => {
    const { id } = req.params as { id: string }
    const file = await getFile(id)
    if (!file) return reply.code(404).send({ error: 'Not found' })
    const url = file.filename_disk ? await getStorage().getUrl(file.filename_disk) : null
    return reply.send({ data: { ...file, url } })
  })

  // Raw object access by storage key (used by the local provider's getUrl()).
  app.get('/raw/*', async (req, reply) => {
    const key = (req.params as Record<string, string>)['*']
    if (!key || key.includes('..')) return reply.code(400).send({ error: 'Invalid key' })
    try {
      const buffer = await getStorage().get(key)
      const contentType = mime.lookup(key) || 'application/octet-stream'
      return reply.header('Content-Type', contentType).send(buffer)
    } catch {
      return reply.code(404).send({ error: 'Not found' })
    }
  })

  // On-the-fly image transformations, cached back into storage.
  app.get('/:id/transform', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { w?: string; h?: string; fit?: string; format?: string; q?: string }

    const file = await getFile(id)
    if (!file || !file.filename_disk) return reply.code(404).send({ error: 'Not found' })
    if (!file.type?.startsWith('image/')) {
      return reply.code(400).send({ error: 'Transformations are only supported for images' })
    }

    const width = q.w ? Math.min(Math.max(1, Number(q.w) || 0), MAX_DIMENSION) : undefined
    const height = q.h ? Math.min(Math.max(1, Number(q.h) || 0), MAX_DIMENSION) : undefined
    const fit: 'cover' | 'contain' = q.fit === 'contain' ? 'contain' : 'cover'
    const format: TransformFormat = TRANSFORM_FORMATS.includes(q.format as TransformFormat)
      ? (q.format as TransformFormat)
      : 'webp'
    const quality = q.q ? Math.min(Math.max(1, Number(q.q) || 80), 100) : 80

    if ((q.w && !width) || (q.h && !height)) {
      return reply.code(400).send({ error: 'Invalid dimensions' })
    }

    const paramsHash = createHash('sha1')
      .update(`w=${width ?? ''}&h=${height ?? ''}&fit=${fit}&format=${format}&q=${quality}`)
      .digest('hex')
      .slice(0, 16)
    const cacheKey = `transforms/${id}/${paramsHash}.${format}`
    const contentType = `image/${format}`
    const storage = getStorage()

    reply
      .header('Content-Type', contentType)
      .header('Cache-Control', 'public, max-age=31536000, immutable')

    const cached = await storage.get(cacheKey).catch(() => null)
    if (cached) return reply.send(cached)

    const original = await readFileBuffer(file).catch(() => null)
    if (!original) return reply.code(404).send({ error: 'Stored object not found' })

    let pipeline = sharp(original)
    if (width || height) pipeline = pipeline.resize({ width, height, fit })
    if (format === 'webp') pipeline = pipeline.webp({ quality })
    else if (format === 'jpeg') pipeline = pipeline.jpeg({ quality })
    else pipeline = pipeline.png()

    const transformed = await pipeline.toBuffer()
    await storage.put(cacheKey, transformed, contentType).catch(() => null)
    return reply.send(transformed)
  })

  app.get('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const q = req.query as { download?: string }
    const file = await getFile(id)
    if (!file || !file.filename_disk) return reply.code(404).send({ error: 'Not found' })
    const contentType =
      file.type ?? (mime.lookup(file.filename_download) || 'application/octet-stream')
    let buffer: Buffer
    try {
      buffer = await readFileBuffer(file)
    } catch {
      return reply.code(404).send({ error: 'Stored object not found' })
    }
    // Report bandwidth usage to gateway (fire-and-forget)
    reportFileBandwidth(file).catch(() => {})
    const mode = q.download === '1' || q.download === 'true' ? 'attachment' : 'inline'
    reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', contentDisposition(file.filename_download ?? 'file', mode))
    return reply.send(buffer)
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      title?: string | null
      description?: string | null
      folder?: string | null
      expires_at?: string | null
      tags?: string[] | null
    }

    const existing = await getFile(id)
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const patch: Parameters<typeof updateFileMeta>[1] = {}
    if ('title' in body) patch.title = body.title
    if ('description' in body) patch.description = body.description
    if ('folder' in body) patch.folder = body.folder
    if ('tags' in body) patch.tags = body.tags
    if ('expires_at' in body) {
      if (!body.expires_at) {
        patch.expires_at = null
      } else {
        const date = new Date(body.expires_at)
        if (Number.isNaN(date.getTime())) {
          return reply.code(400).send({ error: 'Invalid expires_at date' })
        }
        patch.expires_at = date
      }
    }

    const file = await updateFileMeta(id, patch, req.user?.id)
    await logActivity({
      action: 'update',
      collection: 'nivaro_files',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.send({ data: file })
  })

  app.delete('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    await deleteFile(id)
    await logActivity({
      action: 'delete',
      collection: 'nivaro_files',
      item: id,
      user: req.user?.id,
      req
    })
    return reply.code(204).send()
  })
}
