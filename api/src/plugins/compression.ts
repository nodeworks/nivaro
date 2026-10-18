import { constants as zlibConstants } from 'node:zlib'
import fastifyCompress from '@fastify/compress'
import type { FastifyInstance } from 'fastify'

/**
 * Response compression (#2437).
 *
 * Brotli first, gzip second, nothing under 1 KB. Brotli runs at quality 4 —
 * the library default (11) takes seconds on a large JSON page and would burn
 * a CPU per request; 4 is close to gzip-6 CPU and noticeably smaller. Static
 * admin assets are NOT compressed here: the build writes .br/.gz next to each
 * file (scripts/precompress-dist.mjs) and @fastify/static serves those
 * (preCompressed).
 *
 * How it hooks in: @fastify/compress adds its onSend to each ROUTE as the route
 * is defined, and Fastify runs route-level onSend hooks after every app-level
 * one. So the hooks that read a string/Buffer payload (api-logger byte counts,
 * idempotency replay storage, scopeRefusalBody, response-conventions) always
 * see the plain body, as long as this plugin is registered BEFORE the routes it
 * should cover (a route defined earlier is simply not compressed).
 *
 * What never compresses:
 *   - a reply that already has a Content-Encoding, a 206, or a Content-Range
 *     (the plugin's own rules);
 *   - binary types: mime-db marks images (except svg), audio, video, zip, gzip,
 *     tar and pdf not compressible; the plugin DOES treat octet-stream as
 *     compressible, so the guard below skips it explicitly;
 *   - anything the guard below flags: Accept-Ranges (ranged file/media
 *     streams — compressing would break byte offsets), text/event-stream (SSE
 *     must flush per event), and a request that sent x-no-compression;
 *   - routes that set the route option `compress: false` (file/media/backup/
 *     heap-snapshot/tar downloads).
 * SSE routes that hijack the reply never reach onSend at all.
 */
export const COMPRESSION_THRESHOLD = 1024

export function shouldSkipCompression(headers: {
  contentType?: unknown
  acceptRanges?: unknown
  contentRange?: unknown
}): boolean {
  if (headers.acceptRanges !== undefined && headers.acceptRanges !== 'none') return true
  if (headers.contentRange !== undefined) return true
  const type = String(headers.contentType ?? '').toLowerCase()
  return type.startsWith('text/event-stream') || type.startsWith('application/octet-stream')
}

export async function registerCompression(app: FastifyInstance) {
  // Runs ahead of the route-level compress hook (app-level hooks go first).
  // The plugin honours an `x-no-compression` request header, so the guard
  // raises that on the request when the reply must stay as-is.
  app.addHook('onSend', async (req, reply, payload) => {
    if (
      shouldSkipCompression({
        contentType: reply.getHeader('content-type'),
        acceptRanges: reply.getHeader('accept-ranges'),
        contentRange: reply.getHeader('content-range')
      })
    ) {
      req.headers['x-no-compression'] = '1'
    }
    return payload
  })
  await app.register(fastifyCompress, {
    global: true,
    encodings: ['br', 'gzip'],
    threshold: COMPRESSION_THRESHOLD,
    brotliOptions: { params: { [zlibConstants.BROTLI_PARAM_QUALITY]: 4 } },
    zlibOptions: { level: 6 },
    // Responses only — request-body decompression is not ours to change.
    globalDecompression: false
  })
}
