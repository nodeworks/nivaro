import type {
  DesiredResource,
  ListPage,
  Observed,
  OpResult,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import {
  accountIdOf,
  cfCall,
  checkId,
  joinId,
  nextCursor,
  pageOf,
  type RawZone,
  readZone,
  requireZone,
  splitId
} from './client.js'
import { arr, FULL_CAPS, ok, type PlanCfg, planGeneric, str, type TypeImpl } from './common.js'
import { includedEstimate } from './pricing.js'
import { ZONE } from './zone.js'

/**
 * `cloudflare.waf_custom_rule`: one rule of a zone's custom-rules ruleset (phase
 * `http_request_firewall_custom`). External id `<zoneId>:<ruleId>`. The rule's description is its
 * name (unique per zone for the Hub). A rule that blocks or challenges EVERYTHING (an expression
 * that always matches, switched on) is `downtime`: a Hub admin confirms it by typing the name.
 * The check is a pattern test on common always-true expressions, not a full wirefilter parser, so
 * it errs towards asking; Cloudflare itself validates the expression when the rule is written.
 */

export const WAF_RULE = 'cloudflare.waf_custom_rule'
export const WAF_PHASE = 'http_request_firewall_custom'
const ACTIONS = ['block', 'challenge', 'js_challenge', 'managed_challenge', 'log']
const BLOCKING = ['block', 'challenge', 'js_challenge', 'managed_challenge']

const collapse = (s: unknown): string =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()

/** Exported for tests: does this expression match every request? */
export function matchesEverything(expression: unknown): boolean {
  let e = collapse(expression)
    .toLowerCase()
    .replace(/\s*,\s*/g, ',')
  // Strip balanced outer parentheses.
  while (e.startsWith('(') && e.endsWith(')') && balanced(e.slice(1, -1))) e = e.slice(1, -1).trim()
  const FIELDS =
    '(?:http\\.host|http\\.request\\.uri\\.path|http\\.request\\.uri|http\\.request\\.full_uri)'
  const patterns = [
    /^true$/,
    /^not false$/,
    new RegExp(`^${FIELDS} ne ""$`),
    new RegExp(`^${FIELDS} matches "(?:\\.|\\.\\*|\\^|\\^\\.\\*|\\.\\+)"$`),
    new RegExp(`^${FIELDS} contains "/"$`),
    /^starts_with\(http\.request\.uri\.path,"\/"\)$/,
    /^http\.request\.method in \{"get" "post" "put" "delete" "head" "options" "patch"\}$/
  ]
  return patterns.some((p) => p.test(e))
}

function balanced(s: string): boolean {
  let depth = 0
  let quoted = false
  for (const ch of s) {
    if (ch === '"') quoted = !quoted
    if (quoted) continue
    if (ch === '(') depth++
    if (ch === ')' && --depth < 0) return false
  }
  return depth === 0
}

export const wafRuleSpec: ResourceTypeSpec = {
  key: WAF_RULE,
  label: 'WAF custom rule',
  scope: 'app',
  nameField: 'description',
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
      key: 'description',
      label: 'Name',
      kind: 'string',
      required: true,
      help: 'What the rule is for. It identifies the rule.'
    },
    {
      key: 'expression',
      label: 'Expression',
      kind: 'string',
      required: true,
      help: 'A Cloudflare rules expression, like (ip.src in {203.0.113.0/24}).'
    },
    {
      key: 'action',
      label: 'Action',
      kind: 'enum',
      required: true,
      options: ACTIONS.map((a) => ({ value: a, label: a }))
    },
    { key: 'enabled', label: 'Switched on', kind: 'boolean', default: true }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: true,
  refs: [{ field: 'zone', type: ZONE, required: true }],
  risk(op, desired: DesiredResource | null): RiskFlag[] {
    if (op.kind === 'noop') return []
    const flags = new Set<RiskFlag>()
    if (op.kind === 'delete' || op.kind === 'replace') flags.add('destructive')
    if (op.kind !== 'delete' && desired) {
      const f = desired.fields
      if (
        f.enabled !== false &&
        BLOCKING.includes(String(f.action ?? '')) &&
        matchesEverything(f.expression)
      )
        flags.add('downtime')
    }
    return [...flags]
  },
  estimate: includedEstimate(
    'Custom rules are included in the zone’s plan (5 on Free, 20 on Pro, 100 on Business).'
  )
}

interface RawRule {
  id: string
  description?: string
  expression?: string
  action?: string
  enabled?: boolean
}
interface RawRuleset {
  id: string
  rules?: RawRule[]
}

const entrypoint = (zoneId: string) =>
  `/zones/${checkId(zoneId, 'zone id')}/rulesets/phases/${WAF_PHASE}/entrypoint`

async function readRuleset(ctx: ProviderContext, zoneId: string): Promise<RawRuleset | null> {
  const res = await cfCall<RawRuleset>(ctx, 'GET', entrypoint(zoneId), { allow: [404] })
  return res.status === 404 || !res.result ? null : res.result
}

function observedRule(zone: { id: string; name: string }, raw: RawRule): Observed {
  return {
    type: WAF_RULE,
    externalId: joinId(zone.id, raw.id),
    name: str(raw.description),
    fields: {
      zone: zone.id,
      description: str(raw.description),
      expression: str(raw.expression),
      action: str(raw.action),
      enabled: raw.enabled !== false
    },
    tags: {},
    url: `https://dash.cloudflare.com/${encodeURIComponent(zone.name)}/security/waf/custom-rules`
  }
}

const cfg: PlanCfg = {
  spec: wafRuleSpec,
  writable: ['zone', 'description', 'expression', 'action', 'enabled'],
  replaceOn: ['zone'],
  nameOf: (f, o) => String(f.description ?? o?.name ?? ''),
  createHint:
    'a rule with the same name on the zone that the Hub did not create is refused: adopt it instead'
}

function ruleBody(f: Record<string, unknown>): Record<string, unknown> {
  return {
    description: str(f.description),
    expression: collapse(f.expression),
    action: str(f.action),
    enabled: f.enabled !== false
  }
}

export const wafImpl: TypeImpl = {
  spec: wafRuleSpec,
  permissions: [
    {
      need: 'read WAF custom rules',
      group: 'Zone WAF Write',
      async probe(ctx) {
        const zones = await cfCall<RawZone[]>(ctx, 'GET', '/zones', {
          query: { 'account.id': accountIdOf(ctx), per_page: 1 }
        })
        const z = arr(zones.result)[0] as RawZone | undefined
        if (!z) return null
        await readRuleset(ctx, z.id)
        return true
      }
    }
  ],
  async observe(ctx, externalId) {
    const ids = splitId(externalId)
    if (!ids) return null
    checkId(ids[1], 'rule id')
    const zone = await readZone(ctx, ids[0])
    if (!zone) return null
    const rs = await readRuleset(ctx, zone.id)
    const rule = rs?.rules?.find((r) => r.id === ids[1])
    return rule ? observedRule(zone, rule) : null
  },
  async list(ctx, cursor): Promise<ListPage> {
    const page = pageOf(cursor)
    const zones = await cfCall<RawZone[]>(ctx, 'GET', '/zones', {
      query: { 'account.id': accountIdOf(ctx), page, per_page: 1 }
    })
    const z = (arr(zones.result) as RawZone[]).find((x) => x.account?.id === accountIdOf(ctx))
    if (!z) return { items: [], cursor: null }
    const rs = await readRuleset(ctx, z.id)
    return {
      items: (rs?.rules ?? []).map((r) => observedRule(z, r)),
      cursor: nextCursor(zones.info, page)
    }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const zoneId = desired.refs.zone
    const description = str(desired.fields.description)
    if (typeof zoneId !== 'string' || !description) return null
    const zone = await readZone(ctx, zoneId)
    if (!zone) return null
    const rule = (await readRuleset(ctx, zone.id))?.rules?.find(
      (r) => r.description === description
    )
    return rule ? observedRule(zone, rule) : null
  },
  plan(_ctx, desired, observed) {
    // Whitespace in an expression is not a change.
    const d = desired
      ? {
          ...desired,
          fields: { ...desired.fields, expression: collapse(desired.fields.expression) }
        }
      : null
    const o = observed
      ? {
          ...observed,
          fields: { ...observed.fields, expression: collapse(observed.fields.expression) }
        }
      : null
    return planGeneric(cfg, d, o)
  },
  async apply(ctx, op, desired): Promise<OpResult> {
    if (op.kind === 'noop')
      return ok(
        op.externalId ? await wafImpl.observe(ctx, op.externalId) : null,
        op.externalId,
        200
      )
    const ids = op.externalId ? splitId(op.externalId) : null
    const remove = async (): Promise<OpResult> => {
      if (!ids) throw new ProviderError('BAD_ID', 'The rule to delete is not known.')
      const zone = await requireZone(ctx, ids[0])
      const rs = await readRuleset(ctx, zone.id)
      if (!rs?.rules?.some((r) => r.id === ids[1])) return ok(null, op.externalId, 200)
      await cfCall(
        ctx,
        'DELETE',
        `/zones/${checkId(zone.id)}/rulesets/${checkId(rs.id, 'ruleset id')}/rules/${checkId(ids[1], 'rule id')}`,
        { allow: [404] }
      )
      return ok(null, op.externalId, 200)
    }
    const update = async (externalId: string): Promise<OpResult> => {
      const parts = splitId(externalId)
      if (!parts || !desired) throw new ProviderError('BAD_ID', 'The rule to change is not known.')
      const zone = await requireZone(ctx, parts[0])
      const rs = await readRuleset(ctx, zone.id)
      const have = rs?.rules?.find((r) => r.id === parts[1])
      if (!rs || !have)
        throw new ProviderError('NOT_FOUND', 'The rule no longer exists at Cloudflare.', {
          status: 404
        })
      const res = await cfCall<RawRuleset>(
        ctx,
        'PATCH',
        `/zones/${checkId(zone.id)}/rulesets/${checkId(rs.id, 'ruleset id')}/rules/${checkId(parts[1], 'rule id')}`,
        { body: ruleBody(desired.fields) }
      )
      const rule = res.result?.rules?.find((r) => r.id === parts[1]) ?? have
      return ok(observedRule(zone, rule), externalId, res.status)
    }
    const create = async (): Promise<OpResult> => {
      const zoneId = desired?.refs.zone
      if (typeof zoneId !== 'string' || !desired)
        throw new ProviderError('REF_UNRESOLVED', 'The zone this rule belongs to is not known yet.')
      if (
        !str(desired.fields.description) ||
        !str(desired.fields.expression) ||
        !str(desired.fields.action)
      )
        throw new ProviderError('INVALID', 'A rule needs a name, an expression and an action.')
      const zone = await requireZone(ctx, zoneId)
      const rs = await readRuleset(ctx, zone.id)
      const clash = rs?.rules?.find((r) => r.description === desired.fields.description)
      if (clash) {
        if (desired.externalId) return update(joinId(zone.id, clash.id))
        throw new ProviderError(
          'ALREADY_EXISTS',
          `${zone.name} already has a custom rule named ${String(desired.fields.description)} that the Hub did not create. Adopt it instead of creating it.`,
          { status: 409 }
        )
      }
      const body = ruleBody(desired.fields)
      const res = rs
        ? await cfCall<RawRuleset>(
            ctx,
            'POST',
            `/zones/${checkId(zone.id)}/rulesets/${checkId(rs.id, 'ruleset id')}/rules`,
            { body }
          )
        : await cfCall<RawRuleset>(ctx, 'PUT', entrypoint(zone.id), { body: { rules: [body] } })
      const known = new Set((rs?.rules ?? []).map((r) => r.id))
      const made =
        res.result?.rules?.find((r) => !known.has(r.id) && r.description === body.description) ??
        res.result?.rules?.find((r) => r.description === body.description)
      if (!made)
        throw new ProviderError('PROVIDER_REJECTED', 'Cloudflare did not return the new rule.')
      return ok(observedRule(zone, made), joinId(zone.id, made.id), res.status)
    }
    switch (op.kind) {
      case 'create':
        return create()
      case 'update':
        if (!op.externalId) throw new ProviderError('INVALID', 'An update needs a rule.')
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
