import { createReadStream, createWriteStream } from 'node:fs'
import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { FastifyInstance, FastifyReply } from 'fastify'
import {
  hasFfmpeg,
  isLockedMime,
  probeStreamsLocal,
  probeVideoLocal,
  remuxToFileLocal
} from '../services/ffmpeg.js'
import { convertMusicFile } from '../services/help-video-music.js'
import type { UploadContainer } from '../services/help-video-upload-media.js'
import { convertUploadedFile } from '../services/help-video-uploads.js'
import {
  type HandoffRedis,
  handoffBacklog,
  judgeMediaWorker,
  readMediaWorker
} from '../services/media-handoff.js'
import { hasLocalChromium, htmlToPdfLocal, htmlToPngLocal } from '../services/pdf-layout.js'
import { pdfPageImagesLocal } from '../services/pdf-pages.js'
import { registerReadinessCheck } from '../services/readiness.js'
import {
  bearerMatches,
  byteCap,
  encodeMeta,
  imageVariant,
  judgeRenderSetup,
  probeRenderPeer,
  RENDER_FILE_MAX_BYTES,
  RENDER_META_HEADER,
  RENDER_MUSIC_MAX_BYTES,
  RENDER_PDF_MAX_BYTES,
  RENDER_PDF_PAGES_MAX_BYTES,
  RENDER_TOKEN_MIN_LENGTH,
  type RenderFileOp,
  renderPeerToken
} from '../services/render-peer.js'
import { NIVARO_VERSION } from '../version.js'

/**
 * Render peer routes (#2789) — what a process WITH Chromium and ffmpeg (the
 * full image) offers a slim process whose RENDER_URL points here.
 *
 *   GET  /api/internal/render/health        → { ok, chromium, ffmpeg, version }
 *   POST /api/internal/render/pdf           → application/pdf ({ html, format, landscape, margin })
 *   POST /api/internal/render/png           → image/png ({ html, width, max_height, scale }) — #3216
 *   POST /api/internal/render/pdf-pages     → { pages: [base64 JPEG], total } (body: the PDF;
 *                                              ?max_pages=&width=) — #3186 paper forms
 *   POST /api/internal/render/file/:op      → JSON (probe-*) or the output file
 *                                              (remux, convert-upload, convert-music)
 *   GET  /api/internal/render/encoders      → { hardware } (help-video encoder report)
 *
 * Mounted ONLY when RENDER_TOKEN (at least 32 characters) is set on this
 * process (RENDER_TOKEN_FILE works), and in cloud mode only with
 * RENDER_PEER_CLOUD=on as well: never reachable without the token. Every
 * request needs `Authorization: Bearer <RENDER_TOKEN>` (timing-safe; 401
 * otherwise, 429 after 20 failures a minute from one address, with a warn
 * line). The operations are a fixed list running our own fixed ffmpeg
 * arguments — nothing a caller sends ever reaches an argument list but the
 * input file itself, and only with a mime whose demuxer is pinned. PDFs load
 * nothing but inline data, the caller's own origins and public URLs
 * (pdf-layout's pdfRequestAllowed). Work runs in a few slots
 * (RENDER_PEER_PDF_CONCURRENCY / RENDER_PEER_FILE_CONCURRENCY, default 2
 * each) under a scratch budget (RENDER_PEER_SCRATCH_MB, default 6144): past
 * them, 503 RENDER_BUSY. Kept out of the API log, the Traffic Map, the rate
 * limit, the DB-outage 503 and the maintenance freeze; never in the public
 * docs or OpenAPI. Inputs land in a fresh 0700 directory under TMPDIR, deleted
 * when the answer has gone out — the only isolation between callers: the
 * peer is tenant-agnostic.
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

function envInt(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name])
  return Number.isFinite(n) && n >= min ? Math.min(max, Math.floor(n)) : fallback
}

/**
 * A few slots with a short queue. A render server is one process doing heavy
 * work for several web tasks: past its slots callers wait (up to `maxWaitMs`,
 * at most `maxQueue` of them), then get 503 RENDER_BUSY instead of an
 * unbounded pile of browsers or encoders.
 */
export function slots(size: number, maxQueue = 16, maxWaitMs = 60_000) {
  let busy = 0
  const queue: Array<() => void> = []
  const release = () => {
    const next = queue.shift()
    if (next) next()
    else busy = Math.max(0, busy - 1)
  }
  return {
    get busy() {
      return busy
    },
    get waiting() {
      return queue.length
    },
    /** Resolves to a release function, or null when it gave up. */
    async acquire(): Promise<(() => void) | null> {
      if (busy < size) {
        busy++
      } else {
        if (queue.length >= maxQueue) return null
        const got = await new Promise<boolean>((resolve) => {
          const go = () => {
            clearTimeout(timer)
            resolve(true)
          }
          const timer = setTimeout(() => {
            const i = queue.indexOf(go)
            if (i >= 0) queue.splice(i, 1)
            resolve(false)
          }, maxWaitMs)
          queue.push(go)
        })
        if (!got) return null
      }
      let done = false
      return () => {
        if (done) return
        done = true
        release()
      }
    }
  }
}

/** Failed bearer checks per caller address, per minute: past the limit the
 *  address gets 429 for the rest of the minute, and a warn line (the address,
 *  never what it sent). The path is out of the global rate limit and the API
 *  log, so this is where guessing is stopped and seen. */
export function failedAuthLimiter(limit = 20, windowMs = 60_000) {
  const seen = new Map<string, { start: number; n: number }>()
  return {
    blocked(ip: string, now = Date.now()): boolean {
      const e = seen.get(ip)
      return !!e && now - e.start < windowMs && e.n >= limit
    },
    /** Counts one failure; true when it is the first of this window (log it). */
    fail(ip: string, now = Date.now()): boolean {
      if (seen.size > 5000) seen.clear()
      const e = seen.get(ip)
      if (!e || now - e.start >= windowMs) {
        seen.set(ip, { start: now, n: 1 })
        return true
      }
      e.n++
      return e.n === limit
    }
  }
}

function busy(reply: FastifyReply) {
  return refuse(reply, 503, 'RENDER_BUSY', 'The render server is busy. Try again in a moment.')
}

/** Origins the slim caller serves (its PUBLIC_URL / ADMIN_URL), validated. */
function callerOrigins(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const v of raw.slice(0, 8)) {
    if (typeof v !== 'string' || v.length > 300) continue
    try {
      const u = new URL(v)
      if ((u.protocol === 'http:' || u.protocol === 'https:') && u.origin === v) out.push(v)
    } catch {
      /* skip */
    }
  }
  return out
}

let readinessRegistered = false
const READY: Record<'ok' | 'warn' | 'fail', 'pass' | 'warn' | 'fail'> = {
  ok: 'pass',
  warn: 'warn',
  fail: 'fail'
}
/** The client side: does this process's render peer answer, and is there a
 *  media worker for what it hands off? (Also in /api/preflight.) A slim
 *  process without either FAILS: a deploy gate stops it before people meet
 *  503s. */
export function registerRenderPeerReadiness(): void {
  if (readinessRegistered) return
  readinessRegistered = true
  registerReadinessCheck({
    id: 'render-peer',
    label: 'PDFs and video conversion have somewhere to run',
    group: 'Operations',
    description:
      'A slim image (no Chromium, no ffmpeg) hands PDFs, video probes and conversions to the render server named in RENDER_URL. Passes when this process has the binaries itself, or when the render server answers with its token and has them; fails on the slim image otherwise.',
    run: async () => {
      const local = { chromium: await hasLocalChromium(), ffmpeg: await hasFfmpeg() }
      const v = judgeRenderSetup(local, await probeRenderPeer(), imageVariant())
      return { status: READY[v.status], detail: v.summary }
    }
  })
  registerReadinessCheck({
    id: 'media-worker',
    label: 'Clips, captions, thumbnails and replay videos have a worker',
    group: 'Operations',
    description:
      'A process without ffmpeg or Chromium (the slim image) hands clips, generated captions, upload thumbnails and waveforms, and session-replay videos to the media worker: a full-image process that ticks crons (or sets MEDIA_WORKER=on) and checks in every 30 seconds. Fails on the slim image when none has checked in.',
    run: async () => {
      const { getApp } = await import('../services/io-holder.js')
      const r = (getApp()?.redis as HandoffRedis | undefined) ?? null
      const v = judgeMediaWorker(
        { ffmpeg: await hasFfmpeg(), chromium: await hasLocalChromium() },
        {
          variant: imageVariant(),
          cloud: !!process.env.CLOUD_META_DB_URL,
          redis: !!r,
          worker: await readMediaWorker(r),
          backlog: await handoffBacklog(r).catch(() => null)
        }
      )
      return { status: READY[v.status], detail: v.summary }
    }
  })
}

export async function internalRenderRoutes(app: FastifyInstance) {
  registerRenderPeerReadiness()
  const token = renderPeerToken()
  if (!token) return
  if (token.length < RENDER_TOKEN_MIN_LENGTH) {
    app.log.warn(
      `RENDER_TOKEN is shorter than ${RENDER_TOKEN_MIN_LENGTH} characters: render routes not mounted (use e.g. openssl rand -hex 32)`
    )
    return
  }
  if (process.env.CLOUD_META_DB_URL && process.env.RENDER_PEER_CLOUD !== 'on') {
    app.log.warn(
      'RENDER_TOKEN is set in cloud mode without RENDER_PEER_CLOUD=on: render routes not mounted'
    )
    return
  }

  const pdfSlots = slots(envInt('RENDER_PEER_PDF_CONCURRENCY', 2, 1, 16))
  const fileSlots = slots(envInt('RENDER_PEER_FILE_CONCURRENCY', 2, 1, 8))
  const scratchBudget = envInt('RENDER_PEER_SCRATCH_MB', 6144, 64, 1_048_576) * 1024 * 1024
  let scratchInUse = 0
  const authFails = failedAuthLimiter()

  // A raw stream: the file goes straight to disk through byteCap.
  app.addContentTypeParser('application/octet-stream', (_req, payload, done) => done(null, payload))
  // A PDF whose pages to draw (#3186): small enough to hold in memory.
  app.addContentTypeParser(
    'application/pdf',
    { parseAs: 'buffer', bodyLimit: RENDER_PDF_PAGES_MAX_BYTES },
    (_req, body, done) => done(null, body)
  )
  app.addHook('onRequest', async (req, reply) => {
    if (authFails.blocked(req.ip)) return refuse(reply, 429, 'RENDER_TOKEN', 'Too many attempts')
    if (!bearerMatches(req.headers.authorization, token)) {
      if (authFails.fail(req.ip))
        app.log.warn(
          { ip: req.ip, url: req.url.split('?')[0] },
          'render peer: wrong or missing RENDER_TOKEN'
        )
      return refuse(reply, 401, 'RENDER_TOKEN', 'Unauthorized')
    }
  })

  app.get('/internal/render/health', async (_req, reply) => {
    return reply.send({
      ok: true,
      chromium: await hasLocalChromium(),
      ffmpeg: await hasFfmpeg(),
      version: NIVARO_VERSION,
      busy: {
        pdf: pdfSlots.busy,
        files: fileSlots.busy,
        scratch_mb: Math.round(scratchInUse / 1048576)
      }
    })
  })

  // What the help-video encoder can use here (#1561): a slim process's
  // settings page shows the render server's hardware, where renders run.
  app.get<{ Querystring: { fresh?: string } }>('/internal/render/encoders', async (req, reply) => {
    if (!(await hasFfmpeg()))
      return refuse(reply, 503, 'RENDER_UNAVAILABLE', 'This render server has no ffmpeg')
    const release = await fileSlots.acquire()
    if (!release) return busy(reply)
    try {
      const { detectHardwareEncoders } = await import('../services/help-video-encoder.js')
      return reply.send({ hardware: await detectHardwareEncoders(req.query.fresh === '1') })
    } finally {
      release()
    }
  })

  app.post<{
    Body: {
      html?: unknown
      format?: unknown
      landscape?: unknown
      margin?: unknown
      allow_origins?: unknown
    }
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
      const release = await pdfSlots.acquire()
      if (!release) return busy(reply)
      try {
        const pdf = await htmlToPdfLocal(b.html, {
          format: b.format === 'Letter' ? 'Letter' : 'A4',
          landscape: b.landscape === true,
          margin,
          allowOrigins: callerOrigins(b.allow_origins)
        })
        return reply.header('content-type', 'application/pdf').send(pdf)
      } finally {
        release()
      }
    }
  )

  // A page as a PNG (#3216 form images). Shares the PDF slots: one Chromium.
  app.post<{
    Body: {
      html?: unknown
      width?: unknown
      max_height?: unknown
      scale?: unknown
      allow_origins?: unknown
    }
  }>(
    '/internal/render/png',
    { bodyLimit: RENDER_PDF_MAX_BYTES + 64 * 1024, compress: false },
    async (req, reply) => {
      if (!(await hasLocalChromium()))
        return refuse(reply, 503, 'RENDER_UNAVAILABLE', 'This render server has no Chromium')
      const b = req.body ?? {}
      if (typeof b.html !== 'string' || !b.html)
        return refuse(reply, 400, 'RENDER_BAD_REQUEST', 'html is required')
      const release = await pdfSlots.acquire()
      if (!release) return busy(reply)
      try {
        const png = await htmlToPngLocal(b.html, {
          width: Number(b.width) || undefined,
          maxHeight: Number(b.max_height) || undefined,
          scale: Number(b.scale) || undefined,
          allowOrigins: callerOrigins(b.allow_origins)
        })
        return reply.header('content-type', 'image/png').send(png)
      } finally {
        release()
      }
    }
  )

  // #3186: a PDF's first pages as JPEGs (pdf.js in Chromium, nothing loaded from the network).
  app.post<{ Querystring: { max_pages?: string; width?: string } }>(
    '/internal/render/pdf-pages',
    { bodyLimit: RENDER_PDF_PAGES_MAX_BYTES, compress: false },
    async (req, reply) => {
      if (!(await hasLocalChromium()))
        return refuse(reply, 503, 'RENDER_UNAVAILABLE', 'This render server has no Chromium')
      const pdf = req.body
      if (!Buffer.isBuffer(pdf) || pdf.subarray(0, 5).toString('latin1') !== '%PDF-')
        return refuse(reply, 400, 'RENDER_BAD_REQUEST', 'The body must be a PDF')
      const release = await pdfSlots.acquire()
      if (!release) return busy(reply)
      try {
        const out = await pdfPageImagesLocal(pdf, {
          maxPages: Number(req.query.max_pages),
          width: Number(req.query.width)
        })
        return reply.send({ pages: out.pages.map((p) => p.toString('base64')), total: out.total })
      } catch {
        return refuse(reply, 422, 'RENDER_PDF_UNREADABLE', 'The PDF could not be drawn')
      } finally {
        release()
      }
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
      const mime = String(req.query.mime ?? '').slice(0, 100)
      // Every op pins the demuxer by mime: an unknown one would let ffmpeg
      // guess, and an ffconcat script or playlist could read local files.
      if (!isLockedMime(mime))
        return refuse(
          reply,
          400,
          'RENDER_BAD_REQUEST',
          'mime must be a supported audio or video type'
        )
      if (op === 'convert-upload' && !UPLOAD_MIMES.includes(mime as UploadContainer))
        return refuse(reply, 400, 'RENDER_BAD_REQUEST', 'mime must be video/mp4 or video/webm')
      if (scratchInUse >= scratchBudget) return busy(reply)
      const release = await fileSlots.acquire()
      if (!release) return busy(reply)

      const dir = await mkdtemp(join(tmpdir(), 'nivaro-render-'))
      let reserved = 0
      const reserve = (n: number) => {
        reserved += n
        scratchInUse += n
      }
      // The answer went out, or the caller hung up (timeout, cancel): stop
      // the work, drop the files, give back the slot and the scratch bytes.
      const ctl = new AbortController()
      reply.raw.on('close', () => {
        if (!reply.raw.writableFinished) ctl.abort()
        scratchInUse = Math.max(0, scratchInUse - reserved)
        reserved = 0
        release()
        void rm(dir, { recursive: true, force: true }).catch(() => undefined)
      })
      const input = join(dir, 'in.bin')
      try {
        await pipeline(
          req.body as Readable,
          byteCap(op === 'convert-music' ? RENDER_MUSIC_MAX_BYTES : RENDER_FILE_MAX_BYTES, (n) => {
            reserve(n)
            return scratchInUse > scratchBudget
              ? Object.assign(new Error('scratch budget'), { code: 'RENDER_BUSY' })
              : undefined
          }),
          createWriteStream(input)
        )
      } catch (err) {
        const code = (err as { code?: string }).code
        if (code === 'RENDER_BUSY') return busy(reply)
        if (code === 'RENDER_TOO_LARGE')
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
        if (op === 'probe-streams') return reply.send(await probeStreamsLocal(input, mime))
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
          meta = await convertMusicFile(input, mime, out)
        }
        reserve(
          await stat(out)
            .then((s) => s.size)
            .catch(() => 0)
        )
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
