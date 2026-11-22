import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { failedAuthLimiter, windowLimiter } from '../lib/auth-fail-limiter.js'
import { isMultiTenant } from '../services/deployment-mode.js'
import { isHelpVideoFile, isUuid } from '../services/help-video-files.js'
import { registerReadinessCheck } from '../services/readiness.js'
import { bearerMatches } from '../services/render-peer.js'
import {
  FILE_SOURCE_TOKEN_MIN_LENGTH,
  probeFallbackSource
} from '../services/storage/fallback-url.js'
import { peekStoredObject, sendStoredObject } from '../services/stored-object-stream.js'

/**
 * File source — what an environment refreshed FROM this one reads its missing files from
 * (services/storage/fallback-url.ts on the other side, FILES_FALLBACK_URL there).
 *
 *   GET  /api/internal/file-source/:id   the stored object of nivaro_files row :id
 *   HEAD /api/internal/file-source/:id   200 with type + size, or 404
 *
 * Mounted ONLY when FILE_SOURCE_TOKEN (at least 32 characters; FILE_SOURCE_TOKEN_FILE works)
 * is set, never in cloud mode, and never on a process that itself reads from a source
 * (FILES_FALLBACK_URL set): no chains, no loops. Auth is the timing-safe bearer compare and
 * nothing else — no session, API key or OAuth token is ever accepted here. 20 failures a
 * minute from one address = 429; successful reads have their own generous per-address budget
 * (FILE_SOURCE_RATE_PER_MINUTE, default 1200) instead of the anonymous-caller limit.
 *
 * It does NOT judge record access: the calling environment already judged its own reader
 * (services/file-access.ts) before its storage read asked here. It answers only rows of
 * nivaro_files with a stored object, never a help-video file (those are served only through
 * the ticketed help-video routes) and never another source (`remote: false`). Bytes go out
 * through the normal stored-object stream with Range support; read-only.
 */

export function fileSourceToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const t = (env.FILE_SOURCE_TOKEN ?? '').trim()
  return t.length > 0 ? t : null
}

/** Why the route is not mounted, or null when it is. */
export function fileSourceRefusal(env: NodeJS.ProcessEnv = process.env): string | null {
  const token = fileSourceToken(env)
  if (!token) return 'unset'
  if (token.length < FILE_SOURCE_TOKEN_MIN_LENGTH)
    return `FILE_SOURCE_TOKEN is shorter than ${FILE_SOURCE_TOKEN_MIN_LENGTH} characters: file source not mounted (use e.g. openssl rand -hex 32)`
  if (isMultiTenant(env))
    return 'FILE_SOURCE_TOKEN is ignored in cloud mode: file source not mounted'
  if (env.FILES_FALLBACK_URL?.trim())
    return 'FILE_SOURCE_TOKEN is ignored where FILES_FALLBACK_URL is set (an environment that reads from a source is not one): file source not mounted'
  return null
}

function refuse(reply: FastifyReply, status: number, code: string, message: string) {
  return reply
    .code(status)
    .header('Cache-Control', 'no-store')
    .send({ statusCode: status, error: message, message, code })
}

type SourceRow = {
  id: unknown
  filename_disk: string | null
  type: string | null
  filesize: number | string | null
}

async function sourceFile(id: string): Promise<SourceRow | null> {
  if (!isUuid(id)) return null
  const row = (await db('nivaro_files')
    .where('id', id)
    .first('id', 'filename_disk', 'type', 'filesize')) as SourceRow | undefined
  if (!row?.filename_disk) return null
  if (await isHelpVideoFile(String(row.id))) return null
  return row
}

let readinessRegistered = false
function registerFallbackSourceReadiness(): void {
  if (readinessRegistered || !process.env.FILES_FALLBACK_URL?.trim()) return
  if (isMultiTenant()) return
  readinessRegistered = true
  registerReadinessCheck({
    id: 'file-fallback-source',
    label: 'Files missing here can be read from the source environment',
    group: 'Operations',
    description:
      'After an environment refresh the records name files this environment has no copy of; they are read, read-only, from the source API in FILES_FALLBACK_URL with FILES_FALLBACK_TOKEN. Asks the source for a file no row has: passes when it answers 404 with the token and 401 without. Warns when the token is refused, the source is unreachable, or it does not serve files.',
    run: async () => {
      const v = await probeFallbackSource()
      return { status: v.status === 'ok' ? 'pass' : 'warn', detail: v.summary }
    }
  })
}

export async function internalFileSourceRoutes(app: FastifyInstance) {
  // Lower-environment side: the readiness check for the source it reads from.
  registerFallbackSourceReadiness()

  const refusal = fileSourceRefusal()
  if (refusal) {
    // A lower environment may carry the shared secret on purpose (it reads with it): say so
    // quietly; a short token or cloud mode is a mistake worth a warning.
    if (refusal === 'unset') return
    if (process.env.FILES_FALLBACK_URL?.trim()) app.log.info(refusal)
    else app.log.warn(refusal)
    return
  }
  const token = fileSourceToken() as string
  const authFails = failedAuthLimiter()
  const perMinute = Math.max(60, Number(process.env.FILE_SOURCE_RATE_PER_MINUTE) || 1200)
  const served = windowLimiter(perMinute)

  app.addHook('onRequest', async (req, reply) => {
    if (authFails.blocked(req.ip))
      return refuse(reply, 429, 'FILE_SOURCE_TOKEN', 'Too many attempts')
    if (!bearerMatches(req.headers.authorization, token)) {
      if (authFails.fail(req.ip))
        app.log.warn(
          { ip: req.ip, path: req.url.split('?')[0] },
          'file source: wrong or missing FILE_SOURCE_TOKEN'
        )
      return refuse(reply, 401, 'FILE_SOURCE_TOKEN', 'Unauthorized')
    }
    if (!served.take(req.ip)) return refuse(reply, 429, 'FILE_SOURCE_BUSY', 'Too many reads')
  })

  const logRead = (req: FastifyRequest, reply: FastifyReply, id: string) => {
    reply.raw.once('close', () => {
      app.log.info(
        {
          file_source: {
            id,
            status: reply.statusCode,
            bytes: Number(reply.getHeader('content-length')) || 0,
            complete: reply.raw.writableFinished,
            ip: req.ip
          }
        },
        'file source read'
      )
    })
  }

  app.head<{ Params: { id: string } }>('/internal/file-source/:id', async (req, reply) => {
    const file = await sourceFile(req.params.id)
    if (!file?.filename_disk) return refuse(reply, 404, 'NOT_FOUND', 'Not found')
    // The row alone is not the file: a lower environment asks HEAD to decide "File missing",
    // so answer 200 only when this environment's own copy can be read (one byte).
    if (!(await peekStoredObject(file.filename_disk, 1, { remote: false })))
      return refuse(reply, 404, 'NOT_FOUND', 'Stored object not found')
    reply
      .header('Cache-Control', 'no-store')
      .header('Accept-Ranges', 'bytes')
      .header('Content-Type', file.type || 'application/octet-stream')
    const size = Number(file.filesize)
    if (Number.isFinite(size) && size >= 0) reply.header('Content-Length', String(size))
    return reply.code(200).send()
  })

  app.get<{ Params: { id: string } }>(
    '/internal/file-source/:id',
    { compress: false, exposeHeadRoute: false },
    async (req, reply) => {
      const id = req.params.id
      const file = await sourceFile(id)
      if (!file?.filename_disk) return refuse(reply, 404, 'NOT_FOUND', 'Not found')
      logRead(req, reply, String(file.id))
      reply.header('Cache-Control', 'no-store')
      try {
        return await sendStoredObject(reply, file.filename_disk, {
          rangeHeader: req.headers.range,
          contentType: file.type || 'application/octet-stream',
          disposition: 'attachment',
          // Only this environment's own copy: a source never asks another source.
          remote: false
        })
      } catch {
        return refuse(reply, 404, 'NOT_FOUND', 'Stored object not found')
      }
    }
  )
}
