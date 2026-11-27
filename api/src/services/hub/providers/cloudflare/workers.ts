import { typedName } from '../plan-words.js'
import type {
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import {
  accountPath,
  cfCall,
  checkId,
  checkScriptName,
  checkSecretName,
  joinId,
  nextCursor,
  pageOf,
  type RawZone,
  readZone,
  requireZone,
  splitId
} from './client.js'
import {
  arr,
  FULL_CAPS,
  isSecret,
  ok,
  type PlanCfg,
  planGeneric,
  str,
  type TypeImpl
} from './common.js'
import { includedEstimate, workerRouteEstimate } from './pricing.js'
import { ZONE } from './zone.js'

/**
 * Workers pieces an app owns (the script itself is not in scope: scripts come from the app's own
 * CI):
 *
 *  - `cloudflare.worker_route`   a route pattern on a zone that sends matching requests to a
 *                                script (or, with no script, switches Workers off for the pattern).
 *                                External id `<zoneId>:<routeId>`.
 *  - `cloudflare.worker_secret`  one secret of a script (write-only). External id
 *                                `<script>:<name>`. The value is sent once and never read back;
 *                                a change is a new value pasted into the sealed field.
 */

export const WORKER_ROUTE = 'cloudflare.worker_route'
export const WORKER_SECRET = 'cloudflare.worker_secret'

/** A pattern whose host part is `*` matches every hostname of the zone. */
export const isBroadRoute = (pattern: string): boolean => /^\*(\/|$)/.test(pattern.trim())

export const workerRouteSpec: ResourceTypeSpec = {
  key: WORKER_ROUTE,
  label: 'Worker route',
  scope: 'app',
  nameField: 'pattern',
  fields: [
    {
      key: 'zone',
      label: 'Zone',
      kind: 'ref',
      refType: ZONE,
      required: true,
      replaceOnChange: true
    },
    {
      key: 'pattern',
      label: 'Route pattern',
      kind: 'string',
      required: true,
      help: 'Like app.example.com/* (the host and path requests must match).'
    },
    {
      key: 'script',
      label: 'Worker script',
      kind: 'string',
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$',
      help: 'The script that handles it. Empty = no Worker runs for this pattern.'
    }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: true,
  refs: [{ field: 'zone', type: ZONE, required: true }],
  risk(op, desired): RiskFlag[] {
    if (op.kind === 'noop') return []
    const flags = new Set<RiskFlag>()
    // Changing or removing a live route moves real traffic; so does a route over every hostname.
    if (op.kind === 'update' || op.kind === 'delete' || op.kind === 'replace') flags.add('downtime')
    if (op.kind === 'delete' || op.kind === 'replace') flags.add('destructive')
    if (op.kind === 'create' && isBroadRoute(String(desired?.fields.pattern ?? '')))
      flags.add('downtime')
    return [...flags]
  },
  estimate: workerRouteEstimate
}

export const workerSecretSpec: ResourceTypeSpec = {
  key: WORKER_SECRET,
  label: 'Worker secret',
  scope: 'app',
  nameField: 'name',
  fields: [
    {
      key: 'script',
      label: 'Worker script',
      kind: 'string',
      required: true,
      replaceOnChange: true,
      pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$',
      help: 'The script must already exist (it is uploaded by the app’s own CI).'
    },
    {
      key: 'name',
      label: 'Secret name',
      kind: 'string',
      required: true,
      replaceOnChange: true,
      pattern: '^[A-Za-z_][A-Za-z0-9_]{0,127}$'
    },
    { key: 'value', label: 'Value', kind: 'secret', required: true }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: false,
  refs: [],
  risk(op): RiskFlag[] {
    if (op.kind === 'delete' || op.kind === 'replace') return ['destructive']
    return []
  },
  estimate: includedEstimate('Worker secrets are included with the Worker.')
}

// ── Routes ──

interface RawRoute {
  id: string
  pattern: string
  script?: string | null
}

function observedRoute(zone: { id: string; name: string }, raw: RawRoute): Observed {
  return {
    type: WORKER_ROUTE,
    externalId: joinId(zone.id, raw.id),
    name: raw.pattern,
    fields: { zone: zone.id, pattern: raw.pattern, script: str(raw.script) },
    tags: {},
    url: `https://dash.cloudflare.com/${encodeURIComponent(zone.name)}/workers/routes`
  }
}

async function zoneRoutes(ctx: ProviderContext, zoneId: string): Promise<RawRoute[]> {
  const res = await cfCall<RawRoute[]>(
    ctx,
    'GET',
    `/zones/${checkId(zoneId, 'zone id')}/workers/routes`
  )
  return arr(res.result) as RawRoute[]
}

const routeCfg: PlanCfg = {
  spec: workerRouteSpec,
  writable: ['zone', 'pattern', 'script'],
  replaceOn: ['zone'],
  nameOf: (f, o) => String(f.pattern ?? o?.name ?? ''),
  createHint:
    'a route with the same pattern that the Hub did not create is refused: adopt it instead'
}

export const workerRouteImpl: TypeImpl = {
  spec: workerRouteSpec,
  permissions: [
    {
      need: 'read Workers routes',
      group: 'Workers Routes Write',
      async probe(ctx) {
        const zones = await cfCall<RawZone[]>(ctx, 'GET', '/zones', {
          query: { 'account.id': String(ctx.config.accountId), per_page: 1 }
        })
        const z = arr(zones.result)[0] as RawZone | undefined
        if (!z) return null
        await zoneRoutes(ctx, z.id)
        return true
      }
    }
  ],
  async observe(ctx, externalId) {
    const ids = splitId(externalId)
    if (!ids) return null
    checkId(ids[1], 'route id')
    const zone = await readZone(ctx, ids[0])
    if (!zone) return null
    const res = await cfCall<RawRoute>(
      ctx,
      'GET',
      `/zones/${checkId(zone.id)}/workers/routes/${checkId(ids[1], 'route id')}`,
      { allow: [404] }
    )
    return res.status === 404 || !res.result ? null : observedRoute(zone, res.result)
  },
  async list(ctx, cursor): Promise<ListPage> {
    // One zone per page.
    const page = pageOf(cursor)
    const zones = await cfCall<RawZone[]>(ctx, 'GET', '/zones', {
      query: { 'account.id': String(ctx.config.accountId), page, per_page: 1 }
    })
    const z = (arr(zones.result) as RawZone[]).find(
      (x) => x.account?.id === String(ctx.config.accountId)
    )
    if (!z) return { items: [], cursor: null }
    const items = (await zoneRoutes(ctx, z.id)).map((r) => observedRoute(z, r))
    return { items, cursor: nextCursor(zones.info, page) }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const zoneId = desired.refs.zone
    const pattern = str(desired.fields.pattern)
    if (typeof zoneId !== 'string' || !pattern) return null
    const zone = await readZone(ctx, zoneId)
    if (!zone) return null
    const hit = (await zoneRoutes(ctx, zone.id)).find((r) => r.pattern === pattern)
    return hit ? observedRoute(zone, hit) : null
  },
  plan: (_ctx, desired, observed) => planGeneric(routeCfg, desired, observed),
  async apply(ctx, op, desired): Promise<OpResult> {
    const ids = op.externalId ? splitId(op.externalId) : null
    if (op.kind === 'noop')
      return ok(
        op.externalId ? await workerRouteImpl.observe(ctx, op.externalId) : null,
        op.externalId,
        200
      )
    const remove = async (): Promise<OpResult> => {
      if (!ids) throw new ProviderError('BAD_ID', 'The route to remove is not known.')
      const zone = await requireZone(ctx, ids[0])
      await cfCall(
        ctx,
        'DELETE',
        `/zones/${checkId(zone.id)}/workers/routes/${checkId(ids[1], 'route id')}`,
        {
          allow: [404]
        }
      )
      return ok(null, op.externalId, 200)
    }
    const create = async (): Promise<OpResult> => {
      const zoneId = desired?.refs.zone
      if (typeof zoneId !== 'string')
        throw new ProviderError(
          'REF_UNRESOLVED',
          'The zone this route belongs to is not known yet.'
        )
      const pattern = str(desired?.fields.pattern)
      if (!pattern) throw new ProviderError('INVALID', 'A route needs a pattern.')
      const script = str(desired?.fields.script)
      if (script) checkScriptName(script)
      const zone = await requireZone(ctx, zoneId)
      const clash = (await zoneRoutes(ctx, zone.id)).find((r) => r.pattern === pattern)
      if (clash) {
        if (desired?.externalId) return update(joinId(zone.id, clash.id))
        throw new ProviderError(
          'ALREADY_EXISTS',
          `A route for ${pattern} already exists in ${zone.name} and was not created by the Hub. Adopt it instead of creating it.`,
          { status: 409 }
        )
      }
      const res = await cfCall<RawRoute>(ctx, 'POST', `/zones/${checkId(zone.id)}/workers/routes`, {
        body: script ? { pattern, script } : { pattern }
      })
      return ok(observedRoute(zone, res.result), joinId(zone.id, res.result.id), res.status)
    }
    const update = async (externalId: string): Promise<OpResult> => {
      const parts = splitId(externalId)
      if (!parts || !desired) throw new ProviderError('BAD_ID', 'The route to change is not known.')
      const zone = await requireZone(ctx, parts[0])
      const pattern = str(desired.fields.pattern)
      if (!pattern) throw new ProviderError('INVALID', 'A route needs a pattern.')
      const script = str(desired.fields.script)
      if (script) checkScriptName(script)
      const res = await cfCall<RawRoute>(
        ctx,
        'PUT',
        `/zones/${checkId(zone.id)}/workers/routes/${checkId(parts[1], 'route id')}`,
        { body: script ? { pattern, script } : { pattern } }
      )
      return ok(
        observedRoute(zone, res.result ?? { id: parts[1], pattern, script }),
        externalId,
        res.status
      )
    }
    switch (op.kind) {
      case 'create':
        return create()
      case 'update':
        if (!op.externalId) throw new ProviderError('INVALID', 'An update needs a route.')
        return update(op.externalId)
      case 'delete':
        return remove()
      case 'replace':
        if (op.externalId) await remove()
        return create()
      default:
        throw new ProviderError('INVALID', `Unknown operation ${String(op.kind)}.`)
    }
  }
}

// ── Secrets ──

const secretsPath = (ctx: ProviderContext, script: string) =>
  `${accountPath(ctx)}/workers/scripts/${checkScriptName(script)}/secrets`

function observedSecret(script: string, name: string): Observed {
  return {
    type: WORKER_SECRET,
    externalId: joinId(script, name),
    name: `${script} · ${name}`,
    fields: { script, name },
    tags: {}
  }
}

async function getSecret(
  ctx: ProviderContext,
  script: string,
  name: string
): Promise<Observed | null> {
  const res = await cfCall<{ name?: string }>(
    ctx,
    'GET',
    `${secretsPath(ctx, script)}/${checkSecretName(name)}`,
    { allow: [404] }
  )
  return res.status === 404 || !res.result ? null : observedSecret(script, name)
}

const secretCfg: PlanCfg = {
  spec: workerSecretSpec,
  writable: ['value'],
  replaceOn: ['script', 'name'],
  nameOf: (f, o) => String(f.name ?? o?.fields.name ?? ''),
  createHint:
    'a secret with the same name on the script that the Hub did not create is refused: adopt it instead'
}

export const workerSecretImpl: TypeImpl = {
  spec: workerSecretSpec,
  permissions: [
    {
      need: 'read Workers scripts',
      group: 'Workers Scripts Write',
      async probe(ctx) {
        await cfCall(ctx, 'GET', `${accountPath(ctx)}/workers/scripts`)
        return true
      }
    }
  ],
  observe: async (ctx, externalId) => {
    const ids = splitId(externalId)
    return ids ? getSecret(ctx, ids[0], ids[1]) : null
  },
  async list(ctx, cursor): Promise<ListPage> {
    // The script list is not paged; five scripts' secrets are read per call.
    const scripts = await cfCall<Array<{ id?: string }>>(
      ctx,
      'GET',
      `${accountPath(ctx)}/workers/scripts`
    )
    const names = (arr(scripts.result) as Array<{ id?: string }>)
      .map((s) => s.id)
      .filter((n): n is string => typeof n === 'string')
    const from = Math.max(0, Number.parseInt(cursor ?? '0', 10) || 0)
    const items: Observed[] = []
    for (const script of names.slice(from, from + 5)) {
      const res = await cfCall<Array<{ name?: string }>>(ctx, 'GET', secretsPath(ctx, script), {
        allow: [404]
      })
      for (const s of arr(res.result) as Array<{ name?: string }>)
        if (typeof s.name === 'string') items.push(observedSecret(script, s.name))
    }
    return { items, cursor: from + 5 < names.length ? String(from + 5) : null }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const script = str(desired.fields.script)
    const name = str(desired.fields.name)
    return script && name ? getSecret(ctx, script, name) : null
  },
  plan: (_ctx, desired, observed): PlannedOp[] => {
    const ops = planGeneric(secretCfg, desired, observed)
    // A change of an existing secret reads as "Change Value on Worker secret X": say what it is.
    return ops.map((op) =>
      op.kind === 'update'
        ? {
            ...op,
            reason: `Set a new value for ${typedName(workerSecretSpec.label, String(observed?.fields.name ?? ''))} (the value is sent once and never shown).`
          }
        : op
    )
  },
  async apply(ctx, op, desired): Promise<OpResult> {
    const put = async (script: string, name: string): Promise<OpResult> => {
      const v = desired?.fields.value
      if (!isSecret(v) || !v.plain)
        throw new ProviderError('INVALID', 'A Worker secret needs its value.')
      const res = await cfCall(ctx, 'PUT', secretsPath(ctx, script), {
        body: { name: checkSecretName(name), text: v.plain, type: 'secret_text' },
        extraScrub: [v.plain]
      })
      return ok(observedSecret(script, name), joinId(script, name), res.status)
    }
    switch (op.kind) {
      case 'noop':
        return ok(
          op.externalId ? await workerSecretImpl.observe(ctx, op.externalId) : null,
          op.externalId,
          200
        )
      case 'create': {
        if (!desired) throw new ProviderError('INVALID', 'A create needs the wanted values.')
        const script = checkScriptName(desired.fields.script)
        const name = checkSecretName(desired.fields.name)
        const have = await getSecret(ctx, script, name)
        if (have && !desired.externalId)
          throw new ProviderError(
            'ALREADY_EXISTS',
            `${script} already has a secret named ${name} that the Hub did not create. Adopt it instead of creating it.`,
            { status: 409 }
          )
        return put(script, name)
      }
      case 'update': {
        const ids = op.externalId ? splitId(op.externalId) : null
        if (!ids || !desired) throw new ProviderError('INVALID', 'An update needs a secret.')
        const have = await getSecret(ctx, ids[0], ids[1])
        if (!have)
          throw new ProviderError('NOT_FOUND', 'The secret no longer exists at Cloudflare.', {
            status: 404
          })
        return put(ids[0], ids[1])
      }
      case 'delete': {
        const ids = op.externalId ? splitId(op.externalId) : null
        if (!ids) throw new ProviderError('BAD_ID', 'The secret to delete is not known.')
        const res = await cfCall(
          ctx,
          'DELETE',
          `${secretsPath(ctx, ids[0])}/${checkSecretName(ids[1])}`,
          {
            allow: [404]
          }
        )
        return ok(null, op.externalId, res.status)
      }
      case 'replace': {
        if (!desired) throw new ProviderError('INVALID', 'A replace needs the wanted values.')
        const ids = op.externalId ? splitId(op.externalId) : null
        if (ids)
          await cfCall(ctx, 'DELETE', `${secretsPath(ctx, ids[0])}/${checkSecretName(ids[1])}`, {
            allow: [404]
          })
        return put(checkScriptName(desired.fields.script), checkSecretName(desired.fields.name))
      }
      default:
        throw new ProviderError('INVALID', `Unknown operation ${String(op.kind)}.`)
    }
  }
}
