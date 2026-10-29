import type { FastifyRequest } from 'fastify'
import mime from 'mime-types'
import { db } from '../db/index.js'
import type { CMSField, CMSRelation } from '../types.js'
import { logActivity } from './activity.js'
import { getFields, getRelations } from './collections.js'
import { recordWriteRefusal } from './edit-lock.js'
import { normalizeStoredType } from './file-serving-safety.js'
import { assertUploadContent, cleanDownloadName, deleteFile, uploadFileBuffer } from './files.js'
import { readOne, updateOne } from './items.js'
import { getAllowedFields } from './permissions.js'
import { isSystemCollection } from './system-collections.js'

/**
 * Attach a file to a record in one JSON request (#3212, the MCP `attach_file` tool): the bytes
 * arrive base64-encoded, become an ordinary upload (the same content checks as POST
 * /files/upload) and are linked through the record's own file field with the items service AS
 * THE CALLER — so the record's read gate, update permission, row filter, User Scopes, field
 * list, edit lock, validation, hooks and history all apply, and the file then reads for whoever
 * can open the record (services/file-access.ts follows the FK). Nothing is stored when the
 * caller may not change that field: the record is judged before the upload, and an upload whose
 * link is refused is removed again.
 *
 * A single-file field that already holds a file is not overwritten unless `replace` is set
 * (the earlier file stays in the record's history). A to-many file field gains the file.
 */

/** Largest decoded file this route takes (the instance's own upload limit may be lower). */
export const ATTACH_MAX_BYTES = 10 * 1024 * 1024
/** The base64 text for ATTACH_MAX_BYTES, plus slack for padding and line breaks. */
export const ATTACH_MAX_BASE64 = Math.ceil(ATTACH_MAX_BYTES / 3) * 4 + 4096

const FILE_INTERFACES = new Set(['file', 'file-image'])
const FILES_INTERFACES = new Set(['files-m2m', 'files'])
const FILES_TABLES = new Set(['nivaro_files', 'directus_files'])

export class AttachError extends Error {
  constructor(
    message: string,
    public statusCode: number,
    public code?: string
  ) {
    super(message)
  }
}

export interface FileFieldInfo {
  field: string
  kind: 'single' | 'many'
}

/** The record's file fields from its fields + relations (pure; same rule the MCP tools use). */
export function fileFieldsOf(
  collection: string,
  fields: Array<Pick<CMSField, 'field' | 'interface'>>,
  relations: Array<Partial<CMSRelation>>
): FileFieldInfo[] {
  const out: FileFieldInfo[] = []
  for (const f of fields) {
    const name = String(f.field)
    const iface = typeof f.interface === 'string' ? f.interface : ''
    const m2o = relations.find(
      (r) => r.many_collection === collection && r.many_field === name && !r.junction_field
    )
    if (FILE_INTERFACES.has(iface) || FILES_TABLES.has(String(m2o?.one_collection ?? ''))) {
      out.push({ field: name, kind: 'single' })
      continue
    }
    const toMany = relations.find(
      (r) => r.one_collection === collection && r.one_field === name && r.junction_field
    )
    if (!toMany) continue
    const junction = toMany.many_collection
    const leg = String(toMany.junction_field)
    const targetsFiles =
      FILES_INTERFACES.has(iface) ||
      relations.some(
        (r) =>
          r.many_collection === junction &&
          r.many_field === leg &&
          FILES_TABLES.has(String(r.one_collection ?? ''))
      )
    if (targetsFiles) out.push({ field: name, kind: 'many' })
  }
  return out
}

/** Decode strict base64 (optionally a `data:<type>;base64,` URL). Throws AttachError 400. */
export function decodeBase64File(
  raw: unknown,
  maxBytes: number
): { buffer: Buffer; dataUrlType: string | null } {
  if (typeof raw !== 'string' || !raw.trim())
    throw new AttachError('content_base64 is required', 400)
  if (raw.length > ATTACH_MAX_BASE64 + 256)
    throw new AttachError(`The file is larger than ${Math.round(maxBytes / 1048576)} MB`, 413)
  let text = raw.trim()
  let dataUrlType: string | null = null
  const m = text.match(/^data:([\w.+-]+\/[\w.+-]+)?(?:;[\w=.-]+)*;base64,/i)
  if (m) {
    dataUrlType = m[1] ?? null
    text = text.slice(m[0].length)
  }
  text = text.replace(/\s+/g, '')
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 === 1)
    throw new AttachError('content_base64 is not valid base64', 400)
  const buffer = Buffer.from(text, 'base64')
  if (buffer.length === 0) throw new AttachError('The file is empty', 400)
  if (buffer.length > maxBytes)
    throw new AttachError(`The file is larger than ${Math.round(maxBytes / 1048576)} MB`, 413)
  return { buffer, dataUrlType }
}

async function instanceMaxBytes(): Promise<number> {
  try {
    const row = (await db('nivaro_settings').where('id', 1).first('file_max_size_mb')) as
      | { file_max_size_mb?: number | null }
      | undefined
    const mb = Number(row?.file_max_size_mb)
    if (Number.isFinite(mb) && mb > 0) return Math.min(ATTACH_MAX_BYTES, Math.floor(mb * 1048576))
  } catch {
    /* the default below */
  }
  return ATTACH_MAX_BYTES
}

export interface AttachInput {
  collection: unknown
  item: unknown
  field?: unknown
  filename: unknown
  content_base64: unknown
  type?: unknown
  replace?: unknown
}

export interface AttachResult {
  collection: string
  item: string
  field: string
  replaced: string | null
  file: {
    id: string
    filename_download: string
    type: string
    filesize: number
  }
}

const NAME_RE = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/

export async function attachFileToRecord(
  req: FastifyRequest,
  input: AttachInput
): Promise<AttachResult> {
  const user = req.user
  if (!user) throw new AttachError('Sign in first', 401)
  const collection = String(input.collection ?? '')
  const item = String(input.item ?? '').trim()
  if (!NAME_RE.test(collection)) throw new AttachError('collection is not valid', 400)
  if (!item || item.length > 200) throw new AttachError('item is required', 400)
  if (isSystemCollection(collection))
    throw new AttachError('Files attach to business records only', 400)

  const filename = cleanDownloadName(String(input.filename ?? ''))
  if (!filename || filename === 'download')
    throw new AttachError('filename is required (with its extension, e.g. report.pdf)', 400)

  // The record as the caller: one they cannot open is "not found", whatever exists.
  const record = (await readOne(user, collection, item, req.workspaceId ?? undefined).catch(
    (err: { statusCode?: number }) => {
      if (err?.statusCode && err.statusCode < 500) return null
      throw err
    }
  )) as Record<string, unknown> | null
  if (!record) throw new AttachError('Record not found', 404, 'NOT_FOUND')

  // Which field takes the file.
  const [fields, relations] = await Promise.all([getFields(collection), getRelations(collection)])
  const fileFields = fileFieldsOf(collection, fields, relations)
  if (fileFields.length === 0)
    throw new AttachError(`${collection} has no file field to attach to`, 400, 'NO_FILE_FIELD')
  const asked = input.field == null || input.field === '' ? null : String(input.field)
  const target = asked
    ? fileFields.find((f) => f.field === asked)
    : fileFields.length === 1
      ? fileFields[0]
      : undefined
  if (!target)
    throw new AttachError(
      asked
        ? `${asked} is not a file field on ${collection}. File fields: ${fileFields.map((f) => f.field).join(', ')}`
        : `Say which field to attach to: ${fileFields.map((f) => f.field).join(', ')}`,
      400,
      'FIELD_REQUIRED'
    )

  // May the caller change this record and this field — before anything is stored.
  const refusal = await recordWriteRefusal(req, collection, item)
  if (refusal) {
    const body = refusal.body as { error?: string; code?: string }
    throw new AttachError(body.error ?? 'You cannot change this record', refusal.status, body.code)
  }
  const allowed = await getAllowedFields(user, 'update', collection)
  if (allowed && !allowed.includes('*') && !allowed.includes(target.field))
    throw new AttachError(`You cannot change ${target.field} on this record`, 403, 'FORBIDDEN')

  const existing = target.kind === 'single' ? record[target.field] : null
  const existingId =
    existing && typeof existing === 'object'
      ? String((existing as { id?: unknown }).id ?? '')
      : existing
        ? String(existing)
        : ''
  if (target.kind === 'single' && existingId && input.replace !== true)
    throw new AttachError(
      `${target.field} already holds a file. Pass replace: true to put this one in its place (the earlier file stays in the record's history).`,
      409,
      'FIELD_HAS_FILE'
    )

  // The bytes: decoded, size-capped, content-checked like any upload.
  const max = await instanceMaxBytes()
  const { buffer, dataUrlType } = decodeBase64File(input.content_base64, max)
  const claimed = typeof input.type === 'string' && input.type ? input.type : dataUrlType
  const mimeType = normalizeStoredType(claimed, () => mime.lookup(filename))
  try {
    assertUploadContent(buffer, filename, mimeType)
  } catch (err) {
    throw new AttachError((err as Error).message, 400, 'BAD_CONTENT')
  }

  const file = await uploadFileBuffer(user, buffer, filename, mimeType)
  try {
    await updateOne(
      user,
      collection,
      item,
      { [target.field]: target.kind === 'single' ? file.id : [file.id] },
      req,
      req.workspaceId ?? undefined,
      { callerPayload: true }
    )
  } catch (err) {
    // The link was refused: the upload must not stay behind, readable by its uploader only.
    await deleteFile(String(file.id)).catch(() => undefined)
    throw err
  }
  await logActivity({
    action: 'create',
    collection: 'nivaro_files',
    item: String(file.id),
    user: user.id,
    comment: `attached to ${collection}:${item}.${target.field}`,
    req
  })
  return {
    collection,
    item,
    field: target.field,
    replaced: target.kind === 'single' && existingId ? existingId : null,
    file: {
      id: String(file.id),
      filename_download: String(file.filename_download),
      type: String(file.type),
      filesize: Number(file.filesize)
    }
  }
}
