import type { ListPage, Observed, ResourceTypeSpec } from '../types.js'
import { ProviderError } from '../types.js'
import {
  accountIdOf,
  cfCall,
  checkId,
  nextCursor,
  pageOf,
  type RawZone,
  readZone
} from './client.js'
import { asObj, type PlanCfg, planGeneric, str, strs, type TypeImpl } from './common.js'
import { zoneEstimate } from './pricing.js'

/**
 * `cloudflare.zone` (shared): a DNS zone of the pinned account. The Hub adopts and reads zones; it
 * never creates, edits or deletes one. Other types point at it through a `ref` field (DNS records,
 * WAF rules, Worker routes) — Task 38 (ACME) and Task 43 (Registrar) reuse this type and
 * `readZone` from client.ts.
 */

export const ZONE = 'cloudflare.zone'

export const zoneSpec: ResourceTypeSpec = {
  key: ZONE,
  label: 'Cloudflare zone',
  scope: 'shared',
  fields: [
    { key: 'name', label: 'Zone name', kind: 'string', readOnly: true },
    { key: 'status', label: 'Status', kind: 'string', readOnly: true },
    { key: 'plan', label: 'Plan', kind: 'string', readOnly: true },
    { key: 'paused', label: 'Paused', kind: 'boolean', readOnly: true },
    {
      key: 'name_servers',
      label: 'Name servers',
      kind: 'list',
      readOnly: true,
      items: { key: 'item', label: 'Name server', kind: 'string' }
    }
  ],
  capabilities: {
    create: false,
    update: false,
    delete: false,
    adopt: true,
    snapshot: false,
    tag: false
  },
  reversible: false,
  refs: [],
  risk: () => [],
  estimate: zoneEstimate
}

export function observedZone(z: RawZone | null): Observed | null {
  if (!z?.id) return null
  const o = asObj(z)
  return {
    type: ZONE,
    externalId: z.id,
    name: str(z.name),
    fields: {
      name: str(z.name),
      status: str(z.status),
      plan: str(asObj(o.plan).name),
      paused: o.paused === true,
      name_servers: strs(o.name_servers)
    },
    tags: {},
    status: str(z.status),
    url: null
  }
}

const cfg: PlanCfg = { spec: zoneSpec, writable: [], nameOf: (f) => String(f.name ?? '') }

export const zoneImpl: TypeImpl = {
  spec: zoneSpec,
  permissions: [
    {
      need: 'read zones',
      group: 'Zone Read',
      async probe(ctx) {
        await cfCall(ctx, 'GET', '/zones', {
          query: { 'account.id': accountIdOf(ctx), per_page: 1 }
        })
        return true
      }
    }
  ],
  async observe(ctx, externalId) {
    const z = await readZone(ctx, checkId(externalId, 'zone id'))
    const o = observedZone(z)
    if (o && z) o.url = `https://dash.cloudflare.com/${accountIdOf(ctx)}/${z.name}`
    return o
  },
  async list(ctx, cursor): Promise<ListPage> {
    const page = pageOf(cursor)
    const res = await cfCall<RawZone[]>(ctx, 'GET', '/zones', {
      query: { 'account.id': accountIdOf(ctx), page, per_page: 50 }
    })
    const items: Observed[] = []
    for (const z of Array.isArray(res.result) ? res.result : []) {
      // Defence in depth: the account filter is the provider's, the check is ours.
      if (z.account?.id !== accountIdOf(ctx)) continue
      const o = observedZone(z)
      if (o) {
        o.url = `https://dash.cloudflare.com/${accountIdOf(ctx)}/${z.name}`
        items.push(o)
      }
    }
    return { items, cursor: nextCursor(res.info, page) }
  },
  plan(_ctx, desired, observed) {
    return planGeneric(cfg, desired, observed)
  },
  async apply(ctx, op) {
    if (op.kind === 'noop') {
      const observed = op.externalId ? await zoneImpl.observe(ctx, op.externalId) : null
      return { ok: true, externalId: op.externalId, observed, answer: { status: 200 } }
    }
    throw new ProviderError(
      'NOT_SUPPORTED',
      'The Hub adopts Cloudflare zones; it does not create, change or delete them.'
    )
  }
}
