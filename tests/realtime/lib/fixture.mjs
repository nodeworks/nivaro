// Per-suite fixture: the seed, signed-in clients per person, sockets that close themselves.
import { cfg, loadSeed } from './config.mjs'
import { adminClient, Client } from './http.mjs'
import { LiveSocket } from './sock.mjs'

export async function fixture() {
  const seed = loadSeed()
  const admin = adminClient()
  const open = new Set()

  /** A fresh "browser" signed in as `who` with a session cookie (static token → session). */
  async function browser(who, { base } = {}) {
    const u = typeof who === 'string' ? seed.users[who] ?? seed.load.find((l) => l.email.includes(who)) : who
    if (!u) throw new Error(`no seeded user ${who}`)
    const c = new Client({ base: base ?? cfg.base, name: u.email })
    await c.loginWithToken(u.token)
    c.user = u
    return c
  }

  /** An integration signed in by Bearer (static token, API key or masquerade token). */
  function bearer(token, { base, name = 'bearer' } = {}) {
    return new Client({ base: base ?? cfg.base, bearer: token, name })
  }

  /** A signed-in socket (ws-token from `who`'s session) — closed by closeAll(). */
  async function sock(who, o = {}) {
    const c = who instanceof Client ? who : await browser(who, { base: o.base })
    const s = new LiveSocket(c, o)
    open.add(s)
    await s.open({ timeoutMs: o.timeoutMs ?? 15_000 })
    s.http = c
    return s
  }

  function closeAll() {
    for (const s of open) s.close()
    open.clear()
  }

  const item = (i = 0) => seed.items[i]
  return { seed, admin, browser, bearer, sock, closeAll, item, users: seed.users }
}

/** Uppercase-sorted DM room key, the client convention (chat-core.ts). */
export function dmRoom(a, b) {
  return `dm:${[a, b].map((x) => String(x).toUpperCase()).sort().join(':')}`
}
