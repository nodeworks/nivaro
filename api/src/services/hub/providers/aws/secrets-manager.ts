import { createHash } from 'node:crypto'
import {
  type DesiredResource,
  type HealthAnswer,
  type Observed,
  type ProviderContext,
  ProviderError
} from '../types.js'
import { assertArnInAccount, awsJsonFor, hubTags, keyValueTags, orNull } from './client.js'
import {
  type AwsListPage,
  type AwsTypeDef,
  cap,
  nameField,
  observed,
  regionField,
  riskOf
} from './kit.js'
import { secretEstimate } from './pricing-part3.js'

/**
 * aws.secret — AWS Secrets Manager.
 *
 *  - The value is write-only: a `secret` field (`{fingerprint, changed, plain}`); `plain` exists
 *    only inside apply, is never put in observed / steps / errors, and is scrubbed from provider
 *    text. It leaves the adapter only as the `value` OUTPUT (so a stack secret can come from
 *    Secrets Manager), re-read by `readOutputs` — and only for a secret that carries the tag
 *    `nivaro-hub:managed=true`, so an adopted secret nobody tagged is never read.
 *  - Delete is Secrets Manager's own scheduled deletion (7–30 days, never "force without
 *    recovery"): the secret is `pending_deletion` and a create of the same name by the Hub
 *    restores it (RestoreSecret) — that is what the engine's undo of a delete does.
 *  - Rotation (Lambda, schedule) is read and shown; the Hub does not configure it.
 *  - Ids are ARNs; an ARN of another account is AWS_OUT_OF_ACCOUNT.
 */

const NAME_RE = /^[A-Za-z0-9/_+=.@-]{1,512}$/
const DAYS_TAG = 'nivaro-hub:recovery-days'
const DEFAULT_DAYS = 30

const sm = (ctx: ProviderContext, target: string, body: Record<string, unknown>, region: string) =>
  awsJsonFor(ctx, 'secretsmanager', target, body, { region })

interface Secret {
  ARN?: string
  Name?: string
  Description?: string
  KmsKeyId?: string
  RotationEnabled?: boolean
  RotationLambdaARN?: string
  RotationRules?: { AutomaticallyAfterDays?: number }
  Tags?: Array<{ Key: string; Value?: string }>
  DeletedDate?: number | string
}

const describe = async (ctx: ProviderContext, id: string, region: string) => {
  await assertArnInAccount(ctx, id)
  return (await orNull(() => sm(ctx, 'DescribeSecret', { SecretId: id }, region))) as Secret | null
}

function days(s: Secret): number {
  const v = (s.Tags ?? []).find((x) => x.Key === DAYS_TAG)?.Value
  const n = Number(v)
  return Number.isInteger(n) && n >= 7 && n <= 30 ? n : DEFAULT_DAYS
}

function secretObserved(s: Secret, region: string): Observed | null {
  if (!s.ARN || !s.Name) return null
  const tags: Record<string, string> = {}
  for (const x of s.Tags ?? []) tags[x.Key] = x.Value ?? ''
  return observed(
    'aws.secret',
    s.ARN,
    region,
    s.Name,
    {
      name: s.Name,
      description: s.Description ?? '',
      kms_key: s.KmsKeyId ?? '',
      recovery_window_days: days(s),
      rotation_enabled: s.RotationEnabled === true,
      rotation_days: s.RotationRules?.AutomaticallyAfterDays ?? 0,
      rotation_lambda: s.RotationLambdaARN ?? ''
    },
    tags,
    s.DeletedDate ? 'pending_deletion' : 'active'
  )
}

/** A write token derived from the value's fingerprint, so a retried write is the same write. */
const writeToken = (resourceId: number | null, fingerprint: string) =>
  createHash('sha256')
    .update(`${resourceId ?? 0}:${fingerprint}`)
    .digest('hex')

const plainValue = (desired: DesiredResource): string | null => {
  const v = desired.fields.value as { plain?: unknown } | undefined
  return typeof v?.plain === 'string' ? v.plain : null
}

const fingerprintOf = (desired: DesiredResource): string => {
  const v = desired.fields.value as { fingerprint?: unknown } | undefined
  return typeof v?.fingerprint === 'string' ? v.fingerprint : ''
}

const hubTagged = (tags: Record<string, string>) => tags['nivaro-hub:managed'] === 'true'

/** True only for a secret whose `nivaro-hub:resource` tag is THIS resource row. */
const ownedBy = (tags: Record<string, string>, resourceId: number | null | undefined) =>
  hubTagged(tags) && resourceId != null && tags['nivaro-hub:resource'] === String(resourceId)

const tagList = (desired: DesiredResource, own = true) =>
  keyValueTags({
    ...(own
      ? hubTags(desired.tags)
      : Object.fromEntries(
          Object.entries(hubTags(desired.tags)).filter(
            ([k]) => k !== 'nivaro-hub:managed' && k !== 'nivaro-hub:resource'
          )
        )),
    [DAYS_TAG]: String(
      Number.isInteger(desired.fields.recovery_window_days)
        ? desired.fields.recovery_window_days
        : DEFAULT_DAYS
    )
  })

export const secretDef: AwsTypeDef = {
  spec: {
    key: 'aws.secret',
    label: 'Secret',
    scope: 'app',
    fields: [
      regionField,
      {
        ...nameField,
        label: 'Secret name',
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[A-Za-z0-9/_+=.@-]{1,512}$',
        help: 'Slashes make folders (shop/production/db).'
      },
      { key: 'description', label: 'Description', kind: 'string' },
      {
        key: 'value',
        label: 'Value',
        kind: 'secret',
        help: 'Write-only. The Hub never shows it; bind its output to put it in a stack secret.'
      },
      {
        key: 'kms_key',
        label: 'KMS key',
        kind: 'string',
        help: 'A key id, ARN or alias. Empty uses the account’s aws/secretsmanager key.'
      },
      {
        key: 'recovery_window_days',
        label: 'Recovery window (days)',
        kind: 'number',
        default: 30,
        min: 7,
        max: 30,
        help: 'A deleted secret can be restored for this long; then it is gone.'
      },
      { key: 'rotation_enabled', label: 'Rotation on', kind: 'boolean', readOnly: true },
      { key: 'rotation_days', label: 'Rotates every (days)', kind: 'number', readOnly: true },
      { key: 'rotation_lambda', label: 'Rotation function', kind: 'string', readOnly: true }
    ],
    estimate: secretEstimate,
    capabilities: cap(),
    reversible: (f) => f !== 'value',
    refs: [],
    risk: riskOf(),
    outputs: [
      { key: 'value', label: 'Secret value', secret: true },
      { key: 'arn', label: 'Secret ARN', secret: false }
    ]
  },
  probe: {
    need: 'secretsmanager:ListSecrets',
    run: (ctx, region) => sm(ctx, 'ListSecrets', { MaxResults: 1 }, region)
  },
  async observe(ctx, id, region) {
    const s = await describe(ctx, id, region)
    return s ? secretObserved(s, region) : null
  },
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await sm(
      ctx,
      'ListSecrets',
      { MaxResults: 100, NextToken: token ?? undefined, IncludePlannedDeletion: true },
      region
    )
    const out: Observed[] = []
    for (const s of (r.SecretList as Secret[] | undefined) ?? []) {
      const o = secretObserved(s, region)
      if (o) out.push(o)
    }
    return { items: out, next: (r.NextToken as string | undefined) || null }
  },
  async findExisting(ctx, desired, region) {
    const name = String(desired.fields.name ?? '')
    if (!NAME_RE.test(name)) return null
    const s = (await orNull(() =>
      sm(ctx, 'DescribeSecret', { SecretId: name }, region)
    )) as Secret | null
    const o = s ? secretObserved(s, region) : null
    // The Hub's own secret waiting for deletion is restored by create(), not "found".
    if (o?.status === 'pending_deletion' && hubTagged(o.tags)) return null
    return o
  },
  checkPlan(desired) {
    if (!NAME_RE.test(String(desired.fields.name ?? '')))
      throw new ProviderError('INVALID_FIELDS', 'The secret name is not valid.')
  },
  async create(ctx, desired, region) {
    const f = desired.fields
    const name = String(f.name)
    const value = plainValue(desired)
    // The Hub's own secret still inside its recovery window: restore it, then bring it up to date.
    const before = (await orNull(() =>
      sm(ctx, 'DescribeSecret', { SecretId: name }, region)
    )) as Secret | null
    if (before?.DeletedDate && before.ARN) {
      const o = secretObserved(before, region)
      const mark = desired.tags['nivaro-hub:resource']
      if (!o || !hubTagged(o.tags) || !(mark && o.tags['nivaro-hub:resource'] === mark))
        throw new ProviderError(
          'ALREADY_EXISTS',
          `A secret named ${name} is waiting for deletion and was not made by this resource. Restore or adopt it instead.`
        )
      await sm(ctx, 'RestoreSecret', { SecretId: before.ARN }, region)
      await sm(
        ctx,
        'UpdateSecret',
        {
          SecretId: before.ARN,
          Description: String(f.description ?? ''),
          ...(f.kms_key ? { KmsKeyId: String(f.kms_key) } : {})
        },
        region
      )
      await sm(ctx, 'TagResource', { SecretId: before.ARN, Tags: tagList(desired) }, region)
      if (value !== null && (f.value as { changed?: boolean }).changed)
        await sm(
          ctx,
          'PutSecretValue',
          {
            SecretId: before.ARN,
            SecretString: value,
            ClientRequestToken: writeToken(desired.resourceId, fingerprintOf(desired))
          },
          region
        )
      return {
        id: before.ARN,
        outputs: { arn: before.ARN, ...(value !== null ? { value } : {}) }
      }
    }
    const made = await sm(
      ctx,
      'CreateSecret',
      {
        Name: name,
        Description: f.description ? String(f.description) : undefined,
        KmsKeyId: f.kms_key ? String(f.kms_key) : undefined,
        SecretString: value ?? undefined,
        ClientRequestToken: writeToken(desired.resourceId, `create:${fingerprintOf(desired)}`),
        Tags: tagList(desired)
      },
      region
    )
    const arn = made.ARN as string | undefined
    if (!arn)
      throw new ProviderError('AWS_BAD_ANSWER', 'Secrets Manager answered no ARN.', {
        retryable: true
      })
    return { id: arn, outputs: { arn, ...(value !== null ? { value } : {}) } }
  },
  async update(ctx, id, region, desired, obs, changed) {
    // Only a secret the Hub created (its own resource tag, set at CreateSecret) keeps the managed
    // and resource tags; an adopted secret is never tagged into the readable set.
    const own = ownedBy(obs.tags, desired.resourceId)
    await assertArnInAccount(ctx, id)
    const f = desired.fields
    if (obs.status === 'pending_deletion')
      throw new ProviderError(
        'SECRET_PENDING_DELETION',
        'This secret is waiting for deletion. Undo the delete (or recreate it) before changing it.'
      )
    if (changed.has('description') || changed.has('kms_key'))
      await sm(
        ctx,
        'UpdateSecret',
        {
          SecretId: id,
          ...(changed.has('description') ? { Description: String(f.description ?? '') } : {}),
          ...(changed.has('kms_key') && f.kms_key ? { KmsKeyId: String(f.kms_key) } : {})
        },
        region
      )
    // Tags (including the recovery window) follow every change.
    await sm(ctx, 'TagResource', { SecretId: id, Tags: tagList(desired, own) }, region)
    const value = plainValue(desired)
    if (changed.has('value') && value !== null) {
      await sm(
        ctx,
        'PutSecretValue',
        {
          SecretId: id,
          SecretString: value,
          ClientRequestToken: writeToken(desired.resourceId, fingerprintOf(desired))
        },
        region
      )
      return { outputs: { value } }
    }
  },
  async readOutputs(ctx, id, region, resourceId) {
    const s = await describe(ctx, id, region)
    const o = s ? secretObserved(s, region) : null
    if (!s || !o || o.status !== 'active') return s?.ARN ? { arn: s.ARN } : {}
    // The value is read only for the secret THIS row created (its resource tag is this row's id):
    // never an adopted secret, and never another app's or environment's Hub-tagged secret.
    if (!ownedBy(o.tags, resourceId)) return { arn: id }
    const r = await sm(ctx, 'GetSecretValue', { SecretId: id }, region)
    return {
      arn: id,
      ...(typeof r.SecretString === 'string' ? { value: r.SecretString } : {})
    }
  },
  async health(_ctx, _id, _region, obs): Promise<Omit<HealthAnswer, 'checkedAt'>> {
    if (obs.status === 'pending_deletion')
      return {
        status: 'warn',
        message: `Waiting for deletion; it can be restored for ${obs.fields.recovery_window_days} days from when it was deleted.`
      }
    return {
      status: 'ok',
      message: obs.fields.rotation_enabled
        ? `Rotates every ${obs.fields.rotation_days} days`
        : 'No rotation configured'
    }
  },
  async remove(ctx, id, region) {
    const s = await describe(ctx, id, region)
    if (!s || s.DeletedDate) return
    // Never "force delete without recovery": the window is the secret's own, 7–30 days.
    await sm(ctx, 'DeleteSecret', { SecretId: id, RecoveryWindowInDays: days(s) }, region)
  }
}

export const secretsManagerDefs: AwsTypeDef[] = [secretDef]
