// Task 11a (Hub providers): Create app's `providers` step — the parts the Hub makes for an
// environment through the provider change engine, right after its database and before anything is
// deployed or named:
//
//   - the optional parts the person picked for the environment (`providers` in the request):
//       vercel.project       a Vercel project,
//       auth0.application    an Auth0 application whose callback, logout and origin URLs are the
//                            environment's address (filled when the request leaves them out),
//       aws.route53_record   a Route 53 record,
//       aws.rds_instance     an RDS instance (link it as a database server on Databases once it is
//                            available; the environment's own database is the one the request
//                            names);
//       livekit.api_key      (Task 43) a LiveKit Cloud key pair, bound to the app's huddle settings
//                            (huddle_livekit_url / _key / _secret) so nobody copies it;
//       acme.certificate     (Task 43) a TLS certificate for the environment's name, on a Docker
//                            driver whose names are made by hand (the planner refuses it elsewhere);
//   - and, on a driver or target whose DNS mode is `route53`, the environment's name record in the
//     hosted zone (create/dns-route53.ts), so the name step finds it resolving.
//
// One change per connection, carried by the creation (origin `creation`: the engine checks this
// creation is running for this environment, and lets only creates / adopts / updates through).
// The change ids are kept in the creation's `made.provider_changes`, so a retry picks each one up
// where it stopped (runCarriedChange); a part this environment already has (a live managed row of
// the same type, connection and name, made by an earlier try) is not made twice.
//
// The parts' field values may hold secrets (an RDS master password): the request's list is sealed
// at the start (`made.planned.providers_sealed`) and opened only here, for the call that plans the
// change — the engine seals new secret values in its own envelope.

import type { PlanRequest, PlanRequestOp } from '../providers/engine/contract.js'
import { hubActorForUser, runCarriedChange } from '../providers/hooks/carried.js'
import { type HubResourceRow, listResources } from '../providers/store.js'
import { openSecret } from '../secrets.js'
import { recordOp, route53Zone, zoneResourceIdOf } from './dns-route53.js'
import {
  type CreateProviderPart,
  partBindings,
  partFields,
  partName,
  providerPartsOf
} from './provider-parts.js'
import type { BaseStepContext, StepResult } from './steps.js'
import { StepFailure } from './steps.js'

/** The naming config of the creation's driver / target (dns mode, zone, edge). */
export interface ProviderNaming {
  dns_mode?: unknown
  dns_zone_resource_id?: unknown
  wildcard_domain?: string | null
  /** What a record points at: a Docker driver's edge_target, a target's edge_address. */
  edge?: string | null
}

/** The `providers` step. `naming` = the driver / target the environment is named by. */
export async function stepProviders(
  ctx: BaseStepContext,
  naming: ProviderNaming | null
): Promise<StepResult> {
  const planned = ctx.made.planned
  let parts: CreateProviderPart[] = []
  if (planned?.providers_sealed) {
    const plain = openSecret(planned.providers_sealed)
    const checked = providerPartsOf(plain ? JSON.parse(plain) : [])
    if (!checked.ok) throw new StepFailure('BAD_PROVIDER_PART', checked.text)
    parts = checked.parts
  }
  const ops = new Map<number, PlanRequestOp[]>()
  const add = (conn: number, op: PlanRequestOp) => ops.set(conn, [...(ops.get(conn) ?? []), op])
  const have = await listResources({ appId: ctx.app.id, environmentId: ctx.env.id }).catch(
    () => [] as HubResourceRow[]
  )
  const made = (type: string, conn: number, name: unknown) =>
    typeof name === 'string' &&
    have.some(
      (r) =>
        r.type === type &&
        r.connection_id === conn &&
        (r.name === name || r.desired?.name === name || r.observed?.name === name)
    )
  for (const p of parts) {
    const fields = partFields(p, ctx.env.base_url)
    if (made(p.type, p.connection_id, partName({ ...p, fields }))) continue
    add(p.connection_id, { action: 'create', type: p.type, fields })
  }

  if (naming?.dns_mode === 'route53') {
    const zoneId = zoneResourceIdOf(naming.dns_zone_resource_id)
    const host = planned?.hostname ?? ctx.env.hostnames[0] ?? ''
    if (!zoneId || !host || !naming.edge)
      throw new StepFailure(
        'DNS_ZONE_MISSING',
        'Route 53 names need the hosted zone, a hostname and the edge address.'
      )
    const zone = await route53Zone(zoneId, naming.wildcard_domain ?? null)
    if (!zone.ok) throw new StepFailure('DNS_ZONE_MISSING', zone.message)
    const op = recordOp(zone.zoneResourceId, host, naming.edge)
    if (!made('aws.route53_record', zone.connectionId, op.fields?.name)) add(zone.connectionId, op)
  }
  if (!ops.size) return { status: 'done', note: 'No provider parts for this environment.' }

  const actor = await hubActorForUser(ctx.creation.started_by)
  if (!actor)
    throw new StepFailure(
      'PROVIDER_ACTOR',
      'The person who started this creation can no longer act: retry it yourself.'
    )
  const record = ctx.made
  const changes: Record<string, number> = { ...(record.provider_changes ?? {}) }
  const done: string[] = []
  for (const [conn, list] of ops) {
    const req: PlanRequest = {
      connectionId: conn,
      scope: 'app',
      appId: ctx.app.id,
      environmentId: ctx.env.id,
      ops: list
    }
    const out = await runCarriedChange({
      req,
      actor,
      origin: { kind: 'creation', creationId: ctx.creation.id },
      changeId: changes[String(conn)] ?? null,
      onPlanned: async (id) => {
        changes[String(conn)] = id
        record.provider_changes = { ...changes }
        await ctx.saveMade()
      },
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      sleep: ctx.deps.sleep
    })
    if (out.status !== 'applied')
      throw new StepFailure(
        out.status === 'blocked' ? out.code : 'PROVIDER_CHANGE_FAILED',
        out.status === 'pending_approval'
          ? `Resource change #${out.changeId} waits for a Hub administrator's approval; retry once it is approved.`
          : `Resource change${out.changeId ? ` #${out.changeId}` : ''} did not apply: ${out.message}`
      )
    done.push(`#${out.changeId}`)
  }
  ctx.log(`provider parts: changes ${done.join(', ')} applied`)
  // Task 43: the default bindings of the parts made (a LiveKit key → the huddle settings).
  const bound = await bindParts(ctx, parts, actor).catch(() => [] as string[])
  if (bound.length) ctx.log(`provider parts: bound ${bound.join(', ')}`)
  return {
    status: 'done',
    note: `${[...ops.values()].flat().length} provider part(s) made (changes ${done.join(', ')}).`
  }
}

/**
 * Task 43: gives each made part its default bindings (provider-parts.ts partBindings), keeping any
 * binding a person already set, then pushes them in the background (an app setting reaches the app
 * once it answers on its hub link; until then the binding shows the push error and is pushed again
 * with the next change of its outputs or from the resource page). A refusal (a destination another
 * resource already feeds) is skipped, never a failed creation.
 */
async function bindParts(
  ctx: BaseStepContext,
  parts: CreateProviderPart[],
  actor: { id: string; isAdmin: boolean }
): Promise<string[]> {
  const wanted = parts.filter((p) => partBindings(p.type).length)
  if (!wanted.length) return []
  const { listBindings, schedulePush, setBindings } = await import(
    '../providers/engine/bindings.js'
  )
  const rows = await listResources({ appId: ctx.app.id, environmentId: ctx.env.id })
  const out: string[] = []
  for (const p of wanted) {
    const name = partName({ ...p, fields: partFields(p, ctx.env.base_url) })
    const row = rows.find(
      (r) =>
        r.type === p.type &&
        r.connection_id === p.connection_id &&
        (r.name === name || r.desired?.name === name || r.observed?.name === name || !name)
    )
    if (!row) continue
    const have = await listBindings(row.id)
    const add = partBindings(p.type)
      .map((b) => ({ ...b, environment_id: ctx.env.id }))
      .filter(
        (b) =>
          !have.some(
            (h) =>
              h.output_key === b.output_key &&
              h.environment_id === b.environment_id &&
              h.target === b.target &&
              h.target_key === b.target_key
          )
      )
    if (!add.length) continue
    try {
      await setBindings(
        row,
        [
          ...have.map((h) => ({
            output_key: h.output_key,
            environment_id: h.environment_id,
            target: h.target,
            target_key: h.target_key
          })),
          ...add
        ],
        actor
      )
      schedulePush(row.id, { actorId: actor.id })
      out.push(...add.map((b) => b.target_key))
    } catch {
      ctx.log(`provider parts: ${p.type} could not be bound (bind it on its resource page)`)
    }
  }
  return out
}
