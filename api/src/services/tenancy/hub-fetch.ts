import { request as httpRequest, type IncomingMessage } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { Readable } from 'node:stream'

/**
 * The HTTP client for the Hub tenants call (Hub phase 5). That answer carries every app's
 * database credentials, so certificate checks are forced on: `rejectUnauthorized: true` is
 * passed explicitly, which NODE_TLS_REJECT_UNAUTHORIZED=0 (set in some dev and EFP environments)
 * cannot switch off. Trust is Node's default CA store, which already includes NODE_EXTRA_CA_CERTS.
 *
 * Node's built-in fetch cannot take a TLS option without the undici package (not a dependency),
 * so this is a small fetch over node:https with the subset the source uses: method, headers,
 * signal; a redirect is an error (fetch's `redirect: 'error'`). Plain http is reached only for
 * the loopback HUB_URL that deploymentModeProblem() allows.
 */

/** No body: 101, 204, 205, 304 (a Response refuses one for these). */
const NULL_BODY = new Set([101, 204, 205, 304])

export class HubRedirectError extends Error {
  override name = 'HubRedirectError'
}

/** The Hub answered a status a fetch Response cannot carry (outside 200–599). */
export class HubStatusError extends Error {
  override name = 'HubStatusError'
}

export const hubFetch = ((input: string | URL, init?: RequestInit): Promise<Response> => {
  const url = new URL(String(input))
  const headers = (init?.headers ?? {}) as Record<string, string>
  const opts = { method: init?.method ?? 'GET', headers, signal: init?.signal ?? undefined }
  return new Promise<Response>((resolve, reject) => {
    // Everything that touches the answer runs inside try/catch and settles THIS promise: a throw
    // in a socket callback is an uncaught exception for the whole process (an odd status like
    // `HTTP/1.1 999` makes `new Response` throw a RangeError).
    const onResponse = (res: IncomingMessage) => {
      res.on('error', () => {}) // a body error after we answered surfaces through the stream read
      try {
        const status = res.statusCode ?? 0
        if (status < 200 || status > 599) {
          res.resume()
          reject(new HubStatusError(`status ${status}`))
          return
        }
        if (status >= 300 && status < 400 && status !== 304) {
          res.resume()
          reject(new HubRedirectError(`redirect ${status}`))
          return
        }
        const h = new Headers()
        for (const [k, v] of Object.entries(res.headers))
          if (v !== undefined) h.set(k, Array.isArray(v) ? v.join(', ') : v)
        if (NULL_BODY.has(status)) {
          res.resume()
          resolve(new Response(null, { status, headers: h }))
          return
        }
        resolve(
          new Response(Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>, {
            status,
            headers: h
          })
        )
      } catch (err) {
        res.destroy()
        reject(err)
      }
    }
    try {
      const req =
        url.protocol === 'https:'
          ? httpsRequest(url, { ...opts, rejectUnauthorized: true }, onResponse)
          : url.protocol === 'http:'
            ? httpRequest(url, opts, onResponse)
            : null
      if (!req) {
        reject(new Error('unsupported protocol'))
        return
      }
      req.on('error', reject)
      // A 101 with no upgrade listener would leave the request (and every refresh waiting on
      // it) pending forever, past the abort signal: refuse it and close the socket.
      req.on('upgrade', (res, socket) => {
        socket.destroy()
        res.destroy()
        reject(new HubStatusError(`status ${res.statusCode ?? 101}`))
      })
      req.end()
    } catch (err) {
      reject(err)
    }
  })
}) as typeof fetch

export class HubBodyTooLargeError extends Error {
  override name = 'HubBodyTooLargeError'
}

/** The body as text, refusing (and cancelling the stream) past `max` bytes. */
export async function readCappedText(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > max) {
    // never awaited: a cancel can wait on a reader that is not ours (a tee'd body)
    void res.body?.cancel().catch(() => {})
    throw new HubBodyTooLargeError('too large')
  }
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      void reader.cancel().catch(() => {})
      throw new HubBodyTooLargeError('too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}
