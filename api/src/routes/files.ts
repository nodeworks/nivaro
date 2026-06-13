import { createHash } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import mime from 'mime-types'
import sharp from 'sharp'
import { authenticate, requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
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

const MAX_DIMENSION = 4000
const TRANSFORM_FORMATS = ['webp', 'jpeg', 'png'] as const
type TransformFormat = (typeof TRANSFORM_FORMATS)[number]

export async function filesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate)

  app.get('/', async (req, reply) => {
    const q = req.query as { folder?: string; limit?: string; offset?: string }
    const result = await listFiles({
      folder: q.folder,
      limit: Number(q.limit ?? 50),
      offset: Number(q.offset ?? 0)
    })
    return reply.send(result)
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
    reply
      .header('Content-Type', contentType)
      .header('Content-Disposition', `inline; filename="${file.filename_download}"`)
    return reply.send(buffer)
  })

  app.patch('/:id', async (req, reply) => {
    const { id } = req.params as { id: string }
    const body = (req.body ?? {}) as {
      title?: string | null
      description?: string | null
      folder?: string | null
      expires_at?: string | null
    }

    const existing = await getFile(id)
    if (!existing) return reply.code(404).send({ error: 'Not found' })

    const patch: Parameters<typeof updateFileMeta>[1] = {}
    if ('title' in body) patch.title = body.title
    if ('description' in body) patch.description = body.description
    if ('folder' in body) patch.folder = body.folder
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
