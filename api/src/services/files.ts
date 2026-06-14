import { randomUUID } from 'node:crypto'
import { extname, join } from 'node:path'
import type { MultipartFile } from '@fastify/multipart'
import mime from 'mime-types'
import { monotonicFactory } from 'ulid'
import { config } from '../config.js'
import { db } from '../db/index.js'
import { getTenantSlug, getTenantId } from '../db/tenant-context.js'
import type { CMSFile, User } from '../types.js'
import { getStorage, getStorageProviderName } from './storage/index.js'

const ulid = monotonicFactory()

/** CMSFile with the storage/expiry columns added by migration. */
export type StoredFile = CMSFile & {
  expires_at: Date | string | null
  storage_provider: string | null
}

// ─── Cloud usage reporting ───────────────────────────────────────────────────
// All webhook calls are fire-and-forget. A missing GATEWAY_URL / PROVISION_SECRET
// is treated as "not in cloud mode" — the upload/delete continues normally.
//
// Storage strategy (Option A): all tenants share the same S3/R2 bucket; per-tenant
// isolation is achieved via the key prefix `{slug}/files/{id}{ext}`. The gateway
// env vars (STORAGE_PROVIDER, STORAGE_S3_BUCKET, etc.) configure the single
// shared bucket. The /admin/configure-storage endpoint writes per-tenant config
// to nivaro_settings for future per-tenant override support.

type FileEventType = 'created' | 'deleted' | 'bandwidth'

async function reportFileEvent(
  event: FileEventType,
  payload: Record<string, unknown>
): Promise<void> {
  const gatewayUrl = process.env.GATEWAY_URL
  const secret = process.env.PROVISION_SECRET
  if (!gatewayUrl || !secret) return // Not in cloud mode — skip silently

  const endpointMap: Record<FileEventType, string> = {
    created: '/storage/file-created',
    deleted: '/storage/file-deleted',
    bandwidth: '/storage/bandwidth',
  }

  fetch(`${gatewayUrl}${endpointMap[event]}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-provision-secret': secret,
    },
    body: JSON.stringify(payload),
  }).catch(() => {}) // Fire-and-forget — never fail the upload/delete
}

/** Build the storage key for a new file. In cloud mode, prefixes with the tenant
 *  slug so each tenant's files live in their own key namespace within the shared
 *  bucket. Falls back gracefully to a flat key in self-hosted mode. */
function buildDiskName(id: string, ext: string): string {
  // Use tenant UUID as prefix — immune to slug changes; new tenants never collide with old slugs
  const tenantId = getTenantId()
  if (tenantId) return `${tenantId}/files/${id}${ext}`
  return `${id}${ext}`
}

// ─── File operations ─────────────────────────────────────────────────────────

export async function uploadFile(
  user: User,
  multipart: MultipartFile,
  folderId?: string
): Promise<StoredFile> {
  const fileId = randomUUID()
  const diskId = ulid().toLowerCase()
  const originalName = multipart.filename
  const mimeType = multipart.mimetype || mime.lookup(originalName) || 'application/octet-stream'
  const ext =
    extname(originalName) || (mime.extension(mimeType) ? `.${mime.extension(mimeType)}` : '')
  const diskName = buildDiskName(diskId, ext)

  const buffer = await multipart.toBuffer()
  const provider = getStorageProviderName()
  await getStorage().put(diskName, buffer, String(mimeType))

  await db('nivaro_files').insert({
    id: fileId,
    storage: provider,
    storage_provider: provider,
    filename_disk: diskName,
    filename_download: originalName,
    title: originalName.replace(/\.[^.]+$/, ''),
    type: String(mimeType),
    folder: folderId ?? null,
    uploaded_by: user.id,
    uploaded_on: new Date(),
    filesize: buffer.length
  })

  const file = (await db<StoredFile>('nivaro_files').where({ id: fileId }).first()) as StoredFile

  // Report to gateway (fire-and-forget)
  await reportFileEvent('created', {
    slug: getTenantSlug() ?? null,
    fileKey: file.filename_disk,
    filename: file.filename_download,
    mimeType: file.type,
    sizeBytes: file.filesize,
    folder: file.folder ?? null,
  })

  return file
}

/**
 * Create the DB record for a direct (presigned) upload — the bytes are sent
 * straight to object storage by the client, so no buffer passes through here.
 */
export async function createPresignedFile(
  user: User,
  opts: { filename: string; type?: string; folder?: string }
): Promise<{ file: StoredFile; uploadUrl: string }> {
  const storage = getStorage()
  if (!storage.getUploadUrl) {
    throw Object.assign(new Error('Presigned uploads are not supported by the local provider'), {
      statusCode: 400
    })
  }

  const fileId = randomUUID()
  const diskId = ulid().toLowerCase()
  const mimeType = opts.type || mime.lookup(opts.filename) || 'application/octet-stream'
  const ext =
    extname(opts.filename) || (mime.extension(mimeType) ? `.${mime.extension(mimeType)}` : '')
  const diskName = buildDiskName(diskId, ext)
  const provider = getStorageProviderName()

  const uploadUrl = await storage.getUploadUrl(diskName, String(mimeType))

  await db('nivaro_files').insert({
    id: fileId,
    storage: provider,
    storage_provider: provider,
    filename_disk: diskName,
    filename_download: opts.filename,
    title: opts.filename.replace(/\.[^.]+$/, ''),
    type: String(mimeType),
    folder: opts.folder ?? null,
    uploaded_by: user.id,
    uploaded_on: new Date(),
    filesize: null
  })

  const file = (await db<StoredFile>('nivaro_files').where({ id: fileId }).first()) as StoredFile

  // Report presigned upload creation (fire-and-forget; filesize unknown until client finishes)
  await reportFileEvent('created', {
    slug: getTenantSlug() ?? null,
    fileKey: file.filename_disk,
    filename: file.filename_download,
    mimeType: file.type,
    sizeBytes: null,
    folder: file.folder ?? null,
  })

  return { file, uploadUrl }
}

export async function getFile(id: string): Promise<StoredFile | undefined> {
  return db<StoredFile>('nivaro_files').where({ id }).first()
}

/** Read the raw bytes of a file from whichever storage provider holds it. */
export async function readFileBuffer(file: StoredFile): Promise<Buffer> {
  if (!file.filename_disk) throw new Error('File has no stored object')
  return getStorage().get(file.filename_disk)
}

export async function listFiles(opts: { folder?: string; limit?: number; offset?: number } = {}) {
  const { folder, limit = 50, offset = 0 } = opts
  const q = db<StoredFile>('nivaro_files')
    .limit(limit)
    .offset(offset)
    .orderBy('uploaded_on', 'desc')
  if (folder) q.where({ folder })
  const [files, [{ count }]] = await Promise.all([q, db('nivaro_files').count('id as count')])
  return { data: files, total: Number(count) }
}

export async function updateFileMeta(
  id: string,
  patch: {
    title?: string | null
    description?: string | null
    folder?: string | null
    expires_at?: Date | null
  },
  userId?: string
): Promise<StoredFile | undefined> {
  const allowed: Record<string, unknown> = {}
  if ('title' in patch) allowed.title = patch.title
  if ('description' in patch) allowed.description = patch.description
  if ('folder' in patch) allowed.folder = patch.folder
  if ('expires_at' in patch) allowed.expires_at = patch.expires_at
  if (Object.keys(allowed).length === 0) return getFile(id)

  allowed.modified_by = userId ?? null
  allowed.modified_on = new Date()
  await db('nivaro_files').where({ id }).update(allowed)
  return getFile(id)
}

/** Delete all cached transform renditions for a file. */
export async function deleteTransforms(fileId: string): Promise<void> {
  const storage = getStorage()
  if (!storage.list) return
  const keys = await storage.list(`transforms/${fileId}/`).catch(() => [] as string[])
  for (const key of keys) {
    await storage.delete(key).catch(() => null)
  }
}

export async function deleteFile(id: string): Promise<void> {
  const file = await getFile(id)
  if (!file) return
  await db('nivaro_files').where({ id }).delete()
  if (file.filename_disk) {
    await getStorage()
      .delete(file.filename_disk)
      .catch(() => null)
  }
  await deleteTransforms(id).catch(() => null)

  // Report to gateway (fire-and-forget)
  await reportFileEvent('deleted', {
    slug: getTenantSlug() ?? null,
    fileKey: file.filename_disk,
  })
}

/** Report a file serve for bandwidth tracking. Called from the files route
 *  after reading the buffer. Fire-and-forget — never throws. */
export async function reportFileBandwidth(file: StoredFile): Promise<void> {
  await reportFileEvent('bandwidth', {
    slug: getTenantSlug() ?? null,
    bytesTransferred: file.filesize ?? 0,
    requestCount: 1,
  })
}

/** Local-disk path of a file (only meaningful for the local provider). */
export function getFilePath(file: CMSFile): string {
  return join(config.STORAGE_LOCAL_ROOT, file.filename_disk ?? '')
}
