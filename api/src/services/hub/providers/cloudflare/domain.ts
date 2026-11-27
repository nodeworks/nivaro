import { estimateOf, priceLookup, unknownEstimate } from '../pricing/index.js'
import { registrarHealth } from '../registrar.js'
import type {
  CostEstimate,
  DesiredResource,
  HealthAnswer,
  ListPage,
  Observed,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import { accountPath, cfCall, nextCursor, pageOf, seg } from './client.js'
import { asObj, ok, type PlanCfg, planGeneric, str, type TypeImpl } from './common.js'

/**
 * `cloudflare.domain` (shared, Task 43): a domain registered at Cloudflare Registrar in the pinned
 * account. Cloudflare's API reads and changes registrations but does not register or transfer in
 * (that is done in the Cloudflare dashboard), so the Hub adopts them:
 *
 *  - auto-renew (off = `downtime`: the domain then expires on its date),
 *  - transfer lock (off = `destructive`: it allows a transfer away; the Hub offers no transfer out
 *    and never reads an auth code),
 *  - WHOIS privacy / redaction (off = `public_exposure`: the contact details become public),
 *  - registrant contact and nameservers read only (Cloudflare Registrar domains use Cloudflare's
 *    own nameservers).
 *
 * Never deleted by the Hub. Health carries `expiresAt`, `autoRenew`, `locked` (registrar: true)
 * for the domain watch. Every read is under `/accounts/<pinned id>`: a domain of another account
 * reads as gone.
 */

export const DOMAIN = 'cloudflare.domain'
const LABEL = 'Cloudflare Registrar domain'
const DOMAIN_RE = /^(?=.{4,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/

export function domainSeg(v: unknown): string {
  const s = String(v ?? '')
    .trim()
    .toLowerCase()
    .replace(/\.$/, '')
  if (!DOMAIN_RE.test(s))
    throw new ProviderError('BAD_ID', 'That is not a domain name (example.com, no trailing dot).')
  return seg(s, 'domain name')
}

const tldOf = (name: string) => {
  const i = name.indexOf('.')
  return i > 0 ? name.slice(i + 1) : ''
}

async function domainEstimate(
  ctx: ProviderContext,
  desired: DesiredResource | null,
  observed: Observed | null
): Promise<CostEstimate> {
  try {
    const name = String(desired?.fields.name ?? observed?.externalId ?? '').toLowerCase()
    const tld = tldOf(name)
    if (!tld) return unknownEstimate('Enter the domain name to see a price.')
    const p = await priceLookup(ctx, 'cloudflare', `domain:renew:${tld}`, null)
    if (!p) return unknownEstimate(`No Cloudflare Registrar price is known for .${tld}.`)
    const renewing = (desired?.fields.auto_renew ?? observed?.fields.auto_renew) !== false
    return estimateOf({
      basis: 'price_list',
      confidence: 'list_price',
      currency: p.currency,
      lines: [],
      yearlyCents: renewing ? p.unitCents : 0,
      priceAsOf: p.asOf,
      note: renewing
        ? 'Renews each year at cost (registry and ICANN fees); list price from a dated table.'
        : 'Auto-renew is off: nothing is charged, and the domain expires on its date.'
    })
  } catch {
    return unknownEstimate('No Cloudflare Registrar price could be read.')
  }
}

export const domainSpec: ResourceTypeSpec = {
  key: DOMAIN,
  label: LABEL,
  scope: 'shared',
  registrar: true,
  costClass: () => 'yearly',
  estimate: domainEstimate,
  fields: [
    { key: 'name', label: 'Domain name', kind: 'string', required: true, createOnly: true },
    {
      key: 'auto_renew',
      label: 'Renew automatically',
      kind: 'boolean',
      default: true,
      help: 'Off lets the domain expire (and everything on it stop working).'
    },
    {
      key: 'locked',
      label: 'Transfer lock',
      kind: 'boolean',
      default: true,
      help: 'On keeps the domain from being transferred to another registrar. Turning it off is a destructive change.'
    },
    {
      key: 'privacy',
      label: 'Hide contact details (WHOIS privacy)',
      kind: 'boolean',
      default: true,
      help: 'Off publishes the registrant contact in WHOIS / RDAP.'
    },
    { key: 'expires_at', label: 'Expires', kind: 'string', readOnly: true },
    { key: 'current_registrar', label: 'Registrar', kind: 'string', readOnly: true },
    {
      key: 'registrant_organization',
      label: 'Registrant organization',
      kind: 'string',
      readOnly: true
    },
    { key: 'registrant_email', label: 'Registrant email', kind: 'string', readOnly: true }
  ],
  capabilities: {
    create: false,
    update: true,
    delete: false,
    adopt: true,
    snapshot: false,
    tag: false
  },
  reversible: true,
  refs: [],
  nameField: 'name',
  risk(op) {
    const out = new Set<RiskFlag>()
    for (const ch of op.changes) {
      if (ch.field === 'auto_renew' && ch.to === false) out.add('downtime')
      if (ch.field === 'locked' && ch.to === false) out.add('destructive')
      if (ch.field === 'privacy' && ch.to === false) out.add('public_exposure')
    }
    return [...out]
  }
}

function observedDomain(ctx: ProviderContext, raw: unknown, fallbackName: string): Observed | null {
  const d = asObj(raw)
  const name = (str(d.name) ?? fallbackName).toLowerCase()
  if (!name) return null
  const contact = asObj(d.registrant_contact)
  const exp = str(d.expires_at)
  return {
    type: DOMAIN,
    externalId: name,
    name,
    fields: {
      name,
      auto_renew: d.auto_renew === true,
      locked: d.locked === true,
      privacy: d.privacy !== false,
      expires_at: exp ? new Date(exp).toISOString() : '',
      current_registrar: str(d.current_registrar) ?? 'Cloudflare',
      registrant_organization: str(contact.organization),
      registrant_email: str(contact.email)
    },
    tags: {},
    status: 'registered',
    url: `https://dash.cloudflare.com/${String(ctx.config.accountId ?? '')}/domains/registrations/${name}`
  }
}

async function readDomain(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const name = domainSeg(id)
  const res = await cfCall(ctx, 'GET', `${accountPath(ctx)}/registrar/domains/${name}`, {
    allow: [404]
  })
  if (res.status === 404 || !res.result) return null
  // Cloudflare answers availability for a name it does not hold in this account: not ours.
  const r = asObj(res.result)
  if (r.available === true && !r.expires_at) return null
  return observedDomain(ctx, res.result, decodeURIComponent(name))
}

const cfg: PlanCfg = {
  spec: domainSpec,
  writable: ['auto_renew', 'locked', 'privacy'],
  nameOf: (f, o) => String(f.name ?? o?.name ?? '')
}

export const domainImpl: TypeImpl = {
  spec: domainSpec,
  permissions: [
    {
      need: 'read registrar domains',
      group: 'Registrar Domains Write',
      async probe(ctx) {
        await cfCall(ctx, 'GET', `${accountPath(ctx)}/registrar/domains`, {
          query: { per_page: 1 }
        })
        return true
      }
    }
  ],
  observe: (ctx, externalId) => readDomain(ctx, externalId),
  async list(ctx, cursor): Promise<ListPage> {
    const page = pageOf(cursor)
    const res = await cfCall<unknown[]>(ctx, 'GET', `${accountPath(ctx)}/registrar/domains`, {
      query: { page, per_page: 50 }
    })
    const items: Observed[] = []
    for (const raw of Array.isArray(res.result) ? res.result : []) {
      const o = observedDomain(ctx, raw, '')
      if (o && DOMAIN_RE.test(o.externalId)) items.push(o)
    }
    return { items, cursor: nextCursor(res.info, page) }
  },
  plan(_ctx, desired, observed) {
    if (!desired) return []
    return planGeneric(cfg, desired, observed)
  },
  async apply(ctx, op, desired) {
    if (op.kind === 'create' || op.kind === 'replace')
      throw new ProviderError(
        'NOT_SUPPORTED',
        'Cloudflare registers and transfers domains in its dashboard: register it there, then adopt it here.'
      )
    if (op.kind === 'delete')
      throw new ProviderError(
        'NOT_DELETABLE',
        'The Hub never deletes a domain registration. Stop managing it instead.'
      )
    const id = String(op.externalId ?? '')
    if (desired?.externalId && desired.externalId !== id)
      throw new ProviderError('TARGET_MISMATCH', 'The planned domain is not this resource’s.')
    const seen = await readDomain(ctx, id)
    if (!seen)
      throw new ProviderError(
        'CLOUDFLARE_OUT_OF_ACCOUNT',
        `${id} is not registered in this Cloudflare account.`
      )
    if (op.kind === 'noop' || !desired) return ok(seen, seen.externalId, 200)
    // Read before write: only the fields still different are sent.
    const body: Record<string, boolean> = {}
    for (const c of op.changes)
      if (cfg.writable.includes(c.field)) {
        const want = desired.fields[c.field] !== false
        if ((seen.fields[c.field] === true) !== want) body[c.field] = want
      }
    if (Object.keys(body).length)
      await cfCall(ctx, 'PUT', `${accountPath(ctx)}/registrar/domains/${domainSeg(id)}`, { body })
    return ok(await readDomain(ctx, id), seen.externalId, 200)
  },
  async health(ctx, externalId): Promise<HealthAnswer> {
    const o = await readDomain(ctx, externalId)
    if (!o)
      return {
        status: 'down',
        message: 'Not registered in this Cloudflare account any more.',
        checkedAt: ctx.now().toISOString()
      }
    return registrarHealth(ctx.now(), {
      expiresAt:
        typeof o.fields.expires_at === 'string' && o.fields.expires_at ? o.fields.expires_at : null,
      autoRenew: o.fields.auto_renew === true,
      locked: o.fields.locked === true
    })
  }
}
