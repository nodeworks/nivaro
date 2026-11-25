import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'
import { db } from '../../db/index.js'
import { appMap } from '../app-state.js'
import { tenantSource } from '../deployment-mode.js'
import { hubLinkKeyTag } from '../hub-link/retire.js'
import { getApp } from '../io-holder.js'
import { getStorage } from '../storage/index.js'
import { getActiveStorageDriver } from '../storage-drivers.js'
import { appKeyPart } from '../tenancy/credential-binding.js'
import { type S3Creds, type S3Target, s3Request, s3TargetAllowed } from './s3-target.js'

/**
 * Hub data care, APP side: a files backup. The Hub asks (hub link / deployment link,
 * routes/hub-link-data.ts) and this app copies every stored file it has — env-local uploads
 * (`nivaro_files.storage = 'local'`) and its saved-settings S3 / Azure objects — into a backup
 * set on a target, under the same keys, with a `manifest.json` of what was copied:
 *
 *   dir  <path>/<set>/<key>     only under a folder this app's HUB_FILES_BACKUP_DIRS allows
 *                               (comma list of absolute folders): the Hub never makes an app
 *                               write anywhere its own operator did not allow
 *   s3   <prefix>/<set>/<key>   in a bucket this app's HUB_FILES_BACKUP_S3 lists (s3-target.ts:
 *                               endpoint + bucket + prefix allow-list, every request through
 *                               safeFetch, redirects refused), with the key pair the Hub sends
 *
 * One backup per app at a time (FILES_BACKUP_RUNNING). The status lives in this process and is
 * mirrored to Redis (per app, per hub link) so another replica can answer the Hub. A file over
 * MAX_OBJECT_BYTES is counted `too_large`, not copied (objects are read whole). The key pair is
 * held only in the run's closure: never in the status, a Redis value, a log line or an error.
 */

export const MAX_OBJECT_BYTES = 1024 * 1024 * 1024
const RUN_TTL_MS = 24 * 60 * 60_000
const LOCK_TTL_MS = 60_000
const SET_RE = /^[a-z0-9][a-z0-9-]{0,99}$/
const RUN_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

export type FilesTargetIn =
  | { kind: 'dir'; path: string }
  | { kind: 's3'; bucket: string; prefix: string; region: string | null; endpoint: string | null }

export interface FilesBackupStatus {
  state: 'running' | 'done' | 'failed'
  total: number
  copied: number
  failed: number
  too_large: number
  bytes: number
  error: string | null
}

export class FilesBackupError extends Error {
  code: string
  statusCode: number
  constructor(code: string, message: string, statusCode = 400) {
    super(message)
    this.name = 'FilesBackupError'
    this.code = code
    this.statusCode = statusCode
  }
}

export interface Writer {
  put(key: string, buf: Buffer): Promise<void>
  read(key: string): Promise<Buffer | null>
  remove(key: string): Promise<void>
  removeSet(): Promise<void>
}

/** The folders this app lets a files backup write into (HUB_FILES_BACKUP_DIRS). */
export function allowedBackupDirs(env: NodeJS.ProcessEnv = process.env): string[] {
  return String(env.HUB_FILES_BACKUP_DIRS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s && isAbsolute(s))
    .map((s) => resolve(s))
}

const under = (root: string, p: string) => {
  const rel = relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

export function dirAllowed(path: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isAbsolute(path)) return false
  const p = resolve(path)
  return allowedBackupDirs(env).some((root) => under(root, p))
}

function dirWriter(path: string, set: string): Writer {
  const root = resolve(path, set)
  const full = (key: string) => {
    const f = resolve(root, key)
    if (!under(root, f) || f === root) throw new FilesBackupError('BAD_KEY', 'Bad storage key')
    return f
  }
  return {
    async put(key, buf) {
      const f = full(key)
      await mkdir(dirname(f), { recursive: true })
      await writeFile(f, buf)
    },
    async read(key) {
      try {
        return await readFile(full(key))
      } catch {
        return null
      }
    },
    async remove(key) {
      await rm(full(key), { force: true })
    },
    async removeSet() {
      if (root.split(sep).pop() !== set) return
      await rm(root, { recursive: true, force: true })
    }
  }
}

function s3Writer(t: S3Target, set: string, creds: S3Creds): Writer {
  const base = `${t.prefix ? `${t.prefix}/` : ''}${set}/`
  const ok = async (res: Response, what: string) => {
    if (res.ok) return res
    await res.body?.cancel().catch(() => undefined)
    throw new Error(`S3 ${what} failed: ${res.status}`)
  }
  return {
    async put(key, buf) {
      await ok(await s3Request(t, creds, 'PUT', `${base}${key}`, buf), 'PUT')
    },
    async read(key) {
      try {
        const res = await ok(await s3Request(t, creds, 'GET', `${base}${key}`), 'GET')
        return Buffer.from(await res.arrayBuffer())
      } catch {
        return null
      }
    },
    async remove(key) {
      const res = await s3Request(t, creds, 'DELETE', `${base}${key}`)
      await res.body?.cancel().catch(() => undefined)
    },
    async removeSet() {
      /* objects are removed one by one from the manifest */
    }
  }
}

export interface BackupRequest {
  set: string
  target: FilesTargetIn
  credentials?: { access_key_id: string; secret_access_key: string }
}

/** Checks a request body; answers the writer for it. */
export function writerFor(
  body: unknown,
  env: NodeJS.ProcessEnv = process.env
): {
  req: BackupRequest
  writer: Writer
} {
  const b = (body ?? {}) as Record<string, unknown>
  if (typeof b.set !== 'string' || !SET_RE.test(b.set))
    throw new FilesBackupError('BAD_SET', 'set must be lowercase letters, digits and dashes')
  const t = (b.target ?? {}) as Record<string, unknown>
  if (t.kind === 'dir') {
    if (typeof t.path !== 'string' || !dirAllowed(t.path, env))
      throw new FilesBackupError(
        'DIR_NOT_ALLOWED',
        'This app does not allow files backups into that folder (HUB_FILES_BACKUP_DIRS)',
        403
      )
    const target = { kind: 'dir' as const, path: t.path }
    return { req: { set: b.set, target }, writer: dirWriter(t.path, b.set) }
  }
  if (t.kind === 's3') {
    const c = (b.credentials ?? {}) as Record<string, unknown>
    if (
      typeof t.bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(t.bucket) ||
      typeof c.access_key_id !== 'string' ||
      typeof c.secret_access_key !== 'string'
    )
      throw new FilesBackupError('BAD_TARGET', 'An S3 target needs a bucket and a key pair')
    const rawPrefix = t.prefix === undefined || t.prefix === null ? '' : t.prefix
    if (
      typeof rawPrefix !== 'string' ||
      !/^[A-Za-z0-9._/-]{0,200}$/.test(rawPrefix) ||
      rawPrefix.includes('..')
    )
      throw new FilesBackupError('BAD_TARGET', 'The S3 prefix may hold letters, digits and . _ / -')
    const prefix = rawPrefix.replace(/^\/+|\/+$/g, '')
    let endpoint: string | null = null
    if (typeof t.endpoint === 'string' && t.endpoint) {
      try {
        const u = new URL(t.endpoint)
        if (u.protocol !== 'https:' || u.username || u.password) throw new Error('http')
        endpoint = u.origin
      } catch {
        throw new FilesBackupError('BAD_TARGET', 'The S3 endpoint must be an https address')
      }
    }
    const target = {
      kind: 's3' as const,
      bucket: t.bucket,
      prefix,
      region: typeof t.region === 'string' && /^[a-z0-9-]{1,40}$/.test(t.region) ? t.region : null,
      endpoint
    }
    // The app's own operator decides where its files may go (HUB_FILES_BACKUP_S3), before any
    // request leaves: the Hub alone can never send them to an endpoint of its choosing.
    if (!s3TargetAllowed(target, env))
      throw new FilesBackupError(
        'S3_NOT_ALLOWED',
        'This app does not allow files backups into that bucket (HUB_FILES_BACKUP_S3)',
        403
      )
    const creds = { access_key_id: c.access_key_id, secret_access_key: c.secret_access_key }
    return {
      req: { set: b.set, target, credentials: creds },
      writer: s3Writer(target, b.set, creds)
    }
  }
  throw new FilesBackupError('BAD_TARGET', 'target.kind must be dir or s3')
}

// ─── run state ───────────────────────────────────────────────────────────────────────────────

export interface Run {
  id: string
  status: FilesBackupStatus
}

const runs = appMap<string, Run>()

interface MirrorRedis {
  get(key: string): Promise<string | null>
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>
  del(...keys: string[]): Promise<unknown>
}

export const filesBackupDeps = {
  redis(): MirrorRedis | null {
    try {
      return (getApp()?.redis as MirrorRedis | undefined) ?? null
    } catch {
      return null
    }
  },
  async listRows(after: string | null, limit: number) {
    let q = db('nivaro_files')
      .select('id', 'filename_disk', 'storage', 'filesize')
      .whereIn('storage', ['local', 's3', 'azure-blob'])
      .whereNotNull('filename_disk')
      .orderBy('id', 'asc')
      .limit(limit)
    if (after !== null) q = q.where('id', '>', after)
    return (await q) as Array<{
      id: string
      filename_disk: string
      storage: string | null
      filesize: number | string | null
    }>
  },
  async read(storage: string | null, key: string): Promise<Buffer> {
    if (!storage || storage === 'local') return getStorage().get(key)
    return (await getActiveStorageDriver()).get(key)
  },
  concurrency: 3,
  pageSize: 500
}

/** Per app on a shared deployment, per hub link on a dedicated one. */
function linkPart(): string {
  return tenantSource() === 'hub' ? '' : `link:${hubLinkKeyTag()}:`
}
const runKey = (id: string) => `nvr:hub-data:files:${appKeyPart()}${linkPart()}${id}`
const lockKey = () => `nvr:hub-data:files-lock:${appKeyPart()}${linkPart()}`

async function mirror(r: Run): Promise<void> {
  const redis = filesBackupDeps.redis()
  if (!redis) return
  try {
    await redis.set(runKey(r.id), JSON.stringify(r.status), 'PX', RUN_TTL_MS)
  } catch {
    /* best effort: this process still answers */
  }
}

export async function readFilesBackup(runId: string): Promise<FilesBackupStatus | null> {
  if (!RUN_ID_RE.test(runId)) return null
  const local = runs.get(runId)
  if (local) return { ...local.status }
  const redis = filesBackupDeps.redis()
  if (!redis) return null
  try {
    const raw = await redis.get(runKey(runId))
    return raw ? (JSON.parse(raw) as FilesBackupStatus) : null
  } catch {
    return null
  }
}

/** Starts the copy (answers at once); the Hub polls readFilesBackup. */
export async function startFilesBackup(body: unknown): Promise<{ run_id: string }> {
  const { writer } = writerFor(body)
  const redis = filesBackupDeps.redis()
  const id = randomUUID()
  if (redis) {
    let ok: unknown
    try {
      ok = await redis.set(lockKey(), id, 'PX', LOCK_TTL_MS, 'NX')
    } catch {
      throw new FilesBackupError(
        'REDIS_UNAVAILABLE',
        'The backup could not be started (Redis)',
        503
      )
    }
    if (ok !== 'OK')
      throw new FilesBackupError('FILES_BACKUP_RUNNING', 'A files backup is already running', 409)
  } else if ([...runs.values()].some((r) => r.status.state === 'running')) {
    throw new FilesBackupError('FILES_BACKUP_RUNNING', 'A files backup is already running', 409)
  }
  const run: Run = {
    id,
    status: {
      state: 'running',
      total: 0,
      copied: 0,
      failed: 0,
      too_large: 0,
      bytes: 0,
      error: null
    }
  }
  runs.set(id, run)
  void copyAll(run, writer).finally(async () => {
    await mirror(run)
    if (redis) {
      try {
        if ((await redis.get(lockKey())) === id) await redis.del(lockKey())
      } catch {
        /* expires on its own */
      }
    }
  })
  await mirror(run)
  return { run_id: id }
}

/** The copy itself (exported for tests). */
export async function copyAll(run: Run, writer: Writer): Promise<void> {
  const st = run.status
  const manifest: Array<{ id: string; key: string; size: number }> = []
  const redis = filesBackupDeps.redis()
  let lastMirror = 0
  try {
    let after: string | null = null
    for (;;) {
      const rows = await filesBackupDeps.listRows(after, filesBackupDeps.pageSize)
      if (!rows.length) break
      after = String(rows[rows.length - 1].id)
      st.total += rows.length
      let i = 0
      const worker = async () => {
        while (i < rows.length) {
          const r = rows[i++]
          const size = r.filesize == null ? null : Number(r.filesize)
          if (size !== null && size > MAX_OBJECT_BYTES) {
            st.too_large++
            continue
          }
          try {
            const buf = await filesBackupDeps.read(r.storage, r.filename_disk)
            if (buf.length > MAX_OBJECT_BYTES) {
              st.too_large++
              continue
            }
            await writer.put(r.filename_disk, buf)
            manifest.push({ id: String(r.id), key: r.filename_disk, size: buf.length })
            st.copied++
            st.bytes += buf.length
          } catch {
            st.failed++
          }
        }
      }
      await Promise.all(Array.from({ length: filesBackupDeps.concurrency }, worker))
      if (redis && Date.now() - lastMirror > 2_000) {
        lastMirror = Date.now()
        await mirror(run)
        try {
          await redis.set(lockKey(), run.id, 'PX', LOCK_TTL_MS)
        } catch {
          /* the next page tries again */
        }
      }
    }
    await writer.put(
      'manifest.json',
      Buffer.from(JSON.stringify({ format: 1, at: new Date().toISOString(), files: manifest }))
    )
    st.state = 'done'
  } catch {
    st.state = 'failed'
    st.error = 'The list of stored files could not be read, or the manifest could not be written.'
  }
}

/** Deletes one earlier backup set (its manifest names every object). */
export async function deleteFilesBackupSet(body: unknown): Promise<{ deleted: number }> {
  const { writer } = writerFor(body)
  const raw = await writer.read('manifest.json')
  let n = 0
  if (raw) {
    try {
      const m = JSON.parse(raw.toString('utf8')) as { files?: Array<{ key?: unknown }> }
      for (const f of m.files ?? []) {
        if (typeof f.key !== 'string') continue
        await writer.remove(f.key).catch(() => undefined)
        n++
      }
    } catch {
      /* a damaged manifest: the folder goes below, objects stay in a bucket */
    }
    await writer.remove('manifest.json').catch(() => undefined)
  }
  await writer.removeSet()
  return { deleted: n }
}

/** Test seam. */
export function _resetFilesBackupForTests(): void {
  runs.clear()
}
