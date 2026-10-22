import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { listFaults } from '../services/chaos/catalog.js'
import {
  chaosStatus,
  publicArmedView,
  recordRun,
  type StartDrillInput,
  startDrill,
  stopAllDrills,
  stopDrill
} from '../services/chaos/drill.js'
import { ChaosError, chaosRefusal } from '../services/chaos/gate.js'
import { requireChaosOperator } from '../services/chaos/operator.js'
import { armedFaults, setChaosApp, startChaosCluster } from '../services/chaos/registry.js'
import {
  getRun,
  lastRunPerFault,
  listRunEvents,
  listRuns,
  type RunKind,
  type RunStatus,
  runStoreMode
} from '../services/chaos/runs.js'

/**
 * Chaos engineering (#2827) under /api/chaos — always registered; the gate
 * (services/chaos/gate.ts) answers every route with a clear refusal in cloud mode and on an
 * unflagged production box, so the console can say why instead of meeting a 404.
 *
 *   GET  /status            { allowed, reason, armed, nodes }   ← fixed shape
 *   GET  /armed             any signed-in person: labels, names and end times only (the banner)
 *   GET  /catalog           every fault with its caps and last run
 *   GET  /runs              list (?status=&kind=&fault_key=&limit=)
 *   POST /runs              start a drill {fault_key, target, params, seconds, hypothesis, override, note}
 *   GET  /runs/:id          run + events (?after=<event id> for the cockpit)
 *   POST /runs/:id/stop     stop this run's fault everywhere
 *   POST /runs/record       record-only run (CI, game-day steps): {kind, fault_key?, label, verdict, metrics, started_at, ended_at, meta}
 *   POST /stop-all          every fault on every replica, socket drills included
 *   POST /run               the #333 alias {fault, seconds, delay_ms}
 */

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof ChaosError)
    return reply
      .code(err.statusCode)
      .send({ error: err.message, code: err.code, details: err.details ?? undefined })
  const e = err as { statusCode?: number; message?: string }
  if (e?.statusCode && e.statusCode < 500)
    return reply.code(e.statusCode).send({ error: e.message ?? 'Refused' })
  throw err
}

function who(req: FastifyRequest): { id: string | null; name: string | null } {
  const u = req.user as
    | { id?: string; first_name?: string | null; last_name?: string | null; email?: string }
    | undefined
  if (!u) return { id: null, name: null }
  return {
    id: u.id ?? null,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null
  }
}

/** Refuse at the gate before doing anything (reads still answer, with the reason). */
function gated(reply: FastifyReply): FastifyReply | null {
  const why = chaosRefusal()
  return why ? reply.code(403).send({ error: why, code: 'CHAOS_GATE' }) : null
}

export async function chaosRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onReady', async () => {
    await import('../services/chaos/faults/index.js')
    const { wireDrillListeners } = await import('../services/chaos/drill.js')
    wireDrillListeners()
    const { wireSteadyState } = await import('../services/chaos/steady-state.js')
    await wireSteadyState()
    const { wirePreflight } = await import('../services/chaos/preflight-hook.js')
    wirePreflight()
    setChaosApp(app)
    await startChaosCluster(chaosRefusal() ? null : (app.redis ?? null))
  })

  // Everyone signed in: what the banner needs and nothing more.
  await app.register(async (pub) => {
    pub.addHook('preHandler', requireAuth)
    pub.get('/armed', async () => {
      const why = chaosRefusal()
      return { data: { allowed: !why, armed: why ? [] : armedFaults().map(publicArmedView) } }
    })
  })

  // Administrators: read the state.
  await app.register(async (adm) => {
    adm.addHook('preHandler', requireAdmin)

    adm.get('/status', async () => ({ data: await chaosStatus() }))

    // #2848 — the checklist beside the Run button; POST /runs runs it again server-side.
    adm.get('/preflight', async () => {
      const { runPreflight } = await import('../services/chaos/preflight.js')
      const r = await runPreflight()
      return { data: { ok: r.ok, checks: r.checks } }
    })

    adm.get('/catalog', async () => {
      const last = await lastRunPerFault()
      const faults = listFaults().map((f) => {
        const run = last.get(f.key) ?? null
        return {
          key: f.key,
          label: f.label,
          area: f.area ?? null,
          proves: f.proves,
          claim_keys: f.claim_keys,
          targets: f.targets,
          params: f.params,
          max_seconds: f.max_seconds,
          default_seconds: f.default_seconds ?? Math.min(60, f.max_seconds),
          points: f.points,
          danger: f.danger ?? 'low',
          hypothesis_defaults: f.hypothesis_defaults ?? [],
          console_href: f.console_href ?? null,
          last_run: run
            ? {
                id: run.id,
                status: run.status,
                verdict: run.verdict,
                started_at: run.started_at,
                ended_at: run.ended_at
              }
            : null
        }
      })
      return { data: { refusal: chaosRefusal(), store: await runStoreMode(), faults } }
    })

    adm.get<{
      Querystring: { status?: string; kind?: string; fault_key?: string; limit?: string }
    }>('/runs', async (req) => {
      const status = req.query.status
        ? (String(req.query.status).split(',') as RunStatus[])
        : undefined
      const runs = await listRuns({
        status,
        kind: req.query.kind ? (String(req.query.kind) as RunKind) : undefined,
        fault_key: req.query.fault_key ? String(req.query.fault_key) : undefined,
        limit: Number(req.query.limit) || 50
      })
      return { data: runs }
    })

    adm.get<{ Params: { id: string }; Querystring: { after?: string } }>(
      '/runs/:id',
      async (req, reply) => {
        const run = await getRun(String(req.params.id))
        if (!run) return reply.code(404).send({ error: 'No such run' })
        const events = await listRunEvents(run.id, { after: Number(req.query.after) || 0 })
        return { data: { run, events } }
      }
    )
  })

  // Chaos operators: arm, stop, record.
  await app.register(async (ops) => {
    ops.addHook('preHandler', requireChaosOperator)

    ops.post<{ Body: Partial<StartDrillInput> }>('/runs', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      const b = req.body ?? {}
      try {
        const { run, fault } = await startDrill({
          fault_key: String(b.fault_key ?? ''),
          target: b.target,
          params: b.params,
          seconds: b.seconds,
          hypothesis: b.hypothesis ?? null,
          override: b.override ?? null,
          note: b.note ?? null,
          kind: b.kind === 'monkey' || b.kind === 'gameday' ? b.kind : 'drill',
          preset_id: b.preset_id ?? null,
          gameday_id: b.gameday_id ?? null,
          by: who(req)
        })
        await logActivity({
          action: 'chaos-run',
          user: req.user?.id,
          comment: `Chaos drill ${fault.fault_key} on ${run.target?.kind ?? 'all'} for ${Math.round((fault.ends_at - fault.started_at) / 1000)}s`,
          req
        })
        return reply.code(201).send({ data: { run, fault } })
      } catch (err) {
        return fail(reply, err)
      }
    })

    ops.post<{ Params: { id: string }; Body: { reason?: string } }>(
      '/runs/:id/stop',
      async (req, reply) => {
        try {
          const run = await stopDrill(
            String(req.params.id),
            who(req),
            req.body?.reason ? String(req.body.reason).slice(0, 200) : 'stopped by operator'
          )
          await logActivity({
            action: 'chaos-stop',
            user: req.user?.id,
            comment: `Chaos drill ${run.fault_key ?? run.label} stopped`,
            req
          })
          return { data: run }
        } catch (err) {
          return fail(reply, err)
        }
      }
    )

    ops.post<{ Body: { reason?: string } }>('/stop-all', async (req, reply) => {
      try {
        const out = await stopAllDrills(
          who(req),
          req.body?.reason ? String(req.body.reason).slice(0, 200) : 'stop all'
        )
        await logActivity({
          action: 'chaos-stop-all',
          user: req.user?.id,
          comment: `Chaos stop all: ${out.faults.length} fault(s), ${out.runs.length} run(s) closed`,
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
    })

    ops.post<{
      Body: {
        kind?: string
        fault_key?: string | null
        label?: string
        verdict?: string
        metrics?: Record<string, unknown> | null
        started_at?: string | null
        ended_at?: string | null
        meta?: Record<string, unknown> | null
        gameday_id?: string | null
      }
    }>('/runs/record', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      const b = req.body ?? {}
      try {
        const run = await recordRun(
          {
            kind: b.kind as 'ci' | 'gameday',
            fault_key: b.fault_key ?? null,
            label: String(b.label ?? ''),
            verdict: b.verdict as 'held' | 'broke' | 'aborted',
            metrics: b.metrics ?? null,
            started_at: b.started_at ?? null,
            ended_at: b.ended_at ?? null,
            meta: b.meta ?? null,
            gameday_id: b.gameday_id ?? null
          },
          who(req)
        )
        return reply.code(201).send({ data: run })
      } catch (err) {
        return fail(reply, err)
      }
    })

    // #333 callers: {fault, seconds, delay_ms} → a drill on everything.
    ops.post<{ Body: { fault?: string; seconds?: number; delay_ms?: number } }>(
      '/run',
      async (req, reply) => {
        const refused = gated(reply)
        if (refused) return refused
        const fault = String(req.body?.fault ?? '')
        try {
          const { run, fault: armed } = await startDrill({
            fault_key: fault,
            target: { kind: 'all' },
            params: fault === 'slow_requests' ? { delay_ms: req.body?.delay_ms } : {},
            seconds: req.body?.seconds,
            by: who(req)
          })
          return {
            data: {
              fault,
              seconds: Math.round((armed.ends_at - armed.started_at) / 1000),
              delay_ms: armed.params.delay_ms,
              run_id: run.id
            }
          }
        } catch (err) {
          if (err instanceof ChaosError && err.code === 'CHAOS_UNKNOWN_FAULT')
            return reply.code(400).send({
              error: `fault must be one of ${listFaults()
                .map((f) => f.key)
                .join(' | ')}`
            })
          return fail(reply, err)
        }
      }
    )
  })
}
