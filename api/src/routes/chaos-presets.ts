import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { requireAdmin } from '../middleware/authenticate.js'
import { logActivity } from '../services/activity.js'
import { getFault } from '../services/chaos/catalog.js'
import { startDrill } from '../services/chaos/drill.js'
import { ChaosError, chaosRefusal } from '../services/chaos/gate.js'
import { requireChaosOperator } from '../services/chaos/operator.js'
import {
  type ChaosPreset,
  deletePreset,
  getPreset,
  listPresets,
  type PresetInput,
  type PresetSpec,
  presetStoreMode,
  savePreset,
  updatePreset
} from '../services/chaos/presets.js'
import { CHAOS_NODE } from '../services/chaos/registry.js'
import { updateRun } from '../services/chaos/runs.js'

/**
 * Fault presets (#2855) under /api/chaos/presets — saved scenarios plus the shipped ones.
 *
 *   GET    /             admin     { store, presets: [... + fault: {installed, label, danger}] }
 *   GET    /:key         admin     one preset (by key or id)
 *   POST   /             operator  create {key, label, description, proves, claim_keys, spec}
 *   PATCH  /:key         operator  edit (a shipped key becomes a saved override)
 *   DELETE /:key         operator  delete a saved preset (an override's shipped preset comes back)
 *   POST   /:key/run     operator  start a drill from the preset; body overrides any spec field
 *                                  {target, params, seconds, hypothesis, override, note}
 *
 * Writes answer the chaos gate's refusal like every chaos route; reads always answer.
 */

const UUID_RE = /^[0-9a-f-]{36}$/i

/**
 * A preset without a target takes its fault's first target kind. A replica-only fault (a shipped
 * "one replica" preset) gets the replica answering the request — the builder picks one itself.
 */
function presetTarget(spec: PresetSpec): unknown {
  if (spec.target) return spec.target
  return getFault(spec.fault_key)?.targets[0] === 'node'
    ? { kind: 'node', node: CHAOS_NODE }
    : undefined
}

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

/** The caller. The display name never falls back to the email (it lands on run meta). */
function who(req: FastifyRequest): { id: string | null; name: string | null } {
  const u = req.user as
    | { id?: string; first_name?: string | null; last_name?: string | null }
    | undefined
  if (!u) return { id: null, name: null }
  return {
    id: u.id ?? null,
    name: [u.first_name, u.last_name].filter(Boolean).join(' ') || null
  }
}

function gated(reply: FastifyReply): FastifyReply | null {
  const why = chaosRefusal()
  return why ? reply.code(403).send({ error: why, code: 'CHAOS_GATE' }) : null
}

/** A preset plus whether this instance has its fault. */
function withFault(p: ChaosPreset) {
  const def = getFault(p.spec.fault_key)
  return {
    ...p,
    fault: def
      ? { installed: true, label: def.label, danger: def.danger ?? 'low' }
      : { installed: false, label: p.spec.fault_key, danger: null }
  }
}

export async function chaosPresetRoutes(app: FastifyInstance): Promise<void> {
  await app.register(async (adm) => {
    adm.addHook('preHandler', requireAdmin)

    adm.get('/', async () => {
      const [presets, store] = await Promise.all([listPresets(), presetStoreMode()])
      return { data: { store, presets: presets.map(withFault) } }
    })

    adm.get<{ Params: { key: string } }>('/:key', async (req, reply) => {
      const p = await getPreset(String(req.params.key))
      if (!p)
        return reply.code(404).send({ error: 'No such preset', code: 'CHAOS_PRESET_NOT_FOUND' })
      return { data: withFault(p) }
    })
  })

  await app.register(async (ops) => {
    ops.addHook('preHandler', requireChaosOperator)

    ops.post<{ Body: PresetInput }>('/', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      try {
        const p = await savePreset(req.body ?? {}, who(req), { mustBeNew: true })
        await logActivity({
          action: 'chaos-preset-save',
          user: req.user?.id,
          comment: `Chaos preset ${p.key} saved (${p.spec.fault_key})`,
          req
        })
        return reply.code(201).send({ data: withFault(p) })
      } catch (err) {
        return fail(reply, err)
      }
    })

    ops.patch<{ Params: { key: string }; Body: PresetInput }>('/:key', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      try {
        const p = await updatePreset(String(req.params.key), req.body ?? {}, who(req))
        await logActivity({
          action: 'chaos-preset-save',
          user: req.user?.id,
          comment: `Chaos preset ${p.key} edited`,
          req
        })
        return { data: withFault(p) }
      } catch (err) {
        return fail(reply, err)
      }
    })

    ops.delete<{ Params: { key: string } }>('/:key', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      try {
        const out = await deletePreset(String(req.params.key))
        await logActivity({
          action: 'chaos-preset-delete',
          user: req.user?.id,
          comment: `Chaos preset ${req.params.key} deleted${out.restored ? ' (shipped preset restored)' : ''}`,
          req
        })
        return { data: out }
      } catch (err) {
        return fail(reply, err)
      }
    })

    ops.post<{
      Params: { key: string }
      Body: {
        target?: unknown
        params?: unknown
        seconds?: unknown
        hypothesis?: unknown
        abort_after?: unknown
        override?: { working_hours?: boolean } | null
        note?: string | null
      }
    }>('/:key/run', async (req, reply) => {
      const refused = gated(reply)
      if (refused) return refused
      const p = await getPreset(String(req.params.key))
      if (!p)
        return reply.code(404).send({ error: 'No such preset', code: 'CHAOS_PRESET_NOT_FOUND' })
      const b = req.body ?? {}
      try {
        const { run, fault } = await startDrill({
          fault_key: p.spec.fault_key,
          target: b.target ?? presetTarget(p.spec),
          params: b.params ?? p.spec.params,
          seconds: b.seconds ?? p.spec.seconds,
          hypothesis: (Array.isArray(b.hypothesis) ? b.hypothesis : p.spec.hypothesis) ?? null,
          // The working-hours override is an administrator's call, not an operator's (#2862, F6).
          override: req.isAdmin ? (b.override ?? null) : null,
          abort_after: b.abort_after ?? p.spec.abort_after,
          note: b.note ?? p.spec.note ?? null,
          // The run column is a uuid: shipped presets (no id) ride meta.preset_key only.
          preset_id: p.id && UUID_RE.test(p.id) ? p.id : null,
          by: who(req)
        })
        const stored =
          (await updateRun(run.id, {
            meta: { ...run.meta, preset_key: p.key, preset_label: p.label }
          })) ?? run
        await logActivity({
          action: 'chaos-run',
          user: req.user?.id,
          comment: `Chaos drill ${fault.fault_key} from preset ${p.key} for ${Math.round((fault.ends_at - fault.started_at) / 1000)}s`,
          req
        })
        return reply.code(201).send({ data: { run: stored, fault } })
      } catch (err) {
        return fail(reply, err)
      }
    })
  })
}
