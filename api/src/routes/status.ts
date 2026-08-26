import type { FastifyInstance } from 'fastify'
import { db } from '../db/index.js'
import { NIVARO_VERSION } from '../version.js'

// ─── Public status page (#658) ───────────────────────────────────────────────
// Registered at SERVER level (no /api prefix, like sharePublicRoutes) so
// GET /status serves a human page. Deliberately public and deliberately
// content-free beyond up/down + app version: no hostnames, no DB names, no
// connection strings. Checks are the same cheap probes /api/health does
// (SELECT 1, redis ping) but cached 10s in-process so an unauthenticated
// endpoint cannot be used to hammer the database.

interface StatusSnapshot {
  status: 'ok' | 'degraded'
  components: { db: 'ok' | 'down'; redis: 'ok' | 'down'; version: string }
  uptime_s: number
}

const CACHE_MS = 10_000
let cached: { at: number; promise: Promise<StatusSnapshot> } | null = null

async function probe(app: FastifyInstance): Promise<StatusSnapshot> {
  const [dbOk, redisOk] = await Promise.all([
    db
      .raw('SELECT 1')
      .then(() => true)
      .catch(() => false),
    app.redis
      .ping()
      .then((r) => r === 'PONG')
      .catch(() => false)
  ])
  return {
    status: dbOk && redisOk ? 'ok' : 'degraded',
    components: {
      db: dbOk ? 'ok' : 'down',
      redis: redisOk ? 'ok' : 'down',
      version: NIVARO_VERSION
    },
    uptime_s: Math.round(process.uptime())
  }
}

function snapshot(app: FastifyInstance): Promise<StatusSnapshot> {
  // Cache the PROMISE, not just the result — concurrent cold hits share one
  // probe instead of each opening a DB round trip.
  if (!cached || Date.now() - cached.at >= CACHE_MS) {
    cached = { at: Date.now(), promise: probe(app) }
  }
  return cached.promise
}

function fmtUptime(s: number): string {
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86_400) return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`
  return `${Math.floor(s / 86_400)}d ${Math.floor((s % 86_400) / 3600)}h`
}

function statusHtml(s: StatusSnapshot): string {
  const ok = s.status === 'ok'
  const dot = (up: boolean) =>
    `<span class="dot" style="background:${up ? '#10b981' : '#ef4444'}"></span>`
  const row = (label: string, up: boolean) =>
    `<div class="row">${dot(up)}<span>${label}</span><span class="state">${up ? 'Operational' : 'Down'}</span></div>`
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="30">
<title>Service status</title>
<style>
  body{margin:0;font-family:-apple-system,'Segoe UI',Roboto,sans-serif;background:#0f172a;color:#e2e8f0;display:flex;min-height:100vh;align-items:center;justify-content:center}
  .card{width:min(420px,92vw);background:#1e293b;border:1px solid #334155;border-radius:12px;padding:28px}
  h1{font-size:15px;margin:0 0 4px;font-weight:600}
  .overall{display:flex;align-items:center;gap:8px;margin:14px 0 18px;font-size:13px;font-weight:600;color:${ok ? '#34d399' : '#fbbf24'}}
  .dot{display:inline-block;width:9px;height:9px;border-radius:50%}
  .row{display:flex;align-items:center;gap:8px;padding:9px 0;border-top:1px solid #334155;font-size:13px}
  .row .state{margin-left:auto;color:#94a3b8;font-size:12px}
  .meta{margin-top:16px;font-size:11px;color:#64748b}
</style></head><body>
<div class="card">
  <h1>Service status</h1>
  <div class="overall">${dot(ok)}${ok ? 'All systems operational' : 'Degraded — some components are down'}</div>
  ${row('API', true)}
  ${row('Database', s.components.db === 'ok')}
  ${row('Cache & sessions', s.components.redis === 'ok')}
  <div class="meta">v${s.components.version} · up ${fmtUptime(s.uptime_s)} · refreshes every 30s</div>
</div>
</body></html>`
}

export async function statusPublicRoutes(app: FastifyInstance) {
  // GET /status — tiny public HTML page, zero external assets
  app.get('/status', async (_req, reply) => {
    const s = await snapshot(app)
    return reply.type('text/html; charset=utf-8').send(statusHtml(s))
  })

  // GET /api/status.json — public machine-readable status
  app.get('/api/status.json', async (_req, reply) => {
    const s = await snapshot(app)
    return reply.send({ status: s.status, components: s.components, uptime_s: s.uptime_s })
  })

  // GET /api/status/badge — shields.io endpoint-badge JSON
  app.get('/api/status/badge', async (_req, reply) => {
    const s = await snapshot(app)
    return reply.send({
      schemaVersion: 1,
      label: 'nivaro',
      message: s.status,
      color: s.status === 'ok' ? 'green' : 'orange'
    })
  })
}
