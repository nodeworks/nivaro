import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { db } from '../db/index.js'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { stopAllDrills } from '../services/chaos/drill.js'
import { drillWindows } from '../services/chaos/drill-alerts.js'
import { ChaosError, chaosRefusal } from '../services/chaos/gate.js'
import {
  announceMonkeyEnd,
  looksLikeProduction,
  monkeyCandidates,
  monkeyVerdict,
  tickMonkey,
  weekStart
} from '../services/chaos/monkey.js'
import { isChaosOperator, requireChaosOperator } from '../services/chaos/operator.js'
import {
  pushDrillAborted,
  pushDrillStarted,
  redeemStopToken,
  StopTokenError,
  setStopTokenRedis
} from '../services/chaos/push-stop.js'
import { armedFaults, onRegistryChange } from '../services/chaos/registry.js'
import { listRuns } from '../services/chaos/runs.js'
import { capsFor, getChaosSettings, saveChaosSettings } from '../services/chaos/settings.js'
import { instanceKey } from '../services/instance-key.js'

/**
 * Running chaos safely in operations, under /api/chaos (registered beside routes/chaos.ts):
 *
 *   GET   /operator          signed in: may I run faults here? {operator, admin}
 *   GET   /settings          admin: operator roles, per-environment caps, monkey (#2862, #2829)
 *   PATCH /settings          admin: validated patch; every bad field named
 *   GET   /drill-windows     operator: runs overlapping ?since= — the drill tag on alert rows (#2847)
 *   GET   /monkey            operator: monkey settings, this tick's verdict, recent monkey runs
 *   POST  /monkey/try        admin: run one monkey tick now (the dice roll skipped, every rule kept)
 *   POST  /stop-all/push     NO session: a one-time Stop token from a drill push (#2861)
 */

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ChaosError || err instanceof StopTokenError) {
    const details = err instanceof ChaosError ? err.details : undefined
    return reply
      .code(err.statusCode)
      .send({ error: err.message, code: err.code, details: details ?? undefined })
  }
  const e = err as { statusCode?: number; message?: string }
  if (e?.statusCode && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: e.message ?? 'Refused' })
  throw err
}

/** The push Stop is unauthenticated: a few tries per address per minute is plenty. */
const pushTries = new Map<string, number[]>()
export function pushRateLimited(ip: string, now = Date.now(), max = 20): boolean {
  const list = (pushTries.get(ip) ?? []).filter((t) => now - t < 60_000)
  list.push(now)
  pushTries.set(ip, list)
  if (pushTries.size > 5000) pushTries.clear()
  return list.length > max
}

/** Still a chaos operator now (the token was minted earlier)? Active account, admin or role. */
async function stillOperator(userId: string): Promise<boolean> {
  try {
    const row = (await db('nivaro_users as u')
      .leftJoin('nivaro_roles as r', 'r.id', 'u.role')
      .where('u.id', userId)
      .first('u.status', 'u.role', 'r.admin_access')) as
      | { status?: string; role?: string | null; admin_access?: boolean | number | null }
      | undefined
    if (!row || row.status !== 'active') return false
    return isChaosOperator({ role: row.role ?? null }, !!row.admin_access)
  } catch {
    return false
  }
}

export async function chaosOpsRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onReady', async () => {
    setStopTokenRedis(
      (app as unknown as { redis?: Parameters<typeof setStopTokenRedis>[0] }).redis ?? null
    )
    // Pushes with a Stop (#2861) and the monkey's end notice (#2829), from the replica that
    // armed the fault (remote events are another replica's to tell).
    onRegistryChange((ev) => {
      if (ev.remote) return
      if (ev.type === 'armed') void pushDrillStarted(ev.fault).catch(() => undefined)
      if (ev.type === 'disarmed' && ev.reason.startsWith('aborted'))
        void pushDrillAborted(ev.fault, ev.reason).catch(() => undefined)
      const ended = ev.type === 'stop-all' ? ev.faults : ev.type === 'armed' ? [] : [ev.fault]
      for (const f of ended)
        if (f.run_id) void announceMonkeyEnd(app, f.run_id).catch(() => undefined)
    })
  })

  // Anyone signed in: may I run faults here? (the console hides what an operator cannot do)
  await app.register(async (pub) => {
    pub.addHook('preHandler', requireAuth)
    // `caps` = this instance's effective limits (#2862) — the builder (#2844) stops its sliders
    // there; the server enforces them anyway.
    pub.get('/operator', async (req) => {
      const operator = await isChaosOperator(req.user, !!req.isAdmin)
      return {
        data: {
          operator,
          admin: !!req.isAdmin,
          allowed: !chaosRefusal(),
          instance: instanceKey(),
          caps: operator ? capsFor(await getChaosSettings()) : null
        }
      }
    })
  })

  // Administrators: the settings themselves. An operator can never widen their own reach.
  await app.register(async (adm) => {
    adm.addHook('preHandler', requireAdmin)

    adm.get('/settings', async () => {
      const settings = await getChaosSettings()
      return {
        data: {
          settings,
          instance: instanceKey(),
          effective_caps: capsFor(settings),
          candidates: monkeyCandidates()
        }
      }
    })

    adm.patch<{ Body: unknown }>('/settings', async (req, reply) => {
      try {
        const settings = await saveChaosSettings(req.body ?? {})
        await logActivity({
          action: 'chaos-settings',
          user: req.user?.id,
          comment: `Chaos settings changed on ${instanceKey()}: ${Object.keys((req.body ?? {}) as object).join(', ')}`,
          req
        })
        return {
          data: {
            settings,
            instance: instanceKey(),
            effective_caps: capsFor(settings),
            candidates: monkeyCandidates()
          }
        }
      } catch (err) {
        return fail(reply, err)
      }
    })

    adm.post<{ Body: { force?: boolean } }>('/monkey/try', async (req, reply) => {
      if (chaosRefusal()) return reply.code(403).send({ error: chaosRefusal(), code: 'CHAOS_GATE' })
      const r = await tickMonkey(app, { force: true })
      await logActivity({
        action: 'chaos-monkey-try',
        user: req.user?.id,
        comment: `Chaos Monkey tried by hand: ${r.why}`,
        req
      })
      return { data: r }
    })
  })

  // Chaos operators: read what the tags and the monkey tab show.
  await app.register(async (ops) => {
    ops.addHook('preHandler', requireChaosOperator)

    ops.get<{ Querystring: { since?: string } }>('/drill-windows', async (req) => {
      const raw = req.query.since ? Date.parse(String(req.query.since)) : Number.NaN
      const since = Number.isFinite(raw) ? raw : Date.now() - 7 * 86_400_000
      const runs = await listRuns({ limit: 200 })
      return { data: drillWindows(runs, since) }
    })

    ops.get('/monkey', async () => {
      const settings = await getChaosSettings()
      const m = settings.monkey
      const now = new Date()
      const runs = await listRuns({ kind: 'monkey', limit: 30 })
      const since = weekStart(now, m.hours.tz).getTime()
      const thisWeek = runs.filter(
        (r) => r.status !== 'refused' && r.started_at && Date.parse(r.started_at) >= since
      ).length
      return {
        data: {
          monkey: m,
          instance: instanceKey(),
          production: looksLikeProduction(),
          this_week: thisWeek,
          verdict: monkeyVerdict({
            settings: m,
            now,
            thisWeek,
            gateRefusal: chaosRefusal(),
            production: looksLikeProduction(),
            armed: armedFaults().length
          }),
          runs
        }
      }
    })
  })

  // No session (#2861): the Stop action of a drill push. The token is the credential.
  app.post<{ Body: { token?: string } }>(
    '/stop-all/push',
    async (req: FastifyRequest<{ Body: { token?: string } }>, reply) => {
      if (pushRateLimited(req.ip)) return reply.code(429).send({ error: 'Too many tries' })
      try {
        const who = await redeemStopToken(req.body?.token)
        if (!(await stillOperator(who.user_id)))
          return reply
            .code(403)
            .send({ error: 'You can no longer run chaos drills here', code: 'CHAOS_OPERATOR' })
        const out = await stopAllDrills({ id: who.user_id }, 'stopped from a drill push')
        await logActivity({
          action: 'chaos-stop-all',
          user: who.user_id,
          comment: `Chaos stop all from a phone push (run ${who.run_id}): ${out.faults.length} fault(s), ${out.runs.length} run(s) closed`,
          req
        })
        return {
          data: {
            stopped: out.faults.map((f) => ({
              id: f.id,
              fault_key: f.fault_key,
              run_id: f.run_id
            })),
            runs: out.runs
          }
        }
      } catch (err) {
        return fail(reply, err)
      }
    }
  )
}
