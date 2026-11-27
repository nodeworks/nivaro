import {
  type DesiredResource,
  type Observed,
  type ProviderContext,
  ProviderError
} from '../types.js'
import { awsRest, hubTags, md5Base64, orNull, resolveRegion, restXml } from './client.js'
import {
  type AwsListPage,
  type AwsTypeDef,
  cap,
  nameField,
  observed,
  regionField,
  riskOf
} from './kit.js'
import { xmlChild, xmlList, xmlText } from './xml.js'

/**
 * aws.s3_bucket — path-style requests (`s3.<region>.amazonaws.com/<bucket>`), so every bucket
 * name fits the exact-host allow list. Created with all four public-access blocks ON and SSE-S3
 * encryption by default; the block is written FIRST. A bucket that is not empty is never deleted
 * (`BUCKET_NOT_EMPTY`) unless the op carries `data.deleteAllObjects` (set by the engine only
 * after an admin typed "delete all objects in <bucket>"); then every object, version and delete
 * marker is removed before the bucket.
 */

const XMLNS = 'http://s3.amazonaws.com/doc/2006-03-01/'
const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
const t = xmlText
const c = xmlChild

const path = (bucket: string) => `/${encodeURIComponent(bucket)}`

/** A subresource PUT with its required Content-MD5. */
async function putSub(
  ctx: ProviderContext,
  region: string,
  bucket: string,
  sub: string,
  xml: string
) {
  await awsRest(ctx, 's3', 'PUT', path(bucket), {
    region,
    query: { [sub]: '' },
    headers: { 'content-type': 'application/xml', 'content-md5': md5Base64(xml) },
    body: xml
  })
}

const blockXml = (on: boolean) =>
  `<PublicAccessBlockConfiguration xmlns="${XMLNS}"><BlockPublicAcls>${on}</BlockPublicAcls><IgnorePublicAcls>${on}</IgnorePublicAcls><BlockPublicPolicy>${on}</BlockPublicPolicy><RestrictPublicBuckets>${on}</RestrictPublicBuckets></PublicAccessBlockConfiguration>`

const encryptionXml = `<ServerSideEncryptionConfiguration xmlns="${XMLNS}"><Rule><ApplyServerSideEncryptionByDefault><SSEAlgorithm>AES256</SSEAlgorithm></ApplyServerSideEncryptionByDefault></Rule></ServerSideEncryptionConfiguration>`

const versioningXml = (on: boolean) =>
  `<VersioningConfiguration xmlns="${XMLNS}"><Status>${on ? 'Enabled' : 'Suspended'}</Status></VersioningConfiguration>`

const taggingXml = (tags: Record<string, string>) =>
  `<Tagging xmlns="${XMLNS}"><TagSet>${Object.entries(tags)
    .map(([k, v]) => `<Tag><Key>${esc(k)}</Key><Value>${esc(v)}</Value></Tag>`)
    .join('')}</TagSet></Tagging>`

async function bucketTags(
  ctx: ProviderContext,
  region: string,
  bucket: string
): Promise<Record<string, string>> {
  const res = await awsRest(ctx, 's3', 'GET', path(bucket), {
    region,
    query: { tagging: '' },
    allow: [404]
  })
  if (res.status === 404) return {}
  const out: Record<string, string> = {}
  for (const x of xmlList(restXml(ctx, res).TagSet, 'Tag')) {
    const k = t(c(x, 'Key'))
    if (k) out[k] = t(c(x, 'Value'))
  }
  return out
}

async function locationOf(
  ctx: ProviderContext,
  bucket: string,
  region: string
): Promise<string | null> {
  const res = await orNull(() =>
    awsRest(ctx, 's3', 'GET', path(bucket), { region, query: { location: '' } })
  )
  if (!res) return null
  const loc = String(restXmlRoot(ctx, res.text).LocationConstraint ?? '')
  return loc === '' ? 'us-east-1' : loc === 'EU' ? 'eu-west-1' : loc
}

// LocationConstraint is a bare text root; parse it without the object unwrapping.
function restXmlRoot(ctx: ProviderContext, text: string): Record<string, unknown> {
  const m = /<LocationConstraint[^>]*>([^<]*)<\/LocationConstraint>/.exec(text)
  if (m) return { LocationConstraint: m[1] }
  if (/<LocationConstraint[^>]*\/>/.test(text)) return { LocationConstraint: '' }
  throw new ProviderError('AWS_BAD_ANSWER', ctx.scrub('S3 sent an unreadable location answer.'), {
    retryable: true
  })
}

async function observeBucket(
  ctx: ProviderContext,
  bucket: string,
  hint: string
): Promise<Observed | null> {
  const region = (await locationOf(ctx, bucket, hint)) ?? null
  if (!region) return null
  resolveRegion(ctx, region) // a bucket in a region this connection may not use is refused here
  const pab = await awsRest(ctx, 's3', 'GET', path(bucket), {
    region,
    query: { publicAccessBlock: '' },
    allow: [404]
  })
  let block = false
  if (pab.status !== 404) {
    const x = restXml(ctx, pab)
    block = [
      'BlockPublicAcls',
      'IgnorePublicAcls',
      'BlockPublicPolicy',
      'RestrictPublicBuckets'
    ].every((k) => t(x[k]) === 'true')
  }
  const ver = restXml(
    ctx,
    await awsRest(ctx, 's3', 'GET', path(bucket), { region, query: { versioning: '' } })
  )
  const enc = await awsRest(ctx, 's3', 'GET', path(bucket), {
    region,
    query: { encryption: '' },
    allow: [404]
  })
  const tags = await bucketTags(ctx, region, bucket)
  return observed(
    'aws.s3_bucket',
    bucket,
    region,
    bucket,
    {
      block_public_access: block,
      versioning: t(ver.Status) === 'Enabled',
      encryption: enc.status !== 404
    },
    tags,
    'available'
  )
}

async function isEmpty(ctx: ProviderContext, bucket: string, region: string): Promise<boolean> {
  const objs = restXml(
    ctx,
    await awsRest(ctx, 's3', 'GET', path(bucket), {
      region,
      query: { 'list-type': '2', 'max-keys': '1' }
    })
  )
  if (t(objs.KeyCount) !== '0' && xmlList(objs.Contents).length) return false
  const vers = restXml(
    ctx,
    await awsRest(ctx, 's3', 'GET', path(bucket), {
      region,
      query: { versions: '', 'max-keys': '1' }
    })
  )
  return !xmlList(vers.Version).length && !xmlList(vers.DeleteMarker).length
}

async function emptyBucket(ctx: ProviderContext, bucket: string, region: string) {
  for (let round = 0; round < 10_000; round++) {
    const vers = restXml(
      ctx,
      await awsRest(ctx, 's3', 'GET', path(bucket), {
        region,
        query: { versions: '', 'max-keys': '1000' }
      })
    )
    const keys = [...xmlList(vers.Version), ...xmlList(vers.DeleteMarker)]
    if (!keys.length) break
    const body = `<Delete xmlns="${XMLNS}"><Quiet>true</Quiet>${keys
      .map(
        (k) =>
          `<Object><Key>${esc(t(c(k, 'Key')))}</Key><VersionId>${esc(t(c(k, 'VersionId')))}</VersionId></Object>`
      )
      .join('')}</Delete>`
    await awsRest(ctx, 's3', 'POST', path(bucket), {
      region,
      query: { delete: '' },
      headers: { 'content-type': 'application/xml', 'content-md5': md5Base64(body) },
      body
    })
  }
}

const bucketTagSet = (d: DesiredResource) => hubTags(d.tags)

export const s3BucketDef: AwsTypeDef = {
  spec: {
    key: 'aws.s3_bucket',
    label: 'S3 bucket',
    scope: 'app',
    fields: [
      regionField,
      {
        ...nameField,
        label: 'Bucket name',
        createOnly: true,
        replaceOnChange: true,
        pattern: '^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$'
      },
      {
        key: 'block_public_access',
        label: 'Block public access',
        kind: 'boolean',
        default: true,
        help: 'On by default. Turning it off is a public-exposure change.'
      },
      { key: 'versioning', label: 'Versioning', kind: 'boolean', default: false },
      { key: 'encryption', label: 'Encryption (SSE-S3)', kind: 'boolean', default: true }
    ],
    capabilities: cap(),
    reversible: (f) => f === 'block_public_access' || f === 'versioning',
    refs: [],
    risk: riskOf((op, d) => {
      const out: Array<'public_exposure' | 'data_loss'> = []
      const open = op.changes.find((x) => x.field === 'block_public_access')
      if (
        ((op.kind === 'create' || op.kind === 'replace') &&
          d?.fields.block_public_access === false) ||
        open?.to === false
      )
        out.push('public_exposure')
      if (op.data?.deleteAllObjects === true && (op.kind === 'delete' || op.kind === 'replace'))
        out.push('data_loss')
      return out
    })
  },
  probe: {
    need: 's3:ListAllMyBuckets',
    run: (ctx, region) => awsRest(ctx, 's3', 'GET', '/', { region, query: { 'max-buckets': '1' } })
  },
  observe: (ctx, id, region) => observeBucket(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const query: Record<string, string> = { 'bucket-region': region, 'max-buckets': '100' }
    if (token) query['continuation-token'] = token
    const x = restXml(ctx, await awsRest(ctx, 's3', 'GET', '/', { region, query }))
    const out: Observed[] = []
    for (const b of xmlList(x.Buckets, 'Bucket')) {
      const name = t(c(b, 'Name'))
      if (!name) continue
      out.push(
        observed(
          'aws.s3_bucket',
          name,
          region,
          name,
          {},
          await bucketTags(ctx, region, name),
          'available'
        )
      )
    }
    return { items: out, next: t(x.ContinuationToken) || null }
  },
  findExisting: (ctx, desired, region) => observeBucket(ctx, String(desired.fields.name), region),
  async create(ctx, desired, region) {
    const f = desired.fields
    const name = String(f.name)
    const body =
      region === 'us-east-1'
        ? ''
        : `<CreateBucketConfiguration xmlns="${XMLNS}"><LocationConstraint>${region}</LocationConstraint></CreateBucketConfiguration>`
    await awsRest(ctx, 's3', 'PUT', path(name), {
      region,
      headers: body ? { 'content-type': 'application/xml' } : {},
      body
    })
    // Closed first: the public-access block goes on before anything else.
    await putSub(ctx, region, name, 'publicAccessBlock', blockXml(f.block_public_access !== false))
    if (f.encryption !== false) await putSub(ctx, region, name, 'encryption', encryptionXml)
    if (f.versioning === true) await putSub(ctx, region, name, 'versioning', versioningXml(true))
    await putSub(ctx, region, name, 'tagging', taggingXml(bucketTagSet(desired)))
    return name
  },
  async update(ctx, id, region, desired, _obs, changed) {
    const f = desired.fields
    if (changed.has('block_public_access'))
      await putSub(ctx, region, id, 'publicAccessBlock', blockXml(f.block_public_access !== false))
    if (changed.has('encryption') && f.encryption !== false)
      await putSub(ctx, region, id, 'encryption', encryptionXml)
    if (changed.has('versioning'))
      await putSub(ctx, region, id, 'versioning', versioningXml(f.versioning === true))
  },
  async remove(ctx, id, region, op) {
    const have = await observeBucket(ctx, id, region)
    if (!have) return
    const empty = await isEmpty(ctx, id, region)
    if (!empty) {
      if (op.data?.deleteAllObjects !== true)
        throw new ProviderError(
          'BUCKET_NOT_EMPTY',
          `Bucket ${id} is not empty. An admin must type "delete all objects in ${id}" to delete it with everything in it.`
        )
      await emptyBucket(ctx, id, region)
    }
    await awsRest(ctx, 's3', 'DELETE', path(id), { region })
  }
}

export const s3Defs: AwsTypeDef[] = [s3BucketDef]
