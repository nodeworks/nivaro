import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { type Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  hasFfmpeg,
  probeStreamsLocal,
  probeVideoLocal,
  remuxToFileLocal
} from '../services/ffmpeg.js'
import { convertMusicFile } from '../services/help-video-music.js'
import type { UploadContainer } from '../services/help-video-upload-media.js'
import { convertUploadedFile } from '../services/help-video-uploads.js'
import { hasLocalChromium, htmlToPdfLocal } from '../services/pdf-layout.js'
import { registerReadinessCheck } from '../services/readiness.js'
import {
  bearerMatches,
  encodeMeta,
  probeRenderPeer,
  RENDER_FILE_MAX_BYTES,
  RENDER_META_HEADER,
  RENDER_MUSIC_MAX_BYTES,
  RENDER_PDF_MAX_BYTES,
  type RenderFileOp,
  renderPeerToken,
  renderPeerUrl
} from '../services/render-peer.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Render peer routes (#2789) — what a process WITH Chromium and ffmpeg (the
 * full image) offers a slim process whose RENDER_URL points here.
 *
 *   GET  /api/internal/render/health        → { ok, chromium, ffmpeg, version }
 *   POST /api/internal/render/pdf           → application/pdf ({ html, format, landscape, margin })
 *   POST /api/internal/render/file/:op      → JSON (probe-*) or the output file
 *                                              (remux, convert-upload, convert-music)
 *
 * Mounted ONLY when RENDER_TOKEN is set on this process (RENDER_TOKEN_FILE
 * works), and in cloud mode only with RENDER_PEER_CLOUD=on as well: never
 * reachable without the token. Every request needs `Authorization: Bearer
 * <RENDER_TOKEN>` (timing-safe; 401 otherwise). The operations are a fixed
 * list running our own fixed ffmpeg arguments — nothing a caller sends ever
 * reaches an argument list but the input file itself (with its container
 * pinned by mime, same as locally). Kept out of the API log, the Traffic Map,
 * the rate limit, the DB-outage 503 and the maintenance freeze; never in the
 * public docs or OpenAPI. Inputs land in a fresh directory under TMPDIR and
 * are deleted when the answer has gone out.
 */

const OPS: readonly RenderFileOp[] = [
  'probe-video',
  'probe-streams',
  'remux',
  'convert-upload',
  'convert-music'
]
const UPLOAD_MIMES: readonly UploadContainer[] = ['video/mp4', 'video/webm']

function refuse(reply: FastifyReply, status: number, code: string, message: string) {
  return reply.code(status).send({ statusCode: status, error: message, message, code })
}

/** Counts bytes on the way to disk and stops past the cap (the body is a raw
 *  stream here, so Fastify's bodyLimit cannot). */
function capped(limit: number): Transform {
  let n = 0
  return new Transform({
    transform(chunk: Buffer, _enc, cb) {
      n += chunk.length
      if (n > limit) cb(Object.assign(new Error('too large'), { statusCode: 413 }))
      else cb(null, chunk)
    }
  })
}

let readinessRegistered = false
/** The client side: does this process's render peer answer? (Also in /api/preflight.) */
export function registerRenderPeerReadiness(): void {
  if (readinessRegistered) return
  readinessRegistered = true
  registerReadinessCheck({
    id: 'render-peer',
    label: 'PDFs and video conversion have somewhere to run',
    group: 'Operations',
    description:
      'A slim image (no Chromium, no ffmpeg) hands PDFs, video probes and conversions to the render server named in RENDER_URL. Passes when this process has the binaries itself, or when the render server answers with its token.',
    run: async () => {
      const local = (await hasLocalChromium()) && (await hasFfmpeg())
      if (local && !renderPeerUrl())
        return { status: 'pass', detail: 'Chromium and ffmpeg are installed here.' }
      const h = await probeRenderPeer()
      if (!h.configured)
        return {
          status: 'warn',
          detail:
            'No Chromium or ffmpeg here and no RENDER_URL: PDFs, video uploads and music will refuse with a 503.'
        }
      if (!h.ok) return { status: 'fail', detail: `The render server does not answer: ${h.error}` }
      const lacks = [!h.chromium && 'Chromium', !h.ffmpeg && 'ffmpeg'].filter(Boolean)
      return lacks.length
        ? { status: 'warn', detail: `The render server answers but has no ${lacks.join(' or ')}.` }
        : {
            status: 'pass',
            detail: `The render server answers in ${h.ms} ms (version ${h.version}).`
          }
    }
  })
}

export async function internalRenderRoutes(app: FastifyInstance) {
  registerRenderPeerReadiness()
  const token = renderPeerToken()
  if (!token) return
  if (process.env.CLOUD_META_DB_URL && process.env.RENDER_PEER_CLOUD !== 'on') {
    app.log.warn(
      'RENDER_TOKEN is set in cloud mode without RENDER_PEER_CLOUD=on: render routes not mounted'
    )
    return
  }

  // A raw stream: the file goes straight to disk through `capped`.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
  app.addHook('onRequest', async (req, reply) => {
    if (!bearerMatches(req.headers.authorization, token)) {
      return refuse(reply, 401, 'RENDER_TOKEN', 'Unauthorized')
    }
  })

  app.get('/internal/render/health', async (_req, reply) => {
    return reply.send({
      ok: true,
      chromium: await hasLocalChromium(),
      ffmpeg: await hasFfmpeg(),
      version: NIVARO_VERSION
    })
  })

  app.post<{
    Body: { html?: unknown; format?: unknown; landscape?: unknown; margin?: unknown }
  }>(
    '/internal/render/pdf',
    { bodyLimit: RENDER_PDF_MAX_BYTES + 64 * 1024, compress: false },
    async (req, reply) => {
      if (!(await hasLocalChromium()))
        return refuse(reply, 503, 'RENDER_UNAVAILABLE', 'This render server has no Chromium')
      const b = req.body ?? {}
      if (typeof b.html !== 'string' || !b.html)
        return refuse(reply, 400, 'RENDER_BAD_REQUEST', 'html is required')
      const margin =
        typeof b.margin === 'string' && /^[0-9.]{1,6}(mm|cm|in|px)?$/.test(b.margin)
          ? b.margin
          : undefined
      const pdf = await htmlToPdfLocal(b.html, {
        format: b.format === 'Letter' ? 'Letter' : 'A4',
        landscape: b.landscape === true,
        margin
      })
      return reply.header('content-type', 'application/pdf').send(pdf)
    }
  )

  app.post<{ Params: { op: string }; Querystring: { mime?: string } }>(
    '/internal/render/file/:op',
    { bodyLimit: RENDER_FILE_MAX_BYTES, compress: false },
    async (req, reply) => {
      const op = req.params.op as RenderFileOp
      if (!OPS.includes(op)) return refuse(reply, 404, 'RENDER_OP_UNKNOWN', 'Unknown operation')
      if (!(await hasFfmpeg()))
        return refuse(reply, 503, 'RENDER_UNAVAILABLE', 'This render server has no ffmpeg')
      const mime = String(req.query.mime ?? '').slice(0, 100) || undefined
      if (op === 'convert-upload' && !UPLOAD_MIMES.includes(mime as UploadContainer))
        return refuse(reply, 400, 'RENDER_BAD_REQUEST', 'mime must be video/mp4 or video/webm')
      if (op === 'convert-music' && !mime)
        return refuse(reply, 400, 'RENDER_BAD_REQUEST', 'mime is required')

      const dir = await mkdtemp(join(tmpdir(), 'nivaro-render-'))
      const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => undefined)
      // The caller hung up (timeout, cancel): stop the work, drop the files.
      const ctl = new AbortController()
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) ctl.abort()
        void cleanup()
      })
      const input = join(dir, 'in.bin')
      try {
        await pipeline(
          req.body as Readable,
          capped(op === 'convert-music' ? RENDER_MUSIC_MAX_BYTES : RENDER_FILE_MAX_BYTES),
          createWriteStream(input)
        )
      } catch (err) {
        if ((err as { statusCode?: number }).statusCode === 413)
          return refuse(
            reply,
            413,
            'RENDER_TOO_LARGE',
            'This file is too large for the render server'
          )
        throw err
      }

      try {
        if (op === 'probe-video') return reply.send(await probeVideoLocal(input, mime))
        if (op === 'probe-streams') return reply.send(await probeStreamsLocal(input, mime ?? ''))
        let out = join(dir, 'out.bin')
        let meta: unknown = null
        if (op === 'remux') {
          out = join(dir, `out${mime === 'video/mp4' ? '.mp4' : '.webm'}`)
          await remuxToFileLocal(input, out, mime)
          meta = await probeVideoLocal(out, mime)
        } else if (op === 'convert-upload') {
          meta = await convertUploadedFile(input, mime as UploadContainer, {
            signal: ctl.signal,
            outPath: (ext) => {
              out = join(dir, `out${ext}`)
              return out
            }
          })
        } else {
          out = join(dir, 'out.m4a')
          meta = await convertMusicFile(input, mime as string, out)
        }
        return reply
          .header('content-type', 'application/octet-stream')
          .header(RENDER_META_HEADER, encodeMeta(meta))
          .send(createReadStream(out))
      } catch (err) {
        const e = err as Error & { statusCode?: number; code?: string }
        // A refusal the local code raised (422 + code) goes back as is; an
        // ffmpeg failure without one is the file's problem.
        const status = e.statusCode ?? 422
        return refuse(reply, status, e.code ?? 'RENDER_FFMPEG_FAILED', e.message.slice(0, 300))
      }
    }
  )
}
