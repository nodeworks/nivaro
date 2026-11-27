import {
  type DesiredResource,
  type FieldSpec,
  type Observed,
  type ProviderContext,
  ProviderError
} from '../types.js'
import { awsQuery, keyValueTags, orNull } from './client.js'
import {
  type AwsListPage,
  type AwsTypeDef,
  cap,
  nameField,
  observed,
  regionField,
  riskOf
} from './kit.js'
import { type XmlValue, xmlChild, xmlList, xmlText } from './xml.js'

/**
 * Elastic Load Balancing v2: aws.load_balancer (ALB / NLB, `cost: monthly`), aws.target_group
 * and aws.listener. Ids are ARNs. Listing is capped at one page of 50 load balancers.
 */

const t = xmlText
const c = xmlChild
const members = (v: XmlValue | undefined) => xmlList(v, 'member')

const refList = (key: string, label: string, refType: string): FieldSpec => ({
  key,
  label,
  kind: 'list',
  items: { key: 'item', label, kind: 'ref', refType }
})

const ids = (v: string | string[] | null | undefined): string[] =>
  Array.isArray(v) ? v : typeof v === 'string' && v ? [v] : []

const one = (v: string | string[] | null | undefined, what: string): string => {
  if (typeof v !== 'string' || !v)
    throw new ProviderError('REF_UNRESOLVED', `${what} is not created yet.`)
  return v
}

const elbTags = (d: DesiredResource) => keyValueTags({ ...d.tags, 'nivaro-hub:managed': 'true' })

async function tagsOf(
  ctx: ProviderContext,
  region: string,
  arn: string
): Promise<Record<string, string>> {
  const r = await awsQuery(ctx, 'elbv2', 'DescribeTags', { ResourceArns: [arn] }, { region })
  const out: Record<string, string> = {}
  const first = members(r.TagDescriptions)[0]
  for (const x of members(c(first, 'Tags'))) {
    const k = t(c(x, 'Key'))
    if (k) out[k] = t(c(x, 'Value'))
  }
  return out
}

const addTags = (ctx: ProviderContext, region: string, arn: string, d: DesiredResource) =>
  awsQuery(ctx, 'elbv2', 'AddTags', { ResourceArns: [arn], Tags: elbTags(d) }, { region })

// ── Load balancer ──

async function lbFromNode(
  ctx: ProviderContext,
  v: XmlValue,
  region: string
): Promise<Observed | null> {
  const arn = t(c(v, 'LoadBalancerArn'))
  if (!arn) return null
  const o = observed(
    'aws.load_balancer',
    arn,
    region,
    t(c(v, 'LoadBalancerName')),
    {
      type: t(c(v, 'Type')),
      scheme: t(c(v, 'Scheme')),
      subnets: members(c(v, 'AvailabilityZones'))
        .map((z) => t(c(z, 'SubnetId')))
        .filter(Boolean),
      security_groups: members(c(v, 'SecurityGroups'))
        .map((s) => (typeof s === 'string' ? s : ''))
        .filter(Boolean),
      ip_address_type: t(c(v, 'IpAddressType')) || undefined,
      vpc: t(c(v, 'VpcId')),
      dns_name: t(c(v, 'DNSName')),
      zone_id: t(c(v, 'CanonicalHostedZoneId'))
    },
    await tagsOf(ctx, region, arn),
    t(c(c(v, 'State'), 'Code'))
  )
  return o
}

async function describeLb(ctx: ProviderContext, params: Record<string, unknown>, region: string) {
  const r = await orNull(() => awsQuery(ctx, 'elbv2', 'DescribeLoadBalancers', params, { region }))
  const v = r && members(r.LoadBalancers)[0]
  return v ? lbFromNode(ctx, v, region) : null
}

export const loadBalancerDef: AwsTypeDef = {
  spec: {
    key: 'aws.load_balancer',
    label: 'Load balancer',
    scope: 'app',
    fields: [
      regionField,
      {
        ...nameField,
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[a-zA-Z0-9]([a-zA-Z0-9-]{0,30}[a-zA-Z0-9])?$',
        help: 'Up to 32 letters, digits and dashes.'
      },
      {
        key: 'type',
        label: 'Type',
        kind: 'enum',
        default: 'application',
        createOnly: true,
        replaceOnChange: true,
        options: [
          { value: 'application', label: 'Application (ALB)' },
          { value: 'network', label: 'Network (NLB)' }
        ]
      },
      {
        key: 'scheme',
        label: 'Scheme',
        kind: 'enum',
        default: 'internet-facing',
        createOnly: true,
        replaceOnChange: true,
        options: [
          { value: 'internet-facing', label: 'Internet-facing' },
          { value: 'internal', label: 'Internal' }
        ]
      },
      { ...refList('subnets', 'Subnets', 'aws.subnet'), required: true },
      refList('security_groups', 'Security groups', 'aws.security_group'),
      {
        key: 'ip_address_type',
        label: 'Address type',
        kind: 'enum',
        default: 'ipv4',
        options: [
          { value: 'ipv4', label: 'IPv4' },
          { value: 'dualstack', label: 'Dual stack' }
        ]
      },
      { key: 'dns_name', label: 'DNS name', kind: 'string', readOnly: true },
      { key: 'zone_id', label: 'Alias zone id', kind: 'string', readOnly: true },
      { key: 'vpc', label: 'VPC', kind: 'string', readOnly: true }
    ],
    capabilities: cap(),
    reversible: (f) => f === 'security_groups',
    refs: [
      { field: 'subnets', type: 'aws.subnet' },
      { field: 'security_groups', type: 'aws.security_group', required: false }
    ],
    risk: riskOf((op, d) => {
      const out: Array<'cost' | 'public_exposure' | 'downtime'> = []
      if (op.kind === 'create' || op.kind === 'replace') {
        out.push('cost')
        if ((d?.fields.scheme ?? 'internet-facing') === 'internet-facing')
          out.push('public_exposure')
      }
      if (op.kind === 'delete') out.push('downtime')
      return out
    }),
    costClass: () => 'monthly'
  },
  probe: {
    need: 'elasticloadbalancing:DescribeLoadBalancers',
    run: (ctx, region) =>
      awsQuery(ctx, 'elbv2', 'DescribeLoadBalancers', { PageSize: 1 }, { region })
  },
  observe: (ctx, id, region) => describeLb(ctx, { LoadBalancerArns: [id] }, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsQuery(
      ctx,
      'elbv2',
      'DescribeLoadBalancers',
      { PageSize: 50, Marker: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const v of members(r.LoadBalancers)) {
      const o = await lbFromNode(ctx, v, region)
      if (o) out.push(o)
    }
    return { items: out, next: t(r.NextMarker) || null }
  },
  findExisting: (ctx, desired, region) =>
    describeLb(ctx, { Names: [String(desired.fields.name)] }, region),
  async create(ctx, desired, region) {
    const f = desired.fields
    const sgs = ids(desired.refs.security_groups)
    const r = await awsQuery(
      ctx,
      'elbv2',
      'CreateLoadBalancer',
      {
        Name: f.name,
        Type: f.type ?? 'application',
        Scheme: f.scheme ?? 'internet-facing',
        Subnets: ids(desired.refs.subnets),
        SecurityGroups: sgs.length ? sgs : undefined,
        IpAddressType: f.ip_address_type || undefined,
        Tags: elbTags(desired)
      },
      { region }
    )
    const arn = t(c(members(r.LoadBalancers)[0], 'LoadBalancerArn'))
    if (!arn)
      throw new ProviderError('AWS_BAD_ANSWER', 'CreateLoadBalancer answered no ARN.', {
        retryable: true
      })
    return arn
  },
  async update(ctx, id, region, desired, _obs, changed) {
    if (changed.has('security_groups'))
      await awsQuery(
        ctx,
        'elbv2',
        'SetSecurityGroups',
        { LoadBalancerArn: id, SecurityGroups: ids(desired.refs.security_groups) },
        { region }
      )
    if (changed.has('subnets'))
      await awsQuery(
        ctx,
        'elbv2',
        'SetSubnets',
        { LoadBalancerArn: id, Subnets: ids(desired.refs.subnets) },
        { region }
      )
    if (changed.has('ip_address_type'))
      await awsQuery(
        ctx,
        'elbv2',
        'SetIpAddressType',
        { LoadBalancerArn: id, IpAddressType: desired.fields.ip_address_type },
        { region }
      )
    await addTags(ctx, region, id, desired)
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'elbv2', 'DeleteLoadBalancer', { LoadBalancerArn: id }, { region })
  }
}

// ── Target group ──

async function targetsOf(ctx: ProviderContext, arn: string, region: string): Promise<string[]> {
  const r = await awsQuery(
    ctx,
    'elbv2',
    'DescribeTargetHealth',
    { TargetGroupArn: arn },
    { region }
  )
  return members(r.TargetHealthDescriptions)
    .map((d) => t(c(c(d, 'Target'), 'Id')))
    .filter(Boolean)
}

async function tgFromNode(
  ctx: ProviderContext,
  v: XmlValue,
  region: string
): Promise<Observed | null> {
  const arn = t(c(v, 'TargetGroupArn'))
  if (!arn) return null
  return observed(
    'aws.target_group',
    arn,
    region,
    t(c(v, 'TargetGroupName')),
    {
      protocol: t(c(v, 'Protocol')),
      port: t(c(v, 'Port')) === '' ? undefined : Number(t(c(v, 'Port'))),
      vpc: t(c(v, 'VpcId')),
      target_type: t(c(v, 'TargetType')),
      health_check_path: t(c(v, 'HealthCheckPath')) || undefined,
      targets: await targetsOf(ctx, arn, region)
    },
    await tagsOf(ctx, region, arn),
    'active'
  )
}

async function describeTg(ctx: ProviderContext, params: Record<string, unknown>, region: string) {
  const r = await orNull(() => awsQuery(ctx, 'elbv2', 'DescribeTargetGroups', params, { region }))
  const v = r && members(r.TargetGroups)[0]
  return v ? tgFromNode(ctx, v, region) : null
}

export const targetGroupDef: AwsTypeDef = {
  spec: {
    key: 'aws.target_group',
    label: 'Target group',
    scope: 'app',
    fields: [
      regionField,
      { ...nameField, createOnly: true, replaceOnChange: true },
      {
        key: 'protocol',
        label: 'Protocol',
        kind: 'enum',
        required: true,
        createOnly: true,
        replaceOnChange: true,
        options: ['HTTP', 'HTTPS', 'TCP', 'TLS'].map((v) => ({ value: v, label: v }))
      },
      {
        key: 'port',
        label: 'Port',
        kind: 'number',
        required: true,
        min: 1,
        max: 65535,
        createOnly: true,
        replaceOnChange: true
      },
      {
        key: 'vpc',
        label: 'VPC',
        kind: 'ref',
        refType: 'aws.vpc',
        required: true,
        replaceOnChange: true
      },
      {
        key: 'target_type',
        label: 'Target type',
        kind: 'enum',
        default: 'instance',
        createOnly: true,
        replaceOnChange: true,
        options: ['instance', 'ip'].map((v) => ({ value: v, label: v }))
      },
      { key: 'health_check_path', label: 'Health check path', kind: 'string', default: '/' },
      refList('targets', 'Instances', 'aws.ec2_instance')
    ],
    capabilities: cap(),
    reversible: true,
    refs: [
      { field: 'vpc', type: 'aws.vpc' },
      { field: 'targets', type: 'aws.ec2_instance', required: false }
    ],
    risk: riskOf((op) =>
      op.kind === 'update' && op.changes.some((x) => x.field === 'targets') ? ['downtime'] : []
    )
  },
  probe: {
    need: 'elasticloadbalancing:DescribeTargetGroups',
    run: (ctx, region) =>
      awsQuery(ctx, 'elbv2', 'DescribeTargetGroups', { PageSize: 1 }, { region })
  },
  observe: (ctx, id, region) => describeTg(ctx, { TargetGroupArns: [id] }, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsQuery(
      ctx,
      'elbv2',
      'DescribeTargetGroups',
      { PageSize: 50, Marker: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const v of members(r.TargetGroups)) {
      const o = await tgFromNode(ctx, v, region)
      if (o) out.push(o)
    }
    return { items: out, next: t(r.NextMarker) || null }
  },
  findExisting: (ctx, desired, region) =>
    describeTg(ctx, { Names: [String(desired.fields.name)] }, region),
  async create(ctx, desired, region) {
    const f = desired.fields
    const r = await awsQuery(
      ctx,
      'elbv2',
      'CreateTargetGroup',
      {
        Name: f.name,
        Protocol: f.protocol,
        Port: f.port,
        VpcId: one(desired.refs.vpc, 'The VPC'),
        TargetType: f.target_type ?? 'instance',
        HealthCheckPath: f.health_check_path || undefined,
        Tags: elbTags(desired)
      },
      { region }
    )
    const arn = t(c(members(r.TargetGroups)[0], 'TargetGroupArn'))
    if (!arn)
      throw new ProviderError('AWS_BAD_ANSWER', 'CreateTargetGroup answered no ARN.', {
        retryable: true
      })
    const targets = ids(desired.refs.targets)
    if (targets.length)
      await awsQuery(
        ctx,
        'elbv2',
        'RegisterTargets',
        { TargetGroupArn: arn, Targets: targets.map((Id) => ({ Id })) },
        { region }
      )
    return arn
  },
  async update(ctx, id, region, desired, obs, changed) {
    if (changed.has('health_check_path'))
      await awsQuery(
        ctx,
        'elbv2',
        'ModifyTargetGroup',
        { TargetGroupArn: id, HealthCheckPath: desired.fields.health_check_path },
        { region }
      )
    if (changed.has('targets')) {
      const want = new Set(ids(desired.refs.targets))
      const have = new Set((obs.fields.targets as string[] | undefined) ?? [])
      const add = [...want].filter((x) => !have.has(x))
      const drop = [...have].filter((x) => !want.has(x))
      if (add.length)
        await awsQuery(
          ctx,
          'elbv2',
          'RegisterTargets',
          { TargetGroupArn: id, Targets: add.map((Id) => ({ Id })) },
          { region }
        )
      if (drop.length)
        await awsQuery(
          ctx,
          'elbv2',
          'DeregisterTargets',
          { TargetGroupArn: id, Targets: drop.map((Id) => ({ Id })) },
          { region }
        )
    }
    await addTags(ctx, region, id, desired)
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'elbv2', 'DeleteTargetGroup', { TargetGroupArn: id }, { region })
  }
}

// ── Listener ──

async function listenerFromNode(
  ctx: ProviderContext,
  v: XmlValue,
  region: string
): Promise<Observed | null> {
  const arn = t(c(v, 'ListenerArn'))
  if (!arn) return null
  const action = members(c(v, 'DefaultActions'))[0]
  const redirect = t(c(action, 'Type')) === 'redirect'
  const tg =
    t(c(action, 'TargetGroupArn')) ||
    t(c(members(c(c(action, 'ForwardConfig'), 'TargetGroups'))[0], 'TargetGroupArn'))
  return observed(
    'aws.listener',
    arn,
    region,
    `${t(c(v, 'Protocol'))}:${t(c(v, 'Port'))}`,
    {
      load_balancer: t(c(v, 'LoadBalancerArn')),
      port: Number(t(c(v, 'Port'))),
      protocol: t(c(v, 'Protocol')),
      certificate: t(c(members(c(v, 'Certificates'))[0], 'CertificateArn')) || undefined,
      ssl_policy: t(c(v, 'SslPolicy')) || undefined,
      default_action: redirect ? 'redirect_https' : 'forward',
      target_group: redirect ? undefined : tg || undefined
    },
    await tagsOf(ctx, region, arn),
    'active'
  )
}

const TLS_POLICY = 'ELBSecurityPolicy-TLS13-1-2-2021-06'

const defaultAction = (d: DesiredResource) =>
  d.fields.default_action === 'redirect_https'
    ? [
        {
          Type: 'redirect',
          RedirectConfig: { Protocol: 'HTTPS', Port: '443', StatusCode: 'HTTP_301' }
        }
      ]
    : [{ Type: 'forward', TargetGroupArn: one(d.refs.target_group, 'The target group') }]

const certs = (d: DesiredResource) =>
  typeof d.refs.certificate === 'string' && d.refs.certificate
    ? [{ CertificateArn: d.refs.certificate }]
    : undefined

export const listenerDef: AwsTypeDef = {
  spec: {
    key: 'aws.listener',
    label: 'Listener',
    scope: 'app',
    nameField: 'port',
    fields: [
      regionField,
      {
        key: 'load_balancer',
        label: 'Load balancer',
        kind: 'ref',
        refType: 'aws.load_balancer',
        required: true,
        replaceOnChange: true
      },
      { key: 'port', label: 'Port', kind: 'number', required: true, min: 1, max: 65535 },
      {
        key: 'protocol',
        label: 'Protocol',
        kind: 'enum',
        required: true,
        options: ['HTTP', 'HTTPS', 'TCP', 'TLS'].map((v) => ({ value: v, label: v }))
      },
      { key: 'certificate', label: 'Certificate', kind: 'ref', refType: 'aws.acm_certificate' },
      {
        key: 'ssl_policy',
        label: 'TLS policy',
        kind: 'string',
        help: 'HTTPS / TLS only; default ELBSecurityPolicy-TLS13-1-2-2021-06.'
      },
      {
        key: 'default_action',
        label: 'Default action',
        kind: 'enum',
        default: 'forward',
        options: [
          { value: 'forward', label: 'Forward to target group' },
          { value: 'redirect_https', label: 'Redirect to HTTPS' }
        ]
      },
      { key: 'target_group', label: 'Target group', kind: 'ref', refType: 'aws.target_group' }
    ],
    capabilities: cap(),
    reversible: true,
    refs: [
      { field: 'load_balancer', type: 'aws.load_balancer' },
      { field: 'certificate', type: 'aws.acm_certificate', required: false },
      { field: 'target_group', type: 'aws.target_group', required: false }
    ],
    risk: riskOf()
  },
  observe: async (ctx, id, region) => {
    const r = await orNull(() =>
      awsQuery(ctx, 'elbv2', 'DescribeListeners', { ListenerArns: [id] }, { region })
    )
    const v = r && members(r.Listeners)[0]
    return v ? listenerFromNode(ctx, v, region) : null
  },
  async list(ctx, region): Promise<AwsListPage> {
    const lbs = await awsQuery(ctx, 'elbv2', 'DescribeLoadBalancers', { PageSize: 50 }, { region })
    const out: Observed[] = []
    for (const lb of members(lbs.LoadBalancers)) {
      const r = await awsQuery(
        ctx,
        'elbv2',
        'DescribeListeners',
        { LoadBalancerArn: t(c(lb, 'LoadBalancerArn')) },
        { region }
      )
      for (const v of members(r.Listeners)) {
        const o = await listenerFromNode(ctx, v, region)
        if (o) out.push(o)
      }
    }
    return { items: out, next: null }
  },
  async findExisting(ctx, desired, region) {
    const lb = desired.refs.load_balancer
    if (typeof lb !== 'string' || !lb) return null
    const r = await awsQuery(ctx, 'elbv2', 'DescribeListeners', { LoadBalancerArn: lb }, { region })
    for (const v of members(r.Listeners))
      if (Number(t(c(v, 'Port'))) === Number(desired.fields.port))
        return listenerFromNode(ctx, v, region)
    return null
  },
  async create(ctx, desired, region) {
    const f = desired.fields
    const https = f.protocol === 'HTTPS' || f.protocol === 'TLS'
    const r = await awsQuery(
      ctx,
      'elbv2',
      'CreateListener',
      {
        LoadBalancerArn: one(desired.refs.load_balancer, 'The load balancer'),
        Port: f.port,
        Protocol: f.protocol,
        Certificates: https ? certs(desired) : undefined,
        SslPolicy: https ? f.ssl_policy || TLS_POLICY : undefined,
        DefaultActions: defaultAction(desired),
        Tags: elbTags(desired)
      },
      { region }
    )
    const arn = t(c(members(r.Listeners)[0], 'ListenerArn'))
    if (!arn)
      throw new ProviderError('AWS_BAD_ANSWER', 'CreateListener answered no ARN.', {
        retryable: true
      })
    return arn
  },
  async update(ctx, id, region, desired) {
    const f = desired.fields
    const https = f.protocol === 'HTTPS' || f.protocol === 'TLS'
    await awsQuery(
      ctx,
      'elbv2',
      'ModifyListener',
      {
        ListenerArn: id,
        Port: f.port,
        Protocol: f.protocol,
        Certificates: https ? certs(desired) : undefined,
        SslPolicy: https ? f.ssl_policy || TLS_POLICY : undefined,
        DefaultActions: defaultAction(desired)
      },
      { region }
    )
    await addTags(ctx, region, id, desired)
  },
  async remove(ctx, id, region) {
    await awsQuery(ctx, 'elbv2', 'DeleteListener', { ListenerArn: id }, { region })
  }
}

export const elbDefs: AwsTypeDef[] = [loadBalancerDef, targetGroupDef, listenerDef]
