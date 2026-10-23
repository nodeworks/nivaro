// A small HTTP client: a cookie jar (session cookie, Traefik's sticky cookie) or a Bearer, JSON
// in and out. One instance = one "browser" or one integration.
import { cfg } from './config.mjs'

export class Client {
  /**
   * @param {{ base?: string, bearer?: string | null, name?: string }} [opts]
   */
  constructor({ base = cfg.base, bearer = null, name = 'client' } = {}) {
    this.base = base.replace(/\/$/, '')
    this.bearer = bearer
    this.name = name
    /** @type {Map<string, string>} */
    this.cookies = new Map()
  }

  cookieHeader() {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ')
  }

  headers(extra = {}) {
    const h = { ...extra }
    if (this.bearer) h.authorization = `Bearer ${this.bearer}`
    const c = this.cookieHeader()
    if (c) h.cookie = c
    return h
  }

  absorb(res) {
    for (const sc of res.headers.getSetCookie?.() ?? []) {
      const [pair, ...attrs] = sc.split(';')
      const i = pair.indexOf('=')
      const k = pair.slice(0, i).trim()
      const v = pair.slice(i + 1).trim()
      const expired = attrs.some((a) => /max-age=0\b/i.test(a) || /expires=Thu, 01 Jan 1970/i.test(a))
      if (!v || expired) this.cookies.delete(k)
      else this.cookies.set(k, v)
    }
  }

  /** fetch with this client's credentials; returns { status, ok, json, text, headers, ms }. */
  async req(method, path, body, { headers = {}, timeoutMs = 30_000 } = {}) {
    const t0 = performance.now()
    const h = this.headers(headers)
    if (body !== undefined && !(body instanceof FormData)) h['content-type'] = 'application/json'
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: h,
      body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs)
    })
    this.absorb(res)
    const text = await res.text()
    let json = null
    try {
      json = text ? JSON.parse(text) : null
    } catch {}
    return { status: res.status, ok: res.ok, json, text, headers: res.headers, ms: performance.now() - t0 }
  }

  get(path, o) {
    return this.req('GET', path, undefined, o)
  }
  post(path, body = {}, o) {
    return this.req('POST', path, body, o)
  }
  patch(path, body = {}, o) {
    return this.req('PATCH', path, body, o)
  }
  del(path, o) {
    return this.req('DELETE', path, undefined, o)
  }

  /** Throwing variant for setup steps: the body's `data` (or the body). */
  async must(method, path, body, o) {
    const r = await this.req(method, path, body, o)
    if (!r.ok) throw new Error(`${method} ${path} → ${r.status} ${r.text.slice(0, 300)}`)
    return r.json?.data ?? r.json
  }

  /** Session sign-in with a static token (POST /api/auth/login/token) — sets the session cookie. */
  async loginWithToken(token) {
    const r = await this.post('/api/auth/login/token', { token })
    if (r.status !== 200) throw new Error(`login ${this.name}: ${r.status} ${r.text.slice(0, 200)}`)
    return this
  }

  /** A one-time socket token (GET /api/auth/ws-token) for the `auth` event. */
  async wsToken() {
    const r = await this.get('/api/auth/ws-token')
    if (r.status !== 200 || !r.json?.token) {
      const e = new Error(`ws-token ${this.name}: ${r.status} ${r.text.slice(0, 200)}`)
      e.status = r.status
      throw e
    }
    return r.json.token
  }

  /** A one-shot stream ticket (GET /api/events/ticket) for EventSource-style streams. */
  async streamTicket() {
    const r = await this.get('/api/events/ticket')
    if (r.status !== 200) throw new Error(`ticket ${this.name}: ${r.status} ${r.text.slice(0, 200)}`)
    return r.json?.data?.ticket
  }
}

/** A client signed in as the bootstrap administrator by Bearer. */
export function adminClient(base) {
  return new Client({ base, bearer: cfg.adminToken, name: 'admin' })
}

export async function waitHttp(url, { timeoutMs = 120_000, everyMs = 1000, okStatus = 200 } = {}) {
  const end = Date.now() + timeoutMs
  let last = null
  while (Date.now() < end) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(3000) })
      last = r.status
      if (r.status === okStatus) return true
    } catch (e) {
      last = e.message
    }
    await new Promise((r) => setTimeout(r, everyMs))
  }
  throw new Error(`${url} not ${okStatus} after ${timeoutMs} ms (last: ${last})`)
}
