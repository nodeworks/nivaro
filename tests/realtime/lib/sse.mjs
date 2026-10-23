// Server-sent events over fetch (Node has no EventSource): one open stream, every frame recorded
// with its receive time, comments (`: heartbeat`) counted apart.
export class SseStream {
  /**
   * @param {string} url
   * @param {{ headers?: Record<string,string>, method?: string, body?: unknown }} [o]
   */
  constructor(url, o = {}) {
    this.url = url
    this.o = o
    /** @type {{ event: string, data: any, raw: string, id?: string, at: number }[]} */
    this.events = []
    this.comments = 0
    this.status = null
    this.headers = null
    this.ended = null
    this.waiters = new Set()
    this.ac = new AbortController()
  }

  /** Open and wait for the response head (resolves with this; status tells the outcome). */
  async open({ timeoutMs = 10_000 } = {}) {
    const t = setTimeout(() => this.ac.abort(), timeoutMs)
    let res
    try {
      res = await fetch(this.url, {
        method: this.o.method ?? 'GET',
        headers: {
          accept: 'text/event-stream',
          ...(this.o.body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(this.o.headers ?? {})
        },
        body: this.o.body !== undefined ? JSON.stringify(this.o.body) : undefined,
        signal: this.ac.signal
      })
    } catch (e) {
      clearTimeout(t)
      this.status = 0
      this.ended = { reason: e.message, at: Date.now() }
      return this
    }
    clearTimeout(t)
    this.status = res.status
    this.headers = res.headers
    if (!res.ok || !res.body) {
      this.body = await res.text().catch(() => '')
      this.ended = { reason: `HTTP ${res.status}`, at: Date.now() }
      return this
    }
    void this.pump(res.body)
    return this
  }

  async pump(body) {
    const reader = body.getReader()
    const dec = new TextDecoder()
    let buf = ''
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let i = buf.indexOf('\n\n')
        while (i !== -1) {
          this.frame(buf.slice(0, i))
          buf = buf.slice(i + 2)
          i = buf.indexOf('\n\n')
        }
      }
      this.ended = { reason: 'eof', at: Date.now() }
    } catch (e) {
      this.ended = { reason: this.ac.signal.aborted ? 'closed' : e.message, at: Date.now() }
    }
    for (const w of this.waiters) w()
  }

  frame(raw) {
    let event = 'message'
    let id
    const data = []
    let onlyComments = true
    for (const line of raw.split('\n')) {
      if (line.startsWith(':')) continue
      onlyComments = false
      const i = line.indexOf(':')
      const k = i === -1 ? line : line.slice(0, i)
      const v = i === -1 ? '' : line.slice(i + 1).replace(/^ /, '')
      if (k === 'event') event = v
      else if (k === 'data') data.push(v)
      else if (k === 'id') id = v
    }
    if (onlyComments) {
      this.comments++
      return
    }
    const text = data.join('\n')
    let parsed = text
    try {
      parsed = JSON.parse(text)
    } catch {}
    this.events.push({ event, data: parsed, raw, id, at: Date.now() })
    for (const w of this.waiters) w()
  }

  mark() {
    return this.events.length
  }

  /** First frame after `from` matching pred (or null after timeoutMs). */
  next(pred = () => true, { timeoutMs = 8000, from = 0 } = {}) {
    const find = () => this.events.slice(from).find(pred)
    return new Promise((resolve) => {
      const hit = find()
      if (hit) return resolve(hit)
      const check = () => {
        const h = find()
        if (h || this.ended) {
          clearTimeout(t)
          this.waiters.delete(check)
          resolve(h ?? null)
        }
      }
      const t = setTimeout(() => {
        this.waiters.delete(check)
        resolve(null)
      }, timeoutMs)
      this.waiters.add(check)
    })
  }

  /** Resolve when the stream ends (or false after timeoutMs). */
  async waitEnd(timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs
    while (!this.ended && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
    return !!this.ended
  }

  close() {
    this.ac.abort()
  }
}

export async function openSse(url, o = {}) {
  return new SseStream(url, o).open()
}
