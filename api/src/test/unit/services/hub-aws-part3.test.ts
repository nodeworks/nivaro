import { describe, expect, it } from 'vitest'
import { awsProvider } from '../../../services/hub/providers/aws/adapter.js'
import { sesSmtpPassword } from '../../../services/hub/providers/aws/smtp-password.js'
import type { PlannedOp } from '../../../services/hub/providers/types.js'
import { ROTATE_OUTPUTS_FIELD } from '../../../services/hub/providers/types.js'
import { desired, harness, OTHER_PROBES_OK, observedOf } from './hub-aws-harness.js'

// Nivaro Hub providers, Task 30: the AWS adapter's ECR, SES and Secrets Manager types against
// recorded (fixture) AWS answers. Nothing reaches real AWS.

const ZONE = 'Z0AAA1111FAKE'
const SARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:shop/db-AbCdEf'
const FOREIGN = 'arn:aws:secretsmanager:us-east-1:999999999999:secret:other-AbCdEf'
// Derived by an independent implementation (python hmac) from the fixture key.
const SMTP_PASS_US = 'BPEa+9SOyn+7KZYemAz8ougLMxT2FJoVLa+2Fy+oId4S'
const SMTP_PASS_EU = 'BIyCpFY8+/nA5qA/ivDfCYCdXosxThzit68lVCsVmMXT'
const KEY_SECRET = 'test-secret-smtp-key-0001'

const json = (status: number, file: string) => ({ status, file })
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

const repoReads = (over: Record<string, unknown> = {}) => ({
  'ecr:DescribeRepositories': 'ecr-describe-repos.json',
  'ecr:ListTagsForResource': 'ecr-list-tags.json',
  'ecr:ListImages': 'ecr-list-images.json',
  ...over
})
const repoWant = {
  name: 'shop/api',
  scan_on_push: true,
  tag_immutability: true,
  encryption: 'AES256'
}
const identityReads = (over: Record<string, unknown> = {}) => ({
  'ses:GET /v2/email/identities/example.com': 'ses-get-identity.json',
  'ses:GET /v2/email/account': 'ses-account-production.json',
  ...over
})
const userReads = (over: Record<string, unknown> = {}) => ({
  'iam:GetUser': 'iam-get-user-hub.xml',
  'iam:GetUserPolicy': 'iam-get-policy.xml',
  'iam:ListAccessKeys': 'iam-list-keys-one.xml',
  'sts:GetCallerIdentity': 'sts-caller-identity.xml',
  ...over
})
const userWant = { name: 'shop-smtp' }
const userRefs = { identity: 'example.com' }
const secretReads = (over: Record<string, unknown> = {}) => ({
  'secretsmanager:DescribeSecret': 'sm-describe.json',
  'sts:GetCallerIdentity': 'sts-caller-identity.xml',
  ...over
})
const secretWant = {
  name: 'shop/db',
  description: 'Shop database URL',
  recovery_window_days: 14,
  value: { fingerprint: 'fp1', changed: true, plain: 'test-secret-value-from-sm' }
}

describe('aws part 3 testConnection', () => {
  it('lists the missing ECR, SES, IAM and Secrets Manager permissions', async () => {
    const handlers: Record<string, unknown> = {
      ...OTHER_PROBES_OK,
      'sts:GetCallerIdentity': 'sts-caller-identity.xml',
      'ecr:DescribeRepositories': json(400, 'ecr-error-notfound.json'),
      'ses:GET /v2/email/identities': { status: 403, body: '{"message":"denied"}' },
      'secretsmanager:ListSecrets': {
        status: 400,
        body: '{"__type":"AccessDeniedException","Message":"no"}'
      },
      'iam:ListUsers': { status: 403, file: 'iam-error-denied.xml' }
    }
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
    const h = harness(handlers as never)
    const t = await awsProvider.testConnection(h.ctx)
    expect(t.ok).toBe(false)
    expect(t.missing).toContain('ses:ListEmailIdentities')
    expect(t.missing).toContain('secretsmanager:ListSecrets')
    expect(t.missing).toContain('iam:ListUsers')
    expect(t.permissions.find((p) => p.need === 'ses:ListConfigurationSets')?.has).toBe(true)
  })

  it('adds ECR, SES, Secrets Manager and IAM hosts for the allowed regions only', () => {
    const hosts = awsProvider.connection.hosts({ regions: ['us-east-1'] })
    expect(hosts).toEqual(
      expect.arrayContaining([
        'api.ecr.us-east-1.amazonaws.com',
        'email.us-east-1.amazonaws.com',
        'secretsmanager.us-east-1.amazonaws.com',
        'iam.amazonaws.com'
      ])
    )
    expect(hosts).not.toContain('api.ecr.eu-west-1.amazonaws.com')
  })
})

describe('aws part 3 observe', () => {
  it('maps an ECR repository, its tags and whether it holds images', async () => {
    const h = harness(repoReads())
    const r = await awsProvider.observe(h.ctx, 'aws.ecr_repository', 'shop/api')
    expect(r).toMatchObject({
      externalId: 'shop/api',
      status: 'active',
      fields: {
        scan_on_push: true,
        tag_immutability: true,
        encryption: 'AES256',
        kms_key: '',
        has_images: true,
        uri: '123456789012.dkr.ecr.us-east-1.amazonaws.com/shop/api'
      }
    })
    expect(r?.tags['nivaro-hub:resource']).toBe('41')
    // Every call stays in the connection's own registry.
    expect(JSON.stringify(h.calls.map((c) => c.body))).not.toContain('registryId')
  })

  it('answers null for a repository that is gone', async () => {
    const h = harness({ 'ecr:DescribeRepositories': json(400, 'ecr-error-notfound.json') })
    expect(await awsProvider.observe(h.ctx, 'aws.ecr_repository', 'shop/api')).toBeNull()
  })

  it('reads a KMS-encrypted repository and a lifecycle policy in canonical form', async () => {
    const h = harness({
      ...repoReads({ 'ecr:DescribeRepositories': 'ecr-describe-repos-kms.json' }),
      'ecr:GetLifecyclePolicy': 'ecr-lifecycle-get.json'
    })
    const kms = await awsProvider.observe(h.ctx, 'aws.ecr_repository', 'shop/api')
    expect(kms?.fields).toMatchObject({
      encryption: 'KMS',
      kms_key: 'arn:aws:kms:us-east-1:123456789012:key/0000fake-kms'
    })
    const lp = await awsProvider.observe(h.ctx, 'aws.ecr_lifecycle_policy', 'shop/api')
    expect(lp?.fields.repository).toBe('shop/api')
    expect(lp?.fields.policy).toBe(
      '{"rules":[{"action":{"type":"expire"},"description":"keep 10","rulePriority":1,"selection":{"countNumber":10,"countType":"imageCountMoreThan","tagStatus":"any"}}]}'
    )
    const none = harness({
      'ecr:GetLifecyclePolicy': json(400, 'ecr-error-lifecycle-notfound.json')
    })
    expect(await awsProvider.observe(none.ctx, 'aws.ecr_lifecycle_policy', 'shop/api')).toBeNull()
  })

  it('maps an SES identity with its DKIM and MAIL FROM records', async () => {
    const h = harness(identityReads())
    const i = await awsProvider.observe(h.ctx, 'aws.ses_identity', 'example.com')
    expect(i).toMatchObject({
      externalId: 'example.com',
      status: 'active',
      fields: {
        domain: 'example.com',
        mail_from_subdomain: 'mail',
        configuration_set: 'shop-mail'
      }
    })
    expect(i?.fields.dkim_records).toEqual([
      {
        name: 'tok1fake._domainkey.example.com',
        type: 'CNAME',
        value: 'tok1fake.dkim.amazonses.com'
      },
      {
        name: 'tok2fake._domainkey.example.com',
        type: 'CNAME',
        value: 'tok2fake.dkim.amazonses.com'
      },
      {
        name: 'tok3fake._domainkey.example.com',
        type: 'CNAME',
        value: 'tok3fake.dkim.amazonses.com'
      }
    ])
    expect(i?.fields.mail_from_records).toEqual([
      { name: 'mail.example.com', type: 'MX', value: '10 feedback-smtp.us-east-1.amazonses.com' },
      { name: 'mail.example.com', type: 'TXT', value: '"v=spf1 include:amazonses.com ~all"' }
    ])
    const gone = harness({
      'ses:GET /v2/email/identities/example.com': json(404, 'ses-error-notfound.json')
    })
    expect(await awsProvider.observe(gone.ctx, 'aws.ses_identity', 'example.com')).toBeNull()
    const bad = harness({})
    await expect(awsProvider.observe(bad.ctx, 'aws.ses_identity', '../x')).rejects.toMatchObject({
      code: 'INVALID_FIELDS'
    })
  })

  it('maps a configuration set', async () => {
    const h = harness({ 'ses:GET /v2/email/configuration-sets/shop-mail': 'ses-get-set.json' })
    const s = await awsProvider.observe(h.ctx, 'aws.ses_configuration_set', 'shop-mail')
    expect(s?.fields).toMatchObject({
      tls_policy: 'REQUIRE',
      sending_enabled: true,
      reputation_metrics: false
    })
  })

  it('maps the SMTP user, and reads a widened policy as drift (identity null)', async () => {
    const h = harness(userReads())
    const u = await awsProvider.observe(h.ctx, 'aws.ses_smtp_user', 'shop-smtp')
    expect(u).toMatchObject({
      externalId: 'shop-smtp',
      status: 'active',
      fields: { identity: 'example.com', key_count: 1 }
    })
    const wide = harness(userReads({ 'iam:GetUserPolicy': 'iam-get-policy-wide.xml' }))
    expect(
      (await awsProvider.observe(wide.ctx, 'aws.ses_smtp_user', 'shop-smtp'))?.fields.identity
    ).toBeNull()
    const other = harness(userReads({ 'iam:GetUserPolicy': 'iam-get-policy-other-region.xml' }))
    expect(
      (await awsProvider.observe(other.ctx, 'aws.ses_smtp_user', 'shop-smtp'))?.fields.identity
    ).toBeNull()
    const gone = harness({ 'iam:GetUser': { status: 404, file: 'iam-error-noentity.xml' } })
    expect(await awsProvider.observe(gone.ctx, 'aws.ses_smtp_user', 'shop-smtp')).toBeNull()
  })

  it('refuses an IAM user that is not the Hub’s (path or tag) before reading anything else', async () => {
    for (const file of ['iam-get-user-foreign.xml', 'iam-get-user-wrong-tag.xml']) {
      const h = harness({ 'iam:GetUser': file })
      await expect(
        awsProvider.observe(h.ctx, 'aws.ses_smtp_user', 'shop-smtp')
      ).rejects.toMatchObject({
        code: 'NOT_HUB_USER'
      })
      expect(h.calls.map((c) => c.action)).toEqual(['GetUser'])
    }
  })

  it('maps a secret (never its value), and a secret waiting for deletion', async () => {
    const h = harness(secretReads({ 'secretsmanager:DescribeSecret': 'sm-describe-rotating.json' }))
    const s = await awsProvider.observe(h.ctx, 'aws.secret', SARN)
    expect(s).toMatchObject({
      externalId: SARN,
      name: 'shop/db',
      status: 'active',
      fields: {
        description: 'Shop database URL',
        recovery_window_days: 14,
        rotation_enabled: true,
        rotation_days: 30,
        kms_key: 'arn:aws:kms:us-east-1:123456789012:key/0000fake-kms'
      }
    })
    expect(h.of('GetSecretValue')).toHaveLength(0)
    const p = harness(secretReads({ 'secretsmanager:DescribeSecret': 'sm-describe-pending.json' }))
    expect((await awsProvider.observe(p.ctx, 'aws.secret', SARN))?.status).toBe('pending_deletion')
    const gone = harness(
      secretReads({ 'secretsmanager:DescribeSecret': json(400, 'sm-error-notfound.json') })
    )
    expect(await awsProvider.observe(gone.ctx, 'aws.secret', SARN)).toBeNull()
  })

  it('an ARN of another account is refused on every read by id', async () => {
    const h = harness(secretReads())
    await expect(awsProvider.observe(h.ctx, 'aws.secret', FOREIGN)).rejects.toMatchObject({
      code: 'AWS_OUT_OF_ACCOUNT'
    })
    await expect(awsProvider.readOutputs?.(h.ctx, 'aws.secret', FOREIGN)).rejects.toMatchObject({
      code: 'AWS_OUT_OF_ACCOUNT'
    })
    expect(h.of('DescribeSecret')).toHaveLength(0)
  })

  it('an unsafe id never reaches a URL path', async () => {
    const h = harness({})
    for (const bad of ['..', 'a/b', 'a\\b', '']) {
      await expect(awsProvider.observe(h.ctx, 'aws.ses_configuration_set', bad)).resolves.toBeNull()
    }
    expect(h.calls).toHaveLength(0)
  })

  it('health: ECR scan findings of the latest image, SES sandbox, secret pending deletion', async () => {
    const e = harness({ ...repoReads(), 'ecr:DescribeImages': 'ecr-describe-images.json' })
    const eh = await awsProvider.health?.(e.ctx, 'aws.ecr_repository', 'shop/api')
    expect(eh).toMatchObject({
      status: 'warn',
      details: { image: 'v2', critical: 1, high: 2, medium: 5, low: 3 }
    })
    const clean = harness({
      ...repoReads(),
      'ecr:DescribeImages': 'ecr-describe-images-clean.json'
    })
    expect((await awsProvider.health?.(clean.ctx, 'aws.ecr_repository', 'shop/api'))?.status).toBe(
      'ok'
    )
    const sb = harness(identityReads({ 'ses:GET /v2/email/account': 'ses-account-sandbox.json' }))
    const sh = await awsProvider.health?.(sb.ctx, 'aws.ses_identity', 'example.com')
    expect(sh?.status).toBe('warn')
    expect(sh?.message).toMatch(/sandbox/)
    expect(sh?.message).toMatch(/only a person can make/)
    const prod = harness(identityReads())
    expect((await awsProvider.health?.(prod.ctx, 'aws.ses_identity', 'example.com'))?.status).toBe(
      'ok'
    )
    const pend = harness(
      secretReads({ 'secretsmanager:DescribeSecret': 'sm-describe-pending.json' })
    )
    expect((await awsProvider.health?.(pend.ctx, 'aws.secret', SARN))?.status).toBe('warn')
  })
})

describe('aws part 3 plan and risk', () => {
  const ctx = harness({}).ctx

  it('ECR: a rule-set diff per field; encryption is fixed at creation so it replaces', () => {
    const have = observedOf({
      type: 'aws.ecr_repository',
      externalId: 'shop/api',
      fields: {
        region: 'us-east-1',
        name: 'shop/api',
        scan_on_push: true,
        tag_immutability: true,
        encryption: 'AES256',
        kms_key: '',
        has_images: true
      }
    })
    const same = awsProvider.plan(ctx, desired('aws.ecr_repository', repoWant), have)
    expect(same[0].kind).toBe('noop')
    const upd = awsProvider.plan(
      ctx,
      desired('aws.ecr_repository', { ...repoWant, scan_on_push: false }),
      have
    )[0]
    expect(upd.kind).toBe('update')
    expect(upd.changes.map((c) => c.field)).toEqual(['scan_on_push'])
    const rep = awsProvider.plan(
      ctx,
      desired('aws.ecr_repository', { ...repoWant, encryption: 'KMS' }),
      have
    )[0]
    expect(rep.kind).toBe('replace')
    expect(rep.risk).toContain('data_loss') // the repository still holds images
    expect(() =>
      awsProvider.plan(ctx, desired('aws.ecr_repository', { ...repoWant, name: 'Bad Name' }), null)
    ).toThrowError(expect.objectContaining({ code: 'INVALID_FIELDS' }))
    expect(() =>
      awsProvider.plan(
        ctx,
        desired('aws.ecr_repository', { ...repoWant, kms_key: 'arn:aws:kms:x' }),
        null
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_FIELDS' }))
  })

  it('risk flags per type', () => {
    const empty = observedOf({
      type: 'aws.ecr_repository',
      externalId: 'shop/api',
      fields: { region: 'us-east-1', name: 'shop/api', has_images: false }
    })
    const full = observedOf({
      type: 'aws.ecr_repository',
      externalId: 'shop/api',
      fields: { region: 'us-east-1', name: 'shop/api', has_images: true }
    })
    expect(awsProvider.plan(ctx, null, empty)[0].risk).toEqual(['destructive'])
    expect(awsProvider.plan(ctx, null, full)[0].risk.sort()).toEqual(['data_loss', 'destructive'])
    expect(awsProvider.plan(ctx, null, full)[0].data?.hasImages).toBe(true)
    const lp = awsProvider.plan(
      ctx,
      desired(
        'aws.ecr_lifecycle_policy',
        { policy: '{"rules":[{"rulePriority":1}]}' },
        { refs: { repository: 'shop/api' } }
      ),
      null
    )[0]
    expect(lp.risk).toContain('data_loss')
    expect(() =>
      awsProvider.plan(
        ctx,
        desired(
          'aws.ecr_lifecycle_policy',
          { policy: 'not json' },
          { refs: { repository: 'shop/api' } }
        ),
        null
      )
    ).toThrowError(expect.objectContaining({ code: 'INVALID_FIELDS' }))
    const off = awsProvider.plan(
      ctx,
      desired('aws.ses_configuration_set', { name: 'shop-mail', sending_enabled: false }),
      observedOf({
        type: 'aws.ses_configuration_set',
        externalId: 'shop-mail',
        fields: {
          region: 'us-east-1',
          name: 'shop-mail',
          tls_policy: 'OPTIONAL',
          sending_enabled: true,
          reputation_metrics: false
        }
      })
    )[0]
    expect(off.risk).toEqual(['downtime'])
    const user = awsProvider.plan(
      ctx,
      desired('aws.ses_smtp_user', userWant, { refs: userRefs }),
      null
    )[0]
    expect(user.kind).toBe('create')
    expect(user.risk).toEqual([])
    const secretDel = awsProvider.plan(
      ctx,
      null,
      observedOf({
        type: 'aws.secret',
        externalId: SARN,
        fields: { region: 'us-east-1', name: 'shop/db' }
      })
    )[0]
    expect(secretDel.risk).toEqual(['destructive'])
  })

  it('a secret value is never in the plan; only a changed value is listed', () => {
    const create = awsProvider.plan(ctx, desired('aws.secret', secretWant), null)[0]
    expect(create.changes.find((c) => c.field === 'value')).toEqual({
      field: 'value',
      secret: true
    })
    expect(JSON.stringify(create)).not.toContain('test-secret-value-from-sm')
    const have = observedOf({
      type: 'aws.secret',
      externalId: SARN,
      fields: {
        region: 'us-east-1',
        name: 'shop/db',
        description: 'Shop database URL',
        recovery_window_days: 14
      }
    })
    const keep = awsProvider.plan(
      ctx,
      desired('aws.secret', { ...secretWant, value: { fingerprint: 'fp1', changed: false } }),
      have
    )[0]
    expect(keep.kind).toBe('noop')
  })

  it('the rotate trigger plans nothing while off and one change while on', () => {
    const have = observedOf({
      type: 'aws.ses_smtp_user',
      externalId: 'shop-smtp',
      fields: { region: 'us-east-1', name: 'shop-smtp', identity: 'example.com', key_count: 1 }
    })
    const off = awsProvider.plan(
      ctx,
      desired(
        'aws.ses_smtp_user',
        { ...userWant, [ROTATE_OUTPUTS_FIELD]: false },
        { refs: userRefs, externalId: 'shop-smtp' }
      ),
      have
    )[0]
    expect(off.kind).toBe('noop')
    const on = awsProvider.plan(
      ctx,
      desired(
        'aws.ses_smtp_user',
        { ...userWant, [ROTATE_OUTPUTS_FIELD]: true },
        { refs: userRefs, externalId: 'shop-smtp' }
      ),
      have
    )[0]
    expect(on.kind).toBe('update')
    expect(on.changes.map((c) => c.field)).toEqual([ROTATE_OUTPUTS_FIELD])
  })

  it('declares outputs; the SMTP ones are once-only and the password is secret', () => {
    const spec = awsProvider.types.find((t) => t.key === 'aws.ses_smtp_user')
    expect(spec?.outputs).toEqual([
      { key: 'smtp_host', label: 'SMTP host', secret: false },
      { key: 'smtp_port', label: 'SMTP port', secret: false },
      { key: 'smtp_user', label: 'SMTP user (access key id)', secret: false, onceOnly: true },
      { key: 'smtp_pass', label: 'SMTP password', secret: true, onceOnly: true }
    ])
    const sec = awsProvider.types.find((t) => t.key === 'aws.secret')
    expect(sec?.outputs?.find((o) => o.key === 'value')).toMatchObject({ secret: true })
    expect(sec?.outputs?.find((o) => o.key === 'value')?.onceOnly).toBeUndefined()
    const trigger = spec?.fields.find((f) => f.key === ROTATE_OUTPUTS_FIELD)
    expect(trigger).toMatchObject({ kind: 'boolean', trigger: true })
  })
})

describe('aws part 3 ECR apply', () => {
  it('creates once with scanning, immutability, encryption and the Hub tags', async () => {
    const h = harness({
      'ecr:DescribeRepositories': [
        json(400, 'ecr-error-notfound.json'),
        json(400, 'ecr-error-notfound.json'),
        'ecr-describe-repos.json'
      ],
      'ecr:CreateRepository': 'ecr-create-repo.json',
      'ecr:ListTagsForResource': 'ecr-list-tags.json',
      'ecr:ListImages': 'ecr-list-images-empty.json'
    })
    const d = desired('aws.ecr_repository', repoWant)
    const res = await awsProvider.apply(h.ctx, op('create', 'aws.ecr_repository'), d)
    expect(res.externalId).toBe('shop/api')
    const body = JSON.parse(h.of('CreateRepository')[0].body)
    expect(body).toMatchObject({
      repositoryName: 'shop/api',
      imageTagMutability: 'IMMUTABLE',
      imageScanningConfiguration: { scanOnPush: true },
      encryptionConfiguration: { encryptionType: 'AES256' }
    })
    expect(body.tags).toEqual(
      expect.arrayContaining([{ Key: 'nivaro-hub:managed', Value: 'true' }])
    )
    expect(body).not.toHaveProperty('registryId')
  })

  it('a repository the Hub did not make is ALREADY_EXISTS, nothing is changed', async () => {
    const h = harness({
      'ecr:DescribeRepositories': 'ecr-describe-repos.json',
      'ecr:ListTagsForResource': 'ecr-list-tags-other.json',
      'ecr:ListImages': 'ecr-list-images-empty.json'
    })
    await expect(
      awsProvider.apply(
        h.ctx,
        op('create', 'aws.ecr_repository'),
        desired('aws.ecr_repository', repoWant)
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(h.calls.map((c) => c.action).filter((a) => /^(Create|Put|Tag)/.test(a))).toEqual([])
  })

  it('apply is idempotent: an update that already matches makes no write', async () => {
    const h = harness(repoReads())
    const d = desired('aws.ecr_repository', repoWant, { externalId: 'shop/api' })
    const res = await awsProvider.apply(
      h.ctx,
      op('update', 'aws.ecr_repository', { externalId: 'shop/api' }),
      d
    )
    expect(res.ok).toBe(true)
    expect(h.calls.map((c) => c.action).filter((a) => /^(Put|Create|Tag|Delete)/.test(a))).toEqual(
      []
    )
  })

  it('an update writes only what changed, and refuses another target', async () => {
    const h = harness({
      ...repoReads(),
      'ecr:PutImageScanningConfiguration': 'ecr-ok.json',
      'ecr:TagResource': 'ecr-ok.json'
    })
    const d = desired(
      'aws.ecr_repository',
      { ...repoWant, scan_on_push: false },
      { externalId: 'shop/api' }
    )
    await awsProvider.apply(
      h.ctx,
      op('update', 'aws.ecr_repository', { externalId: 'shop/api' }),
      d
    )
    expect(h.of('PutImageScanningConfiguration')).toHaveLength(1)
    expect(h.of('PutImageTagMutability')).toHaveLength(0)
    await expect(
      awsProvider.apply(h.ctx, op('update', 'aws.ecr_repository', { externalId: 'other/repo' }), d)
    ).rejects.toMatchObject({ code: 'TARGET_MISMATCH' })
  })

  it('delete of a repository with images is REPOSITORY_NOT_EMPTY until the typed confirm', async () => {
    const h = harness({ ...repoReads(), 'ecr:DeleteRepository': 'ecr-ok.json' })
    await expect(
      awsProvider.apply(h.ctx, op('delete', 'aws.ecr_repository', { externalId: 'shop/api' }), null)
    ).rejects.toMatchObject({ code: 'REPOSITORY_NOT_EMPTY' })
    expect(h.of('DeleteRepository')).toHaveLength(0)
    await awsProvider.apply(
      h.ctx,
      op('delete', 'aws.ecr_repository', {
        externalId: 'shop/api',
        data: { region: 'us-east-1', deleteAllObjects: true }
      }),
      null
    )
    expect(JSON.parse(h.of('DeleteRepository')[0].body)).toEqual({
      repositoryName: 'shop/api',
      force: true
    })
  })

  it('delete of an empty repository does not force', async () => {
    const h = harness({
      ...repoReads({ 'ecr:ListImages': 'ecr-list-images-empty.json' }),
      'ecr:DeleteRepository': 'ecr-ok.json'
    })
    await awsProvider.apply(
      h.ctx,
      op('delete', 'aws.ecr_repository', { externalId: 'shop/api' }),
      null
    )
    expect(JSON.parse(h.of('DeleteRepository')[0].body).force).toBe(false)
  })

  it('writes the lifecycle policy in canonical form and removes it', async () => {
    const h = harness({
      'ecr:GetLifecyclePolicy': [
        json(400, 'ecr-error-lifecycle-notfound.json'),
        json(400, 'ecr-error-lifecycle-notfound.json'),
        'ecr-lifecycle-get.json'
      ],
      'ecr:PutLifecyclePolicy': 'ecr-ok.json'
    })
    const d = desired(
      'aws.ecr_lifecycle_policy',
      { policy: '{ "rules": [ {"rulePriority": 1, "action": {"type":"expire"}} ] }' },
      { refs: { repository: 'shop/api' } }
    )
    const res = await awsProvider.apply(h.ctx, op('create', 'aws.ecr_lifecycle_policy'), d)
    expect(res.externalId).toBe('shop/api')
    expect(JSON.parse(h.of('PutLifecyclePolicy')[0].body)).toEqual({
      repositoryName: 'shop/api',
      lifecyclePolicyText: '{"rules":[{"action":{"type":"expire"},"rulePriority":1}]}'
    })
  })
})

describe('aws part 3 SES apply', () => {
  const createReads = (over: Record<string, unknown> = {}) => ({
    'ses:GET /v2/email/identities/example.com': [
      json(404, 'ses-error-notfound.json'),
      json(404, 'ses-error-notfound.json'),
      'ses-get-identity-pending.json'
    ],
    'ses:POST /v2/email/identities': 'ses-create-identity.json',
    'ses:PUT /v2/email/identities/example.com/mail-from': 'ses-ok.json',
    'ses:GET /v2/email/account': 'ses-account-sandbox.json',
    ...over
  })
  const idWant = { domain: 'example.com', mail_from_subdomain: 'mail' }

  it('creates the identity, MAIL FROM, and writes only missing records into the zone', async () => {
    const h = harness({
      ...createReads(),
      [`route53:GET /2013-04-01/hostedzone/${ZONE}`]: 'r53-get-zone.xml',
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: [
        'r53-list-rrsets-dkim.xml', // tok1 exists with the right value: skipped
        'r53-list-rrsets-empty.xml'
      ],
      [`route53:POST /2013-04-01/hostedzone/${ZONE}/rrset/`]: 'r53-change-ok.xml'
    })
    const d = desired('aws.ses_identity', idWant, { refs: { zone: ZONE } })
    const res = await awsProvider.apply(h.ctx, op('create', 'aws.ses_identity'), d)
    expect(res.externalId).toBe('example.com')
    const made = JSON.parse(
      h.calls.find((c) => c.method === 'POST' && c.path === '/v2/email/identities')?.body ?? '{}'
    )
    expect(made).toMatchObject({
      EmailIdentity: 'example.com',
      DkimSigningAttributes: { NextSigningKeyLength: 'RSA_2048_BIT' }
    })
    const change =
      h.calls.find((c) => c.method === 'POST' && c.path.endsWith('/rrset/'))?.body ?? ''
    expect(change).toContain('<Action>CREATE</Action>')
    expect(change).not.toContain('UPSERT')
    expect(change).not.toContain('tok1fake') // already there
    expect(change).toContain('tok2fake._domainkey.example.com.')
    expect(change).toContain('10 feedback-smtp.us-east-1.amazonses.com')
  })

  it('never overwrites a DNS record that holds other values', async () => {
    const h = harness({
      ...createReads(),
      [`route53:GET /2013-04-01/hostedzone/${ZONE}`]: 'r53-get-zone.xml',
      [`route53:GET /2013-04-01/hostedzone/${ZONE}/rrset`]: 'r53-list-rrsets-dkim-other.xml'
    })
    const d = desired('aws.ses_identity', { domain: 'example.com' }, { refs: { zone: ZONE } })
    await expect(
      awsProvider.apply(h.ctx, op('create', 'aws.ses_identity'), d)
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS'
    })
    expect(h.calls.some((c) => c.path.endsWith('/rrset/'))).toBe(false)
  })

  it('refuses a zone that does not hold the domain', async () => {
    const h = harness({
      ...createReads(),
      [`route53:GET /2013-04-01/hostedzone/${ZONE}`]: 'r53-get-zone.xml'
    })
    const d = desired('aws.ses_identity', { domain: 'example.net' }, { refs: { zone: ZONE } })
    const h2 = harness({
      ...createReads({
        'ses:GET /v2/email/identities/example.net': [
          json(404, 'ses-error-notfound.json'),
          json(404, 'ses-error-notfound.json')
        ],
        'ses:POST /v2/email/identities': 'ses-create-identity.json'
      }),
      [`route53:GET /2013-04-01/hostedzone/${ZONE}`]: 'r53-get-zone.xml'
    })
    await expect(
      awsProvider.apply(h2.ctx, op('create', 'aws.ses_identity'), d)
    ).rejects.toMatchObject({
      code: 'ZONE_MISMATCH'
    })
    void h
  })

  it('an identity the Hub did not make is ALREADY_EXISTS; nothing is written', async () => {
    const h = harness({
      'ses:GET /v2/email/identities/example.com': {
        file: 'ses-get-identity.json'
      }
    })
    // The recorded identity carries resource tag 41; ask for another resource.
    const d = desired('aws.ses_identity', idWant, {
      tags: { 'nivaro-hub:resource': '77' }
    })
    await expect(
      awsProvider.apply(h.ctx, op('create', 'aws.ses_identity'), d)
    ).rejects.toMatchObject({
      code: 'ALREADY_EXISTS',
      retryable: false
    })
    expect(h.calls.filter((c) => c.method !== 'GET')).toHaveLength(0)
  })

  it('maps SES duplicate and throttling answers by the error-type header', async () => {
    const dup = harness({
      'ses:GET /v2/email/identities/example.com': json(404, 'ses-error-notfound.json'),
      'ses:POST /v2/email/identities': {
        status: 400,
        file: 'ses-error-exists.json',
        headers: { 'x-amzn-errortype': 'AlreadyExistsException:http://internal.amazon.com/' }
      }
    })
    await expect(
      awsProvider.apply(
        dup.ctx,
        op('create', 'aws.ses_identity'),
        desired('aws.ses_identity', { domain: 'example.com' })
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    const slow = harness({
      'ses:GET /v2/email/identities/example.com': {
        status: 429,
        file: 'ses-error-throttle.json',
        headers: { 'x-amzn-errortype': 'TooManyRequestsException' }
      }
    })
    await expect(
      awsProvider.observe(slow.ctx, 'aws.ses_identity', 'example.com')
    ).rejects.toMatchObject({
      retryable: true,
      code: 'TooManyRequestsException'
    })
  })

  it('creates and updates a configuration set; delete is idempotent', async () => {
    const h = harness({
      'ses:GET /v2/email/configuration-sets/shop-mail': [
        json(404, 'ses-error-notfound.json'),
        json(404, 'ses-error-notfound.json'),
        'ses-get-set.json'
      ],
      'ses:POST /v2/email/configuration-sets': 'ses-ok.json'
    })
    const d = desired('aws.ses_configuration_set', { name: 'shop-mail', tls_policy: 'REQUIRE' })
    await awsProvider.apply(h.ctx, op('create', 'aws.ses_configuration_set'), d)
    expect(
      JSON.parse(h.of('')[0] ? (h.calls.find((c) => c.method === 'POST')?.body ?? '{}') : '{}')
    ).toMatchObject({
      ConfigurationSetName: 'shop-mail',
      DeliveryOptions: { TlsPolicy: 'REQUIRE' },
      SendingOptions: { SendingEnabled: true }
    })
    const up = harness({
      'ses:GET /v2/email/configuration-sets/shop-mail': 'ses-get-set.json',
      'ses:PUT /v2/email/configuration-sets/shop-mail/sending': 'ses-ok.json'
    })
    await awsProvider.apply(
      up.ctx,
      op('update', 'aws.ses_configuration_set', { externalId: 'shop-mail' }),
      desired(
        'aws.ses_configuration_set',
        { name: 'shop-mail', tls_policy: 'REQUIRE', sending_enabled: false },
        { externalId: 'shop-mail' }
      )
    )
    expect(up.calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    const gone = harness({
      'ses:GET /v2/email/configuration-sets/shop-mail': json(404, 'ses-error-notfound.json')
    })
    const res = await awsProvider.apply(
      gone.ctx,
      op('delete', 'aws.ses_configuration_set', { externalId: 'shop-mail' }),
      null
    )
    expect(res.answer?.alreadyGone).toBe(true)
  })
})

describe('aws part 3 SES SMTP user (the IAM exception)', () => {
  const createHandlers = (over: Record<string, unknown> = {}) => ({
    'ses:GET /v2/email/identities/example.com': 'ses-get-identity.json',
    'sts:GetCallerIdentity': 'sts-caller-identity.xml',
    'iam:GetUser': [
      { status: 404, file: 'iam-error-noentity.xml' },
      { status: 404, file: 'iam-error-noentity.xml' },
      'iam-get-user-hub.xml'
    ],
    'iam:CreateUser': 'iam-create-user.xml',
    'iam:PutUserPolicy': 'iam-ok.xml',
    'iam:CreateAccessKey': 'iam-create-key.xml',
    'iam:GetUserPolicy': 'iam-get-policy.xml',
    'iam:ListAccessKeys': 'iam-list-keys-one.xml',
    ...over
  })

  it('derives the SMTP password with the documented algorithm (vector from an independent implementation)', () => {
    expect(sesSmtpPassword(KEY_SECRET, 'us-east-1')).toBe(SMTP_PASS_US)
    expect(sesSmtpPassword(KEY_SECRET, 'eu-west-1')).toBe(SMTP_PASS_EU)
    expect(SMTP_PASS_US).not.toBe(SMTP_PASS_EU)
  })

  it('creates a user under /nivaro-hub/ whose only policy sends as that identity, and hands out the outputs', async () => {
    const h = harness(createHandlers())
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.ses_smtp_user'),
      desired('aws.ses_smtp_user', userWant, { refs: userRefs })
    )
    expect(res.externalId).toBe('shop-smtp')
    const user = h.of('CreateUser')[0].params
    expect(user.Path).toBe('/nivaro-hub/')
    expect(user['Tags.member.1.Key']).toBeTruthy()
    expect(Object.values(user)).toContain('nivaro-hub:managed')
    const policy = JSON.parse(h.of('PutUserPolicy')[0].params.PolicyDocument)
    expect(policy.Statement).toHaveLength(1)
    expect(policy.Statement[0]).toEqual({
      Sid: 'NivaroHubSesSend',
      Effect: 'Allow',
      Action: ['ses:SendRawEmail', 'ses:SendEmail'],
      Resource: 'arn:aws:ses:us-east-1:123456789012:identity/example.com'
    })
    expect(h.of('AttachUserPolicy')).toHaveLength(0)
    expect(res.outputs).toEqual({
      smtp_host: 'email-smtp.us-east-1.amazonaws.com',
      smtp_port: '587',
      smtp_user: 'AKIAFAKESMTP0000003C',
      smtp_pass: SMTP_PASS_US
    })
  })

  it('declares outputs and none leak into observed, answer or steps', async () => {
    const h = harness(createHandlers())
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.ses_smtp_user'),
      desired('aws.ses_smtp_user', userWant, { refs: userRefs })
    )
    const visible = JSON.stringify({ observed: res.observed, answer: res.answer, error: res.error })
    expect(visible).not.toContain(KEY_SECRET)
    expect(visible).not.toContain(SMTP_PASS_US)
    expect(visible).not.toContain('AKIAFAKESMTP0000003C')
    for (const k of Object.keys(res.outputs ?? {}))
      expect(
        awsProvider.types.find((t) => t.key === 'aws.ses_smtp_user')?.outputs?.map((o) => o.key)
      ).toContain(k)
  })

  it('a failed create leaves nothing behind (policy, keys and user removed) and the secret is not in the error', async () => {
    const h = harness(
      createHandlers({
        'iam:CreateAccessKey': {
          status: 400,
          body: `<ErrorResponse xmlns="https://iam.amazonaws.com/doc/2010-05-08/"><Error><Type>Sender</Type><Code>LimitExceeded</Code><Message>Cannot exceed quota for AccessKeysPerUser (${KEY_SECRET})</Message></Error></ErrorResponse>`
        },
        'iam:DeleteUserPolicy': 'iam-ok.xml',
        'iam:DeleteUser': 'iam-ok.xml',
        'iam:ListAccessKeys': 'iam-list-keys-none.xml'
      })
    )
    const err = await awsProvider
      .apply(
        h.ctx,
        op('create', 'aws.ses_smtp_user'),
        desired('aws.ses_smtp_user', userWant, { refs: userRefs })
      )
      .catch((e) => e)
    expect(err.code).toBe('LimitExceeded')
    expect(h.of('DeleteUserPolicy')).toHaveLength(1)
    expect(h.of('DeleteUser')).toHaveLength(1)
  })

  it('refuses a missing identity, and an identity in another region', async () => {
    const h = harness(
      createHandlers({
        'ses:GET /v2/email/identities/example.com': json(404, 'ses-error-notfound.json')
      })
    )
    await expect(
      awsProvider.apply(
        h.ctx,
        op('create', 'aws.ses_smtp_user'),
        desired('aws.ses_smtp_user', userWant, { refs: userRefs })
      )
    ).rejects.toMatchObject({ code: 'IDENTITY_NOT_FOUND' })
    expect(h.of('CreateUser')).toHaveLength(0)
  })

  it('a same-named IAM user the Hub did not make is refused, never bound', async () => {
    const h = harness(createHandlers({ 'iam:GetUser': 'iam-get-user-foreign.xml' }))
    await expect(
      awsProvider.apply(
        h.ctx,
        op('create', 'aws.ses_smtp_user'),
        desired('aws.ses_smtp_user', userWant, { refs: userRefs })
      )
    ).rejects.toMatchObject({ code: 'NOT_HUB_USER' })
    expect(h.of('CreateUser')).toHaveLength(0)
    expect(h.of('PutUserPolicy')).toHaveLength(0)
  })

  it('rotate deletes the older of two keys, makes one, and answers the new outputs only', async () => {
    const h = harness(
      userReads({
        'iam:ListAccessKeys': 'iam-list-keys-two.xml',
        'iam:DeleteAccessKey': 'iam-ok.xml',
        'iam:CreateAccessKey': 'iam-create-key.xml'
      })
    )
    const d = desired(
      'aws.ses_smtp_user',
      { ...userWant, [ROTATE_OUTPUTS_FIELD]: true },
      { refs: userRefs, externalId: 'shop-smtp' }
    )
    const res = await awsProvider.apply(
      h.ctx,
      op('update', 'aws.ses_smtp_user', { externalId: 'shop-smtp' }),
      d
    )
    expect(h.of('DeleteAccessKey').map((c) => c.params.AccessKeyId)).toEqual([
      'AKIAFAKESMTP0000001A'
    ])
    expect(h.of('CreateAccessKey')).toHaveLength(1)
    expect(res.outputs?.smtp_pass).toBe(SMTP_PASS_US)
    expect(JSON.stringify(res.observed)).not.toContain(SMTP_PASS_US)
  })

  it('a widened policy is put back; an update on a foreign user is refused before any write', async () => {
    const h = harness(
      userReads({
        'iam:GetUserPolicy': 'iam-get-policy-wide.xml',
        'iam:PutUserPolicy': 'iam-ok.xml',
        'ses:GET /v2/email/identities/example.com': 'ses-get-identity.json'
      })
    )
    const d = desired('aws.ses_smtp_user', userWant, { refs: userRefs, externalId: 'shop-smtp' })
    await awsProvider.apply(
      h.ctx,
      op('update', 'aws.ses_smtp_user', { externalId: 'shop-smtp' }),
      d
    )
    const doc = JSON.parse(h.of('PutUserPolicy')[0].params.PolicyDocument)
    expect(doc.Statement[0].Action).toEqual(['ses:SendRawEmail', 'ses:SendEmail'])
    const foreign = harness(userReads({ 'iam:GetUser': 'iam-get-user-foreign.xml' }))
    await expect(
      awsProvider.apply(
        foreign.ctx,
        op('update', 'aws.ses_smtp_user', { externalId: 'shop-smtp' }),
        d
      )
    ).rejects.toMatchObject({ code: 'NOT_HUB_USER' })
    expect(foreign.calls.filter((c) => /^(Put|Create|Delete)/.test(c.action))).toEqual([])
  })

  it('delete removes keys, the Hub’s policy and the user, in that order', async () => {
    const h = harness(
      userReads({
        'iam:DeleteAccessKey': 'iam-ok.xml',
        'iam:DeleteUserPolicy': 'iam-ok.xml',
        'iam:DeleteUser': 'iam-ok.xml'
      })
    )
    await awsProvider.apply(
      h.ctx,
      op('delete', 'aws.ses_smtp_user', { externalId: 'shop-smtp' }),
      null
    )
    const order = h.calls.map((c) => c.action).filter((a) => /^Delete/.test(a))
    expect(order).toEqual(['DeleteAccessKey', 'DeleteUserPolicy', 'DeleteUser'])
    const foreign = harness({ 'iam:GetUser': 'iam-get-user-foreign.xml' })
    await expect(
      awsProvider.apply(
        foreign.ctx,
        op('delete', 'aws.ses_smtp_user', { externalId: 'shop-smtp' }),
        null
      )
    ).rejects.toMatchObject({ code: 'NOT_HUB_USER' })
  })

  it('lists only the Hub’s users under the path', async () => {
    const h = harness(userReads({ 'iam:ListUsers': 'iam-list-users.xml' }), { region: null })
    const page = await awsProvider.list(h.ctx, 'aws.ses_smtp_user', null)
    expect(page.items.map((i) => i.externalId)).toEqual(['shop-smtp'])
    expect(h.of('ListUsers')[0].params.PathPrefix).toBe('/nivaro-hub/')
    expect(page.cursor).toBeNull()
  })

  it('maps IAM 429 to retryable and a bad key to AUTH_FAILED', async () => {
    const slow = harness({ 'iam:GetUser': { status: 429, file: 'iam-error-throttle.xml' } })
    await expect(
      awsProvider.observe(slow.ctx, 'aws.ses_smtp_user', 'shop-smtp')
    ).rejects.toMatchObject({
      retryable: true
    })
  })
})

describe('aws part 3 Secrets Manager apply', () => {
  it('creates with the value, the Hub tags and the recovery window; outputs carry the value', async () => {
    const h = harness({
      'secretsmanager:DescribeSecret': [
        json(400, 'sm-error-notfound.json'),
        json(400, 'sm-error-notfound.json'),
        json(400, 'sm-error-notfound.json'),
        'sm-describe.json'
      ],
      'secretsmanager:CreateSecret': 'sm-create.json',
      'sts:GetCallerIdentity': 'sts-caller-identity.xml'
    })
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.secret'),
      desired('aws.secret', secretWant)
    )
    expect(res.externalId).toBe(SARN)
    const body = JSON.parse(h.of('CreateSecret')[0].body)
    expect(body.Name).toBe('shop/db')
    expect(body.SecretString).toBe('test-secret-value-from-sm')
    expect(body.ClientRequestToken).toMatch(/^[0-9a-f]{64}$/)
    expect(body.Tags).toEqual(
      expect.arrayContaining([
        { Key: 'nivaro-hub:managed', Value: 'true' },
        { Key: 'nivaro-hub:recovery-days', Value: '14' }
      ])
    )
    expect(res.outputs).toEqual({ arn: SARN, value: 'test-secret-value-from-sm' })
    expect(JSON.stringify({ o: res.observed, a: res.answer })).not.toContain(
      'test-secret-value-from-sm'
    )
  })

  it('a secret the Hub did not make is ALREADY_EXISTS; the value is never overwritten', async () => {
    const h = harness({
      'secretsmanager:DescribeSecret': 'sm-describe-untagged.json',
      'sts:GetCallerIdentity': 'sts-caller-identity.xml'
    })
    await expect(
      awsProvider.apply(h.ctx, op('create', 'aws.secret'), desired('aws.secret', secretWant))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS', retryable: false })
    expect(h.calls.map((c) => c.action).filter((a) => /^(Create|Put|Update|Tag)/.test(a))).toEqual(
      []
    )
  })

  it('apply is idempotent: nothing changed means no write, and the value is not rewritten', async () => {
    const h = harness(secretReads())
    const d = desired(
      'aws.secret',
      { ...secretWant, value: { fingerprint: 'fp1', changed: false } },
      { externalId: SARN }
    )
    const res = await awsProvider.apply(h.ctx, op('update', 'aws.secret', { externalId: SARN }), d)
    expect(res.ok).toBe(true)
    expect(
      h.calls.map((c) => c.action).filter((a) => /^(Put|Create|Update|Tag|Delete)/.test(a))
    ).toEqual([])
    expect(res.outputs).toBeUndefined()
  })

  it('a changed value is written once with a stable token and comes back only as the output', async () => {
    const h = harness({
      ...secretReads(),
      'secretsmanager:PutSecretValue': 'sm-put-value.json',
      'secretsmanager:TagResource': 'sm-ok.json'
    })
    const d = desired('aws.secret', secretWant, { externalId: SARN })
    const res = await awsProvider.apply(h.ctx, op('update', 'aws.secret', { externalId: SARN }), d)
    expect(h.of('PutSecretValue')).toHaveLength(1)
    expect(JSON.parse(h.of('PutSecretValue')[0].body).SecretString).toBe(
      'test-secret-value-from-sm'
    )
    expect(res.outputs).toEqual({ value: 'test-secret-value-from-sm' })
    expect(JSON.stringify(res.answer)).not.toContain('test-secret-value-from-sm')
  })

  it('delete schedules the secret’s own recovery window, never a forced delete', async () => {
    const h = harness({ ...secretReads(), 'secretsmanager:DeleteSecret': 'sm-delete.json' })
    await awsProvider.apply(h.ctx, op('delete', 'aws.secret', { externalId: SARN }), null)
    const body = JSON.parse(h.of('DeleteSecret')[0].body)
    expect(body).toEqual({ SecretId: SARN, RecoveryWindowInDays: 14 })
    expect(h.of('DeleteSecret')[0].body).not.toContain('ForceDeleteWithoutRecovery')
  })

  it('a delete of a secret already waiting for deletion does nothing', async () => {
    const h = harness(secretReads({ 'secretsmanager:DescribeSecret': 'sm-describe-pending.json' }))
    await awsProvider.apply(h.ctx, op('delete', 'aws.secret', { externalId: SARN }), null)
    expect(h.of('DeleteSecret')).toHaveLength(0)
  })

  it('undo of a delete: the Hub’s own secret inside its window is restored, not recreated', async () => {
    const h = harness({
      'secretsmanager:DescribeSecret': [
        'sm-describe-pending.json', // findExisting: pending + Hub tagged → null, create() takes over
        'sm-describe-pending.json', // create() looks again
        'sm-describe-pending.json', // (kit) none
        'sm-describe.json'
      ],
      'secretsmanager:RestoreSecret': 'sm-restore.json',
      'secretsmanager:UpdateSecret': 'sm-ok.json',
      'secretsmanager:TagResource': 'sm-ok.json',
      'secretsmanager:PutSecretValue': 'sm-put-value.json',
      'sts:GetCallerIdentity': 'sts-caller-identity.xml'
    })
    const res = await awsProvider.apply(
      h.ctx,
      op('create', 'aws.secret'),
      desired('aws.secret', { ...secretWant, value: { fingerprint: 'fp1', changed: false } })
    )
    expect(h.of('RestoreSecret')).toHaveLength(1)
    expect(h.of('CreateSecret')).toHaveLength(0)
    expect(res.externalId).toBe(SARN)
    expect(res.outputs).toEqual({ arn: SARN })
  })

  it('a pending-deletion secret of another owner is ALREADY_EXISTS, never restored', async () => {
    const h = harness({
      'secretsmanager:DescribeSecret': 'sm-describe-pending-foreign.json',
      'sts:GetCallerIdentity': 'sts-caller-identity.xml'
    })
    await expect(
      awsProvider.apply(h.ctx, op('create', 'aws.secret'), desired('aws.secret', secretWant))
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
    expect(h.of('RestoreSecret')).toHaveLength(0)
  })

  it('readOutputs: the value of a Hub-tagged secret only; an untagged one gets the ARN and nothing else', async () => {
    const h = harness({ ...secretReads(), 'secretsmanager:GetSecretValue': 'sm-get-value.json' })
    expect(await awsProvider.readOutputs?.(h.ctx, 'aws.secret', SARN)).toEqual({
      arn: SARN,
      value: 'test-secret-value-from-sm'
    })
    const untagged = harness({
      ...secretReads({ 'secretsmanager:DescribeSecret': 'sm-describe-untagged.json' }),
      'secretsmanager:GetSecretValue': 'sm-get-value.json'
    })
    expect(await awsProvider.readOutputs?.(untagged.ctx, 'aws.secret', SARN)).toEqual({ arn: SARN })
    expect(untagged.of('GetSecretValue')).toHaveLength(0)
    const pending = harness({
      ...secretReads({ 'secretsmanager:DescribeSecret': 'sm-describe-pending.json' }),
      'secretsmanager:GetSecretValue': 'sm-get-value.json'
    })
    expect(await awsProvider.readOutputs?.(pending.ctx, 'aws.secret', SARN)).toEqual({ arn: SARN })
    expect(pending.of('GetSecretValue')).toHaveLength(0)
  })

  it('maps 429 to retryable and scrubs the secret value from the error text', async () => {
    const slow = harness({
      'secretsmanager:DescribeSecret': { status: 429, file: 'sm-error-throttle.json' },
      'sts:GetCallerIdentity': 'sts-caller-identity.xml'
    })
    await expect(awsProvider.observe(slow.ctx, 'aws.secret', SARN)).rejects.toMatchObject({
      retryable: true,
      code: 'ThrottlingException'
    })
    const leak = harness({
      ...secretReads({
        'secretsmanager:DescribeSecret': json(400, 'sm-error-notfound.json')
      }),
      'secretsmanager:CreateSecret': {
        status: 400,
        body: '{"__type":"InvalidParameterException","Message":"bad value test-secret-value-from-sm"}'
      }
    })
    const err = await awsProvider
      .apply(leak.ctx, op('create', 'aws.secret'), desired('aws.secret', secretWant))
      .catch((e) => e)
    expect(err.code).toBe('InvalidParameterException')
    expect(err.message).not.toContain('test-secret-value-from-sm')
  })

  it('maps ECR 429 to retryable and a duplicate to ALREADY_EXISTS', async () => {
    const slow = harness({
      'ecr:DescribeRepositories': { status: 400, file: 'ecr-error-throttle.json' }
    })
    await expect(
      awsProvider.observe(slow.ctx, 'aws.ecr_repository', 'shop/api')
    ).rejects.toMatchObject({
      retryable: true
    })
    const dup = harness({
      'ecr:DescribeRepositories': json(400, 'ecr-error-notfound.json'),
      'ecr:CreateRepository': json(400, 'ecr-error-exists.json')
    })
    await expect(
      awsProvider.apply(
        dup.ctx,
        op('create', 'aws.ecr_repository'),
        desired('aws.ecr_repository', repoWant)
      )
    ).rejects.toMatchObject({ code: 'ALREADY_EXISTS' })
  })

  it('a bad key (UnrecognizedClientException) is AUTH_FAILED, not retryable', async () => {
    const h = harness({
      'ecr:DescribeRepositories': {
        status: 400,
        body: '{"__type":"UnrecognizedClientException","message":"The security token included in the request is invalid."}'
      }
    })
    await expect(
      awsProvider.observe(h.ctx, 'aws.ecr_repository', 'shop/api')
    ).rejects.toMatchObject({
      code: 'AUTH_FAILED',
      retryable: false
    })
  })

  it('the connection secret never appears in an error', async () => {
    const h = harness({
      'ecr:DescribeRepositories': {
        status: 400,
        body: '{"__type":"ValidationException","message":"bad test-secret-access-key-0001"}'
      }
    })
    const err = await awsProvider.observe(h.ctx, 'aws.ecr_repository', 'shop/api').catch((e) => e)
    expect(err.message).not.toContain('test-secret-access-key-0001')
  })
})
