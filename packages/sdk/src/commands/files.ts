/**
 * File manager commands: listing, metadata, presigned uploads, updates,
 * deletion, and URL builders for raw/download/transform endpoints.
 *
 * Multipart uploads go through `client.upload(file)` (FormData needs the
 * client's fetch wiring); everything else is a plain command.
 */
import { type Command, cmd } from '../command.js'
import type { ISODate, UUID } from '../index.js'

export interface FileRecord {
  id: string
  filename_disk: string
  filename_download: string
  title: string | null
  type: string
  filesize: number
  width: number | null
  height: number | null
  folder: string | null
  uploaded_by: UUID | null
  uploaded_on: ISODate
  expires_at?: ISODate | null
}

export function listFiles(
  options: { folder?: string; search?: string; limit?: number; page?: number } = {}
): Command<{ data: FileRecord[] }> {
  return cmd('GET', '/files', options)
}

export function readFileMeta(id: string): Command<{ data: FileRecord }> {
  return cmd('GET', `/files/${id}/meta`)
}

/** Create a file record + presigned upload URL (S3-style storage; admin).
 *  PUT the bytes to `upload_url` yourself, then the file is live. */
export function presignFileUpload(data: {
  filename: string
  type?: string
  folder?: string
}): Command<{ data: FileRecord; upload_url: string }> {
  return cmd('POST', '/files/presign', undefined, data)
}

export function updateFileMeta(
  id: string,
  data: { title?: string | null; folder?: string | null; expires_at?: ISODate | null }
): Command<{ data: FileRecord }> {
  return cmd('PATCH', `/files/${id}`, undefined, data)
}

export function deleteFile(id: string): Command<void> {
  return cmd('DELETE', `/files/${id}`)
}

// ─── Usage tracking ───────────────────────────────────────────────────────────

export interface FileUsageEntry {
  table: string
  column: string
  count: number
}

/** Where is this file referenced? FK-driven scan of every column pointing at nivaro_files. */
export function readFileUsage(id: string): Command<{ data: { usages: FileUsageEntry[]; total: number } }> {
  return cmd('GET', `/files/${id}/usage`)
}

/** Files referenced by nothing — safe-to-delete candidates (admin only). */
export function listOrphanFiles(
  options: { limit?: number; offset?: number } = {}
): Command<{ data: FileRecord[]; total: number }> {
  return cmd('GET', '/files/usage/orphans', {
    ...(options.limit != null ? { limit: String(options.limit) } : {}),
    ...(options.offset != null ? { offset: String(options.offset) } : {})
  })
}

// ─── URL builders (for <img src>, downloads — combine with client.url) ────────

/** Path serving the file bytes; pass download=true for an attachment disposition. */
export function fileDownloadPath(id: string, options: { download?: boolean } = {}): string {
  return `/api/files/${id}${options.download ? '?download=1' : ''}`
}

/** Path serving an on-the-fly image transform (cached server-side). */
export function fileTransformPath(
  id: string,
  options: { width?: number; height?: number; fit?: string; quality?: number } = {}
): string {
  const qs = new URLSearchParams(
    Object.fromEntries(
      Object.entries(options)
        .filter(([, v]) => v != null)
        .map(([k, v]) => [k, String(v)])
    )
  ).toString()
  return `/api/files/${id}/transform${qs ? `?${qs}` : ''}`
}
