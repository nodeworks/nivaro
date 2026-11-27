import { type FieldSpec, type PlannedOp, type ProviderContext, ProviderError } from '../types.js'
import { awsQuery, ec2TagSpec, hubTags, isNotFound } from './client.js'
import {
  child,
  describeLister,
  describeOne,
  ec2Probe,
  findByResourceTag,
  int,
  items,
  putTags,
  tagsOf,
  text
} from './ec2.js'
import { type AwsTypeDef, cap, nameField, observed, regionField, riskOf } from './kit.js'
import type { XmlValue } from './xml.js'

/**
 * aws.security_group — rules are one entry per source: a CIDR (`cidr` / `cidr6`) or another
 * security group (`source_group`). `protocol` is tcp | udp | icmp | all (`-1`). Descriptions are
 * written when a rule is added and are not compared. Opening a port other than 80/443 to
 * 0.0.0.0/0 or ::/0 is flagged `public_exposure` (admin only).
 */

export interface SgRule {
  protocol: string
  from_port?: number
  to_port?: number
  cidr?: string
  cidr6?: string
  source_group?: string
  description?: string
}

const ruleSpec: FieldSpec = {
  key: 'rule',
  label: 'Rule',
  kind: 'object',
  fields: [
    {
      key: 'protocol',
      label: 'Protocol',
      kind: 'enum',
      required: true,
      options: ['tcp', 'udp', 'icmp', 'all'].map((v) => ({ value: v, label: v }))
    },
    { key: 'from_port', label: 'From port', kind: 'number', min: -1, max: 65535 },
    { key: 'to_port', label: 'To port', kind: 'number', min: -1, max: 65535 },
    { key: 'cidr', label: 'IPv4 CIDR', kind: 'string' },
    { key: 'cidr6', label: 'IPv6 CIDR', kind: 'string' },
    { key: 'source_group', label: 'Source security group id', kind: 'string' },
    { key: 'description', label: 'Description', kind: 'string' }
  ]
}

/** One rule in the form AWS reports it (protocol `-1` for all, no ports then, no description). */
export function normRule(r: SgRule): SgRule {
  const protocol = r.protocol === 'all' ? '-1' : r.protocol
  const out: SgRule = { protocol }
  if (protocol !== '-1') {
    if (r.from_port !== undefined && r.from_port !== null) out.from_port = Number(r.from_port)
    out.to_port = Number(r.to_port ?? r.from_port ?? out.from_port)
  }
  if (r.cidr) out.cidr = r.cidr
  if (r.cidr6) out.cidr6 = r.cidr6
  if (r.source_group) out.source_group = r.source_group
  return out
}

export const ruleKey = (r: SgRule) =>
  JSON.stringify([
    r.protocol,
    r.from_port ?? null,
    r.to_port ?? null,
    r.cidr ?? '',
    r.cidr6 ?? '',
    r.source_group ?? ''
  ])

/** True when the rule lets the whole internet reach anything but plain web ports. */
export function exposesPublicly(r: SgRule): boolean {
  const n = normRule(r)
  if (n.cidr !== '0.0.0.0/0' && n.cidr6 !== '::/0') return false
  return !(
    n.protocol === 'tcp' &&
    n.from_port === n.to_port &&
    (n.from_port === 80 || n.from_port === 443)
  )
}

function parsePerms(set: XmlValue | undefined): SgRule[] {
  const out: SgRule[] = []
  for (const p of items(set)) {
    const protocol = text(child(p, 'ipProtocol'))
    const ports =
      protocol === '-1'
        ? {}
        : { from_port: int(child(p, 'fromPort')), to_port: int(child(p, 'toPort')) }
    for (const r of items(child(p, 'ipRanges')))
      out.push({ protocol, ...ports, cidr: text(child(r, 'cidrIp')) })
    for (const r of items(child(p, 'ipv6Ranges')))
      out.push({ protocol, ...ports, cidr6: text(child(r, 'cidrIpv6')) })
    for (const g of items(child(p, 'groups')))
      out.push({ protocol, ...ports, source_group: text(child(g, 'groupId')) })
  }
  return out.map((r) => {
    const o = { ...r }
    for (const k of Object.keys(o) as Array<keyof SgRule>) if (o[k] === undefined) delete o[k]
    return o
  })
}

function sgMap(v: XmlValue, region: string) {
  const id = text(child(v, 'groupId'))
  if (!id) return null
  const tags = tagsOf(child(v, 'tagSet'))
  return observed(
    'aws.security_group',
    id,
    region,
    text(child(v, 'groupName')),
    {
      description: text(child(v, 'groupDescription')),
      vpc: text(child(v, 'vpcId')),
      ingress: parsePerms(child(v, 'ipPermissions')),
      egress: parsePerms(child(v, 'ipPermissionsEgress'))
    },
    tags,
    'available'
  )
}

const permission = (r: SgRule) => {
  const n = normRule(r)
  const desc = r.description ? { Description: r.description } : {}
  return {
    IpProtocol: n.protocol,
    FromPort: n.from_port,
    ToPort: n.to_port,
    IpRanges: n.cidr ? [{ CidrIp: n.cidr, ...desc }] : undefined,
    Ipv6Ranges: n.cidr6 ? [{ CidrIpv6: n.cidr6, ...desc }] : undefined,
    UserIdGroupPairs: n.source_group ? [{ GroupId: n.source_group, ...desc }] : undefined
  }
}

async function syncRules(
  ctx: ProviderContext,
  region: string,
  id: string,
  dir: 'Ingress' | 'Egress',
  want: SgRule[] | undefined,
  have: SgRule[]
) {
  if (!want) return
  const wantBy = new Map(want.map((r) => [ruleKey(normRule(r)), r]))
  const haveKeys = new Set(have.map((r) => ruleKey(normRule(r))))
  // Add before remove: a rule that moves never leaves a gap.
  for (const [k, r] of wantBy)
    if (!haveKeys.has(k))
      await awsQuery(
        ctx,
        'ec2',
        `AuthorizeSecurityGroup${dir}`,
        { GroupId: id, IpPermissions: [permission(r)] },
        { region }
      ).catch((e) => {
        if (!(e instanceof ProviderError && e.code === 'InvalidPermission.Duplicate')) throw e
      })
  for (const h of have)
    if (!wantBy.has(ruleKey(normRule(h))))
      await awsQuery(
        ctx,
        'ec2',
        `RevokeSecurityGroup${dir}`,
        { GroupId: id, IpPermissions: [permission(h)] },
        { region }
      ).catch((e) => {
        if (
          !(
            e instanceof ProviderError &&
            (e.code === 'InvalidPermission.NotFound' || isNotFound(e))
          )
        )
          throw e
      })
}

const addedRules = (
  op: PlannedOp,
  desired: { fields: Record<string, unknown> } | null
): SgRule[] => {
  const to = (desired?.fields.ingress as SgRule[] | undefined) ?? []
  if (op.kind === 'create' || op.kind === 'replace') return to
  const change = op.changes.find((c) => c.field === 'ingress')
  if (!change) return []
  const from = new Set(
    ((change.from as SgRule[] | undefined) ?? []).map((r) => ruleKey(normRule(r)))
  )
  return ((change.to as SgRule[] | undefined) ?? []).filter((r) => !from.has(ruleKey(normRule(r))))
}

export const securityGroupDef: AwsTypeDef = {
  spec: {
    key: 'aws.security_group',
    label: 'Security group',
    scope: 'app',
    fields: [
      regionField,
      { ...nameField, createOnly: true, replaceOnChange: true },
      {
        key: 'description',
        label: 'Description',
        kind: 'string',
        createOnly: true,
        replaceOnChange: true,
        default: 'Managed by Nivaro Hub'
      },
      {
        key: 'vpc',
        label: 'VPC',
        kind: 'ref',
        refType: 'aws.vpc',
        required: true,
        replaceOnChange: true
      },
      { key: 'ingress', label: 'Inbound rules', kind: 'list', items: ruleSpec },
      { key: 'egress', label: 'Outbound rules', kind: 'list', items: ruleSpec }
    ],
    capabilities: cap(),
    reversible: (f) => f === 'ingress' || f === 'egress',
    refs: [{ field: 'vpc', type: 'aws.vpc' }],
    risk: riskOf((op, d) => (addedRules(op, d).some(exposesPublicly) ? ['public_exposure'] : []))
  },
  probe: ec2Probe('DescribeSecurityGroups'),
  normalize: (f) => ({
    ...f,
    ingress: Array.isArray(f.ingress) ? (f.ingress as SgRule[]).map(normRule) : f.ingress,
    egress: Array.isArray(f.egress) ? (f.egress as SgRule[]).map(normRule) : f.egress
  }),
  async observe(ctx, id, region) {
    const v = await describeOne(
      ctx,
      'DescribeSecurityGroups',
      'securityGroupInfo',
      'GroupId',
      id,
      region
    )
    return v ? sgMap(v, region) : null
  },
  list: describeLister('DescribeSecurityGroups', 'securityGroupInfo', sgMap),
  /**
   * The Hub's own earlier create (resource tag), else a group of the same name in the same VPC
   * (names are unique per VPC). Without a resolved VPC (made in the same change) nothing collides.
   */
  async findExisting(ctx, desired, region) {
    const own = await findByResourceTag('DescribeSecurityGroups', 'securityGroupInfo', sgMap)(
      ctx,
      desired,
      region
    )
    if (own) return own
    const name = typeof desired.fields.name === 'string' ? desired.fields.name : ''
    const vpc = typeof desired.refs.vpc === 'string' ? desired.refs.vpc : ''
    if (!name || !vpc) return null
    const r = await awsQuery(
      ctx,
      'ec2',
      'DescribeSecurityGroups',
      {
        Filter: [
          { Name: 'group-name', Value: [name] },
          { Name: 'vpc-id', Value: [vpc] }
        ]
      },
      { region }
    )
    for (const it of items(r.securityGroupInfo)) {
      const o = sgMap(it, region)
      if (o) return o
    }
    return null
  },
  async create(ctx, desired, region) {
    const r = await awsQuery(
      ctx,
      'ec2',
      'CreateSecurityGroup',
      {
        GroupName: desired.fields.name,
        GroupDescription: desired.fields.description || 'Managed by Nivaro Hub',
        VpcId: typeof desired.refs.vpc === 'string' ? desired.refs.vpc : undefined,
        TagSpecification: ec2TagSpec('security-group', hubTags(desired.tags, desired.fields.name))
      },
      { region }
    )
    const id = text(child(r, 'groupId'))
    if (!id)
      throw new ProviderError('AWS_BAD_ANSWER', 'CreateSecurityGroup answered no id.', {
        retryable: true
      })
    const have = await securityGroupDef.observe(ctx, id, region)
    await syncRules(
      ctx,
      region,
      id,
      'Ingress',
      desired.fields.ingress as SgRule[] | undefined,
      (have?.fields.ingress as SgRule[]) ?? []
    )
    await syncRules(
      ctx,
      region,
      id,
      'Egress',
      desired.fields.egress as SgRule[] | undefined,
      (have?.fields.egress as SgRule[]) ?? []
    )
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
    if (changed.has('ingress'))
      await syncRules(
        ctx,
        region,
        id,
        'Ingress',
        desired.fields.ingress as SgRule[] | undefined,
        (obs.fields.ingress as SgRule[]) ?? []
      )
    if (changed.has('egress'))
      await syncRules(
        ctx,
        region,
        id,
        'Egress',
        desired.fields.egress as SgRule[] | undefined,
        (obs.fields.egress as SgRule[]) ?? []
      )
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'ec2', 'DeleteSecurityGroup', { GroupId: id }, { region })
  }
}
