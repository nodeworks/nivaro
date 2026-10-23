// Driving the stack: docker compose (through rtci.sh, which knows the running mode and image),
// toxiproxy toxics, per-node socket counts and process samples.
import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'
import { cfg, directUrl, Redis, socketNodes, stackDir } from './config.mjs'
import { adminClient, waitHttp } from './http.mjs'

const rtci = resolve(stackDir, 'rtci.sh')

/** `docker compose …` for this stack; returns { status, out }. */
export function compose(...args) {
  const r = spawnSync(rtci, ['compose', ...args], { encoding: 'utf8', env: process.env })
  return { status: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}

export function composeOk(...args) {
  const r = compose(...args)
  if (r.status !== 0) throw new Error(`compose ${args.join(' ')}: ${r.out.slice(-800)}`)
  return r.out
}

export const kill = (svc, signal = 'SIGKILL') => composeOk('kill', '-s', signal, svc)
export const stop = (svc, t = 15) => composeOk('stop', '-t', String(t), svc)
export const start = (svc) => composeOk('start', svc)
/** Recreate one service (picks up RTCI_IMAGE_* overrides in env). */
export const recreate = (svc, env = {}) => {
  const r = spawnSync(rtci, ['compose', 'up', '-d', '--no-deps', '--force-recreate', svc], {
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
  if (r.status !== 0) throw new Error(`recreate ${svc}: ${r.stderr.slice(-800)}`)
}

export async function waitReady(node, timeoutMs = 180_000) {
  return waitHttp(`${directUrl(node)}/api/ready`, { timeoutMs, everyMs: 1000 })
}

/** docker stats for this stack's API containers: { svc: { cpu, memMiB } }. */
export function dockerStats() {
  const ps = compose('ps', '--format', '{{.Service}} {{.Name}}')
  const names = {}
  for (const line of ps.out.split('\n')) {
    const [svc, name] = line.trim().split(/\s+/)
    if (svc && name && cfg.nodes[svc]) names[name] = svc
  }
  if (!Object.keys(names).length) return {}
  const r = spawnSync(
    'docker',
    ['stats', '--no-stream', '--format', '{{.Name}} {{.CPUPerc}} {{.MemUsage}}', ...Object.keys(names)],
    { encoding: 'utf8' }
  )
  const out = {}
  for (const line of (r.stdout ?? '').split('\n')) {
    const m = line.match(/^(\S+)\s+([\d.]+)%\s+([\d.]+)(KiB|MiB|GiB)/)
    if (!m) continue
    const mult = m[4] === 'GiB' ? 1024 : m[4] === 'KiB' ? 1 / 1024 : 1
    out[names[m[1]]] = { cpu: Number(m[2]), memMiB: Number(m[3]) * mult }
  }
  return out
}

// ── toxiproxy ────────────────────────────────────────────────────────────────
async function toxi(method, path, body) {
  const res = await fetch(`${cfg.toxi}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  })
  if (!res.ok && res.status !== 404 && res.status !== 409)
    throw new Error(`toxiproxy ${method} ${path}: HTTP ${res.status} ${await res.text()}`)
  return res.status === 204 ? null : res.json().catch(() => null)
}

export const toxics = {
  add: (proxy, type, attributes = {}, stream = 'downstream', name) =>
    toxi('POST', `/proxies/${proxy}/toxics`, {
      name: name ?? `${type}_${stream}`,
      type,
      stream,
      toxicity: 1,
      attributes
    }),
  clear: async (proxy) => {
    const list = (await toxi('GET', `/proxies/${proxy}/toxics`)) ?? []
    for (const t of list) await toxi('DELETE', `/proxies/${proxy}/toxics/${t.name}`)
  },
  enable: (proxy, enabled) => toxi('POST', `/proxies/${proxy}`, { enabled }),
  async resetAll() {
    const proxies = (await toxi('GET', '/proxies')) ?? {}
    for (const name of Object.keys(proxies)) {
      await this.clear(name).catch(() => {})
      await this.enable(name, true).catch(() => {})
    }
  }
}

// ── per-node socket counts ───────────────────────────────────────────────────
/**
 * Sockets on each socket-holding process. Tier: the realtime /api/health `sockets` (public).
 * Single: /api/realtime/stats `socket_count` on each web process directly (administrator).
 */
export async function socketCounts() {
  const out = {}
  for (const node of socketNodes()) {
    try {
      if (cfg.nodes[node].role === 'realtime') {
        const r = await fetch(`${directUrl(node)}/api/health`, { signal: AbortSignal.timeout(3000) })
        out[node] = (await r.json())?.sockets ?? null
      } else {
        const r = await adminClient(directUrl(node)).get('/api/realtime/stats', { timeoutMs: 5000 })
        out[node] = r.json?.data?.socket_count ?? null
      }
    } catch {
      out[node] = null
    }
  }
  return out
}

/** The instance roster from Redis (nvr:instance:*), directly. */
export async function roster() {
  const r = new Redis(cfg.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1 })
  try {
    await r.connect()
    const keys = await r.keys('nvr:instance:*')
    const vals = keys.length ? await r.mget(...keys) : []
    return vals.map((v) => {
      try {
        return JSON.parse(v)
      } catch {
        return v
      }
    })
  } finally {
    r.disconnect()
  }
}

export function redis() {
  return new Redis(cfg.redisUrl, { maxRetriesPerRequest: 2 })
}
