import { randomUUID } from 'node:crypto'
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin, requireAuth } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import {
  bindBlindRun,
  blindWindows,
  closeBlindWindow,
  openBlindWindow,
  revealBlindWindow,
  startBlindCluster,
  stopBlindCluster,
  windowOfRun
} from '../services/chaos/blind.js'
import { type StartDrillInput, startDrill } from '../services/chaos/drill.js'
import {
  type Actor,
  addNote,
  cancelGameday,
  createGameday,
  declareIncident,
  endGameday,
  gamedayDetail,
  gamedayMeta,
  isParticipant,
  listGamedays,
  revealGameday,
  runGamedayTick,
  startGameday,
  stepGameday,
  updateGameday
} from '../services/chaos/gameday.js'
import {
  easternToUtc,
  notePoints,
  parseMark,
  participantsOf,
  stagingTemplate
} from '../services/chaos/gameday-plan.js'
import { ChaosError, chaosRefusal } from '../services/chaos/gate.js'
import { isChaosOperator, requireChaosOperator } from '../services/chaos/operator.js'
import { getRun, listRunEvents, listRuns, updateRun } from '../services/chaos/runs.js'

/**
 * Game days (#2816, #2852), scribe marks (#2853) and blind mode (#2854) under /api/chaos.
 *
 *   GET  /gamedays                 admin     list (planned, running, past)
 *   GET  /gamedays/template        admin     the monthly staging plan + whether the task kill can run
 *   GET  /gamedays/active          signed in the running / planned days I take part in (no injects)
 *   GET  /gamedays/:id             admin     plan, timeline, child runs, people, TTD/TTF
 *   POST /gamedays                 operator  create {plan}
 *   PATCH /gamedays/:id            operator  edit while planned
 *   POST /gamedays/:id/start|cancel|reveal   operator
 *   POST /gamedays/:id/step        operator  {inject_id} fire one inject now
 *   POST /gamedays/:id/end         operator  {how: 'completed'|'aborted'} — never gated
 *   GET  /runs/:id/notes           admin or participant: note events + TTD/TTF points
 *   POST /runs/:id/notes           admin or participant: {mark?, text?}
 *   POST /declare                  signed in: "Declare incident" — always answers ok
 *   GET  /blind                    admin     open blind windows
 *   POST /blind/runs               operator  start one drill blind (the POST /runs body)
 *   POST /blind/runs/:id/reveal    operator
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

/** The caller. `operator` = administrators plus the chaos operator roles (#2862). */
async function who(req: FastifyRequest): Promise<Actor> {
  const u = req.user as
    | { id?: string; first_name?: string | null; last_name?: string | null; email?: string }
    | undefined
  return {
    id: u?.id ?? null,
    name: u ? [u.first_name, u.last_name].filter(Boolean).join(' ') || u.email || null : null,
    operator: await isChaosOperator(req.user, !!req.isAdmin)
  }
}

function gated(reply: FastifyReply): FastifyReply | null {
  const why = chaosRefusal()
  return why ? reply.code(403).send({ error: why, code: 'CHAOS_GATE' }) : null
}

/** The next second Tuesday at 2 PM Eastern — the template's suggested slot. */
function suggestedStart(now = new Date()): string {
  for (let add = 0; add < 3; add++) {
    const y = now.getUTCFullYear() + Math.floor((now.getUTCMonth() + add) / 12)
    const m = ((now.getUTCMonth() + add) % 12) + 1
    const first = new Date(Date.UTC(y, m - 1, 1)).getUTCDay()
    const day = 1 + ((2 - first + 7) % 7) + 7
    const at = easternToUtc(y, m, day, 14, 0)
    if (at > now.getTime() + 3600_000) return new Date(at).toISOString()
  }
  return new Date(now.getTime() + 7 * 86_400_000).toISOString()
}

export async function chaosGamedayRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('onReady', async () => {
    await startBlindCluster(chaosRefusal() ? null : (app.redis ?? null))
    // Leader-only and cronTicksEnabled() like every cron; the in-process timers cover dev.
    app.cron?.schedule(
      'chaos-gamedays',
      '* * * * *',
      async () => {
        if (chaosRefusal()) return
        await runGamedayTick(app)
      },
      {
        quiet: true,
        idempotent: 'safe',
        description:
          'Every minute — game days (#2852): reminders before a planned day, the automatic start when the plan asks for one, each inject on time (once, claimed), and the end of a running day. Does nothing where chaos is refused.'
      }
    )
  })
  app.addHook('preClose', async () => {
    await stopBlindCluster()
  })

  // ── Everyone signed in ────────────────────────────────────────────────────
  await app.register(async (pub) => {
    pub.addHook('preHandler', requireAuth)

    // The days I take part in — titles and times only, never the injects (blind days).
    pub.get('/gamedays/active', async (req) => {
      const me = req.user?.id ?? null
      if (chaosRefusal() || !me) return { data: [] }
      const rows = await listRuns({ kind: 'gameday', status: ['planned', 'running'], limit: 200 })
      const data = rows
        .filter((r) => isParticipant(r, me))
        .map((r) => {
          const { plan, channel_room } = gamedayMeta(r)
          const role =
            plan.lead === me.toLowerCase()
              ? 'lead'
              : plan.scribe === me.toLowerCase()
                ? 'scribe'
                : 'responder'
          return {
            id: r.id,
            title: plan.title,
            status: r.status,
            role,
            starts_at: plan.starts_at,
            started_at: r.started_at,
            ends_at: r.ends_at,
            channel_room: channel_room ?? null
          }
        })
      return { data }
    })

    pub.get<{ Params: { id: string } }>('/runs/:id/notes', async (req, reply) => {
      try {
        const run = await getRun(String(req.params.id))
        if (!run) return reply.code(404).send({ error: 'No such run' })
        const home = run.gameday_id ? await getRun(run.gameday_id) : run
        if (!home) return reply.code(404).send({ error: 'No such run' })
        if (!req.isAdmin && !isParticipant(home, req.user?.id ?? null))
          return reply.code(404).send({ error: 'No such run' })
        const events = await listRunEvents(home.id, { limit: 3000 })
        const notes = events.filter((e) => e.kind === 'note')
        return { data: { run_id: home.id, notes, points: notePoints(events) } }
      } catch (err) {
        return fail(reply, err)
      }
    })

    pub.post<{ Params: { id: string }; Body: { mark?: string; text?: string } }>(
      '/runs/:id/notes',
      async (req, reply) => {
        const refused = gated(reply)
        if (refused) return refused
        try {
          const ev = await addNote(
            String(req.params.id),
            { mark: parseMark(req.body?.mark), text: req.body?.text ?? null },
            await who(req),
            app
          )
          return reply.code(201).send({ data: ev })
        } catch (err) {
          return fail(reply, err)
        }
      }
    )

    // Always the same answer: a blind responder must not learn it was a drill from the button.
    pub.post('/declare', async (req) => {
      if (!chaosRefusal()) {
        try {
          await declareIncident(await who(req))
        } catch (err) {
          req.log.warn({ err }, 'chaos: declare incident not recorded')
        }
      }
      return { data: { ok: true, at: new Date().toISOString() } }
    })
  })

  // ── Administrators: read ──────────────────────────────────────────────────
  await app.register(async (adm) => {
    adm.addHook('preHandler', requireAdmin)

    adm.get('/gamedays', async () => ({ data: await listGamedays(200) }))

    adm.get('/gamedays/template', async (req) => {
      const { killTaskRefusal } = await import('../services/chaos/faults/gameday.js')
      return {
        data: {
          plan: stagingTemplate(suggestedStart(), String(req.user?.id ?? '')),
          kill_task: await killTaskRefusal('staging').catch((e) => String(e?.message ?? e))
        }
      }
    })

    adm.get<{ Params: { id: string } }>('/gamedays/:id', async (req, reply) => {
      try {
        return { data: await gamedayDetail(String(req.params.id)) }
      } catch (err) {
        return fail(reply, err)
      }
    })

    adm.get('/blind', async () => ({ data: blindWindows() }))
  })

  // ── Chaos operators: plan, run, end ───────────────────────────────────────
  await app.register(async (ops) => {
    ops.addHook('preHandler', requireChaosOperator)

    ops.post<{ Body: Record<string, unknown> }>('/gamedays', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      try {
        const out = await createGameday(req.body ?? {}, await who(req), app)
        await logActivity({
          action: 'chaos-gameday-plan',
          user: req.user?.id,
          comment: `Game day planned for ${gamedayMeta(out.run).plan.starts_at} (${participantsOf(gamedayMeta(out.run).plan).length} people)`,
          req
        })
        return reply.code(201).send({ data: out })
      } catch (err) {
        return fail(reply, err)
      }
    })

    ops.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
      '/gamedays/:id',
      async (req, reply) => {
        const refused = gated(reply)
        if (refused) return refused
        try {
          return {
            data: await updateGameday(String(req.params.id), req.body ?? {}, await who(req), app)
          }
        } catch (err) {
          return fail(reply, err)
        }
      }
    )

    ops.post<{ Params: { id: string } }>('/gamedays/:id/start', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      try {
        const run = await startGameday(String(req.params.id), await who(req), { app })
        await logActivity({
          action: 'chaos-gameday-start',
          user: req.user?.id,
          comment: `Game day ${run.id} started`,
          req
        })
        return { data: run }
      } catch (err) {
        return fail(reply, err)
      }
    })

    ops.post<{ Params: { id: string }; Body: { inject_id?: string } }>(
      '/gamedays/:id/step',
      async (req, reply) => {
        const refused = gated(reply)
        if (refused) return refused
        try {
          const ev = await stepGameday(
            String(req.params.id),
            String(req.body?.inject_id ?? ''),
            await who(req),
            app
          )
          return { data: ev }
        } catch (err) {
          return fail(reply, err)
        }
      }
    )

    // Ending is never gated: whatever the gate says, a running day can always be closed.
    ops.post<{ Params: { id: string }; Body: { how?: string; reason?: string } }>(
      '/gamedays/:id/end',
      async (req, reply) => {
        try {
          const how = req.body?.how === 'aborted' ? 'aborted' : 'completed'
          const run = await endGameday(String(req.params.id), how, await who(req), {
            reason: req.body?.reason ? String(req.body.reason).slice(0, 200) : undefined,
            app
          })
          if (!run) return reply.code(409).send({ error: 'The game day is not running' })
          await logActivity({
            action: 'chaos-gameday-end',
            user: req.user?.id,
            comment: `Game day ${run.id} ${how}`,
            req
          })
          return { data: run }
        } catch (err) {
          return fail(reply, err)
        }
      }
    )

    ops.post<{ Params: { id: string } }>('/gamedays/:id/cancel', async (req, reply) => {
      try {
        return { data: await cancelGameday(String(req.params.id), await who(req), app) }
      } catch (err) {
        return fail(reply, err)
      }
    })

    ops.post<{ Params: { id: string } }>('/gamedays/:id/reveal', async (req, reply) => {
      try {
        return { data: await revealGameday(String(req.params.id), await who(req), app) }
      } catch (err) {
        return fail(reply, err)
      }
    })

    // One drill, blind (#2854): the window opens before the fault is armed.
    ops.post<{ Body: Partial<StartDrillInput> }>('/blind/runs', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      const b = req.body ?? {}
      const me = await who(req)
      if (!me.id) return reply.code(401).send({ error: 'Sign in' })
      const seconds = Math.max(5, Math.min(3600, Number(b.seconds) || 60))
      const windowId = randomUUID()
      await openBlindWindow({
        id: windowId,
        kind: 'run',
        lead: me.id,
        until: Date.now() + (seconds + 120) * 1000
      })
      try {
        const out = await startDrill({
          fault_key: String(b.fault_key ?? ''),
          target: b.target,
          params: b.params,
          seconds: b.seconds,
          hypothesis: b.hypothesis ?? null,
          override: b.override ?? null,
          note: b.note ?? null,
          by: { id: me.id, name: me.name }
        })
        await bindBlindRun(windowId, out.run.id)
        // Read by drill-alert routing (#2847): drill tags go to the lead + operators only.
        await updateRun(out.run.id, { meta: { ...out.run.meta, blind: true, lead: me.id } })
        await logActivity({
          action: 'chaos-run',
          user: req.user?.id,
          comment: `Blind chaos drill ${out.fault.fault_key}`,
          req
        })
        return reply.code(201).send({ data: { ...out, blind_window: windowId } })
      } catch (err) {
        await closeBlindWindow(windowId)
        return fail(reply, err)
      }
    })

    ops.post<{ Params: { id: string } }>('/blind/runs/:id/reveal', async (req, reply) => {
      const w = windowOfRun(String(req.params.id))
      if (!w) return reply.code(404).send({ error: 'That run is not blind' })
      if (w.kind === 'gameday') {
        try {
          return { data: await revealGameday(w.id, await who(req), app) }
        } catch (err) {
          return fail(reply, err)
        }
      }
      await revealBlindWindow(w.id)
      const run = await getRun(String(req.params.id))
      if (run) await updateRun(run.id, { meta: { ...run.meta, blind: false } })
      return { data: { revealed: true } }
    })
  })
}
