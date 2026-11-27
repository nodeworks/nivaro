import { type HealthAnswer, type Observed, type ProviderContext, ProviderError } from '../types.js'
import { awsJsonFor, hubTags, keyValueTags, orNull } from './client.js'
import { type AwsListPage, type AwsTypeDef, cap, observed, regionField, riskOf } from './kit.js'
import { ecrLifecycleEstimate, ecrRepositoryEstimate } from './pricing-part3.js'

/**
 * Amazon ECR (private registry of the connection's own account; calls never pass a registryId).
 *
 *  - `aws.ecr_repository`: scan on push, tag immutability, encryption (AES256 or a KMS key; both
 *    fixed at creation, so a change replaces). A repository that still holds images is never
 *    deleted (`REPOSITORY_NOT_EMPTY`) unless the op carries `data.deleteAllObjects` (set by the
 *    engine after an admin typed "delete all objects in <name>"); it is then `data_loss`.
 *    Health: the latest pushed image's scan findings by severity (the same counts Task 33 feeds
 *    to the Hub vulnerability tab as source `ecr`, through `ecrScanSummary`).
 *  - `aws.ecr_lifecycle_policy`: the one lifecycle policy of a Hub-managed repository.
 */

const ecr = (ctx: ProviderContext, target: string, body: Record<string, unknown>, region: string) =>
  awsJsonFor(ctx, 'ecr', target, body, { region })

interface Repo {
  repositoryArn?: string
  repositoryName?: string
  repositoryUri?: string
  imageTagMutability?: string
  imageScanningConfiguration?: { scanOnPush?: boolean }
  encryptionConfiguration?: { encryptionType?: string; kmsKey?: string }
}

const NAME_RE = /^[a-z0-9]+(?:[._/-][a-z0-9]+)*$/

const describeRepo = async (ctx: ProviderContext, name: string, region: string) => {
  const r = await orNull(() =>
    ecr(ctx, 'DescribeRepositories', { repositoryNames: [name] }, region)
  )
  return ((r?.repositories as Repo[] | undefined) ?? [])[0] ?? null
}

async function repoTags(
  ctx: ProviderContext,
  arn: string,
  region: string
): Promise<Record<string, string>> {
  const r = await ecr(ctx, 'ListTagsForResource', { resourceArn: arn }, region)
  const out: Record<string, string> = {}
  for (const x of (r.tags as Array<{ Key: string; Value?: string }> | undefined) ?? [])
    out[x.Key] = x.Value ?? ''
  return out
}

async function hasImages(ctx: ProviderContext, name: string, region: string): Promise<boolean> {
  const r = await ecr(ctx, 'ListImages', { repositoryName: name, maxResults: 1 }, region)
  return ((r.imageIds as unknown[] | undefined) ?? []).length > 0
}

async function repoObserved(
  ctx: ProviderContext,
  repo: Repo,
  region: string,
  withImages: boolean
): Promise<Observed | null> {
  const name = repo.repositoryName
  if (!name || !repo.repositoryArn) return null
  const enc = repo.encryptionConfiguration?.encryptionType === 'KMS' ? 'KMS' : 'AES256'
  return observed(
    'aws.ecr_repository',
    name,
    region,
    name,
    {
      scan_on_push: repo.imageScanningConfiguration?.scanOnPush === true,
      tag_immutability: repo.imageTagMutability === 'IMMUTABLE',
      encryption: enc,
      kms_key: enc === 'KMS' ? (repo.encryptionConfiguration?.kmsKey ?? '') : '',
      uri: repo.repositoryUri ?? '',
      ...(withImages ? { has_images: await hasImages(ctx, name, region) } : {})
    },
    await repoTags(ctx, repo.repositoryArn, region),
    'active'
  )
}

// ── Scan findings (health, and the Hub's vulnerability tab) ──

interface ImageDetail {
  imageDigest?: string
  imageTags?: string[]
  imageSizeInBytes?: number
  imagePushedAt?: number | string
  imageScanStatus?: { status?: string }
  imageScanFindingsSummary?: {
    imageScanCompletedAt?: number | string
    findingSeverityCounts?: Record<string, number>
  }
}

/** Every image's details, newest pages first as AWS answers, capped (never unbounded). */
export async function ecrImages(
  ctx: ProviderContext,
  name: string,
  region: string,
  maxPages = 5
): Promise<ImageDetail[]> {
  const out: ImageDetail[] = []
  let token: string | undefined
  for (let i = 0; i < maxPages; i++) {
    const r = await ecr(
      ctx,
      'DescribeImages',
      { repositoryName: name, maxResults: 100, nextToken: token },
      region
    )
    out.push(...((r.imageDetails as ImageDetail[] | undefined) ?? []))
    token = (r.nextToken as string | undefined) || undefined
    if (!token) break
  }
  return out
}

const stamp = (v: number | string | undefined): number => {
  const n = typeof v === 'string' ? Date.parse(v) : typeof v === 'number' ? v * 1000 : 0
  return Number.isFinite(n) ? n : 0
}

export interface EcrScanSummary {
  imageTag: string | null
  digest: string | null
  pushedAt: string | null
  scanStatus: string | null
  /** CRITICAL / HIGH / MEDIUM / LOW / INFORMATIONAL / UNDEFINED → count, for the latest image. */
  counts: Record<string, number>
  totalImages: number
}

/** The latest pushed image's scan finding counts by severity (null counts = never scanned). */
export async function ecrScanSummary(
  ctx: ProviderContext,
  name: string,
  region: string
): Promise<EcrScanSummary> {
  const images = await ecrImages(ctx, name, region)
  const latest = [...images].sort((a, b) => stamp(b.imagePushedAt) - stamp(a.imagePushedAt))[0]
  if (!latest)
    return {
      imageTag: null,
      digest: null,
      pushedAt: null,
      scanStatus: null,
      counts: {},
      totalImages: 0
    }
  const counts: Record<string, number> = {}
  for (const [k, v] of Object.entries(latest.imageScanFindingsSummary?.findingSeverityCounts ?? {}))
    if (typeof v === 'number' && Number.isFinite(v)) counts[k.toUpperCase()] = v
  const pushed = stamp(latest.imagePushedAt)
  return {
    imageTag: latest.imageTags?.[0] ?? null,
    digest: latest.imageDigest ?? null,
    pushedAt: pushed ? new Date(pushed).toISOString() : null,
    scanStatus: latest.imageScanStatus?.status ?? null,
    counts,
    totalImages: images.length
  }
}

async function repoHealth(
  ctx: ProviderContext,
  id: string,
  region: string
): Promise<Omit<HealthAnswer, 'checkedAt'>> {
  const s = await ecrScanSummary(ctx, id, region)
  if (!s.totalImages) return { status: 'ok', message: 'No images have been pushed yet.' }
  const n = (k: string) => s.counts[k] ?? 0
  const details = {
    image: s.imageTag ?? s.digest ?? 'untagged',
    critical: n('CRITICAL'),
    high: n('HIGH'),
    medium: n('MEDIUM'),
    low: n('LOW'),
    informational: n('INFORMATIONAL'),
    undefined: n('UNDEFINED')
  }
  if (!s.scanStatus || !Object.keys(s.counts).length)
    return {
      status: 'ok',
      message: s.scanStatus
        ? `Latest image ${details.image}: scan ${s.scanStatus.toLowerCase()}, no findings.`
        : `Latest image ${details.image} has not been scanned.`,
      details
    }
  const bad = details.critical + details.high
  return {
    status: bad > 0 ? 'warn' : 'ok',
    message: `Latest image ${details.image}: ${details.critical} critical, ${details.high} high, ${details.medium} medium, ${details.low} low findings.`,
    details
  }
}

// ── aws.ecr_repository ──

const fieldsList = [
  regionField,
  {
    key: 'name',
    label: 'Repository name',
    kind: 'string' as const,
    required: true,
    createOnly: true,
    replaceOnChange: true,
    pattern: '^[a-z0-9]+(?:[._/-][a-z0-9]+)*$',
    help: 'Lower case; slashes make namespaces (shop/api).'
  },
  {
    key: 'scan_on_push',
    label: 'Scan on push',
    kind: 'boolean' as const,
    default: true,
    help: 'Basic scanning of every pushed image.'
  },
  {
    key: 'tag_immutability',
    label: 'Immutable tags',
    kind: 'boolean' as const,
    default: false,
    help: 'On: a tag cannot be pushed again (no moving :latest).'
  },
  {
    key: 'encryption',
    label: 'Encryption',
    kind: 'enum' as const,
    default: 'AES256',
    createOnly: true,
    replaceOnChange: true,
    options: [
      { value: 'AES256', label: 'AES-256 (ECR managed)' },
      { value: 'KMS', label: 'KMS key' }
    ],
    help: 'Fixed at creation.'
  },
  {
    key: 'kms_key',
    label: 'KMS key',
    kind: 'string' as const,
    createOnly: true,
    replaceOnChange: true,
    help: 'Key ARN, for KMS encryption. Empty uses the account’s aws/ecr key.'
  },
  { key: 'uri', label: 'Repository URI', kind: 'string' as const, readOnly: true }
]

export const ecrRepositoryDef: AwsTypeDef = {
  spec: {
    key: 'aws.ecr_repository',
    label: 'ECR repository',
    scope: 'app',
    fields: fieldsList,
    estimate: ecrRepositoryEstimate,
    capabilities: cap(),
    reversible: (f) => f === 'scan_on_push' || f === 'tag_immutability',
    refs: [],
    risk: riskOf((op) => {
      const out: Array<'data_loss'> = []
      if (
        (op.kind === 'delete' || op.kind === 'replace') &&
        (op.data?.deleteAllObjects === true || op.data?.hasImages === true)
      )
        out.push('data_loss')
      return out
    })
  },
  probe: {
    need: 'ecr:DescribeRepositories',
    run: (ctx, region) => ecr(ctx, 'DescribeRepositories', { maxResults: 1 }, region)
  },
  async observe(ctx, id, region) {
    const repo = await describeRepo(ctx, id, region)
    return repo ? repoObserved(ctx, repo, region, true) : null
  },
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await ecr(ctx, 'DescribeRepositories', { maxResults: 100, nextToken: token }, region)
    const out: Observed[] = []
    for (const repo of (r.repositories as Repo[] | undefined) ?? []) {
      const o = await repoObserved(ctx, repo, region, false)
      if (o) out.push(o)
    }
    return { items: out, next: (r.nextToken as string | undefined) || null }
  },
  async findExisting(ctx, desired, region) {
    const repo = await describeRepo(ctx, String(desired.fields.name ?? ''), region)
    return repo ? repoObserved(ctx, repo, region, false) : null
  },
  opData: (_ctx, _d, obs, kind) =>
    kind === 'delete' || kind === 'replace' ? { hasImages: obs?.fields.has_images === true } : {},
  checkPlan(desired) {
    const name = String(desired.fields.name ?? '')
    if (name && (!NAME_RE.test(name) || name.length < 2 || name.length > 256))
      throw new ProviderError('INVALID_FIELDS', 'The repository name is not a valid ECR name.')
    if (desired.fields.encryption !== 'KMS' && desired.fields.kms_key)
      throw new ProviderError(
        'INVALID_FIELDS',
        'A KMS key only applies when encryption is set to KMS.'
      )
  },
  async create(ctx, desired, region) {
    const f = desired.fields
    const kms = f.encryption === 'KMS'
    await ecr(
      ctx,
      'CreateRepository',
      {
        repositoryName: f.name,
        imageTagMutability: f.tag_immutability === true ? 'IMMUTABLE' : 'MUTABLE',
        imageScanningConfiguration: { scanOnPush: f.scan_on_push !== false },
        encryptionConfiguration: kms
          ? { encryptionType: 'KMS', ...(f.kms_key ? { kmsKey: String(f.kms_key) } : {}) }
          : { encryptionType: 'AES256' },
        tags: keyValueTags(hubTags(desired.tags))
      },
      region
    )
    return String(f.name)
  },
  async update(ctx, id, region, desired, obs, changed) {
    const f = desired.fields
    if (changed.has('scan_on_push'))
      await ecr(
        ctx,
        'PutImageScanningConfiguration',
        {
          repositoryName: id,
          imageScanningConfiguration: { scanOnPush: f.scan_on_push !== false }
        },
        region
      )
    if (changed.has('tag_immutability'))
      await ecr(
        ctx,
        'PutImageTagMutability',
        {
          repositoryName: id,
          imageTagMutability: f.tag_immutability === true ? 'IMMUTABLE' : 'MUTABLE'
        },
        region
      )
    const arn = (await describeRepo(ctx, id, region))?.repositoryArn
    if (arn && obs)
      await ecr(
        ctx,
        'TagResource',
        { resourceArn: arn, tags: keyValueTags(hubTags(desired.tags)) },
        region
      )
  },
  health: (ctx, id, region) => repoHealth(ctx, id, region),
  async remove(ctx, id, region, op) {
    const repo = await describeRepo(ctx, id, region)
    if (!repo) return
    const full = await hasImages(ctx, id, region)
    if (full && op.data?.deleteAllObjects !== true)
      throw new ProviderError(
        'REPOSITORY_NOT_EMPTY',
        `Repository ${id} still holds images. An admin must type "delete all objects in ${id}" to delete it with every image in it.`
      )
    await ecr(ctx, 'DeleteRepository', { repositoryName: id, force: full }, region)
  }
}

// ── aws.ecr_lifecycle_policy ──

/** The policy JSON with keys sorted and no extra whitespace (both sides are compared in this form). */
export function canonicalPolicy(text: unknown): string {
  if (typeof text !== 'string' || !text.trim()) return ''
  const sort = (v: unknown): unknown =>
    Array.isArray(v)
      ? v.map(sort)
      : v && typeof v === 'object'
        ? Object.fromEntries(
            Object.entries(v as Record<string, unknown>)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, x]) => [k, sort(x)])
          )
        : v
  try {
    return JSON.stringify(sort(JSON.parse(text)))
  } catch {
    return text.trim()
  }
}

async function readPolicy(
  ctx: ProviderContext,
  repo: string,
  region: string
): Promise<Observed | null> {
  const r = await orNull(() => ecr(ctx, 'GetLifecyclePolicy', { repositoryName: repo }, region))
  if (!r || typeof r.lifecyclePolicyText !== 'string') return null
  return observed(
    'aws.ecr_lifecycle_policy',
    repo,
    region,
    null,
    { repository: repo, policy: canonicalPolicy(r.lifecyclePolicyText) },
    {},
    'active'
  )
}

export const ecrLifecyclePolicyDef: AwsTypeDef = {
  spec: {
    key: 'aws.ecr_lifecycle_policy',
    label: 'ECR lifecycle policy',
    scope: 'app',
    fields: [
      regionField,
      {
        key: 'repository',
        label: 'Repository',
        kind: 'ref',
        refType: 'aws.ecr_repository',
        required: true,
        createOnly: true,
        replaceOnChange: true
      },
      {
        key: 'policy',
        label: 'Policy (JSON)',
        kind: 'string',
        required: true,
        help: 'The ECR lifecycle policy document: {"rules":[…]}. Expired images are deleted by AWS.'
      }
    ],
    estimate: ecrLifecycleEstimate,
    capabilities: cap({ tag: false }),
    reversible: (f) => f === 'policy',
    refs: [{ field: 'repository', type: 'aws.ecr_repository', required: true }],
    risk: riskOf((op) =>
      // A lifecycle policy deletes images by rule: a new or changed policy can remove data.
      op.kind === 'create' || op.kind === 'update' || op.kind === 'replace' ? ['data_loss'] : []
    )
  },
  probe: {
    need: 'ecr:GetLifecyclePolicy',
    run: async (ctx, region) => {
      // A repository that does not exist answers RepositoryNotFound: the permission is there.
      try {
        await ecr(ctx, 'GetLifecyclePolicy', { repositoryName: 'nivaro-hub-probe' }, region)
      } catch (err) {
        if (err instanceof ProviderError && /NotFound/.test(err.code)) return
        throw err
      }
    }
  },
  normalize: (fields) => ({ ...fields, policy: canonicalPolicy(fields.policy) }),
  checkPlan(desired) {
    const text = canonicalPolicy(desired.fields.policy)
    let ok = false
    try {
      const j = JSON.parse(text) as { rules?: unknown }
      ok = Array.isArray(j.rules) && j.rules.length > 0
    } catch {
      ok = false
    }
    if (!ok)
      throw new ProviderError(
        'INVALID_FIELDS',
        'The lifecycle policy must be JSON with a non-empty "rules" list.'
      )
  },
  observe: (ctx, id, region) => readPolicy(ctx, id, region),
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await ecr(ctx, 'DescribeRepositories', { maxResults: 50, nextToken: token }, region)
    const out: Observed[] = []
    for (const repo of (r.repositories as Repo[] | undefined) ?? []) {
      if (!repo.repositoryName) continue
      const o = await readPolicy(ctx, repo.repositoryName, region)
      if (o) out.push(o)
    }
    return { items: out, next: (r.nextToken as string | undefined) || null }
  },
  findExisting: (ctx, desired, region) =>
    readPolicy(ctx, String(desired.refs.repository ?? ''), region),
  async create(ctx, desired, region) {
    const repo = String(desired.refs.repository ?? '')
    if (!repo) throw new ProviderError('INVALID_FIELDS', 'Pick the repository for this policy.')
    await ecr(
      ctx,
      'PutLifecyclePolicy',
      { repositoryName: repo, lifecyclePolicyText: canonicalPolicy(desired.fields.policy) },
      region
    )
    return repo
  },
  async update(ctx, id, region, desired) {
    await ecr(
      ctx,
      'PutLifecyclePolicy',
      { repositoryName: id, lifecyclePolicyText: canonicalPolicy(desired.fields.policy) },
      region
    )
  },
  async remove(ctx, id, region) {
    await orNull(() => ecr(ctx, 'DeleteLifecyclePolicy', { repositoryName: id }, region))
  }
}

export const ecrDefs: AwsTypeDef[] = [ecrRepositoryDef, ecrLifecyclePolicyDef]
