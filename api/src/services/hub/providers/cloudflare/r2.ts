import { typedName } from '../plan-words.js'
import type {
  FieldChange,
  ListPage,
  Observed,
  OpResult,
  PlannedOp,
  ProviderContext,
  ResourceTypeSpec,
  RiskFlag
} from '../types.js'
import { ProviderError } from '../types.js'
import { accountIdOf, accountPath, cfCall, cfCodeOf, checkBucketName, seg } from './client.js'
import {
  arr,
  asObj,
  FULL_CAPS,
  isSecret,
  ok,
  type PlanCfg,
  planGeneric,
  str,
  type TypeImpl
} from './common.js'
import { r2Estimate } from './pricing.js'

/**
 * `cloudflare.r2_bucket`: an R2 bucket of the pinned account (default jurisdiction).
 *
 *  - Created with an optional location hint; name and location never change (no replace: a
 *    bucket holds data, a "replace" would lose it).
 *  - Deleting a bucket that still holds objects is refused with `BUCKET_NOT_EMPTY`: Cloudflare's
 *    own API refuses it, and its REST API cannot list or delete objects (that needs the S3 API
 *    with keys). Empty it first (dashboard, rclone, `aws s3 rm`), then delete.
 *  - S3 API keys cannot be made through this API token: a person creates them in the dashboard and
 *    pastes them once into this resource's sealed fields. The Hub passes them on as outputs
 *    (`access_key_id`, `secret_access_key`, once-only) so a binding can put them in the app's
 *    stack secrets; they are never read back from Cloudflare or kept in the observed state.
 */

export const R2_BUCKET = 'cloudflare.r2_bucket'
const LOCATIONS = ['auto', 'apac', 'eeur', 'enam', 'weur', 'wnam', 'oc']
const NOT_EMPTY_CODE = 10008

export const r2BucketSpec: ResourceTypeSpec = {
  key: R2_BUCKET,
  label: 'R2 bucket',
  scope: 'app',
  nameField: 'name',
  fields: [
    {
      key: 'name',
      label: 'Bucket name',
      kind: 'string',
      required: true,
      createOnly: true,
      pattern: '^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$',
      help: '3 to 63 characters: lower-case letters, digits and hyphens. It cannot be changed.'
    },
    {
      key: 'location',
      label: 'Location hint',
      kind: 'enum',
      default: 'auto',
      createOnly: true,
      options: LOCATIONS.map((l) => ({
        value: l,
        label: l === 'auto' ? 'Automatic' : l.toUpperCase()
      })),
      help: 'Where the data should live. It cannot be changed.'
    },
    {
      key: 's3_access_key_id',
      label: 'S3 access key id',
      kind: 'string',
      help: 'From the dashboard (R2, Manage API tokens). Paste it with its secret to hand both to the app.'
    },
    {
      key: 's3_secret_access_key',
      label: 'S3 secret access key',
      kind: 'secret',
      help: 'Shown once in the dashboard. Sealed here; the Hub never shows it again.'
    }
  ],
  capabilities: { ...FULL_CAPS },
  reversible: false,
  refs: [],
  risk(op): RiskFlag[] {
    return op.kind === 'delete' ? ['destructive', 'data_loss'] : []
  },
  outputs: [
    { key: 'endpoint', label: 'S3 endpoint', secret: false },
    { key: 'bucket', label: 'Bucket name', secret: false },
    { key: 'access_key_id', label: 'S3 access key id', secret: true, onceOnly: true },
    { key: 'secret_access_key', label: 'S3 secret access key', secret: true, onceOnly: true }
  ],
  estimate: r2Estimate
}

interface RawBucket {
  name: string
  creation_date?: string
  location?: string
  storage_class?: string
}

function observedBucket(raw: RawBucket, accountId: string): Observed {
  return {
    type: R2_BUCKET,
    externalId: raw.name,
    name: raw.name,
    fields: { name: raw.name, location: str(raw.location)?.toLowerCase() ?? null },
    tags: {},
    url: `https://dash.cloudflare.com/${accountId}/r2/default/buckets/${encodeURIComponent(raw.name)}`
  }
}

const endpointOf = (ctx: ProviderContext) => `https://${accountIdOf(ctx)}.r2.cloudflarestorage.com`

function outputsFor(ctx: ProviderContext, bucket: string, secret?: { id: string; key: string }) {
  const out: Record<string, string> = { endpoint: endpointOf(ctx), bucket }
  if (secret) {
    out.access_key_id = secret.id
    out.secret_access_key = secret.key
  }
  return out
}

async function getBucket(ctx: ProviderContext, name: string): Promise<Observed | null> {
  const res = await cfCall<RawBucket>(
    ctx,
    'GET',
    `${accountPath(ctx)}/r2/buckets/${checkBucketName(name)}`,
    { allow: [404] }
  )
  return res.status === 404 || !res.result ? null : observedBucket(res.result, accountIdOf(ctx))
}

const cfg: PlanCfg = {
  spec: r2BucketSpec,
  writable: [],
  nameOf: (f, o) => String(f.name ?? o?.name ?? ''),
  createHint: 'a bucket with the same name that the Hub did not create is refused: adopt it instead'
}

function pastedKeys(fields: Record<string, unknown>): { id: string | null; changed: boolean } {
  const s = fields.s3_secret_access_key
  return { id: str(fields.s3_access_key_id), changed: isSecret(s) && s.changed }
}

export const r2Impl: TypeImpl = {
  spec: r2BucketSpec,
  permissions: [
    {
      need: 'read R2 buckets',
      group: 'Workers R2 Storage Write',
      async probe(ctx) {
        await cfCall(ctx, 'GET', `${accountPath(ctx)}/r2/buckets`, { query: { per_page: 1 } })
        return true
      }
    }
  ],
  observe: (ctx, name) => getBucket(ctx, name),
  async list(ctx, cursor): Promise<ListPage> {
    const res = await cfCall<{ buckets?: RawBucket[] }>(
      ctx,
      'GET',
      `${accountPath(ctx)}/r2/buckets`,
      {
        query: { per_page: 50, cursor: cursor ?? undefined }
      }
    )
    const rows = arr(asObj(res.result).buckets) as RawBucket[]
    const next = str(res.info?.cursor)
    return {
      items: rows.map((b) => observedBucket(b, accountIdOf(ctx))),
      cursor: rows.length >= 50 && next ? next : null
    }
  },
  async findExisting(ctx, desired) {
    if (desired.externalId) return null
    const name = str(desired.fields.name)
    return name ? getBucket(ctx, name) : null
  },
  plan(_ctx, desired, observed): PlannedOp[] {
    if (!desired || !observed) {
      const ops = planGeneric(cfg, desired, observed)
      const keys = desired ? pastedKeys(desired.fields) : null
      if (desired && !observed && keys?.changed && ops[0]?.kind === 'create') {
        const extra: FieldChange[] = [
          { field: 's3_access_key_id', to: keys.id },
          { field: 's3_secret_access_key', secret: true }
        ]
        ops[0] = { ...ops[0], changes: [...ops[0].changes.filter((c) => !c.secret), ...extra] }
      }
      if (!desired && observed && ops[0])
        ops[0] = {
          ...ops[0],
          reason: `Delete ${typedName(r2BucketSpec.label, observed.name)}. Cloudflare refuses it while the bucket holds objects: empty it first (its REST API cannot delete objects).`
        }
      return ops
    }
    const keys = pastedKeys(desired.fields)
    if (!keys.changed)
      return [
        {
          kind: 'noop',
          type: R2_BUCKET,
          resourceId: desired.resourceId,
          externalId: observed.externalId,
          reason: `${typedName(r2BucketSpec.label, observed.name)} is up to date.`,
          changes: [],
          preconditions: {},
          risk: []
        }
      ]
    return [
      {
        kind: 'update',
        type: R2_BUCKET,
        resourceId: desired.resourceId,
        externalId: observed.externalId,
        reason: `Store new S3 access keys for ${typedName(r2BucketSpec.label, observed.name)} and hand them to the app.`,
        changes: [
          { field: 's3_access_key_id', to: keys.id },
          { field: 's3_secret_access_key', secret: true }
        ],
        preconditions: { name: observed.name },
        risk: []
      }
    ]
  },
  async readOutputs(ctx, externalId) {
    return outputsFor(ctx, checkBucketName(externalId))
  },
  async apply(ctx, op, desired): Promise<OpResult> {
    const base = `${accountPath(ctx)}/r2/buckets`
    const keyOutputs = (): { id: string; key: string } | undefined => {
      const s = desired?.fields.s3_secret_access_key
      const id = str(desired?.fields.s3_access_key_id)
      if (isSecret(s) && s.changed && s.plain && id) return { id, key: s.plain }
      return undefined
    }
    switch (op.kind) {
      case 'noop':
        return ok(op.externalId ? await getBucket(ctx, op.externalId) : null, op.externalId, 200)
      case 'create': {
        if (!desired) throw new ProviderError('INVALID', 'A create needs the wanted values.')
        const name = checkBucketName(desired.fields.name)
        const have = await getBucket(ctx, name)
        if (have) {
          if (!desired.externalId)
            throw new ProviderError(
              'ALREADY_EXISTS',
              `A bucket named ${name} already exists in this Cloudflare account and was not created by the Hub. Adopt it instead of creating it.`,
              { status: 409 }
            )
          return ok(have, name, 200, outputsFor(ctx, name, keyOutputs()))
        }
        const hint = str(desired.fields.location)
        const body: Record<string, unknown> = { name }
        if (hint && hint !== 'auto') body.locationHint = hint
        const res = await cfCall<RawBucket>(ctx, 'POST', base, {
          body,
          extraScrub:
            desired.fields.s3_secret_access_key && isSecret(desired.fields.s3_secret_access_key)
              ? [desired.fields.s3_secret_access_key.plain ?? '']
              : []
        })
        return ok(
          observedBucket(res.result ?? { name }, accountIdOf(ctx)),
          name,
          res.status,
          outputsFor(ctx, name, keyOutputs())
        )
      }
      case 'update': {
        if (!op.externalId || !desired)
          throw new ProviderError('INVALID', 'An update needs a bucket.')
        const name = checkBucketName(op.externalId)
        const have = await getBucket(ctx, name)
        if (!have)
          throw new ProviderError('NOT_FOUND', 'The bucket no longer exists at Cloudflare.', {
            status: 404
          })
        const keys = keyOutputs()
        if (!keys)
          throw new ProviderError(
            'INVALID',
            'New S3 access keys need both the access key id and the secret.'
          )
        return ok(have, name, 200, outputsFor(ctx, name, keys))
      }
      case 'delete': {
        if (!op.externalId) throw new ProviderError('INVALID', 'A delete needs a bucket name.')
        const name = checkBucketName(op.externalId)
        try {
          const res = await cfCall(ctx, 'DELETE', `${base}/${seg(name)}`, { allow: [404] })
          return ok(null, name, res.status)
        } catch (err) {
          if (
            err instanceof ProviderError &&
            (cfCodeOf(err) === NOT_EMPTY_CODE || err.status === 409)
          )
            throw new ProviderError(
              'BUCKET_NOT_EMPTY',
              `${name} still holds objects. Empty it first (the Cloudflare API cannot delete objects: use the dashboard or an S3 tool), then delete it.`,
              { status: 409 }
            )
          throw err
        }
      }
      default:
        throw new ProviderError(
          'UNSUPPORTED',
          'A bucket’s name and location cannot change; create a new bucket instead.'
        )
    }
  }
}
