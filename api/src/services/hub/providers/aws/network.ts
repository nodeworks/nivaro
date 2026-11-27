import type { DesiredResource, FieldSpec, Observed, ProviderContext } from '../types.js'
import { ProviderError } from '../types.js'
import { awsQuery, ec2TagSpec, hubTags, waitFor } from './client.js'
import {
  child,
  describeLister,
  describeOne,
  ec2Probe,
  findByResourceTag,
  flag,
  int,
  items,
  putTags,
  tagsOf,
  text
} from './ec2.js'
import { type AwsTypeDef, cap, nameField, observed, regionField, riskOf } from './kit.js'
import type { XmlValue } from './xml.js'

/**
 * AWS networking types: VPC, subnet, route table, internet gateway, NAT gateway, network ACL and
 * Elastic IP. VPC, subnet, route table, gateways and ACLs are `shared` (Hub admins only; a VPC
 * still referenced by app resources is refused by the engine as SHARED_IN_USE).
 */

const WORLD4 = '0.0.0.0/0'

const ref = (
  key: string,
  label: string,
  refType: string,
  extra: Partial<FieldSpec> = {}
): FieldSpec => ({
  key,
  label,
  kind: 'ref',
  refType,
  ...extra
})

const refList = (key: string, label: string, refType: string): FieldSpec => ({
  key,
  label,
  kind: 'list',
  items: { key: 'item', label, kind: 'ref', refType }
})

const refOne = (desired: DesiredResource, key: string): string => {
  const v = desired.refs[key]
  if (typeof v !== 'string' || !v)
    throw new ProviderError('REF_UNRESOLVED', `${key} is not created yet.`)
  return v
}

const refMany = (desired: DesiredResource, key: string): string[] => {
  const v = desired.refs[key]
  return Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []
}

async function ec2Id(
  ctx: ProviderContext,
  action: string,
  params: Record<string, unknown>,
  region: string,
  path: string[]
): Promise<string> {
  const r = await awsQuery(ctx, 'ec2', action, params, { region })
  let v: XmlValue | undefined = r
  for (const p of path) v = child(v, p)
  const id = text(v)
  if (!id)
    throw new ProviderError('AWS_BAD_ANSWER', `${action} answered no id.`, { retryable: true })
  return id
}

// ── VPC ──

function vpcMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'vpcId'))
  if (!id) return null
  const tags = tagsOf(child(v, 'tagSet'))
  return observed(
    'aws.vpc',
    id,
    region,
    tags.Name ?? null,
    { cidr: text(child(v, 'cidrBlock')) },
    tags,
    text(child(v, 'state'))
  )
}

export const vpcDef: AwsTypeDef = {
  spec: {
    key: 'aws.vpc',
    label: 'VPC',
    scope: 'shared',
    fields: [
      regionField,
      nameField,
      {
        key: 'cidr',
        label: 'CIDR block',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^\\d{1,3}(\\.\\d{1,3}){3}/\\d{1,2}$'
      },
      { key: 'enable_dns_support', label: 'DNS resolution', kind: 'boolean', default: true },
      { key: 'enable_dns_hostnames', label: 'DNS hostnames', kind: 'boolean', default: false }
    ],
    capabilities: cap(),
    reversible: (f) => f !== 'cidr' && f !== 'region',
    refs: [],
    risk: riskOf()
  },
  probe: ec2Probe('DescribeVpcs'),
  async observe(ctx, id, region) {
    const v = await describeOne(ctx, 'DescribeVpcs', 'vpcSet', 'VpcId', id, region)
    const o = v && vpcMap(v, region)
    if (!o) return null
    const attr = async (a: string) =>
      flag(
        child(
          child(
            await awsQuery(
              ctx,
              'ec2',
              'DescribeVpcAttribute',
              { VpcId: id, Attribute: a },
              { region }
            ),
            a
          ),
          'value'
        )
      )
    o.fields.enable_dns_support = await attr('enableDnsSupport')
    o.fields.enable_dns_hostnames = await attr('enableDnsHostnames')
    return o
  },
  list: describeLister('DescribeVpcs', 'vpcSet', vpcMap),
  findExisting: findByResourceTag('DescribeVpcs', 'vpcSet', vpcMap),
  async create(ctx, desired, region) {
    const id = await ec2Id(
      ctx,
      'CreateVpc',
      {
        CidrBlock: desired.fields.cidr,
        TagSpecification: ec2TagSpec('vpc', hubTags(desired.tags, desired.fields.name))
      },
      region,
      ['vpc', 'vpcId']
    )
    if (desired.fields.enable_dns_support === false)
      await awsQuery(
        ctx,
        'ec2',
        'ModifyVpcAttribute',
        { VpcId: id, EnableDnsSupport: { Value: false } },
        { region }
      )
    if (desired.fields.enable_dns_hostnames === true)
      await awsQuery(
        ctx,
        'ec2',
        'ModifyVpcAttribute',
        { VpcId: id, EnableDnsHostnames: { Value: true } },
        { region }
      )
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
    for (const [field, attr] of [
      ['enable_dns_support', 'EnableDnsSupport'],
      ['enable_dns_hostnames', 'EnableDnsHostnames']
    ] as const) {
      if (!changed.has(field)) continue
      const want = desired.fields[field] ?? field === 'enable_dns_support'
      if (obs.fields[field] === want) continue
      await awsQuery(
        ctx,
        'ec2',
        'ModifyVpcAttribute',
        { VpcId: id, [attr]: { Value: !!want } },
        { region }
      )
    }
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'ec2', 'DeleteVpc', { VpcId: id }, { region })
  }
}

// ── Subnet ──

function subnetMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'subnetId'))
  if (!id) return null
  const tags = tagsOf(child(v, 'tagSet'))
  return observed(
    'aws.subnet',
    id,
    region,
    tags.Name ?? null,
    {
      vpc: text(child(v, 'vpcId')),
      cidr: text(child(v, 'cidrBlock')),
      availability_zone: text(child(v, 'availabilityZone')),
      map_public_ip: flag(child(v, 'mapPublicIpOnLaunch'))
    },
    tags,
    text(child(v, 'state'))
  )
}

export const subnetDef: AwsTypeDef = {
  spec: {
    key: 'aws.subnet',
    label: 'Subnet',
    scope: 'shared',
    fields: [
      regionField,
      nameField,
      ref('vpc', 'VPC', 'aws.vpc', { required: true, replaceOnChange: true }),
      {
        key: 'cidr',
        label: 'CIDR block',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true
      },
      {
        key: 'availability_zone',
        label: 'Availability zone',
        kind: 'string',
        createOnly: true,
        replaceOnChange: true
      },
      { key: 'map_public_ip', label: 'Public IP on launch', kind: 'boolean', default: false }
    ],
    capabilities: cap(),
    reversible: (f) => f === 'map_public_ip' || f === 'name',
    refs: [{ field: 'vpc', type: 'aws.vpc' }],
    risk: riskOf((op, d) =>
      op.kind === 'update' && d?.fields.map_public_ip === true ? ['public_exposure'] : []
    )
  },
  probe: ec2Probe('DescribeSubnets'),
  async observe(ctx, id, region) {
    const v = await describeOne(ctx, 'DescribeSubnets', 'subnetSet', 'SubnetId', id, region)
    return v ? subnetMap(v, region) : null
  },
  list: describeLister('DescribeSubnets', 'subnetSet', subnetMap),
  findExisting: findByResourceTag('DescribeSubnets', 'subnetSet', subnetMap),
  async create(ctx, desired, region) {
    const id = await ec2Id(
      ctx,
      'CreateSubnet',
      {
        VpcId: refOne(desired, 'vpc'),
        CidrBlock: desired.fields.cidr,
        AvailabilityZone: desired.fields.availability_zone || undefined,
        TagSpecification: ec2TagSpec('subnet', hubTags(desired.tags, desired.fields.name))
      },
      region,
      ['subnet', 'subnetId']
    )
    if (desired.fields.map_public_ip === true)
      await awsQuery(
        ctx,
        'ec2',
        'ModifySubnetAttribute',
        { SubnetId: id, MapPublicIpOnLaunch: { Value: true } },
        { region }
      )
    return id
  },
  async update(ctx, id, region, desired, _obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
    if (changed.has('map_public_ip'))
      await awsQuery(
        ctx,
        'ec2',
        'ModifySubnetAttribute',
        { SubnetId: id, MapPublicIpOnLaunch: { Value: desired.fields.map_public_ip === true } },
        { region }
      )
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'ec2', 'DeleteSubnet', { SubnetId: id }, { region })
  }
}

// ── Internet gateway ──

function igwMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'internetGatewayId'))
  if (!id) return null
  const tags = tagsOf(child(v, 'tagSet'))
  const att = items(child(v, 'attachmentSet'))[0]
  return observed(
    'aws.internet_gateway',
    id,
    region,
    tags.Name ?? null,
    { vpc: text(child(att, 'vpcId')) || undefined },
    tags,
    text(child(att, 'state')) || 'detached'
  )
}

export const internetGatewayDef: AwsTypeDef = {
  spec: {
    key: 'aws.internet_gateway',
    label: 'Internet gateway',
    scope: 'shared',
    fields: [
      regionField,
      nameField,
      ref('vpc', 'VPC', 'aws.vpc', { required: true, replaceOnChange: true })
    ],
    capabilities: cap(),
    reversible: (f) => f === 'name',
    refs: [{ field: 'vpc', type: 'aws.vpc' }],
    risk: riskOf((op) => (op.kind === 'create' || op.kind === 'replace' ? ['public_exposure'] : []))
  },
  probe: ec2Probe('DescribeInternetGateways'),
  async observe(ctx, id, region) {
    const v = await describeOne(
      ctx,
      'DescribeInternetGateways',
      'internetGatewaySet',
      'InternetGatewayId',
      id,
      region
    )
    return v ? igwMap(v, region) : null
  },
  list: describeLister('DescribeInternetGateways', 'internetGatewaySet', igwMap),
  findExisting: findByResourceTag('DescribeInternetGateways', 'internetGatewaySet', igwMap),
  async create(ctx, desired, region) {
    const id = await ec2Id(
      ctx,
      'CreateInternetGateway',
      {
        TagSpecification: ec2TagSpec('internet-gateway', hubTags(desired.tags, desired.fields.name))
      },
      region,
      ['internetGateway', 'internetGatewayId']
    )
    await awsQuery(
      ctx,
      'ec2',
      'AttachInternetGateway',
      { InternetGatewayId: id, VpcId: refOne(desired, 'vpc') },
      { region }
    )
    return id
  },
  async update(ctx, id, region, desired, _obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
  },
  async remove(ctx, id, region) {
    const have = await describeOne(
      ctx,
      'DescribeInternetGateways',
      'internetGatewaySet',
      'InternetGatewayId',
      id,
      region
    )
    const vpc = text(child(items(child(have ?? '', 'attachmentSet'))[0], 'vpcId'))
    if (vpc)
      await awsQuery(
        ctx,
        'ec2',
        'DetachInternetGateway',
        { InternetGatewayId: id, VpcId: vpc },
        { region }
      )
    await awsQuery(ctx, 'ec2', 'DeleteInternetGateway', { InternetGatewayId: id }, { region })
  }
}

// ── Elastic IP ──

function eipMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'allocationId'))
  if (!id) return null
  const tags = tagsOf(child(v, 'tagSet'))
  return observed(
    'aws.elastic_ip',
    id,
    region,
    tags.Name ?? null,
    {
      instance: text(child(v, 'instanceId')) || undefined,
      public_ip: text(child(v, 'publicIp')),
      association_id: text(child(v, 'associationId')) || undefined
    },
    tags,
    text(child(v, 'associationId')) ? 'associated' : 'allocated'
  )
}

export const elasticIpDef: AwsTypeDef = {
  spec: {
    key: 'aws.elastic_ip',
    label: 'Elastic IP',
    scope: 'app',
    fields: [
      regionField,
      nameField,
      ref('instance', 'Attached instance', 'aws.ec2_instance'),
      { key: 'public_ip', label: 'Address', kind: 'string', readOnly: true },
      { key: 'association_id', label: 'Association', kind: 'string', readOnly: true }
    ],
    capabilities: cap(),
    reversible: (f) => f === 'instance' || f === 'name',
    refs: [{ field: 'instance', type: 'aws.ec2_instance', required: false }],
    risk: riskOf((op) => (op.changes.some((c) => c.field === 'instance') ? ['downtime'] : []))
  },
  probe: ec2Probe('DescribeAddresses'),
  async observe(ctx, id, region) {
    const v = await describeOne(
      ctx,
      'DescribeAddresses',
      'addressesSet',
      'AllocationId',
      id,
      region
    )
    return v ? eipMap(v, region) : null
  },
  list: describeLister('DescribeAddresses', 'addressesSet', eipMap, { paged: false }),
  findExisting: findByResourceTag('DescribeAddresses', 'addressesSet', eipMap),
  async create(ctx, desired, region) {
    const id = await ec2Id(
      ctx,
      'AllocateAddress',
      {
        Domain: 'vpc',
        TagSpecification: ec2TagSpec('elastic-ip', hubTags(desired.tags, desired.fields.name))
      },
      region,
      ['allocationId']
    )
    const inst = desired.refs.instance
    if (typeof inst === 'string' && inst)
      await awsQuery(
        ctx,
        'ec2',
        'AssociateAddress',
        { AllocationId: id, InstanceId: inst, AllowReassociation: false },
        { region }
      )
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
    if (!changed.has('instance')) return
    const want = typeof desired.refs.instance === 'string' ? desired.refs.instance : ''
    const have = typeof obs.fields.instance === 'string' ? obs.fields.instance : ''
    if (want === have) return
    const assoc = obs.fields.association_id
    if (typeof assoc === 'string' && assoc)
      await awsQuery(ctx, 'ec2', 'DisassociateAddress', { AssociationId: assoc }, { region })
    if (want)
      await awsQuery(
        ctx,
        'ec2',
        'AssociateAddress',
        { AllocationId: id, InstanceId: want, AllowReassociation: false },
        { region }
      )
  },
  async remove(ctx, id, region) {
    const have = await elasticIpDef.observe(ctx, id, region)
    const assoc = have?.fields.association_id
    if (typeof assoc === 'string' && assoc)
      await awsQuery(ctx, 'ec2', 'DisassociateAddress', { AssociationId: assoc }, { region })
    await awsQuery(ctx, 'ec2', 'ReleaseAddress', { AllocationId: id }, { region })
  }
}

// ── NAT gateway ──

function natMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'natGatewayId'))
  const state = text(child(v, 'state'))
  if (!id || state === 'deleted') return null
  const tags = tagsOf(child(v, 'tagSet'))
  const addr = items(child(v, 'natGatewayAddressSet'))[0]
  return observed(
    'aws.nat_gateway',
    id,
    region,
    tags.Name ?? null,
    {
      subnet: text(child(v, 'subnetId')),
      elastic_ip: text(child(addr, 'allocationId')) || undefined,
      connectivity: text(child(v, 'connectivityType')) || 'public',
      public_ip: text(child(addr, 'publicIp')) || undefined
    },
    tags,
    state
  )
}

export const natGatewayDef: AwsTypeDef = {
  spec: {
    key: 'aws.nat_gateway',
    label: 'NAT gateway',
    scope: 'shared',
    fields: [
      regionField,
      nameField,
      ref('subnet', 'Subnet', 'aws.subnet', { required: true, replaceOnChange: true }),
      ref('elastic_ip', 'Elastic IP', 'aws.elastic_ip', { replaceOnChange: true }),
      {
        key: 'connectivity',
        label: 'Connectivity',
        kind: 'enum',
        default: 'public',
        createOnly: true,
        replaceOnChange: true,
        options: [
          { value: 'public', label: 'Public' },
          { value: 'private', label: 'Private' }
        ]
      },
      { key: 'public_ip', label: 'Address', kind: 'string', readOnly: true }
    ],
    capabilities: cap(),
    reversible: (f) => f === 'name',
    refs: [
      { field: 'subnet', type: 'aws.subnet' },
      { field: 'elastic_ip', type: 'aws.elastic_ip', required: false }
    ],
    risk: riskOf((op) => (op.kind === 'create' || op.kind === 'replace' ? ['cost'] : [])),
    costClass: () => 'monthly'
  },
  probe: ec2Probe('DescribeNatGateways'),
  async observe(ctx, id, region) {
    const v = await describeOne(
      ctx,
      'DescribeNatGateways',
      'natGatewaySet',
      'NatGatewayId',
      id,
      region
    )
    return v ? natMap(v, region) : null
  },
  list: describeLister('DescribeNatGateways', 'natGatewaySet', natMap),
  findExisting: findByResourceTag('DescribeNatGateways', 'natGatewaySet', natMap),
  opData: (ctx, desired, _o, kind) =>
    kind === 'create' || kind === 'replace'
      ? { clientToken: `nivaro-nat-${desired?.resourceId ?? 'x'}-${ctx.now().getTime()}` }
      : {},
  async create(ctx, desired, region, op) {
    const connectivity = String(desired.fields.connectivity ?? 'public')
    const alloc = desired.refs.elastic_ip
    const id = await ec2Id(
      ctx,
      'CreateNatGateway',
      {
        SubnetId: refOne(desired, 'subnet'),
        AllocationId: connectivity === 'public' && typeof alloc === 'string' ? alloc : undefined,
        ConnectivityType: connectivity,
        ClientToken: String(op.data?.clientToken ?? '').slice(0, 64) || undefined,
        TagSpecification: ec2TagSpec('natgateway', hubTags(desired.tags, desired.fields.name))
      },
      region,
      ['natGateway', 'natGatewayId']
    )
    // Routes can only point at an available gateway.
    await waitFor(ctx, async () => {
      const o = await natGatewayDef.observe(ctx, id, region)
      if (o?.status === 'failed')
        throw new ProviderError('NAT_FAILED', 'AWS could not create the NAT gateway.')
      return o?.status === 'available' ? o : null
    })
    return id
  },
  async update(ctx, id, region, desired, _o, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'ec2', 'DeleteNatGateway', { NatGatewayId: id }, { region })
  }
}

// ── Route table ──

const routeTarget = (t: string): Record<string, string> => {
  if (t.startsWith('nat-')) return { NatGatewayId: t }
  if (t.startsWith('i-')) return { InstanceId: t }
  if (t.startsWith('pcx-')) return { VpcPeeringConnectionId: t }
  if (t.startsWith('eni-')) return { NetworkInterfaceId: t }
  if (t.startsWith('tgw-')) return { TransitGatewayId: t }
  return { GatewayId: t }
}

interface RawRoute {
  dest: string
  target: string
}

function rawRoutes(v: XmlValue): RawRoute[] {
  const out: RawRoute[] = []
  for (const r of items(child(v, 'routeSet'))) {
    if (text(child(r, 'origin')) !== 'CreateRoute') continue
    const dest =
      text(child(r, 'destinationCidrBlock')) ||
      text(child(r, 'destinationIpv6CidrBlock')) ||
      text(child(r, 'destinationPrefixListId'))
    const target =
      text(child(r, 'gatewayId')) ||
      text(child(r, 'natGatewayId')) ||
      text(child(r, 'instanceId')) ||
      text(child(r, 'vpcPeeringConnectionId')) ||
      text(child(r, 'networkInterfaceId')) ||
      text(child(r, 'transitGatewayId'))
    if (dest && target && target !== 'local') out.push({ dest, target })
  }
  return out
}

function rtMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'routeTableId'))
  if (!id) return null
  const tags = tagsOf(child(v, 'tagSet'))
  const routes = rawRoutes(v)
  const igw = routes.find((r) => r.dest === WORLD4 && r.target.startsWith('igw-'))
  const nat = routes.find((r) => r.dest === WORLD4 && r.target.startsWith('nat-'))
  const subnets = items(child(v, 'associationSet'))
    .filter((a) => !flag(child(a, 'main')) && text(child(a, 'subnetId')))
    .map((a) => text(child(a, 'subnetId')))
  return observed(
    'aws.route_table',
    id,
    region,
    tags.Name ?? null,
    {
      vpc: text(child(v, 'vpcId')),
      internet_gateway: igw?.target,
      nat_gateway: nat?.target,
      routes: routes
        .filter((r) => r !== igw && r !== nat)
        .map((r) => ({ destination: r.dest, target: r.target })),
      subnets
    },
    tags,
    'available'
  )
}

async function syncRoutes(
  ctx: ProviderContext,
  region: string,
  id: string,
  desired: DesiredResource,
  have: Observed
) {
  const managed =
    desired.refs.internet_gateway !== undefined ||
    desired.refs.nat_gateway !== undefined ||
    desired.fields.routes !== undefined
  if (!managed) return
  const want = new Map<string, string>()
  const ig = desired.refs.internet_gateway
  const nat = desired.refs.nat_gateway
  if (typeof ig === 'string' && ig) want.set(WORLD4, ig)
  else if (typeof nat === 'string' && nat) want.set(WORLD4, nat)
  for (const r of (desired.fields.routes as
    | Array<{ destination: string; target: string }>
    | undefined) ?? [])
    want.set(r.destination, r.target)
  const cur = new Map<string, string>()
  const f = have.fields
  if (typeof f.internet_gateway === 'string') cur.set(WORLD4, f.internet_gateway)
  else if (typeof f.nat_gateway === 'string') cur.set(WORLD4, f.nat_gateway)
  for (const r of (f.routes as Array<{ destination: string; target: string }> | undefined) ?? [])
    cur.set(r.destination, r.target)
  for (const [dest, target] of want) {
    if (cur.get(dest) === target) continue
    const p = { RouteTableId: id, DestinationCidrBlock: dest, ...routeTarget(target) }
    await awsQuery(ctx, 'ec2', cur.has(dest) ? 'ReplaceRoute' : 'CreateRoute', p, { region })
  }
  for (const dest of cur.keys())
    if (!want.has(dest))
      await awsQuery(
        ctx,
        'ec2',
        'DeleteRoute',
        { RouteTableId: id, DestinationCidrBlock: dest },
        { region }
      )
}

async function syncAssociations(
  ctx: ProviderContext,
  region: string,
  id: string,
  desired: DesiredResource
) {
  if (desired.refs.subnets === undefined) return
  const want = new Set(refMany(desired, 'subnets'))
  const raw = await describeOne(
    ctx,
    'DescribeRouteTables',
    'routeTableSet',
    'RouteTableId',
    id,
    region
  )
  const have = new Map<string, string>()
  for (const a of items(child(raw ?? '', 'associationSet')))
    if (!flag(child(a, 'main')) && text(child(a, 'subnetId')))
      have.set(text(child(a, 'subnetId')), text(child(a, 'routeTableAssociationId')))
  for (const s of want)
    if (!have.has(s))
      await awsQuery(
        ctx,
        'ec2',
        'AssociateRouteTable',
        { RouteTableId: id, SubnetId: s },
        { region }
      )
  for (const [s, assoc] of have)
    if (!want.has(s))
      await awsQuery(ctx, 'ec2', 'DisassociateRouteTable', { AssociationId: assoc }, { region })
}

export const routeTableDef: AwsTypeDef = {
  spec: {
    key: 'aws.route_table',
    label: 'Route table',
    scope: 'shared',
    fields: [
      regionField,
      nameField,
      ref('vpc', 'VPC', 'aws.vpc', { required: true, replaceOnChange: true }),
      ref('internet_gateway', 'Internet gateway (0.0.0.0/0)', 'aws.internet_gateway'),
      ref('nat_gateway', 'NAT gateway (0.0.0.0/0)', 'aws.nat_gateway', {
        help: 'Used for 0.0.0.0/0 only when no internet gateway is set.'
      }),
      {
        key: 'routes',
        label: 'Other routes',
        kind: 'list',
        items: {
          key: 'route',
          label: 'Route',
          kind: 'object',
          fields: [
            { key: 'destination', label: 'Destination CIDR', kind: 'string', required: true },
            {
              key: 'target',
              label: 'Target id',
              kind: 'string',
              required: true,
              help: 'pcx-…, tgw-…, eni-…, i-…'
            }
          ]
        }
      },
      refList('subnets', 'Associated subnets', 'aws.subnet')
    ],
    capabilities: cap(),
    reversible: true,
    refs: [
      { field: 'vpc', type: 'aws.vpc' },
      { field: 'internet_gateway', type: 'aws.internet_gateway', required: false },
      { field: 'nat_gateway', type: 'aws.nat_gateway', required: false },
      { field: 'subnets', type: 'aws.subnet', required: false }
    ],
    risk: riskOf((op) =>
      op.kind === 'update' &&
      op.changes.some(
        (c) => c.field === 'internet_gateway' || c.field === 'routes' || c.field === 'subnets'
      )
        ? ['downtime']
        : []
    )
  },
  probe: ec2Probe('DescribeRouteTables'),
  async observe(ctx, id, region) {
    const v = await describeOne(
      ctx,
      'DescribeRouteTables',
      'routeTableSet',
      'RouteTableId',
      id,
      region
    )
    return v ? rtMap(v, region) : null
  },
  list: describeLister('DescribeRouteTables', 'routeTableSet', rtMap),
  findExisting: findByResourceTag('DescribeRouteTables', 'routeTableSet', rtMap),
  async create(ctx, desired, region) {
    const id = await ec2Id(
      ctx,
      'CreateRouteTable',
      {
        VpcId: refOne(desired, 'vpc'),
        TagSpecification: ec2TagSpec('route-table', hubTags(desired.tags, desired.fields.name))
      },
      region,
      ['routeTable', 'routeTableId']
    )
    await syncRoutes(
      ctx,
      region,
      id,
      desired,
      observed('aws.route_table', id, region, null, {}, {})
    )
    await syncAssociations(ctx, region, id, desired)
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
    await syncRoutes(ctx, region, id, desired, obs)
    if (changed.has('subnets')) await syncAssociations(ctx, region, id, desired)
  },
  async remove(ctx, id, region) {
    const raw = await describeOne(
      ctx,
      'DescribeRouteTables',
      'routeTableSet',
      'RouteTableId',
      id,
      region
    )
    for (const a of items(child(raw ?? '', 'associationSet')))
      if (!flag(child(a, 'main')) && text(child(a, 'routeTableAssociationId')))
        await awsQuery(
          ctx,
          'ec2',
          'DisassociateRouteTable',
          { AssociationId: text(child(a, 'routeTableAssociationId')) },
          { region }
        )
    await awsQuery(ctx, 'ec2', 'DeleteRouteTable', { RouteTableId: id }, { region })
  }
}

// ── Network ACL ──

interface AclRule {
  rule_number: number
  protocol: string
  action: string
  cidr: string
  from_port?: number
  to_port?: number
}

const PROTO_NUM: Record<string, string> = { tcp: '6', udp: '17', icmp: '1', all: '-1', '-1': '-1' }
const PROTO_NAME: Record<string, string> = { '6': 'tcp', '17': 'udp', '1': 'icmp', '-1': 'all' }

const aclRuleFields: FieldSpec = {
  key: 'rule',
  label: 'Rule',
  kind: 'object',
  fields: [
    {
      key: 'rule_number',
      label: 'Rule number',
      kind: 'number',
      required: true,
      min: 1,
      max: 32766
    },
    {
      key: 'protocol',
      label: 'Protocol',
      kind: 'enum',
      required: true,
      options: ['tcp', 'udp', 'icmp', 'all'].map((v) => ({ value: v, label: v }))
    },
    {
      key: 'action',
      label: 'Action',
      kind: 'enum',
      required: true,
      options: [
        { value: 'allow', label: 'Allow' },
        { value: 'deny', label: 'Deny' }
      ]
    },
    { key: 'cidr', label: 'CIDR', kind: 'string', required: true },
    { key: 'from_port', label: 'From port', kind: 'number' },
    { key: 'to_port', label: 'To port', kind: 'number' }
  ]
}

function aclRules(v: XmlValue, egress: boolean): AclRule[] {
  const out: AclRule[] = []
  for (const e of items(child(v, 'entrySet'))) {
    if (flag(child(e, 'egress')) !== egress) continue
    const n = int(child(e, 'ruleNumber')) ?? 0
    if (n === 32767) continue // the implicit deny
    const pr = child(e, 'portRange')
    out.push({
      rule_number: n,
      protocol: PROTO_NAME[text(child(e, 'protocol'))] ?? text(child(e, 'protocol')),
      action: text(child(e, 'ruleAction')),
      cidr: text(child(e, 'cidrBlock')),
      from_port: pr ? int(child(pr, 'from')) : undefined,
      to_port: pr ? int(child(pr, 'to')) : undefined
    })
  }
  return out.sort((a, b) => a.rule_number - b.rule_number)
}

function aclMap(v: XmlValue, region: string): Observed | null {
  const id = text(child(v, 'networkAclId'))
  if (!id || flag(child(v, 'default')))
    return id
      ? observed(
          'aws.network_acl',
          id,
          region,
          'default',
          { vpc: text(child(v, 'vpcId')) },
          tagsOf(child(v, 'tagSet')),
          'default'
        )
      : null
  const tags = tagsOf(child(v, 'tagSet'))
  return observed(
    'aws.network_acl',
    id,
    region,
    tags.Name ?? null,
    {
      vpc: text(child(v, 'vpcId')),
      ingress: aclRules(v, false),
      egress: aclRules(v, true),
      subnets: items(child(v, 'associationSet'))
        .map((a) => text(child(a, 'subnetId')))
        .filter(Boolean)
    },
    tags,
    'available'
  )
}

const aclEntry = (id: string, r: AclRule, egress: boolean) => ({
  NetworkAclId: id,
  RuleNumber: r.rule_number,
  Protocol: PROTO_NUM[r.protocol] ?? r.protocol,
  RuleAction: r.action,
  Egress: egress,
  CidrBlock: r.cidr,
  PortRange:
    r.protocol === 'tcp' || r.protocol === 'udp'
      ? { From: r.from_port ?? 0, To: r.to_port ?? r.from_port ?? 65535 }
      : undefined
})

async function syncAclRules(
  ctx: ProviderContext,
  region: string,
  id: string,
  egress: boolean,
  want: AclRule[] | undefined,
  have: AclRule[]
) {
  if (!want) return
  const key = (r: AclRule) =>
    JSON.stringify([r.protocol, r.action, r.cidr, r.from_port ?? null, r.to_port ?? null])
  const haveBy = new Map(have.map((r) => [r.rule_number, r]))
  const wantNums = new Set(want.map((r) => r.rule_number))
  for (const r of want) {
    const h = haveBy.get(r.rule_number)
    if (h && key(h) === key(r)) continue
    await awsQuery(
      ctx,
      'ec2',
      h ? 'ReplaceNetworkAclEntry' : 'CreateNetworkAclEntry',
      aclEntry(id, r, egress),
      { region }
    )
  }
  for (const h of have)
    if (!wantNums.has(h.rule_number))
      await awsQuery(
        ctx,
        'ec2',
        'DeleteNetworkAclEntry',
        { NetworkAclId: id, RuleNumber: h.rule_number, Egress: egress },
        { region }
      )
}

async function aclSubnets(
  ctx: ProviderContext,
  region: string,
  id: string,
  desired: DesiredResource | null,
  obs: Observed
) {
  if (desired && desired.refs.subnets === undefined) return
  const want = new Set(desired ? refMany(desired, 'subnets') : [])
  const have = new Set((obs.fields.subnets as string[] | undefined) ?? [])
  const vpc = String(obs.fields.vpc ?? '')
  const defaults = await awsQuery(
    ctx,
    'ec2',
    'DescribeNetworkAcls',
    {
      Filter: [
        { Name: 'vpc-id', Value: [vpc] },
        { Name: 'default', Value: ['true'] }
      ]
    },
    { region }
  )
  const defaultId = text(child(items(defaults.networkAclSet)[0], 'networkAclId'))
  const assocFor = async (subnet: string) => {
    const r = await awsQuery(
      ctx,
      'ec2',
      'DescribeNetworkAcls',
      { Filter: [{ Name: 'association.subnet-id', Value: [subnet] }] },
      { region }
    )
    for (const acl of items(r.networkAclSet))
      for (const a of items(child(acl, 'associationSet')))
        if (text(child(a, 'subnetId')) === subnet) return text(child(a, 'networkAclAssociationId'))
    return ''
  }
  for (const s of want)
    if (!have.has(s)) {
      const assoc = await assocFor(s)
      if (assoc)
        await awsQuery(
          ctx,
          'ec2',
          'ReplaceNetworkAclAssociation',
          { AssociationId: assoc, NetworkAclId: id },
          { region }
        )
    }
  for (const s of have)
    if (!want.has(s) && defaultId) {
      const assoc = await assocFor(s)
      if (assoc)
        await awsQuery(
          ctx,
          'ec2',
          'ReplaceNetworkAclAssociation',
          { AssociationId: assoc, NetworkAclId: defaultId },
          { region }
        )
    }
}

export const networkAclDef: AwsTypeDef = {
  spec: {
    key: 'aws.network_acl',
    label: 'Network ACL',
    scope: 'shared',
    fields: [
      regionField,
      nameField,
      ref('vpc', 'VPC', 'aws.vpc', { required: true, replaceOnChange: true }),
      { key: 'ingress', label: 'Inbound rules', kind: 'list', items: aclRuleFields },
      { key: 'egress', label: 'Outbound rules', kind: 'list', items: aclRuleFields },
      refList('subnets', 'Associated subnets', 'aws.subnet')
    ],
    capabilities: cap(),
    reversible: true,
    refs: [
      { field: 'vpc', type: 'aws.vpc' },
      { field: 'subnets', type: 'aws.subnet', required: false }
    ],
    risk: riskOf((op, d) => {
      const out: Array<'public_exposure'> = []
      const rules = [...((d?.fields.ingress as AclRule[] | undefined) ?? [])]
      if (
        op.kind !== 'delete' &&
        rules.some(
          (r) =>
            r.action === 'allow' &&
            r.cidr === WORLD4 &&
            !(r.from_port === 443 && r.to_port === 443) &&
            !(r.from_port === 80 && r.to_port === 80)
        )
      )
        out.push('public_exposure')
      return out
    })
  },
  probe: ec2Probe('DescribeNetworkAcls'),
  async observe(ctx, id, region) {
    const v = await describeOne(
      ctx,
      'DescribeNetworkAcls',
      'networkAclSet',
      'NetworkAclId',
      id,
      region
    )
    return v ? aclMap(v, region) : null
  },
  list: describeLister('DescribeNetworkAcls', 'networkAclSet', aclMap),
  findExisting: findByResourceTag('DescribeNetworkAcls', 'networkAclSet', aclMap),
  async create(ctx, desired, region) {
    const id = await ec2Id(
      ctx,
      'CreateNetworkAcl',
      {
        VpcId: refOne(desired, 'vpc'),
        TagSpecification: ec2TagSpec('network-acl', hubTags(desired.tags, desired.fields.name))
      },
      region,
      ['networkAcl', 'networkAclId']
    )
    const have = await networkAclDef.observe(ctx, id, region)
    if (!have)
      throw new ProviderError('AWS_BAD_ANSWER', 'The new network ACL is not readable yet.', {
        retryable: true
      })
    await syncAclRules(ctx, region, id, false, desired.fields.ingress as AclRule[] | undefined, [])
    await syncAclRules(ctx, region, id, true, desired.fields.egress as AclRule[] | undefined, [])
    await aclSubnets(ctx, region, id, desired, have)
    return id
  },
  async update(ctx, id, region, desired, obs, changed) {
    if (changed.has('name'))
      await putTags(ctx, region, id, hubTags(desired.tags, desired.fields.name))
    if (changed.has('ingress'))
      await syncAclRules(
        ctx,
        region,
        id,
        false,
        desired.fields.ingress as AclRule[] | undefined,
        (obs.fields.ingress as AclRule[]) ?? []
      )
    if (changed.has('egress'))
      await syncAclRules(
        ctx,
        region,
        id,
        true,
        desired.fields.egress as AclRule[] | undefined,
        (obs.fields.egress as AclRule[]) ?? []
      )
    if (changed.has('subnets')) await aclSubnets(ctx, region, id, desired, obs)
  },
  async remove(ctx, id, region) {
    const have = await networkAclDef.observe(ctx, id, region)
    if (have) await aclSubnets(ctx, region, id, null, have)
    await awsQuery(ctx, 'ec2', 'DeleteNetworkAcl', { NetworkAclId: id }, { region })
  }
}

export const networkDefs: AwsTypeDef[] = [
  vpcDef,
  subnetDef,
  routeTableDef,
  internetGatewayDef,
  natGatewayDef,
  networkAclDef,
  elasticIpDef
]
