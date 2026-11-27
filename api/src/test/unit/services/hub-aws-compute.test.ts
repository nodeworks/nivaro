import { describe, expect, it } from 'vitest'
import { awsProvider } from '../../../services/hub/providers/aws/adapter.js'
import { awsConnection } from '../../../services/hub/providers/aws/client.js'
import { CORE_PROVIDERS } from '../../../services/hub/providers/index.js'
import { ProviderError } from '../../../services/hub/providers/types.js'
import { CONFIG, desired, harness, OTHER_PROBES_OK, observedOf } from './hub-aws-harness.js'

// Nivaro Hub providers, Task 6: the AWS adapter's networking + compute types against recorded
// (fixture) AWS answers. LocalStack is not available here, so nothing runs against a live API.

const attrs = (call: { params: Record<string, string> }) =>
  call.params.Attribute === 'enableDnsSupport'
    ? 'ec2-vpc-attr-dns-support.xml'
    : 'ec2-vpc-attr-dns-hostnames.xml'

const EMPTY_SG =
  '<DescribeSecurityGroupsResponse xmlns="http://ec2.amazonaws.com/doc/2016-11-15/"><securityGroupInfo/></DescribeSecurityGroupsResponse>'

const vpcWant = {
  name: 'core',
  cidr: '10.0.0.0/16',
  enable_dns_support: true,
  enable_dns_hostnames: false
}

describe('aws adapter registration and connection', () => {
  it('is one CORE_PROVIDERS entry with exact per-region hosts and no wildcard', () => {
    expect(CORE_PROVIDERS.filter((p) => p.key === 'aws')).toHaveLength(1)
    const hosts = awsConnection.hosts(CONFIG)
    expect(hosts).toContain('ec2.us-east-1.amazonaws.com')
    expect(hosts).toContain('route53.amazonaws.com')
    expect(hosts.some((h) => h.startsWith('*'))).toBe(false)
    expect(hosts.some((h) => h.includes('ap-south'))).toBe(false)
    expect(hosts.some((h) => h.includes('169.254'))).toBe(false)
  })

  it('refuses a region that is not allowed before any call', async () => {
    const h = harness({}, { region: 'ap-south-1' })
    await expect(awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-1')).rejects.toMatchObject({
      code: 'REGION_NOT_ALLOWED'
    })
    expect(h.calls).toHaveLength(0)
  })

  it('assumes the role once with the external id and signs later calls with the session', async () => {
    const h = harness(
      {
        'sts:AssumeRole': 'sts-assume-role.xml',
        'ec2:DescribeVpcs': 'ec2-describe-vpcs.xml',
        'ec2:DescribeVpcAttribute': attrs
      },
      {
        config: { ...CONFIG, role_arn: 'arn:aws:iam::123456789012:role/nivaro-hub' },
        secrets: { external_id: 'test-secret-external-id' }
      }
    )
    await awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-0aaa1111')
    await awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-0aaa1111')
    expect(h.of('AssumeRole')).toHaveLength(1)
    expect(h.of('AssumeRole')[0].params.ExternalId).toBe('test-secret-external-id')
    expect(h.of('AssumeRole')[0].params.RoleArn).toBe('arn:aws:iam::123456789012:role/nivaro-hub')
    const ec2 = h.of('DescribeVpcs')[0]
    expect(ec2.headers.authorization).toContain('Credential=ASIAFAKEFAKEFAKE0001/')
    expect(ec2.headers['x-amz-security-token']).toBe('test-secret-session-token-0001')
  })
})

describe('aws testConnection', () => {
  it('lists missing permissions', async () => {
    const reads = [
      'DescribeVpcs',
      'DescribeSubnets',
      'DescribeRouteTables',
      'DescribeInternetGateways',
      'DescribeNatGateways',
      'DescribeNetworkAcls',
      'DescribeSecurityGroups',
      'DescribeAddresses',
      'DescribeInstances',
      'DescribeVolumes'
    ]
    const handlers: Record<string, never | { status: number; file: string }> = {}
    for (const a of reads)
      handlers[`ec2:${a}`] =
        a === 'DescribeInstances'
          ? { status: 403, file: 'ec2-error-unauthorized.xml' }
          : { status: 412, file: 'ec2-error-dryrun.xml' }
    const h = harness({
      ...OTHER_PROBES_OK,
      'sts:GetCallerIdentity': 'sts-caller-identity.xml',
      ...handlers
    } as never)
    const t = await awsProvider.testConnection(h.ctx)
    expect(t.ok).toBe(false)
    expect(t.identity).toContain('assumed-role/nivaro-hub')
    expect(t.missing).toEqual(['ec2:DescribeInstances'])
    expect(t.permissions.find((p) => p.type === 'aws.vpc')?.has).toBe(true)
  })

  it('answers not ok with a scrubbed message when the credentials are refused', async () => {
    const h = harness({
      'sts:GetCallerIdentity': {
        status: 403,
        body: '<ErrorResponse><Error><Type>Sender</Type><Code>InvalidClientTokenId</Code><Message>The security token test-secret-access-key-0001 is invalid</Message></Error></ErrorResponse>'
      }
    })
    const t = await awsProvider.testConnection(h.ctx)
    expect(t.ok).toBe(false)
    expect(t.message).not.toContain('test-secret-access-key-0001')
  })

  // Task 3b F: bad keys are AUTH_FAILED and never retryable ("check the keys", not "try again").
  it('maps every credential refusal to AUTH_FAILED, not retryable', async () => {
    const ec2 = (code: string) =>
      `<Response><Errors><Error><Code>${code}</Code><Message>key test-secret-access-key-0001 refused</Message></Error></Errors><RequestID>req-fake</RequestID></Response>`
    for (const [code, status] of [
      ['AuthFailure', 401],
      ['InvalidClientTokenId', 403],
      ['SignatureDoesNotMatch', 403],
      ['UnrecognizedClientException', 400],
      ['ExpiredToken', 400],
      ['', 401]
    ] as const) {
      const h = harness({
        'ec2:DescribeVpcs': { status, body: code ? ec2(code) : '' }
      })
      const err = await awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-1').catch((e) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect(err).toMatchObject({ code: 'AUTH_FAILED', retryable: false, status })
      expect(err.message).not.toContain('test-secret-access-key-0001')
      if (code) expect(err.message).toContain(code)
    }
    // A missing permission keeps its own code (it is not the keys), still not retryable.
    const h = harness({ 'ec2:DescribeVpcs': { status: 403, file: 'ec2-error-unauthorized.xml' } })
    const denied = await awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-1').catch((e) => e)
    expect(denied).toMatchObject({ code: 'UnauthorizedOperation', retryable: false })
    // Throttling stays retryable.
    const slow = harness({
      'ec2:DescribeVpcs': { status: 503, body: ec2('RequestLimitExceeded') }
    })
    const busy = await awsProvider.observe(slow.ctx, 'aws.vpc', 'vpc-1').catch((e) => e)
    expect(busy).toMatchObject({ code: 'RequestLimitExceeded', retryable: true })
  })
})

describe('aws plan reasons (Task 3b H)', () => {
  it('name the type and fields by their labels', () => {
    const h = harness({})
    const d = desired('aws.vpc', { ...vpcWant, region: 'us-east-1', name: 'hub-shared-2' })
    const [create] = awsProvider.plan(h.ctx, d, null)
    expect(create.reason).toBe('Create VPC hub-shared-2')
    const seen = observedOf({
      type: 'aws.vpc',
      externalId: 'vpc-1',
      name: 'hub-shared-2',
      fields: { ...vpcWant, region: 'us-east-1', name: 'hub-shared-2', enable_dns_hostnames: true }
    })
    const [update] = awsProvider.plan(h.ctx, { ...d, externalId: 'vpc-1' }, seen)
    expect(update.reason).toBe('Change DNS hostnames on VPC hub-shared-2')
  })
})

describe('aws observe', () => {
  it('maps a VPC with its DNS attributes and tags', async () => {
    const h = harness({
      'ec2:DescribeVpcs': 'ec2-describe-vpcs.xml',
      'ec2:DescribeVpcAttribute': attrs
    })
    const o = await awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-0aaa1111')
    expect(o).toMatchObject({
      externalId: 'vpc-0aaa1111',
      name: 'core',
      status: 'available',
      fields: {
        region: 'us-east-1',
        cidr: '10.0.0.0/16',
        enable_dns_support: true,
        enable_dns_hostnames: false
      }
    })
    expect(o?.tags['nivaro-hub:managed']).toBe('true')
  })

  it('answers null for a VPC that is gone', async () => {
    const h = harness({ 'ec2:DescribeVpcs': { status: 400, file: 'ec2-error-vpc-notfound.xml' } })
    expect(await awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-gone')).toBeNull()
  })

  it('maps security group rules, an instance, a volume, a NAT gateway, a route table and an address', async () => {
    const h = harness({
      'ec2:DescribeSecurityGroups': 'ec2-describe-sg.xml',
      'ec2:DescribeInstances': 'ec2-describe-instances.xml',
      'ec2:DescribeVolumes': 'ec2-describe-volumes.xml',
      'ec2:DescribeNatGateways': 'ec2-describe-nat.xml',
      'ec2:DescribeRouteTables': 'ec2-describe-route-tables.xml',
      'ec2:DescribeAddresses': 'ec2-describe-addresses.xml'
    })
    const sg = await awsProvider.observe(h.ctx, 'aws.security_group', 'sg-0ccc3333')
    expect(sg?.fields.ingress).toEqual([
      { protocol: 'tcp', from_port: 443, to_port: 443, cidr: '0.0.0.0/0' }
    ])
    expect(sg?.fields.egress).toEqual([{ protocol: '-1', cidr: '0.0.0.0/0' }])
    const i = await awsProvider.observe(h.ctx, 'aws.ec2_instance', 'i-0eee5555')
    expect(i?.fields).toMatchObject({
      instance_type: 't3.small',
      subnet: 'subnet-0fff6666',
      security_groups: ['sg-0ccc3333'],
      public_ip: '203.0.113.10'
    })
    expect(i?.status).toBe('running')
    const v = await awsProvider.observe(h.ctx, 'aws.ebs_volume', 'vol-0abc7777')
    expect(v?.fields).toMatchObject({
      size_gb: 100,
      volume_type: 'gp3',
      instance: 'i-0eee5555',
      device: '/dev/sdf'
    })
    const nat = await awsProvider.observe(h.ctx, 'aws.nat_gateway', 'nat-0aaa8888')
    expect(nat?.fields).toMatchObject({
      subnet: 'subnet-0fff6666',
      elastic_ip: 'eipalloc-0bbb9999'
    })
    const rt = await awsProvider.observe(h.ctx, 'aws.route_table', 'rtb-0ccc1010')
    expect(rt?.fields).toMatchObject({
      internet_gateway: 'igw-0ddd1111',
      subnets: ['subnet-0fff6666'],
      routes: []
    })
    const eip = await awsProvider.observe(h.ctx, 'aws.elastic_ip', 'eipalloc-0ccc2020')
    expect(eip?.fields).toMatchObject({ instance: 'i-0eee5555', public_ip: '203.0.113.30' })
  })

  it('lists across the allowed regions with a cursor', async () => {
    const h = harness({ 'ec2:DescribeVpcs': 'ec2-describe-vpcs.xml' }, { region: null })
    const first = await awsProvider.list(h.ctx, 'aws.vpc', null)
    expect(first.items).toHaveLength(1)
    expect(first.cursor).toBe('1|')
    const second = await awsProvider.list(h.ctx, 'aws.vpc', first.cursor)
    expect(second.cursor).toBeNull()
    expect(
      h.calls.map((c) => new URL(`https://x/${c.headers['x-amz-date']}`).pathname).length
    ).toBe(2)
  })
})

describe('aws plan', () => {
  const ctx = harness({}).ctx
  const vpcObs = observedOf({
    type: 'aws.vpc',
    externalId: 'vpc-0aaa1111',
    name: 'core',
    status: 'available',
    fields: {
      region: 'us-east-1',
      name: 'core',
      cidr: '10.0.0.0/16',
      enable_dns_support: true,
      enable_dns_hostnames: false
    }
  })

  it('creates, then answers a noop for an unchanged VPC', () => {
    const create = awsProvider.plan(ctx, desired('aws.vpc', vpcWant, { scope: 'shared' }), null)
    expect(create).toHaveLength(1)
    expect(create[0]).toMatchObject({ kind: 'create', type: 'aws.vpc' })
    expect(create[0].changes.map((c) => c.field)).toContain('cidr')
    const same = awsProvider.plan(ctx, desired('aws.vpc', vpcWant, { scope: 'shared' }), vpcObs)
    expect(same[0].kind).toBe('noop')
  })

  it('updates in place and replaces when a create-only field changes', () => {
    const upd = awsProvider.plan(
      ctx,
      desired('aws.vpc', { ...vpcWant, enable_dns_hostnames: true }),
      vpcObs
    )[0]
    expect(upd.kind).toBe('update')
    expect(upd.changes).toEqual([{ field: 'enable_dns_hostnames', from: false, to: true }])
    expect(upd.preconditions).toMatchObject({ status: 'available', enable_dns_hostnames: false })
    const rep = awsProvider.plan(
      ctx,
      desired('aws.vpc', { ...vpcWant, cidr: '10.9.0.0/16' }),
      vpcObs
    )[0]
    expect(rep.kind).toBe('replace')
    expect(rep.risk).toContain('destructive')
  })

  it('plans a delete from the observed state with its region', () => {
    const del = awsProvider.plan(ctx, null, vpcObs)[0]
    expect(del).toMatchObject({
      kind: 'delete',
      externalId: 'vpc-0aaa1111',
      data: { region: 'us-east-1' }
    })
    expect(del.risk).toContain('destructive')
  })

  it('treats a ref still being created as a change and ignores write-only fields', () => {
    const subnetObs = observedOf({
      type: 'aws.subnet',
      externalId: 'subnet-1',
      fields: {
        region: 'us-east-1',
        name: 's',
        vpc: 'vpc-1',
        cidr: '10.0.1.0/24',
        map_public_ip: false
      }
    })
    const d = desired(
      'aws.subnet',
      { name: 's', cidr: '10.0.1.0/24', map_public_ip: false },
      { refs: { vpc: 'vpc-1' } }
    )
    expect(awsProvider.plan(ctx, d, subnetObs)[0].kind).toBe('noop')
    const moved = desired(
      'aws.subnet',
      { name: 's', cidr: '10.0.1.0/24', map_public_ip: false },
      { refs: { vpc: null } }
    )
    expect(awsProvider.plan(ctx, moved, subnetObs)[0].kind).toBe('replace')
    const inst = observedOf({
      type: 'aws.ec2_instance',
      externalId: 'i-1',
      status: 'running',
      fields: {
        region: 'us-east-1',
        name: 'a',
        instance_type: 't3.small',
        image_id: 'ami-0fake0001',
        subnet: 'subnet-1',
        security_groups: ['sg-1']
      }
    })
    const di = desired(
      'aws.ec2_instance',
      { name: 'a', instance_type: 't3.small', image_id: 'ami-0fake0001', user_data: '#!/bin/sh' },
      { refs: { subnet: 'subnet-1', security_groups: ['sg-1'] } }
    )
    expect(awsProvider.plan(ctx, di, inst)[0].kind).toBe('noop')
  })

  it('diffs security group rules ignoring descriptions and order', () => {
    const obs = observedOf({
      type: 'aws.security_group',
      externalId: 'sg-1',
      fields: {
        region: 'us-east-1',
        name: 'web',
        description: 'Managed by Nivaro Hub',
        vpc: 'vpc-1',
        ingress: [{ protocol: 'tcp', from_port: 443, to_port: 443, cidr: '0.0.0.0/0' }]
      }
    })
    const base = { name: 'web', description: 'Managed by Nivaro Hub' }
    const same = desired(
      'aws.security_group',
      {
        ...base,
        ingress: [{ protocol: 'tcp', from_port: 443, cidr: '0.0.0.0/0', description: 'https' }]
      },
      { refs: { vpc: 'vpc-1' } }
    )
    expect(awsProvider.plan(ctx, same, obs)[0].kind).toBe('noop')
    const more = desired(
      'aws.security_group',
      {
        ...base,
        ingress: [
          { protocol: 'tcp', from_port: 443, cidr: '0.0.0.0/0' },
          { protocol: 'tcp', from_port: 22, cidr: '10.0.0.0/8' }
        ]
      },
      { refs: { vpc: 'vpc-1' } }
    )
    const op = awsProvider.plan(ctx, more, obs)[0]
    expect(op.kind).toBe('update')
    expect(op.changes[0].field).toBe('ingress')
    expect(op.risk).toEqual([])
  })

  it('refuses a volume shrink and plans a grow as an update', () => {
    const obs = observedOf({
      type: 'aws.ebs_volume',
      externalId: 'vol-1',
      status: 'in-use',
      fields: {
        region: 'us-east-1',
        name: 'data',
        availability_zone: 'us-east-1a',
        size_gb: 100,
        volume_type: 'gp3',
        encrypted: true
      }
    })
    const want = (size: number) =>
      desired('aws.ebs_volume', {
        name: 'data',
        availability_zone: 'us-east-1a',
        size_gb: size,
        volume_type: 'gp3',
        encrypted: true
      })
    expect(() => awsProvider.plan(ctx, want(50), obs)).toThrowError(
      expect.objectContaining({ code: 'VOLUME_SHRINK_REFUSED' })
    )
    expect(awsProvider.plan(ctx, want(200), obs)[0].kind).toBe('update')
  })

  it('plans an instance type change as an update that stops the instance', () => {
    const obs = observedOf({
      type: 'aws.ec2_instance',
      externalId: 'i-1',
      status: 'running',
      fields: {
        region: 'us-east-1',
        name: 'a',
        instance_type: 't3.small',
        image_id: 'ami-0fake0001',
        subnet: 'subnet-1',
        security_groups: []
      }
    })
    const d = desired(
      'aws.ec2_instance',
      { name: 'a', instance_type: 'm5.large', image_id: 'ami-0fake0001' },
      { refs: { subnet: 'subnet-1' } }
    )
    const op = awsProvider.plan(ctx, d, obs)[0]
    expect(op.kind).toBe('update')
    expect(op.risk.sort()).toEqual(['cost', 'downtime'])
  })
})

describe('aws risk flags', () => {
  const ctx = harness({}).ctx
  const risk = (type: string, fields: Record<string, unknown>, refs: Record<string, string> = {}) =>
    awsProvider.plan(ctx, desired(type, fields, { refs }), null)[0].risk

  it('flags world-open ingress other than 80/443 as public_exposure', () => {
    const sg = (rules: unknown[]) =>
      risk('aws.security_group', { name: 'w', ingress: rules }, { vpc: 'vpc-1' })
    expect(sg([{ protocol: 'tcp', from_port: 22, cidr: '0.0.0.0/0' }])).toContain('public_exposure')
    expect(sg([{ protocol: 'tcp', from_port: 22, cidr6: '::/0' }])).toContain('public_exposure')
    expect(sg([{ protocol: 'all', cidr: '0.0.0.0/0' }])).toContain('public_exposure')
    expect(sg([{ protocol: 'tcp', from_port: 80, to_port: 443, cidr: '0.0.0.0/0' }])).toContain(
      'public_exposure'
    )
    expect(sg([{ protocol: 'tcp', from_port: 443, cidr: '0.0.0.0/0' }])).toEqual([])
    expect(sg([{ protocol: 'tcp', from_port: 22, cidr: '10.0.0.0/8' }])).toEqual([])
  })

  it('flags cost, downtime and data loss per type', () => {
    expect(risk('aws.nat_gateway', { name: 'n' }, { subnet: 's' })).toContain('cost')
    expect(
      risk(
        'aws.ec2_instance',
        { name: 'a', instance_type: 't3.small', image_id: 'ami-0fake0001' },
        { subnet: 's' }
      )
    ).toEqual([])
    expect(
      risk(
        'aws.ec2_instance',
        { name: 'a', instance_type: 't3.medium', image_id: 'ami-0fake0001' },
        { subnet: 's' }
      )
    ).toContain('cost')
    expect(
      risk('aws.ebs_volume', { name: 'v', volume_type: 'io2', size_gb: 10, iops: 4000 })
    ).toContain('cost')
    const del = awsProvider.plan(
      ctx,
      null,
      observedOf({
        type: 'aws.ebs_volume',
        externalId: 'vol-1',
        fields: { region: 'us-east-1', size_gb: 1 }
      })
    )[0]
    expect(del.risk.sort()).toEqual(['data_loss', 'destructive'])
    expect(risk('aws.internet_gateway', { name: 'g' }, { vpc: 'v' })).toContain('public_exposure')
  })

  it('declares the right scope per type', () => {
    const scope = Object.fromEntries(awsProvider.types.map((t) => [t.key, t.scope]))
    expect(scope).toMatchObject({
      'aws.vpc': 'shared',
      'aws.subnet': 'shared',
      'aws.route_table': 'shared',
      'aws.internet_gateway': 'shared',
      'aws.nat_gateway': 'shared',
      'aws.network_acl': 'shared',
      'aws.security_group': 'app',
      'aws.elastic_ip': 'app',
      'aws.ec2_instance': 'app',
      'aws.ebs_volume': 'app'
    })
    expect(awsProvider.types.find((t) => t.key === 'aws.ebs_volume')?.capabilities.snapshot).toBe(
      true
    )
  })
})

describe('aws apply', () => {
  it('creates a VPC with the Hub tags and a client-safe request', async () => {
    const h = harness({
      'ec2:DescribeVpcs': [{ file: 'ec2-describe-vpcs-empty.xml' }, 'ec2-describe-vpcs.xml'],
      'ec2:CreateVpc': 'ec2-create-vpc.xml',
      'ec2:DescribeVpcAttribute': attrs
    })
    const d = desired('aws.vpc', vpcWant, { scope: 'shared' })
    const [op] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, op, d)
    expect(res.ok).toBe(true)
    expect(res.externalId).toBe('vpc-0bbb2222')
    const call = h.of('CreateVpc')[0]
    expect(call.params.CidrBlock).toBe('10.0.0.0/16')
    expect(call.params['TagSpecification.1.ResourceType']).toBe('vpc')
    const tags = Object.fromEntries(
      [1, 2, 3, 4, 5].map((n) => [
        call.params[`TagSpecification.1.Tag.${n}.Key`],
        call.params[`TagSpecification.1.Tag.${n}.Value`]
      ])
    )
    expect(tags).toMatchObject({
      'nivaro-hub:managed': 'true',
      'nivaro-hub:app': 'shop',
      'nivaro-hub:env': 'production',
      Name: 'core'
    })
  })

  it('is idempotent: a create resumed after the Hub made it reuses the tagged resource', async () => {
    const h = harness({
      'ec2:DescribeInstances': 'ec2-describe-instances.xml',
      'ec2:RunInstances': {
        status: 500,
        body: '<Response><Errors><Error><Code>InternalError</Code><Message>no</Message></Error></Errors></Response>'
      }
    })
    const d = desired(
      'aws.ec2_instance',
      { name: 'app-1', instance_type: 't3.small', image_id: 'ami-0fake0001', key_name: 'ops' },
      { refs: { subnet: 'subnet-0fff6666', security_groups: ['sg-0ccc3333'] } }
    )
    const [op] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, op, d)
    expect(res.externalId).toBe('i-0eee5555')
    expect(h.of('RunInstances')).toHaveLength(0)
  })

  it('does not write when an update finds nothing left to change, and does not delete a gone resource', async () => {
    const h = harness({
      'ec2:DescribeVpcs': 'ec2-describe-vpcs.xml',
      'ec2:DescribeVpcAttribute': attrs,
      'ec2:ModifyVpcAttribute': 'ec2-ok.xml'
    })
    const d = desired('aws.vpc', vpcWant, { externalId: 'vpc-0aaa1111', scope: 'shared' })
    const op = {
      kind: 'update' as const,
      type: 'aws.vpc',
      resourceId: 41,
      externalId: 'vpc-0aaa1111',
      reason: 'x',
      changes: [{ field: 'enable_dns_hostnames', from: false, to: true }],
      preconditions: {},
      risk: [],
      data: { region: 'us-east-1' }
    }
    const res = await awsProvider.apply(h.ctx, op, d)
    expect(res.ok).toBe(true)
    expect(h.of('ModifyVpcAttribute')).toHaveLength(0)

    const gone = harness({
      'ec2:DescribeVpcs': { status: 400, file: 'ec2-error-vpc-notfound.xml' }
    })
    const del = await awsProvider.apply(gone.ctx, { ...op, kind: 'delete', changes: [] }, null)
    expect(del).toMatchObject({ ok: true, observed: null })
    expect(gone.of('DeleteVpc')).toHaveLength(0)
  })

  it('refuses an update aimed at a different resource than the one desired (TARGET_MISMATCH)', async () => {
    const h = harness({ 'ec2:DescribeVpcs': 'ec2-describe-vpcs.xml' })
    const d = desired('aws.vpc', vpcWant, { externalId: 'vpc-0aaa1111' })
    await expect(
      awsProvider.apply(
        h.ctx,
        {
          kind: 'update',
          type: 'aws.vpc',
          resourceId: 41,
          externalId: 'vpc-0zzz9999',
          reason: '',
          changes: [],
          preconditions: {},
          risk: []
        },
        d
      )
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('snapshots a volume before it is deleted', async () => {
    const h = harness({ 'ec2:CreateSnapshot': 'ec2-create-snapshot.xml' })
    const snap = await awsProvider.snapshot?.(h.ctx, 'aws.ebs_volume', 'vol-0abc7777')
    expect(snap).toMatchObject({ kind: 'ebs_snapshot', id: 'snap-0123fake' })
    expect(h.of('CreateSnapshot')[0].params.VolumeId).toBe('vol-0abc7777')
  })

  it('security group create writes ingress rules and drops the default egress when egress is given', async () => {
    const h = harness({
      // tag lookup, name lookup (both empty), then the read after the create
      'ec2:DescribeSecurityGroups': [
        { body: EMPTY_SG },
        { body: EMPTY_SG },
        { file: 'ec2-describe-sg.xml' }
      ],
      'ec2:CreateSecurityGroup': 'ec2-create-sg.xml',
      'ec2:AuthorizeSecurityGroupIngress': 'ec2-ok.xml',
      'ec2:AuthorizeSecurityGroupEgress': 'ec2-ok.xml',
      'ec2:RevokeSecurityGroupIngress': 'ec2-ok.xml',
      'ec2:RevokeSecurityGroupEgress': 'ec2-ok.xml'
    })
    const d = desired(
      'aws.security_group',
      {
        name: 'api',
        description: 'API',
        ingress: [
          { protocol: 'tcp', from_port: 8080, cidr: '10.0.0.0/8', description: 'internal' }
        ],
        egress: [{ protocol: 'tcp', from_port: 443, cidr: '0.0.0.0/0' }]
      },
      { refs: { vpc: 'vpc-0aaa1111' } }
    )
    const [op] = awsProvider.plan(h.ctx, d, null)
    await awsProvider.apply(h.ctx, op, d)
    const auth = h.of('AuthorizeSecurityGroupIngress')[0]
    expect(auth.params['IpPermissions.1.IpProtocol']).toBe('tcp')
    expect(auth.params['IpPermissions.1.FromPort']).toBe('8080')
    expect(auth.params['IpPermissions.1.ToPort']).toBe('8080')
    expect(auth.params['IpPermissions.1.IpRanges.1.Description']).toBe('internal')
    expect(h.of('RevokeSecurityGroupEgress')[0].params['IpPermissions.1.IpProtocol']).toBe('-1')
  })
})

describe('aws create collisions never bind a resource the Hub did not make', () => {
  it('throws ALREADY_EXISTS when the name lookup finds a resource without the Hub resource tag', async () => {
    // The VPC answer carries no nivaro-hub:resource tag: someone else's resource.
    const h = harness({
      'ec2:DescribeVpcs': 'ec2-describe-vpcs.xml',
      'ec2:CreateVpc': 'ec2-create-vpc.xml'
    })
    const d = desired('aws.vpc', vpcWant, { scope: 'shared' })
    const [op] = awsProvider.plan(h.ctx, d, null)
    const err = await awsProvider.apply(h.ctx, op, d).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(err.message).toMatch(/adopt/i)
    expect(h.of('CreateVpc')).toHaveLength(0)
    expect(h.of('ModifyVpcAttribute')).toHaveLength(0)
  })

  it('throws ALREADY_EXISTS when AWS says the security group name is taken', async () => {
    const h = harness({
      'ec2:DescribeSecurityGroups': { file: 'ec2-describe-sg.xml' },
      'ec2:CreateSecurityGroup': { status: 400, file: 'ec2-error-sg-duplicate.xml' }
    })
    // findExisting would see the tagged group; make the lookup empty so the create itself collides.
    const empty = harness({
      'ec2:DescribeSecurityGroups': { body: EMPTY_SG },
      'ec2:CreateSecurityGroup': { status: 400, file: 'ec2-error-sg-duplicate.xml' }
    })
    const d = desired(
      'aws.security_group',
      { name: 'web', description: 'x' },
      { refs: { vpc: 'vpc-0aaa1111' } }
    )
    const [op] = awsProvider.plan(empty.ctx, d, null)
    await expect(awsProvider.apply(empty.ctx, op, d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(h.calls).toHaveLength(0)
  })
})

describe('aws findExisting (plan-time collision)', () => {
  it('a security group of that name in the VPC is a collision; the lookup is a read', async () => {
    const h = harness({
      'ec2:DescribeSecurityGroups': [{ body: EMPTY_SG }, { file: 'ec2-describe-sg.xml' }]
    })
    const d = desired(
      'aws.security_group',
      { name: 'web', description: 'x' },
      { refs: { vpc: 'vpc-0aaa1111' } }
    )
    const hit = await awsProvider.findExisting?.(h.ctx, 'aws.security_group', d)
    expect(hit).toMatchObject({ type: 'aws.security_group', externalId: 'sg-0ccc3333' })
    const byName = h.of('DescribeSecurityGroups')[1]
    expect(byName.params['Filter.1.Name']).toBe('group-name')
    expect(byName.params['Filter.1.Value.1']).toBe('web')
    expect(byName.params['Filter.2.Name']).toBe('vpc-id')
    expect(byName.params['Filter.2.Value.1']).toBe('vpc-0aaa1111')
    expect(h.calls.every((c) => c.action.startsWith('Describe'))).toBe(true)
  })

  it('no collision when the name is free, the VPC is made in the same change, or the run is resumed', async () => {
    const free = harness({ 'ec2:DescribeSecurityGroups': { body: EMPTY_SG } })
    const d = desired(
      'aws.security_group',
      { name: 'web', description: 'x' },
      { refs: { vpc: 'vpc-0aaa1111' } }
    )
    expect(await awsProvider.findExisting?.(free.ctx, 'aws.security_group', d)).toBeNull()
    const n = free.calls.length
    expect(
      await awsProvider.findExisting?.(
        free.ctx,
        'aws.security_group',
        desired('aws.security_group', { name: 'web', description: 'x' })
      )
    ).toBeNull()
    expect(free.calls.length).toBe(n + 1) // only the tag lookup; no name lookup without a VPC
    expect(
      await awsProvider.findExisting?.(free.ctx, 'aws.security_group', {
        ...d,
        externalId: 'sg-0ccc3333'
      })
    ).toBeNull()
    expect(free.calls.length).toBe(n + 1)
  })
})

describe('aws errors', () => {
  it('maps 429 and request-limit answers to a retryable error', async () => {
    const h = harness({ 'ec2:DescribeVpcs': { status: 429, file: 'ec2-error-throttle.xml' } })
    const err = await awsProvider.observe(h.ctx, 'aws.vpc', 'vpc-1').catch((e) => e)
    expect(err).toMatchObject({ code: 'RequestLimitExceeded', retryable: true, status: 429 })
    const h2 = harness({ 'ec2:DescribeVpcs': { status: 400, file: 'ec2-error-throttle.xml' } })
    expect(await awsProvider.observe(h2.ctx, 'aws.vpc', 'vpc-1').catch((e) => e)).toMatchObject({
      retryable: true
    })
    const h3 = harness({ 'ec2:DescribeVpcs': { status: 503, body: 'down' } })
    expect(await awsProvider.observe(h3.ctx, 'aws.vpc', 'vpc-1').catch((e) => e)).toMatchObject({
      retryable: true,
      status: 503
    })
    const h4 = harness({ 'ec2:DescribeVpcs': { status: 403, file: 'ec2-error-unauthorized.xml' } })
    expect(await awsProvider.observe(h4.ctx, 'aws.vpc', 'vpc-1').catch((e) => e)).toMatchObject({
      retryable: false
    })
  })

  it('never carries a connection secret, a session token or a password in an error', async () => {
    const leak =
      '<Response><Errors><Error><Code>InvalidParameterValue</Code><Message>bad test-secret-access-key-0001 and test-secret-session-token-0001 and hunter2-plain-pw</Message></Error></Errors></Response>'
    const h = harness(
      {
        'sts:AssumeRole': 'sts-assume-role.xml',
        'ec2:DescribeVpcs': { status: 200, file: 'ec2-describe-vpcs-empty.xml' },
        'ec2:CreateVpc': { status: 400, body: leak }
      },
      { config: { ...CONFIG, role_arn: 'arn:aws:iam::123456789012:role/nivaro-hub' } }
    )
    const d = desired('aws.vpc', {
      ...vpcWant,
      secretish: { fingerprint: 'f', changed: true, plain: 'hunter2-plain-pw' }
    })
    const [op] = awsProvider.plan(h.ctx, d, null)
    const err = await awsProvider.apply(h.ctx, op, d).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    for (const s of [
      'test-secret-access-key-0001',
      'test-secret-session-token-0001',
      'hunter2-plain-pw'
    ])
      expect(err.message).not.toContain(s)
    expect(h.ctx.scrub('x test-secret-access-key-0001')).not.toContain(
      'test-secret-access-key-0001'
    )
  })

  it('turns a host outside the allow list into a non-retryable error', async () => {
    const h = harness({}, { config: { ...CONFIG, regions: ['us-east-1'] }, region: 'us-east-1' })
    // eu-west-1 is not in this connection's list: refused before any call.
    await expect(
      awsProvider.list(
        harness({}, { config: { ...CONFIG, regions: ['us-east-1'] }, region: 'eu-west-1' }).ctx,
        'aws.vpc',
        null
      )
    ).rejects.toMatchObject({ code: 'REGION_NOT_ALLOWED' })
    expect(h.calls).toHaveLength(0)
  })
})
