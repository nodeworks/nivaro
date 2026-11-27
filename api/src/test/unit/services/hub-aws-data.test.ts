import { describe, expect, it } from 'vitest'
import { awsProvider } from '../../../services/hub/providers/aws/adapter.js'
import type { PlannedOp } from '../../../services/hub/providers/types.js'
import { ProviderError } from '../../../services/hub/providers/types.js'
import { desired, harness, observedOf } from './hub-aws-harness.js'

// Nivaro Hub providers, Task 7: the AWS adapter's data and edge types (RDS, S3, Route 53, load
// balancers, ACM) against recorded (fixture) AWS answers. LocalStack is not available here.

const ARN =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:loadbalancer/app/shop-lb/50dc6c495c0c9188'
const TG =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:targetgroup/shop-tg/73e2d6bc24d8a067'
const LS =
  'arn:aws:elasticloadbalancing:us-east-1:123456789012:listener/app/shop-lb/50dc6c495c0c9188/f2f7dc8efc522ab2'
const CERT = 'arn:aws:acm:us-east-1:123456789012:certificate/0123fake'
const ZONE = 'Z0AAA1111FAKE'

const notFound = (file: string, status = 400) => ({ status, file })

/** The five subresource reads of an existing, hub-tagged, locked-down bucket. */
const bucket = (over: Record<string, unknown> = {}) => ({
  's3:GET /shop-assets?location=': 's3-location-us-east-1.xml',
  's3:GET /shop-assets?publicAccessBlock=': 's3-public-access-block.xml',
  's3:GET /shop-assets?versioning=': 's3-versioning.xml',
  's3:GET /shop-assets?encryption=': 's3-encryption.xml',
  's3:GET /shop-assets?tagging=': 's3-tagging-hub.xml',
  ...over
})

const bucketWant = {
  name: 'shop-assets',
  block_public_access: true,
  versioning: true,
  encryption: true
}
const rdsWant = {
  name: 'shop-db',
  engine: 'postgres',
  engine_version: '16.3',
  instance_class: 'db.t3.medium',
  allocated_storage_gb: 100,
  master_username: 'shopadmin',
  master_password: { fingerprint: 'abc', changed: true, plain: 'hunter2-plain-pw' }
}
const rdsRefs = { subnet_group: 'shop-subnets', security_groups: ['sg-0ccc3333'] }
const op = (kind: PlannedOp['kind'], type: string, extra: Partial<PlannedOp> = {}): PlannedOp => ({
  kind,
  type,
  resourceId: 41,
  externalId: null,
  reason: '',
  changes: [],
  preconditions: {},
  risk: [],
  data: { region: 'us-east-1' },
  ...extra
})

describe('aws data+edge testConnection', () => {
  it('lists missing permissions across RDS, S3, Route 53, ELB and ACM', async () => {
    const handlers: Record<string, unknown> = { 'sts:GetCallerIdentity': 'sts-caller-identity.xml' }
    for (const a of [
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
    ])
      handlers[`ec2:${a}`] = { status: 412, file: 'ec2-error-dryrun.xml' }
    Object.assign(handlers, {
      'rds:DescribeDBInstances': 'rds-describe-instances.xml',
      'rds:DescribeDBSubnetGroups': { status: 403, file: 'rds-error-denied.xml' },
      'rds:DescribeDBParameterGroups': 'rds-describe-param-groups.xml',
      's3:GET /': {
        body: '<ListAllMyBucketsResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Buckets/></ListAllMyBucketsResult>'
      },
      'route53:GET /2013-04-01/hostedzone': 'r53-list-zones.xml',
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: 'r53-list-rrsets.xml',
      'elbv2:DescribeLoadBalancers': 'elb-describe-lbs.xml',
      'elbv2:DescribeTargetGroups': 'elb-describe-tg.xml',
      'acm:ListCertificates': {
        status: 400,
        body: '{"__type":"AccessDeniedException","message":"no"}'
      }
    })
    const h = harness(handlers as never)
    const t = await awsProvider.testConnection(h.ctx)
    expect(t.ok).toBe(false)
    expect(t.missing.sort()).toEqual(['acm:ListCertificates', 'rds:DescribeDBSubnetGroups'])
    expect(t.permissions.find((p) => p.type === 'aws.s3_bucket')?.has).toBe(true)
  })
})

describe('aws data+edge observe', () => {
  it('maps an RDS instance with its tags, subnet and parameter groups', async () => {
    const h = harness({
      'rds:DescribeDBInstances': 'rds-describe-instances.xml',
      'rds:ListTagsForResource': 'rds-list-tags.xml',
      'rds:DescribeDBSubnetGroups': 'rds-describe-subnet-groups.xml',
      'rds:DescribeDBParameterGroups': 'rds-describe-param-groups.xml',
      'rds:DescribeDBParameters': 'rds-describe-params.xml'
    })
    const db = await awsProvider.observe(h.ctx, 'aws.rds_instance', 'shop-db')
    expect(db).toMatchObject({
      externalId: 'shop-db',
      status: 'available',
      fields: {
        engine: 'postgres',
        engine_version: '16.3',
        instance_class: 'db.t3.medium',
        allocated_storage_gb: 100,
        subnet_group: 'shop-subnets',
        parameter_group: 'shop-pg',
        security_groups: ['sg-0ccc3333'],
        publicly_accessible: false,
        endpoint: 'shop-db.fake.us-east-1.rds.amazonaws.com',
        port: 5432
      }
    })
    expect(db?.tags['nivaro-hub:resource']).toBe('41')
    expect(JSON.stringify(db)).not.toContain('MasterUserPassword')
    const sg = await awsProvider.observe(h.ctx, 'aws.rds_subnet_group', 'shop-subnets')
    expect(sg?.fields.subnets).toEqual(['subnet-0fff6666', 'subnet-0fff7777'])
    const pg = await awsProvider.observe(h.ctx, 'aws.rds_parameter_group', 'shop-pg')
    expect(pg?.fields).toMatchObject({
      family: 'postgres16',
      parameters: [{ name: 'max_connections', value: '200' }]
    })
  })

  it('answers null for an RDS instance that is gone', async () => {
    const h = harness({ 'rds:DescribeDBInstances': notFound('rds-error-notfound.xml', 404) })
    expect(await awsProvider.observe(h.ctx, 'aws.rds_instance', 'shop-db')).toBeNull()
  })

  it('maps a bucket, and reads a missing block / encryption as off', async () => {
    const h = harness(bucket())
    const b = await awsProvider.observe(h.ctx, 'aws.s3_bucket', 'shop-assets')
    expect(b).toMatchObject({
      externalId: 'shop-assets',
      fields: { region: 'us-east-1', block_public_access: true, versioning: true, encryption: true }
    })
    expect(b?.tags['nivaro-hub:resource']).toBe('41')
    const open = harness(
      bucket({
        's3:GET /shop-assets?publicAccessBlock=': { status: 404, file: 's3-error-no-pab.xml' },
        's3:GET /shop-assets?encryption=': { status: 404, file: 's3-error-no-encryption.xml' }
      })
    )
    expect(
      (await awsProvider.observe(open.ctx, 'aws.s3_bucket', 'shop-assets'))?.fields
    ).toMatchObject({ block_public_access: false, encryption: false })
    const gone = harness({
      's3:GET /shop-assets?location=': { status: 404, file: 's3-error-nosuchbucket.xml' }
    })
    expect(await awsProvider.observe(gone.ctx, 'aws.s3_bucket', 'shop-assets')).toBeNull()
  })

  it('maps a zone and a record (and answers null for a different record)', async () => {
    const h = harness({
      [`route53:GET /2013-04-01/hostedzone/${ZONE}`]: 'r53-get-zone.xml',
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: 'r53-list-rrsets.xml'
    })
    const z = await awsProvider.observe(h.ctx, 'aws.route53_zone', ZONE)
    expect(z).toMatchObject({
      externalId: ZONE,
      name: 'example.com',
      fields: { private: false, record_count: 4 }
    })
    const r = await awsProvider.observe(h.ctx, 'aws.route53_record', `${ZONE}|www.example.com|A`)
    expect(r?.fields).toMatchObject({
      zone: ZONE,
      name: 'www.example.com',
      record_type: 'A',
      ttl: 300,
      values: ['203.0.113.10']
    })
    const other = harness({
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: 'r53-list-rrsets-other.xml'
    })
    expect(
      await awsProvider.observe(other.ctx, 'aws.route53_record', `${ZONE}|www.example.com|A`)
    ).toBeNull()
    const nozone = harness({
      [`route53:GET /2013-04-01/hostedzone/${ZONE}`]: { status: 404, file: 'r53-error-nozone.xml' }
    })
    expect(await awsProvider.observe(nozone.ctx, 'aws.route53_zone', ZONE)).toBeNull()
  })

  it('lists global Route 53 zones once, however many regions are allowed', async () => {
    const h = harness(
      { 'route53:GET /2013-04-01/hostedzone': 'r53-list-zones.xml' },
      { region: null }
    )
    const page = await awsProvider.list(h.ctx, 'aws.route53_zone', null)
    expect(page.items.map((i) => i.externalId)).toEqual([ZONE])
    expect(page.cursor).toBeNull()
    expect(h.calls).toHaveLength(1)
  })

  it('maps a load balancer, target group, listener and certificate', async () => {
    const h = harness({
      'elbv2:DescribeLoadBalancers': 'elb-describe-lbs.xml',
      'elbv2:DescribeTags': 'elb-describe-tags.xml',
      'elbv2:DescribeTargetGroups': 'elb-describe-tg.xml',
      'elbv2:DescribeTargetHealth': 'elb-target-health.xml',
      'elbv2:DescribeListeners': 'elb-describe-listeners.xml',
      'acm:DescribeCertificate': 'acm-describe-cert.json',
      'acm:ListTagsForCertificate': 'acm-list-tags.json'
    })
    const lb = await awsProvider.observe(h.ctx, 'aws.load_balancer', ARN)
    expect(lb?.fields).toMatchObject({
      type: 'application',
      scheme: 'internet-facing',
      subnets: ['subnet-0fff6666', 'subnet-0fff7777'],
      security_groups: ['sg-0ccc3333'],
      dns_name: 'shop-lb-1.us-east-1.elb.amazonaws.com',
      zone_id: 'Z35SXDOTRQ7X7K'
    })
    expect(lb?.status).toBe('active')
    const tg = await awsProvider.observe(h.ctx, 'aws.target_group', TG)
    expect(tg?.fields).toMatchObject({
      protocol: 'HTTP',
      port: 8080,
      health_check_path: '/health',
      targets: ['i-0eee5555']
    })
    const l = await awsProvider.observe(h.ctx, 'aws.listener', LS)
    expect(l?.fields).toMatchObject({
      load_balancer: ARN,
      port: 443,
      protocol: 'HTTPS',
      certificate: CERT,
      default_action: 'forward',
      target_group: TG
    })
    const cert = await awsProvider.observe(h.ctx, 'aws.acm_certificate', CERT)
    expect(cert).toMatchObject({
      status: 'ISSUED',
      fields: { domain: 'example.com', alternative_names: ['www.example.com'] }
    })
    expect((cert?.fields.validation_records as unknown[]).length).toBe(2)
    const gone = harness({
      'acm:DescribeCertificate': { status: 400, file: 'acm-error-notfound.json' }
    })
    expect(await awsProvider.observe(gone.ctx, 'aws.acm_certificate', CERT)).toBeNull()
  })
})

describe('aws data+edge plan and risk', () => {
  const ctx = harness({}).ctx
  const rdsObs = observedOf({
    type: 'aws.rds_instance',
    externalId: 'shop-db',
    status: 'available',
    fields: {
      region: 'us-east-1',
      name: 'shop-db',
      engine: 'postgres',
      engine_version: '16.3',
      instance_class: 'db.t3.medium',
      allocated_storage_gb: 100,
      master_username: 'shopadmin',
      subnet_group: 'shop-subnets',
      security_groups: ['sg-0ccc3333'],
      storage_type: 'gp3',
      multi_az: false,
      backup_retention_days: 7,
      publicly_accessible: false,
      deletion_protection: true,
      storage_encrypted: true
    }
  })

  it('RDS: create is cost, public access is exposure, delete names a final snapshot, shrink is refused', () => {
    const create = awsProvider.plan(
      ctx,
      desired('aws.rds_instance', rdsWant, { refs: rdsRefs }),
      null
    )[0]
    expect(create.risk).toEqual(['cost'])
    expect(create.changes.find((c) => c.field === 'master_password')).toEqual({
      field: 'master_password',
      secret: true
    })
    expect(JSON.stringify(create)).not.toContain('hunter2-plain-pw')
    const pub = awsProvider.plan(
      ctx,
      desired('aws.rds_instance', { ...rdsWant, publicly_accessible: true }, { refs: rdsRefs }),
      null
    )[0]
    expect(pub.risk).toContain('public_exposure')
    const del = awsProvider.plan(ctx, null, rdsObs)[0]
    expect(del.risk.sort()).toEqual(['data_loss', 'destructive'])
    expect(del.data?.finalSnapshot).toBe('nivaro-final-shop-db-202611261200')
    expect(() =>
      awsProvider.plan(
        ctx,
        desired('aws.rds_instance', { ...rdsWant, allocated_storage_gb: 50 }, { refs: rdsRefs }),
        rdsObs
      )
    ).toThrowError(expect.objectContaining({ code: 'STORAGE_SHRINK_REFUSED' }))
    const up = awsProvider.plan(
      ctx,
      desired(
        'aws.rds_instance',
        {
          ...rdsWant,
          instance_class: 'db.m5.large',
          master_password: { fingerprint: 'abc', changed: false }
        },
        { refs: rdsRefs }
      ),
      rdsObs
    )[0]
    expect(up.kind).toBe('update')
    expect(up.risk.sort()).toEqual(['cost', 'downtime'])
  })

  it('RDS: a changed engine replaces; an unchanged instance is a noop (password not compared)', () => {
    const same = desired(
      'aws.rds_instance',
      { ...rdsWant, master_password: { fingerprint: 'abc', changed: false } },
      { refs: rdsRefs }
    )
    expect(awsProvider.plan(ctx, same, rdsObs)[0].kind).toBe('noop')
    const rep = awsProvider.plan(
      ctx,
      { ...same, fields: { ...same.fields, engine: 'mysql' } },
      rdsObs
    )[0]
    expect(rep.kind).toBe('replace')
  })

  it('S3: block off is exposure, delete-all is data loss, unchanged is a noop', () => {
    const obs = observedOf({
      type: 'aws.s3_bucket',
      externalId: 'shop-assets',
      fields: {
        region: 'us-east-1',
        name: 'shop-assets',
        block_public_access: true,
        versioning: true,
        encryption: true
      }
    })
    expect(awsProvider.plan(ctx, desired('aws.s3_bucket', bucketWant), obs)[0].kind).toBe('noop')
    const open = awsProvider.plan(
      ctx,
      desired('aws.s3_bucket', { ...bucketWant, block_public_access: false }),
      obs
    )[0]
    expect(open.kind).toBe('update')
    expect(open.risk).toEqual(['public_exposure'])
    expect(
      awsProvider.plan(
        ctx,
        desired('aws.s3_bucket', { name: 'shop-assets', block_public_access: false }),
        null
      )[0].risk
    ).toContain('public_exposure')
    expect(
      awsProvider.plan(ctx, desired('aws.s3_bucket', { name: 'shop-assets' }), null)[0].risk
    ).toEqual([])
    const spec = awsProvider.types.find((t) => t.key === 'aws.s3_bucket')
    expect(
      spec?.risk(op('delete', 'aws.s3_bucket', { data: { deleteAllObjects: true } }), null).sort()
    ).toEqual(['data_loss', 'destructive'])
    expect(awsProvider.plan(ctx, null, obs)[0].risk).toEqual(['destructive'])
  })

  it('Route 53: names compare case-insensitively; a TTL change is an update', () => {
    const obs = observedOf({
      type: 'aws.route53_record',
      externalId: `${ZONE}|www.example.com|A`,
      fields: {
        zone: ZONE,
        name: 'www.example.com',
        record_type: 'A',
        ttl: 300,
        values: ['203.0.113.10']
      }
    })
    const d = (f: Record<string, unknown>) =>
      desired(
        'aws.route53_record',
        { name: 'WWW.Example.com.', record_type: 'A', ttl: 300, values: ['203.0.113.10'], ...f },
        { refs: { zone: ZONE } }
      )
    expect(awsProvider.plan(ctx, d({}), obs)[0].kind).toBe('noop')
    const up = awsProvider.plan(ctx, d({ ttl: 60 }), obs)[0]
    expect(up).toMatchObject({ kind: 'update', changes: [{ field: 'ttl', from: 300, to: 60 }] })
  })

  it('the hosted zone is shared and read / adopt only', () => {
    const spec = awsProvider.types.find((t) => t.key === 'aws.route53_zone')
    expect(spec?.scope).toBe('shared')
    expect(spec?.capabilities).toMatchObject({
      create: false,
      update: false,
      delete: false,
      adopt: true
    })
  })

  it('ELB: a load balancer is cost + exposure when internet-facing, cost only when internal', () => {
    const lb = (scheme: string) =>
      awsProvider.plan(
        ctx,
        desired(
          'aws.load_balancer',
          { name: 'shop-lb', scheme },
          { refs: { subnets: ['subnet-1', 'subnet-2'] } }
        ),
        null
      )[0].risk
    expect(lb('internet-facing').sort()).toEqual(['cost', 'public_exposure'])
    expect(lb('internal')).toEqual(['cost'])
  })

  it('ELB: target changes are downtime; a matching listener is a noop', () => {
    const tgObs = observedOf({
      type: 'aws.target_group',
      externalId: TG,
      fields: {
        region: 'us-east-1',
        name: 'shop-tg',
        protocol: 'HTTP',
        port: 8080,
        vpc: 'vpc-1',
        target_type: 'instance',
        health_check_path: '/health',
        targets: ['i-1']
      }
    })
    const d = desired(
      'aws.target_group',
      {
        name: 'shop-tg',
        protocol: 'HTTP',
        port: 8080,
        target_type: 'instance',
        health_check_path: '/health'
      },
      { refs: { vpc: 'vpc-1', targets: ['i-1', 'i-2'] } }
    )
    const op1 = awsProvider.plan(ctx, d, tgObs)[0]
    expect(op1.kind).toBe('update')
    expect(op1.risk).toEqual(['downtime'])
    const lObs = observedOf({
      type: 'aws.listener',
      externalId: LS,
      fields: {
        region: 'us-east-1',
        load_balancer: ARN,
        port: 443,
        protocol: 'HTTPS',
        certificate: CERT,
        default_action: 'forward',
        target_group: TG,
        ssl_policy: 'x'
      }
    })
    const ld = desired(
      'aws.listener',
      { port: 443, protocol: 'HTTPS' },
      { refs: { load_balancer: ARN, certificate: CERT, target_group: TG } }
    )
    expect(awsProvider.plan(ctx, ld, lObs)[0].kind).toBe('noop')
  })

  it('costs: RDS, NAT, load balancers bill monthly; scopes are right', () => {
    const cls = (k: string) =>
      awsProvider.types.find((t) => t.key === k)?.costClass?.(desired(k, {}))
    expect(cls('aws.rds_instance')).toBe('monthly')
    expect(cls('aws.load_balancer')).toBe('monthly')
    expect(cls('aws.s3_bucket')).toBeUndefined()
    expect(
      Object.fromEntries(
        awsProvider.types
          .filter((t) => /rds|s3|route53|load|target|listener|acm/.test(t.key))
          .map((t) => [t.key, t.scope])
      )
    ).toMatchObject({
      'aws.rds_instance': 'app',
      'aws.s3_bucket': 'app',
      'aws.route53_record': 'app',
      'aws.route53_zone': 'shared',
      'aws.load_balancer': 'app',
      'aws.acm_certificate': 'app'
    })
  })
})

describe('aws data+edge apply', () => {
  it('RDS create sends the password only to AWS, tags, refs and encryption defaults', async () => {
    const h = harness({
      'rds:DescribeDBInstances': [
        notFound('rds-error-notfound.xml', 404),
        'rds-describe-instances.xml'
      ],
      'rds:ListTagsForResource': 'rds-list-tags.xml',
      'rds:CreateDBInstance': 'rds-ok.xml'
    })
    const d = desired('aws.rds_instance', rdsWant, { refs: rdsRefs })
    const [o] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, o, d)
    expect(res.externalId).toBe('shop-db')
    expect(JSON.stringify(res)).not.toContain('hunter2-plain-pw')
    const p = h.of('CreateDBInstance')[0].params
    expect(p).toMatchObject({
      DBInstanceIdentifier: 'shop-db',
      Engine: 'postgres',
      MasterUserPassword: 'hunter2-plain-pw',
      DBSubnetGroupName: 'shop-subnets',
      'VpcSecurityGroupIds.member.1': 'sg-0ccc3333',
      StorageEncrypted: 'true',
      PubliclyAccessible: 'false',
      DeletionProtection: 'true'
    })
    expect(p['Tags.member.1.Key']).toBeDefined()
    const tags = Object.fromEntries(
      [1, 2, 3, 4].map((n) => [p[`Tags.member.${n}.Key`], p[`Tags.member.${n}.Value`]])
    )
    expect(tags).toMatchObject({ 'nivaro-hub:managed': 'true', 'nivaro-hub:resource': '41' })
  })

  it('RDS create without a password is refused before any write', async () => {
    const h = harness({ 'rds:DescribeDBInstances': notFound('rds-error-notfound.xml', 404) })
    const d = desired(
      'aws.rds_instance',
      { ...rdsWant, master_password: { fingerprint: 'abc', changed: false } },
      { refs: rdsRefs }
    )
    const [o] = awsProvider.plan(h.ctx, d, null)
    await expect(awsProvider.apply(h.ctx, o, d)).rejects.toMatchObject({ code: 'SECRET_MISSING' })
    expect(h.of('CreateDBInstance')).toHaveLength(0)
  })

  it('RDS resumed create reuses the Hub-tagged instance without writing', async () => {
    const h = harness({
      'rds:DescribeDBInstances': 'rds-describe-instances.xml',
      'rds:ListTagsForResource': 'rds-list-tags.xml'
    })
    const d = desired(
      'aws.rds_instance',
      { ...rdsWant, master_password: { fingerprint: 'abc', changed: false } },
      { refs: rdsRefs }
    )
    const [o] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, o, d)
    expect(res.answer).toMatchObject({ reused: true })
    expect(h.of('CreateDBInstance')).toHaveLength(0)
    expect(h.of('ModifyDBInstance')).toHaveLength(0)
  })

  it('RDS delete always takes the named final snapshot; a snapshot op names its own', async () => {
    const h = harness({
      'rds:DescribeDBInstances': 'rds-describe-instances.xml',
      'rds:ListTagsForResource': 'rds-list-tags.xml',
      'rds:DeleteDBInstance': 'rds-delete.xml',
      'rds:CreateDBSnapshot': 'rds-ok.xml'
    })
    const [o] = awsProvider.plan(
      h.ctx,
      null,
      (await awsProvider.observe(h.ctx, 'aws.rds_instance', 'shop-db')) ?? null
    )
    await awsProvider.apply(h.ctx, o, null)
    const del = h.of('DeleteDBInstance')[0].params
    expect(del.SkipFinalSnapshot).toBe('false')
    expect(del.FinalDBSnapshotIdentifier).toBe('nivaro-final-shop-db-202611261200')
    const snap = await awsProvider.snapshot?.(h.ctx, 'aws.rds_instance', 'shop-db')
    expect(snap).toMatchObject({ kind: 'rds_snapshot', id: 'nivaro-shop-db-202611261200' })
  })

  it('S3 create writes the public-access block first, then encryption, versioning and tags', async () => {
    const h = harness(
      bucket({
        's3:GET /shop-assets?location=': [
          { status: 404, file: 's3-error-nosuchbucket.xml' },
          's3-location-eu-west-1.xml'
        ],
        's3:PUT /shop-assets': { body: '' },
        's3:PUT /shop-assets?publicAccessBlock=': { body: '' },
        's3:PUT /shop-assets?encryption=': { body: '' },
        's3:PUT /shop-assets?versioning=': { body: '' },
        's3:PUT /shop-assets?tagging=': { body: '' }
      }),
      { region: 'eu-west-1' }
    )
    const d = desired('aws.s3_bucket', bucketWant, {
      fields: { region: 'eu-west-1', ...bucketWant }
    })
    const [o] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, o, d)
    expect(res.externalId).toBe('shop-assets')
    const puts = h.calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => Object.keys(c.query)[0] ?? 'create')).toEqual([
      'create',
      'publicAccessBlock',
      'encryption',
      'versioning',
      'tagging'
    ])
    expect(puts[0].body).toContain('<LocationConstraint>eu-west-1</LocationConstraint>')
    expect(puts[1].body).not.toContain('false')
    for (const p of puts.slice(1)) expect(p.headers['content-md5']).toBeTruthy()
    expect(puts[4].body).toContain('nivaro-hub:resource')
  })

  it('S3 refuses to delete a bucket that is not empty, and empties it only when told to', async () => {
    const listing = {
      's3:GET /shop-assets?list-type=2&max-keys=1': 's3-list-objects-nonempty.xml',
      's3:GET /shop-assets?versions=&max-keys=1000': [
        's3-list-versions.xml',
        's3-list-versions-empty.xml'
      ],
      's3:POST /shop-assets?delete=': 's3-delete-result.xml',
      's3:DELETE /shop-assets': { status: 204, body: '' }
    }
    const h = harness(bucket(listing))
    const err = await awsProvider
      .apply(h.ctx, op('delete', 'aws.s3_bucket', { externalId: 'shop-assets' }), null)
      .catch((e) => e)
    expect(err).toMatchObject({ code: 'BUCKET_NOT_EMPTY', retryable: false })
    expect(err.message).toContain('delete all objects in shop-assets')
    expect(h.calls.some((c) => c.method === 'DELETE' || c.method === 'POST')).toBe(false)

    const all = harness(bucket(listing))
    await awsProvider.apply(
      all.ctx,
      op('delete', 'aws.s3_bucket', {
        externalId: 'shop-assets',
        data: { region: 'us-east-1', deleteAllObjects: true }
      }),
      null
    )
    const post = all.calls.find((c) => c.method === 'POST')
    expect(post?.body).toContain('<Key>logo &amp; one.png</Key><VersionId>v1fake</VersionId>')
    expect(post?.body).toContain('<Key>old.png</Key>')
    expect(post?.headers['content-md5']).toBeTruthy()
    expect(all.calls.at(-1)?.method).toBe('DELETE')
  })

  it('S3 deletes an empty bucket without the confirm', async () => {
    const h = harness(
      bucket({
        's3:GET /shop-assets?list-type=2&max-keys=1': 's3-list-objects-empty.xml',
        's3:GET /shop-assets?versions=&max-keys=1': 's3-list-versions-empty.xml',
        's3:DELETE /shop-assets': { status: 204, body: '' }
      })
    )
    const res = await awsProvider.apply(
      h.ctx,
      op('delete', 'aws.s3_bucket', { externalId: 'shop-assets' }),
      null
    )
    expect(res.ok).toBe(true)
    expect(h.calls.filter((c) => c.method === 'DELETE')).toHaveLength(1)
  })

  it('Route 53 create uses CREATE and a trailing-dot name; update uses UPSERT; delete sends the exact current record', async () => {
    const h = harness({
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: 'r53-list-rrsets.xml',
      [`route53:POST /2013-04-01/hostedzone/${ZONE}/rrset/`]: 'r53-change-ok.xml'
    })
    const d = desired(
      'aws.route53_record',
      { name: 'www.example.com', record_type: 'A', ttl: 300, values: ['203.0.113.10'] },
      { refs: { zone: ZONE } }
    )
    const [create] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, create, d)
    expect(res.externalId).toBe(`${ZONE}|www.example.com|A`)
    const body = h.calls.find((c) => c.method === 'POST')?.body ?? ''
    expect(body).toContain('<Action>CREATE</Action>')
    expect(body).toContain('<Name>www.example.com.</Name>')
    expect(body).not.toContain('UPSERT')

    const upd = harness({
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: 'r53-list-rrsets.xml',
      [`route53:POST /2013-04-01/hostedzone/${ZONE}/rrset/`]: 'r53-change-ok.xml'
    })
    const d2 = desired(
      'aws.route53_record',
      { name: 'www.example.com', record_type: 'A', ttl: 60, values: ['203.0.113.10'] },
      { refs: { zone: ZONE }, externalId: `${ZONE}|www.example.com|A` }
    )
    const obs = await awsProvider.observe(
      upd.ctx,
      'aws.route53_record',
      `${ZONE}|www.example.com|A`
    )
    const [u] = awsProvider.plan(upd.ctx, d2, obs)
    await awsProvider.apply(upd.ctx, u, d2)
    expect(upd.calls.find((c) => c.method === 'POST')?.body).toContain(
      '<Action>UPSERT</Action><ResourceRecordSet><Name>www.example.com.</Name><Type>A</Type><TTL>60</TTL>'
    )

    const del = harness({
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: 'r53-list-rrsets.xml',
      [`route53:POST /2013-04-01/hostedzone/${ZONE}/rrset/`]: 'r53-change-ok.xml'
    })
    await awsProvider.apply(
      del.ctx,
      op('delete', 'aws.route53_record', { externalId: `${ZONE}|www.example.com|A` }),
      null
    )
    const dbody = del.calls.find((c) => c.method === 'POST')?.body ?? ''
    expect(dbody).toContain('<Action>DELETE</Action>')
    expect(dbody).toContain('<Value>203.0.113.10</Value>')
  })

  it('ELB create: load balancer, target group with targets and a redirecting listener', async () => {
    const h = harness({
      'elbv2:DescribeLoadBalancers': [notFound('elb-error-notfound.xml'), 'elb-describe-lbs.xml'],
      'elbv2:DescribeTags': 'elb-describe-tags.xml',
      'elbv2:CreateLoadBalancer': 'elb-create-lb.xml'
    })
    const d = desired(
      'aws.load_balancer',
      { name: 'shop-lb', scheme: 'internet-facing' },
      {
        refs: { subnets: ['subnet-0fff6666', 'subnet-0fff7777'], security_groups: ['sg-0ccc3333'] }
      }
    )
    const [o] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, o, d)
    expect(res.externalId).toBe(ARN)
    expect(h.of('CreateLoadBalancer')[0].params).toMatchObject({
      Name: 'shop-lb',
      Scheme: 'internet-facing',
      Type: 'application',
      'Subnets.member.1': 'subnet-0fff6666',
      'Subnets.member.2': 'subnet-0fff7777',
      'SecurityGroups.member.1': 'sg-0ccc3333'
    })

    const tg = harness({
      'elbv2:DescribeTargetGroups': [notFound('elb-error-notfound.xml'), 'elb-describe-tg.xml'],
      'elbv2:DescribeTargetHealth': 'elb-target-health.xml',
      'elbv2:DescribeTags': 'elb-describe-tags.xml',
      'elbv2:CreateTargetGroup': {
        body: `<CreateTargetGroupResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><CreateTargetGroupResult><TargetGroups><member><TargetGroupArn>${TG}</TargetGroupArn></member></TargetGroups></CreateTargetGroupResult></CreateTargetGroupResponse>`
      },
      'elbv2:RegisterTargets': {
        body: '<RegisterTargetsResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"/>'
      }
    })
    const dt = desired(
      'aws.target_group',
      { name: 'shop-tg', protocol: 'HTTP', port: 8080, health_check_path: '/health' },
      { refs: { vpc: 'vpc-0aaa1111', targets: ['i-0eee5555'] } }
    )
    const [ot] = awsProvider.plan(tg.ctx, dt, null)
    await awsProvider.apply(tg.ctx, ot, dt)
    expect(tg.of('RegisterTargets')[0].params).toMatchObject({
      TargetGroupArn: TG,
      'Targets.member.1.Id': 'i-0eee5555'
    })

    const ls = harness({
      'elbv2:DescribeListeners': [
        {
          body: '<DescribeListenersResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><DescribeListenersResult><Listeners/></DescribeListenersResult></DescribeListenersResponse>'
        },
        'elb-describe-listeners.xml'
      ],
      'elbv2:DescribeTags': 'elb-describe-tags.xml',
      'elbv2:CreateListener': {
        body: `<CreateListenerResponse xmlns="http://elasticloadbalancing.amazonaws.com/doc/2015-12-01/"><CreateListenerResult><Listeners><member><ListenerArn>${LS}</ListenerArn></member></Listeners></CreateListenerResult></CreateListenerResponse>`
      }
    })
    const dl = desired(
      'aws.listener',
      { port: 80, protocol: 'HTTP', default_action: 'redirect_https' },
      { refs: { load_balancer: ARN } }
    )
    const [ol] = awsProvider.plan(ls.ctx, dl, null)
    await awsProvider.apply(ls.ctx, ol, dl)
    expect(ls.of('CreateListener')[0].params).toMatchObject({
      Port: '80',
      Protocol: 'HTTP',
      'DefaultActions.member.1.Type': 'redirect',
      'DefaultActions.member.1.RedirectConfig.StatusCode': 'HTTP_301'
    })
    expect(ls.of('CreateListener')[0].params.SslPolicy).toBeUndefined()
  })

  it('ACM create requests a DNS certificate and writes the validation records into the zone', async () => {
    const h = harness({
      'acm:RequestCertificate': 'acm-request.json',
      'acm:DescribeCertificate': 'acm-describe-cert-pending.json',
      'acm:ListTagsForCertificate': 'acm-list-tags.json',
      [`route53:POST /2013-04-01/hostedzone/${ZONE}/rrset/`]: 'r53-change-ok.xml'
    })
    const d = desired('aws.acm_certificate', { domain: 'example.com' }, { refs: { zone: ZONE } })
    const [o] = awsProvider.plan(h.ctx, d, null)
    const res = await awsProvider.apply(h.ctx, o, d)
    expect(res.externalId).toBe(CERT)
    expect(res.observed?.status).toBe('PENDING_VALIDATION')
    const req = JSON.parse(h.of('RequestCertificate')[0].body)
    expect(req).toMatchObject({ DomainName: 'example.com', ValidationMethod: 'DNS' })
    expect(req.IdempotencyToken).toMatch(/^[A-Za-z0-9]{1,32}$/)
    expect(req.Tags.map((t: { Key: string }) => t.Key)).toContain('nivaro-hub:managed')
    const body = h.calls.find((c) => c.service === 'route53')?.body ?? ''
    expect(body).toContain('<Action>UPSERT</Action>')
    expect(body).toContain('<Name>_a1.example.com.</Name><Type>CNAME</Type>')
    expect(body).toContain('<Value>_b1.acm-validations.aws.</Value>')

    const noZone = harness({
      'acm:RequestCertificate': 'acm-request.json',
      'acm:DescribeCertificate': 'acm-describe-cert-pending.json',
      'acm:ListTagsForCertificate': 'acm-list-tags.json'
    })
    const d2 = desired('aws.acm_certificate', { domain: 'example.com' })
    const [o2] = awsProvider.plan(noZone.ctx, d2, null)
    await awsProvider.apply(noZone.ctx, o2, d2)
    expect(noZone.calls.some((c) => c.service === 'route53')).toBe(false)
  })
})

describe('aws data+edge create collisions never bind or weaken a resource the Hub did not make', () => {
  it('S3: a bucket that exists without the Hub tag is ALREADY_EXISTS, and nothing is written', async () => {
    const h = harness(bucket({ 's3:GET /shop-assets?tagging=': 's3-tagging-other.xml' }))
    const d = desired('aws.s3_bucket', bucketWant)
    const [o] = awsProvider.plan(h.ctx, d, null)
    const err = await awsProvider.apply(h.ctx, o, d).catch((e) => e)
    expect(err).toBeInstanceOf(ProviderError)
    expect(err).toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(err.message).toMatch(/adopt/i)
    expect(h.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('S3: AWS saying the name is taken (another account) is ALREADY_EXISTS', async () => {
    const h = harness({
      's3:GET /shop-assets?location=': { status: 404, file: 's3-error-nosuchbucket.xml' },
      's3:PUT /shop-assets': { status: 409, file: 's3-error-exists.xml' }
    })
    const d = desired('aws.s3_bucket', bucketWant)
    const [o] = awsProvider.plan(h.ctx, d, null)
    await expect(awsProvider.apply(h.ctx, o, d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(h.calls.filter((c) => c.method === 'PUT' && Object.keys(c.query).length)).toHaveLength(0)
  })

  it('RDS: an instance with the same identifier and no Hub tag is ALREADY_EXISTS (never modified)', async () => {
    const h = harness({
      'rds:DescribeDBInstances': 'rds-describe-instances.xml',
      'rds:ListTagsForResource': 'rds-list-tags-empty.xml'
    })
    const d = desired('aws.rds_instance', rdsWant, { refs: rdsRefs })
    const [o] = awsProvider.plan(h.ctx, d, null)
    await expect(awsProvider.apply(h.ctx, o, d)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(h.calls.filter((c) => /^(Create|Modify|Add)/.test(c.action))).toHaveLength(0)
  })

  it('ELB: a load balancer with the same name and no Hub tag is ALREADY_EXISTS (CreateLoadBalancer would silently return it)', async () => {
    const h = harness({
      'elbv2:DescribeLoadBalancers': 'elb-describe-lbs.xml',
      'elbv2:DescribeTags': 'elb-describe-tags-other.xml'
    })
    const d = desired(
      'aws.load_balancer',
      { name: 'shop-lb' },
      { refs: { subnets: ['subnet-1', 'subnet-2'] } }
    )
    const [o] = awsProvider.plan(h.ctx, d, null)
    await expect(awsProvider.apply(h.ctx, o, d)).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(h.of('CreateLoadBalancer')).toHaveLength(0)
  })

  it('Route 53: CREATE on a record that exists is ALREADY_EXISTS and never UPSERTs over it', async () => {
    const h = harness({
      [`route53:POST /2013-04-01/hostedzone/${ZONE}/rrset/`]: {
        status: 400,
        file: 'r53-error-exists.xml'
      }
    })
    const d = desired(
      'aws.route53_record',
      { name: 'www.example.com', record_type: 'A', ttl: 300, values: ['203.0.113.50'] },
      { refs: { zone: ZONE } }
    )
    const [o] = awsProvider.plan(h.ctx, d, null)
    await expect(awsProvider.apply(h.ctx, o, d)).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(h.calls.filter((c) => c.method === 'POST' && c.body.includes('UPSERT'))).toHaveLength(0)
  })
})

describe('aws data+edge errors', () => {
  it('maps 429 / throttling / 503 to a retryable error on every service', async () => {
    const cases: Array<[string, Record<string, unknown>, () => Promise<unknown>]> = []
    const mk = (
      handlers: Record<string, unknown>,
      run: (h: ReturnType<typeof harness>) => Promise<unknown>
    ) => {
      const h = harness(handlers as never)
      cases.push(['', handlers, () => run(h)])
    }
    mk({ 'rds:DescribeDBInstances': { status: 400, file: 'rds-error-throttle.xml' } }, (h) =>
      awsProvider.observe(h.ctx, 'aws.rds_instance', 'x')
    )
    mk({ 's3:GET /b?location=': { status: 503, file: 's3-error-slowdown.xml' } }, (h) =>
      awsProvider.observe(h.ctx, 'aws.s3_bucket', 'b')
    )
    mk(
      {
        [`route53:GET /2013-04-01/hostedzone/${ZONE}`]: {
          status: 400,
          file: 'r53-error-throttle.xml'
        }
      },
      (h) => awsProvider.observe(h.ctx, 'aws.route53_zone', ZONE)
    )
    mk({ 'elbv2:DescribeLoadBalancers': { status: 429, file: 'elb-error-throttle.xml' } }, (h) =>
      awsProvider.observe(h.ctx, 'aws.load_balancer', ARN)
    )
    mk({ 'acm:DescribeCertificate': { status: 400, file: 'acm-error-throttle.json' } }, (h) =>
      awsProvider.observe(h.ctx, 'aws.acm_certificate', CERT)
    )
    for (const [, , run] of cases) {
      const err = await run().catch((e) => e)
      expect(err).toBeInstanceOf(ProviderError)
      expect((err as ProviderError).retryable).toBe(true)
    }
  })

  it('never carries a connection secret or the master password in an error', async () => {
    const leak =
      '<ErrorResponse><Error><Type>Sender</Type><Code>InvalidParameterValue</Code><Message>bad hunter2-plain-pw and test-secret-access-key-0001</Message></Error></ErrorResponse>'
    const h = harness({
      'rds:DescribeDBInstances': notFound('rds-error-notfound.xml', 404),
      'rds:CreateDBInstance': { status: 400, body: leak }
    })
    const d = desired('aws.rds_instance', rdsWant, { refs: rdsRefs })
    const [o] = awsProvider.plan(h.ctx, d, null)
    const err = await awsProvider.apply(h.ctx, o, d).catch((e) => e)
    expect(err.message).not.toContain('hunter2-plain-pw')
    expect(err.message).not.toContain('test-secret-access-key-0001')
    const s3 = harness({
      's3:GET /b?location=': {
        status: 403,
        body: '<Error><Code>AccessDenied</Code><Message>key test-secret-access-key-0001 denied</Message></Error>'
      }
    })
    const e2 = await awsProvider.observe(s3.ctx, 'aws.s3_bucket', 'b').catch((e) => e)
    expect(e2.message).not.toContain('test-secret-access-key-0001')
  })
})
