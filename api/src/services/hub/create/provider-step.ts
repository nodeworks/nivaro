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

import type { HubActor, PlanRequest, PlanRequestOp } from '../providers/engine/contract.js'
import { hubActorForUser, runCarriedChange } from '../providers/hooks/carried.js'
import { type HubResourceRow, listResources, readConnection } from '../providers/store.js'
import { openSecret } from '../secrets.js'
import {
  isManagedDnsMode,
  MANAGED_DNS,
  recordOp,
  route53Zone,
  zoneResourceIdOf
} from './dns-route53.js'
import {
  type CreateProviderPart,
  ENTRA_APP_TYPE,
  ENTRA_SECRET_TYPE,
  entraIssuerOf,
  entraSecretFields,
  PART_BINDINGS,
  partFields,
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
  const rowNamed = (type: string, conn: number, name: unknown) =>
    typeof name === 'string'
      ? (have.find(
          (r) =>
            r.type === type &&
            r.connection_id === conn &&
            (r.name === name || r.desired?.name === name || r.observed?.name === name)
        ) ?? null)
      : null
  for (const p of parts) {
    const fields = partFields(p, ctx.env.base_url)
    if (p.type === ENTRA_APP_TYPE) {
      // Task 33: the app registration and, in the same change, its client secret (a negative ref
      // points at a create of this change). A retry makes only what is missing.
      const secret = entraSecretFields(ctx.app.key, ctx.env.key)
      const appRow = rowNamed(p.type, p.connection_id, fields.name)
      if (!appRow) {
        add(p.connection_id, { action: 'create', type: p.type, fields })
        const at = (ops.get(p.connection_id) ?? []).length - 1
        add(p.connection_id, {
          action: 'create',
          type: ENTRA_SECRET_TYPE,
          fields: { ...secret, application: { resourceId: -(at + 1) } }
        })
      } else if (!rowNamed(ENTRA_SECRET_TYPE, p.connection_id, secret.name))
        add(p.connection_id, {
          action: 'create',
          type: ENTRA_SECRET_TYPE,
          fields: { ...secret, application: { resourceId: appRow.id } }
        })
      continue
    }
    if (made(p.type, p.connection_id, fields.name)) continue
    add(p.connection_id, { action: 'create', type: p.type, fields })
  }

  // Route 53 (Task 11a) or Cloudflare (Task 33): the environment's name record in the zone.
  if (isManagedDnsMode(naming?.dns_mode)) {
    const mode = naming.dns_mode
    const zoneId = zoneResourceIdOf(naming.dns_zone_resource_id)
    const host = planned?.hostname ?? ctx.env.hostnames[0] ?? ''
    if (!zoneId || !host || !naming.edge)
      throw new StepFailure(
        'DNS_ZONE_MISSING',
        `${MANAGED_DNS[mode].label} names need the ${mode === 'route53' ? 'hosted zone' : 'zone'}, a hostname and the edge address.`
      )
    const zone = await route53Zone(zoneId, naming.wildcard_domain ?? null, mode)
    if (!zone.ok) throw new StepFailure('DNS_ZONE_MISSING', zone.message)
    const op = recordOp(zone.zoneResourceId, host, naming.edge, mode)
    if (!made(String(op.type), zone.connectionId, op.fields?.name)) add(zone.connectionId, op)
  }
  const bindsSomething = parts.some((p) => PART_BINDINGS[p.type]?.length)
  if (!ops.size && !bindsSomething)
    return { status: 'done', note: 'No provider parts for this environment.' }

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
  if (done.length) ctx.log(`provider parts: changes ${done.join(', ')} applied`)
  const bound = bindsSomething ? await bindParts(ctx, parts, actor) : 0
  return {
    status: 'done',
    note: `${[...ops.values()].flat().length} provider part(s) made${done.length ? ` (changes ${done.join(', ')})` : ''}${bound ? `; ${bound} value(s) bound to the stack` : ''}.`
  }
}

/**
 * Task 33: binds the parts' outputs to the environment's stack (PART_BINDINGS: the Entra client
 * id + secret as the stack's sign-in, a managed Redis's URL as REDIS_URL) and keeps the Entra
 * tenant's issuer in `made.entra_issuer` for the stack step. The bindings are the engine's own
 * (setBindings: the same checks as the Outputs card); the values are written when the stack step
 * has saved the stack settings (docker-steps.ts pushes them), never deployed here. Answers how many
 * bindings the environment holds from its parts.
 */
async function bindParts(
  ctx: BaseStepContext,
  parts: CreateProviderPart[],
  actor: HubActor
): Promise<number> {
  // Loaded here: the bindings module pulls the engine and every adapter (a static import closes
  // a cycle through promote-run → create steps → this file).
  const { BindingError, listBindings, setBindings } = await import(
    '../providers/engine/bindings.js'
  )
  const rows = await listResources({ appId: ctx.app.id, environmentId: ctx.env.id })
  const named = (type: string, conn: number, name: unknown) =>
    rows.find(
      (r) =>
        r.type === type &&
        r.connection_id === conn &&
        (r.name === name || r.desired?.name === name || r.observed?.name === name)
    ) ?? null
  let count = 0
  for (const p of parts) {
    const want = PART_BINDINGS[p.type]
    if (!want?.length) continue
    const fields = partFields(p, ctx.env.base_url)
    const partRow = named(p.type, p.connection_id, fields.name)
    const secretRow =
      p.type === ENTRA_APP_TYPE
        ? named(
            ENTRA_SECRET_TYPE,
            p.connection_id,
            entraSecretFields(ctx.app.key, ctx.env.key).name
          )
        : null
    for (const [which, row] of [
      ['part', partRow],
      ['secret', secretRow]
    ] as const) {
      const mine = want.filter((b) => b.resource === which)
      if (!mine.length) continue
      if (!row)
        throw new StepFailure(
          'PROVIDER_CHANGE_FAILED',
          `The ${which === 'secret' ? 'Entra client secret' : p.type} this environment needs is not there: retry the step.`
        )
      const before = await listBindings(row.id)
      const inputs = before.map((b) => ({
        output_key: b.output_key,
        environment_id: b.environment_id,
        target: b.target,
        target_key: b.target_key
      }))
      for (const b of mine)
        if (
          !inputs.some(
            (x) =>
              x.environment_id === ctx.env.id &&
              x.target === b.target &&
              x.target_key === b.target_key
          )
        )
          inputs.push({
            output_key: b.output_key,
            environment_id: ctx.env.id,
            target: b.target,
            target_key: b.target_key
          })
      try {
        await setBindings(row, inputs, actor)
      } catch (e) {
        if (e instanceof BindingError) throw new StepFailure(e.code, e.message)
        throw e
      }
      count += mine.length
    }
    if (p.type === ENTRA_APP_TYPE) {
      const conn = await readConnection(p.connection_id)
      const issuer = entraIssuerOf(conn?.config?.tenant_id)
      if (!issuer)
        throw new StepFailure(
          'BAD_PROVIDER_PART',
          'The Entra connection names no tenant: its sign-in issuer is unknown.'
        )
      if (ctx.made.entra_issuer !== issuer) {
        ctx.made.entra_issuer = issuer
        await ctx.saveMade()
      }
    }
  }
  return count
}
