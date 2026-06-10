import { extname, join } from 'node:path'
import type { MultipartFile } from '@fastify/multipart'
import mime from 'mime-types'
import { monotonicFactory } from 'ulid'
import { config } from '../config.js'
import { db } from '../db/index.js'
import type { CMSFile, User } from '../types.js'
import { getStorage, getStorageProviderName } from './storage/index.js'

const ulid = monotonicFactory()

/** CMSFile with the storage/expiry columns added by migration. */
export type StoredFile = CMSFile & {
  expires_at: Date | string | null
  storage_provider: string | null
}

export async function uploadFile(
  user: User,
  multipart: MultipartFile,
  folderId?: string
): Promise<StoredFile> {
  const id = ulid().toLowerCase()
  const originalName = multipart.filename
  const mimeType = multipart.mimetype || mime.lookup(originalName) || 'application/octet-stream'
  const ext =
    extname(originalName) || (mime.extension(mimeType) ? `.${mime.extension(mimeType)}` : '')
  const diskName = `${id}${ext}`

  const buffer = await multipart.toBuffer()
  const provider = getStorageProviderName()
  await getStorage().put(diskName, buffer, String(mimeType))

  const [fileId] = (await db('nivaro_files')
    .insert({
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
    .returning('id')) as unknown as [string]

  return db<StoredFile>('nivaro_files').where({ id: fileId }).first() as Promise<StoredFile>
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

  const id = ulid().toLowerCase()
  const mimeType = opts.type || mime.lookup(opts.filename) || 'application/octet-stream'
  const ext =
    extname(opts.filename) || (mime.extension(mimeType) ? `.${mime.extension(mimeType)}` : '')
  const diskName = `${id}${ext}`
  const provider = getStorageProviderName()

  const uploadUrl = await storage.getUploadUrl(diskName, String(mimeType))

  const [fileId] = (await db('nivaro_files')
    .insert({
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
    .returning('id')) as unknown as [string]

  const file = (await db<StoredFile>('nivaro_files').where({ id: fileId }).first()) as StoredFile
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
}

/** Local-disk path of a file (only meaningful for the local provider). */
export function getFilePath(file: CMSFile): string {
  return join(config.STORAGE_LOCAL_ROOT, file.filename_disk ?? '')
}
