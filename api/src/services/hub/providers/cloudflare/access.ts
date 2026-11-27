import type {
  DesiredResource,
  FieldSpec,
  ListPage,
  Observed,
  OpResult,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import { accountPath, cfCall, checkId, joinId, nextCursor, pageOf, splitId } from './client.js'
import {
  arr,
  asObj,
  FULL_CAPS,
  ok,
  type PlanCfg,
  planGeneric,
  str,
  type TypeImpl
} from './common.js'
import { zeroTrustEstimate } from './pricing.js'

/**
 * Cloudflare Access (Zero Trust):
 *
 *  - `cloudflare.access_application`  a self-hosted application (a hostname behind Access). Output
 *                                     `aud` (the application audience tag a service checks in the
 *                                     CF-Access JWT). Deleting one, or moving it to another
 *                                     domain, takes the protection off the old hostname:
 *                                     `public_exposure`.
 *  - `cloudflare.access_policy`       one policy of an application (allow / deny / bypass rules).
 *                                     A policy that lets everyone in — an allow or bypass whose
 *                                     include has "everyone" and nothing narrows it — is
 *                                     `public_exposure` (a Hub admin approves it).
 *
 * Both are account-level, so the pinned account is in every path. Rules are written as
 * `{kind, value}` pairs and translated to Cloudflare's shapes; rule kinds the Hub does not know
 * are kept verbatim (`other`) so editing a policy never drops them silently from the plan.
 */

export const ACCESS_APP = 'cloudflare.access_application'
export const ACCESS_POLICY = 'cloudflare.access_policy'

const DURATIONS = ['15m', '30m', '6h', '12h', '24h', '168h', '730h']
const DECISIONS = ['allow', 'deny', 'non_identity', 'bypass']
const RULE_KINDS = [
  { value: 'everyone', label: 'Everyone' },
  { value: 'email', label: 'Email address' },
  { value: 'email_domain', label: 'Email domain' },
  { value: 'ip', label: 'IP range' },
  { value: 'group', label: 'Access group (id)' },
  { value: 'service_token', label: 'Service token (id)' },
  { value: 'any_valid_service_token', label: 'Any valid service token' }
]

const ruleList = (key: string, label: string, help?: string): FieldSpec => ({
  key,
  label,
  kind: 'list',
  help,
  items: {
    key: 'rule',
    label: 'Rule',
    kind: 'object',
    fields: [
      { key: 'kind', label: 'Kind', kind: 'enum', required: true, options: RULE_KINDS },
      { key: 'value', label: 'Value', kind: 'string' }
    ]
  }
})

export const accessAppSpec: ResourceTypeSpec = {
  key: ACCESS_APP,
  label: 'Access application',
  scope: 'app',
  fields: [
    { key: 'name', label: 'Name', kind: 'string', required: true },
    {
      key: 'domain',
      label: 'Hostname',
      kind: 'string',
      required: true,
      help: 'The hostname (and optional path) Access protects, like app.example.com.'
    },
    {
      key: 'session_duration',
      label: 'Session duration',
      kind: 'enum',
      default: '24h',
      options: DURATIONS.map((d) => ({ value: d, label: d }))
    },
    {
      key: 'auto_redirect_to_identity',
      label: 'Skip the identity provider picker',
      kind: 'boolean',
      default: false
    }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: true,
  refs: [],
  risk(op): RiskFlag[] {
    if (op.kind === 'noop') return []
    const flags = new Set<RiskFlag>()
    if (op.kind === 'delete' || op.kind === 'replace') {
      flags.add('destructive')
      // The hostname is reachable without signing in once nothing guards it.
      flags.add('public_exposure')
    }
    if (op.kind === 'update' && op.changes.some((c) => c.field === 'domain'))
      flags.add('public_exposure')
    return [...flags]
  },
  outputs: [{ key: 'aud', label: 'Audience tag', secret: false }],
  estimate: zeroTrustEstimate
}

export const accessPolicySpec: ResourceTypeSpec = {
  key: ACCESS_POLICY,
  label: 'Access policy',
  scope: 'app',
  fields: [
    {
      key: 'application',
      label: 'Application',
      kind: 'ref',
      refType: ACCESS_APP,
      required: true,
      replaceOnChange: true
    },
    { key: 'name', label: 'Name', kind: 'string', required: true },
    {
      key: 'decision',
      label: 'Decision',
      kind: 'enum',
      required: true,
      options: DECISIONS.map((d) => ({ value: d, label: d }))
    },
    ruleList('include', 'Include (any of)', 'Who the policy covers. "Everyone" lets anyone in.'),
    ruleList('exclude', 'Exclude (none of)'),
    ruleList('require', 'Require (all of)'),
    { key: 'precedence', label: 'Precedence', kind: 'number', min: 1 }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: true,
  refs: [{ field: 'application', type: ACCESS_APP, required: true }],
  risk(op, desired): RiskFlag[] {
    if (op.kind === 'noop') return []
    const flags = new Set<RiskFlag>()
    if (op.kind === 'delete' || op.kind === 'replace') flags.add('destructive')
    if (op.kind !== 'delete' && desired && letsEveryoneIn(desired.fields))
      flags.add('public_exposure')
    return [...flags]
  },
  estimate: zeroTrustEstimate
}

// ── Rules ──

interface Rule {
  kind: string
  value: string | null
}

const SIMPLE: Record<string, { key: string; field: string | null }> = {
  email: { key: 'email', field: 'email' },
  email_domain: { key: 'email_domain', field: 'domain' },
  ip: { key: 'ip', field: 'ip' },
  group: { key: 'group', field: 'id' },
  service_token: { key: 'service_token', field: 'token_id' },
  everyone: { key: 'everyone', field: null },
  any_valid_service_token: { key: 'any_valid_service_token', field: null }
}

function ruleToCf(rule: unknown): Record<string, unknown> {
  const r = asObj(rule)
  const kind = String(r.kind ?? '')
  const value = r.value == null ? '' : String(r.value)
  if (kind === 'other') {
    try {
      return asObj(JSON.parse(value))
    } catch {
      throw new ProviderError('INVALID', 'A kept rule is not valid JSON.')
    }
  }
  const def = Object.hasOwn(SIMPLE, kind) ? SIMPLE[kind] : null
  if (!def) throw new ProviderError('INVALID', `Unknown Access rule kind ${JSON.stringify(kind)}.`)
  if (def.field === null) return { [def.key]: {} }
  if (!value) throw new ProviderError('INVALID', `An ${kind} rule needs a value.`)
  return { [def.key]: { [def.field]: value } }
}

function ruleFromCf(raw: unknown): Rule {
  const o = asObj(raw)
  const keys = Object.keys(o)
  if (keys.length === 1) {
    const [key] = keys
    for (const [kind, def] of Object.entries(SIMPLE)) {
      if (def.key !== key) continue
      if (def.field === null) return { kind, value: null }
      const v = asObj(o[key])[def.field]
      if (typeof v === 'string') return { kind, value: v }
    }
  }
  // A kind the Hub does not model: kept as it is, so it can be shown and round-tripped.
  return { kind: 'other', value: JSON.stringify(o) }
}

const rulesIn = (v: unknown): Rule[] =>
  arr(v).map((r) => ({
    kind: String(asObj(r).kind ?? ''),
    value: asObj(r).value == null || asObj(r).value === '' ? null : String(asObj(r).value)
  }))

/** Exported for tests: does this policy let everyone in? */
export function letsEveryoneIn(fields: Record<string, unknown>): boolean {
  const decision = String(fields.decision ?? '')
  if (decision !== 'allow' && decision !== 'bypass') return false
  if (!rulesIn(fields.include).some((r) => r.kind === 'everyone')) return false
  // A require list narrows "everyone" to people who also meet every rule in it.
  return rulesIn(fields.require).length === 0
}

// ── Applications ──

interface RawApp {
  id: string
  name?: string
  domain?: string
  type?: string
  aud?: string
  session_duration?: string
  auto_redirect_to_identity?: boolean
  policies?: unknown[]
}

function observedApp(raw: RawApp, accountId: string): Observed {
  return {
    type: ACCESS_APP,
    externalId: String(raw.id),
    name: str(raw.name),
    fields: {
      name: str(raw.name),
      domain: str(raw.domain),
      session_duration: str(raw.session_duration),
      auto_redirect_to_identity: raw.auto_redirect_to_identity === true
    },
    tags: {},
    url: `https://one.dash.cloudflare.com/${accountId}/access/apps`
  }
}

async function getApp(ctx: ProviderContext, id: string): Promise<Observed | null> {
  const res = await cfCall<RawApp>(
    ctx,
    'GET',
    `${accountPath(ctx)}/access/apps/${checkId(id, 'application id')}`,
    { allow: [404] }
  )
  if (res.status === 404 || !res.result) return null
  // Only self-hosted applications are the Hub's to manage; other kinds are not shown.
  if (res.result.type && res.result.type !== 'self_hosted') return null
  return observedApp(res.result, String(ctx.config.accountId))
}

async function findAppByDomain(ctx: ProviderContext, domain: string): Promise<Observed | null> {
  const res = await cfCall<RawApp[]>(ctx, 'GET', `${accountPath(ctx)}/access/apps`, {
    query: { domain, per_page: 50 }
  })
  const hit = arr(res.result).find(
    (a) => String(asObj(a).domain ?? '').toLowerCase() === domain.toLowerCase()
  ) as RawApp | undefined
  return hit ? observedApp(hit, String(ctx.config.accountId)) : null
}

const appCfg: PlanCfg = {
  spec: accessAppSpec,
  writable: ['name', 'domain', 'session_duration', 'auto_redirect_to_identity'],
  nameOf: (f, o) => String(f.name ?? o?.name ?? ''),
  createHint:
    'an application for the same hostname that the Hub did not create is refused: adopt it instead'
}

export const accessAppImpl: TypeImpl = {
  spec: accessAppSpec,
  permissions: [
    {
      need: 'read Access applications',
      group: 'Access: Apps and Policies Write',
      async probe(ctx) {
        await cfCall(ctx, 'GET', `${accountPath(ctx)}/access/apps`, { query: { per_page: 1 } })
        return true
      }
    }
  ],
  observe: (ctx, id) => getApp(ctx, id),
  async list(ctx, cursor): Promise<ListPage> {
    const page = pageOf(cursor)
    const res = await cfCall<RawApp[]>(ctx, 'GET', `${accountPath(ctx)}/access/apps`, {
      query: { page, per_page: 50 }
    })
    const items = (arr(res.result) as RawApp[])
      .filter((a) => !a.type || a.type === 'self_hosted')
      .map((a) => observedApp(a, String(ctx.config.accountId)))
    return { items, cursor: nextCursor(res.info, page) }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const domain = str(desired.fields.domain)
    return domain ? findAppByDomain(ctx, domain) : null
  },
  plan: (_ctx, desired, observed) => planGeneric(appCfg, desired, observed),
  async readOutputs(ctx, externalId): Promise<Record<string, string>> {
    const res = await cfCall<RawApp>(
      ctx,
      'GET',
      `${accountPath(ctx)}/access/apps/${checkId(externalId, 'application id')}`,
      { allow: [404] }
    )
    const aud = str(res.result?.aud)
    return aud ? { aud } : {}
  },
  async apply(ctx, op, desired): Promise<OpResult> {
    const base = `${accountPath(ctx)}/access/apps`
    const bodyOf = (f: Record<string, unknown>, current?: RawApp) => {
      const body: Record<string, unknown> = {
        name: str(f.name),
        domain: str(f.domain),
        type: 'self_hosted',
        session_duration: str(f.session_duration) ?? current?.session_duration ?? '24h',
        auto_redirect_to_identity:
          f.auto_redirect_to_identity === undefined
            ? (current?.auto_redirect_to_identity ?? false)
            : f.auto_redirect_to_identity === true
      }
      // A full replace (PUT) must carry the attached policies or Cloudflare drops them.
      if (current && Array.isArray(current.policies))
        body.policies = current.policies
          .map((p) => asObj(p))
          .filter((p) => typeof p.id === 'string')
          .map((p) => ({ id: p.id, precedence: p.precedence }))
      return body
    }
    const out = (res: { status: number; result: RawApp }): OpResult => {
      const o = observedApp(res.result, String(ctx.config.accountId))
      const aud = str(res.result.aud)
      return ok(o, o.externalId, res.status, aud ? { aud } : undefined)
    }
    switch (op.kind) {
      case 'noop':
        return ok(op.externalId ? await getApp(ctx, op.externalId) : null, op.externalId, 200)
      case 'create': {
        if (!desired) throw new ProviderError('INVALID', 'A create needs the wanted values.')
        const domain = str(desired.fields.domain)
        if (!domain || !str(desired.fields.name))
          throw new ProviderError('INVALID', 'An application needs a name and a hostname.')
        if (desired.externalId) {
          const have = await getApp(ctx, desired.externalId)
          if (have)
            return accessAppImpl.apply(
              ctx,
              { ...op, kind: 'update', externalId: have.externalId },
              desired
            )
        } else {
          const clash = await findAppByDomain(ctx, domain)
          if (clash)
            throw new ProviderError(
              'ALREADY_EXISTS',
              `An Access application for ${domain} already exists and was not created by the Hub. Adopt it instead of creating it.`,
              { status: 409 }
            )
        }
        const res = await cfCall<RawApp>(ctx, 'POST', base, { body: bodyOf(desired.fields) })
        return out(res)
      }
      case 'update': {
        if (!op.externalId || !desired)
          throw new ProviderError('INVALID', 'An update needs an application.')
        const id = checkId(op.externalId, 'application id')
        const cur = await cfCall<RawApp>(ctx, 'GET', `${base}/${id}`, { allow: [404] })
        if (cur.status === 404 || !cur.result)
          throw new ProviderError('NOT_FOUND', 'The application no longer exists at Cloudflare.', {
            status: 404
          })
        const res = await cfCall<RawApp>(ctx, 'PUT', `${base}/${id}`, {
          body: { ...bodyOf({ ...asObj(cur.result), ...desired.fields }, cur.result) }
        })
        return out(res)
      }
      case 'delete': {
        if (!op.externalId) throw new ProviderError('INVALID', 'A delete needs an application id.')
        const id = checkId(op.externalId, 'application id')
        const res = await cfCall(ctx, 'DELETE', `${base}/${id}`, { allow: [404] })
        return ok(null, id, res.status)
      }
      default:
        throw new ProviderError('UNSUPPORTED', 'An application is edited or deleted, not replaced.')
    }
  }
}

// ── Policies ──

interface RawPolicy {
  id: string
  name?: string
  decision?: string
  include?: unknown[]
  exclude?: unknown[]
  require?: unknown[]
  precedence?: number
}

function observedPolicy(appId: string, raw: RawPolicy, accountId: string): Observed {
  return {
    type: ACCESS_POLICY,
    externalId: joinId(appId, String(raw.id)),
    name: str(raw.name),
    fields: {
      application: appId,
      name: str(raw.name),
      decision: str(raw.decision),
      include: arr(raw.include).map(ruleFromCf),
      exclude: arr(raw.exclude).map(ruleFromCf),
      require: arr(raw.require).map(ruleFromCf),
      precedence: typeof raw.precedence === 'number' ? raw.precedence : null
    },
    tags: {},
    url: `https://one.dash.cloudflare.com/${accountId}/access/apps`
  }
}

async function getPolicy(
  ctx: ProviderContext,
  appId: string,
  id: string
): Promise<Observed | null> {
  const res = await cfCall<RawPolicy>(
    ctx,
    'GET',
    `${accountPath(ctx)}/access/apps/${checkId(appId, 'application id')}/policies/${checkId(id, 'policy id')}`,
    { allow: [404] }
  )
  return res.status === 404 || !res.result
    ? null
    : observedPolicy(appId, res.result, String(ctx.config.accountId))
}

async function listPolicies(ctx: ProviderContext, appId: string): Promise<RawPolicy[]> {
  const res = await cfCall<RawPolicy[]>(
    ctx,
    'GET',
    `${accountPath(ctx)}/access/apps/${checkId(appId, 'application id')}/policies`,
    { allow: [404] }
  )
  return res.status === 404 ? [] : (arr(res.result) as RawPolicy[])
}

const policyCfg: PlanCfg = {
  spec: accessPolicySpec,
  writable: ['application', 'name', 'decision', 'include', 'exclude', 'require', 'precedence'],
  replaceOn: ['application'],
  nameOf: (f, o) => String(f.name ?? o?.name ?? ''),
  createHint:
    'a policy with the same name on the application that the Hub did not create is refused: adopt it instead'
}

function policyBody(f: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = {
    name: str(f.name),
    decision: str(f.decision),
    include: arr(f.include).map(ruleToCf),
    exclude: arr(f.exclude).map(ruleToCf),
    require: arr(f.require).map(ruleToCf)
  }
  if (typeof f.precedence === 'number') body.precedence = f.precedence
  return body
}

export const accessPolicyImpl: TypeImpl = {
  spec: accessPolicySpec,
  permissions: [
    {
      need: 'read Access policies',
      group: 'Access: Apps and Policies Write',
      async probe(ctx) {
        const res = await cfCall<RawApp[]>(ctx, 'GET', `${accountPath(ctx)}/access/apps`, {
          query: { per_page: 1 }
        })
        const a = arr(res.result)[0] as RawApp | undefined
        if (!a) return null
        await listPolicies(ctx, a.id)
        return true
      }
    }
  ],
  async observe(ctx, externalId) {
    const ids = splitId(externalId)
    return ids ? getPolicy(ctx, ids[0], ids[1]) : null
  },
  async list(ctx, cursor): Promise<ListPage> {
    // One application per page of the list.
    const page = pageOf(cursor)
    const apps = await cfCall<RawApp[]>(ctx, 'GET', `${accountPath(ctx)}/access/apps`, {
      query: { page, per_page: 10 }
    })
    const items: Observed[] = []
    for (const a of (arr(apps.result) as RawApp[]).filter(
      (x) => !x.type || x.type === 'self_hosted'
    ))
      for (const p of await listPolicies(ctx, a.id))
        items.push(observedPolicy(a.id, p, String(ctx.config.accountId)))
    return { items, cursor: nextCursor(apps.info, page) }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const appId = desired.refs.application
    const name = str(desired.fields.name)
    if (typeof appId !== 'string' || !name) return null
    const hit = (await listPolicies(ctx, appId)).find((p) => p.name === name)
    return hit ? observedPolicy(appId, hit, String(ctx.config.accountId)) : null
  },
  plan(_ctx, desired, observed) {
    if (!desired) return planGeneric(policyCfg, desired, observed)
    // Compare rules the way the provider reports them (an empty value is absent).
    const fields = { ...desired.fields }
    for (const k of ['include', 'exclude', 'require'])
      if (fields[k] !== undefined) fields[k] = rulesIn(fields[k])
    return planGeneric(policyCfg, { ...desired, fields }, observed)
  },
  async apply(ctx, op, desired): Promise<OpResult> {
    const accountId = String(ctx.config.accountId)
    const pathOf = (appId: string, id?: string) =>
      `${accountPath(ctx)}/access/apps/${checkId(appId, 'application id')}/policies${id ? `/${checkId(id, 'policy id')}` : ''}`
    const create = async (d: DesiredResource): Promise<OpResult> => {
      const appId = d.refs.application
      if (typeof appId !== 'string')
        throw new ProviderError(
          'REF_UNRESOLVED',
          'The application this policy is for is not created yet.'
        )
      if (!str(d.fields.name) || !str(d.fields.decision))
        throw new ProviderError('INVALID', 'A policy needs a name and a decision.')
      if (d.externalId) {
        const ids = splitId(d.externalId)
        const have = ids ? await getPolicy(ctx, ids[0], ids[1]) : null
        if (have) return update(have.externalId, d)
      } else {
        const clash = (await listPolicies(ctx, appId)).find((p) => p.name === d.fields.name)
        if (clash)
          throw new ProviderError(
            'ALREADY_EXISTS',
            `The application already has a policy named ${String(d.fields.name)} that the Hub did not create. Adopt it instead of creating it.`,
            { status: 409 }
          )
      }
      const res = await cfCall<RawPolicy>(ctx, 'POST', pathOf(appId), {
        body: policyBody(d.fields)
      })
      const o = observedPolicy(appId, res.result, accountId)
      return ok(o, o.externalId, res.status)
    }
    const update = async (externalId: string, d: DesiredResource): Promise<OpResult> => {
      const ids = splitId(externalId)
      if (!ids) throw new ProviderError('BAD_ID', 'The policy to change is not known.')
      const cur = await getPolicy(ctx, ids[0], ids[1])
      if (!cur)
        throw new ProviderError('NOT_FOUND', 'The policy no longer exists at Cloudflare.', {
          status: 404
        })
      const f = { ...d.fields }
      if (f.precedence === undefined && typeof cur.fields.precedence === 'number')
        f.precedence = cur.fields.precedence
      const res = await cfCall<RawPolicy>(ctx, 'PUT', pathOf(ids[0], ids[1]), {
        body: policyBody(f)
      })
      return ok(observedPolicy(ids[0], res.result, accountId), externalId, res.status)
    }
    const remove = async (externalId: string): Promise<OpResult> => {
      const ids = splitId(externalId)
      if (!ids) throw new ProviderError('BAD_ID', 'The policy to delete is not known.')
      const res = await cfCall(ctx, 'DELETE', pathOf(ids[0], ids[1]), { allow: [404] })
      return ok(null, externalId, res.status)
    }
    switch (op.kind) {
      case 'noop':
        return ok(
          op.externalId ? await accessPolicyImpl.observe(ctx, op.externalId) : null,
          op.externalId,
          200
        )
      case 'create':
        if (!desired) throw new ProviderError('INVALID', 'A create needs the wanted values.')
        return create(desired)
      case 'update':
        if (!op.externalId || !desired)
          throw new ProviderError('INVALID', 'An update needs a policy.')
        return update(op.externalId, desired)
      case 'delete':
        return remove(String(op.externalId ?? ''))
      case 'replace':
        if (!desired) throw new ProviderError('INVALID', 'A replace needs the wanted values.')
        if (op.externalId) await remove(op.externalId)
        return create({ ...desired, externalId: null })
      default:
        throw new ProviderError('INVALID', `Unknown operation ${String(op.kind)}.`)
    }
  }
}
