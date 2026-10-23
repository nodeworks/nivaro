// A graphql-ws (graphql-transport-ws) client on Node's built-in WebSocket: connection_init,
// subscribe, every `next` recorded. Enough protocol for subscription parity tests.
export class GqlWs {
  constructor(url, connectionParams = {}) {
    this.url = url
    this.connectionParams = connectionParams
    this.messages = []
    this.closed = null
    this.acked = false
    this.waiters = new Set()
    this.nextId = 1
  }

  open({ timeoutMs = 10_000 } = {}) {
    return new Promise((resolve) => {
      const ws = new WebSocket(this.url, 'graphql-transport-ws')
      this.ws = ws
      const t = setTimeout(() => resolve(this), timeoutMs)
      ws.onopen = () => ws.send(JSON.stringify({ type: 'connection_init', payload: this.connectionParams }))
      ws.onmessage = (m) => {
        let msg
        try {
          msg = JSON.parse(String(m.data))
        } catch {
          return
        }
        msg.at = Date.now()
        this.messages.push(msg)
        if (msg.type === 'connection_ack') {
          this.acked = true
          clearTimeout(t)
          resolve(this)
        }
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong' }))
        for (const w of this.waiters) w()
      }
      ws.onclose = (e) => {
        this.closed = { code: e.code, reason: e.reason, at: Date.now() }
        clearTimeout(t)
        for (const w of this.waiters) w()
        resolve(this)
      }
      ws.onerror = () => {}
    })
  }

  subscribe(query, variables = {}) {
    const id = String(this.nextId++)
    this.ws.send(JSON.stringify({ id, type: 'subscribe', payload: { query, variables } }))
    return id
  }

  mark() {
    return this.messages.length
  }

  next(pred = () => true, { timeoutMs = 8000, from = 0 } = {}) {
    const find = () => this.messages.slice(from).find(pred)
    return new Promise((resolve) => {
      const hit = find()
      if (hit) return resolve(hit)
      const check = () => {
        const h = find()
        if (h || this.closed) {
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

  async waitClose(timeoutMs = 10_000) {
    const end = Date.now() + timeoutMs
    while (!this.closed && Date.now() < end) await new Promise((r) => setTimeout(r, 100))
    return this.closed
  }

  close() {
    try {
      this.ws.close(1000)
    } catch {}
  }
}

export function wsUrl(base, path) {
  return `${base.replace(/^http/, 'ws')}${path}`
}
