import { type Observed, type ProviderContext, ProviderError } from '../types.js'
import { awsJson, hubTags, keyValueTags, orNull, waitFor } from './client.js'
import { type AwsListPage, type AwsTypeDef, cap, observed, regionField, riskOf } from './kit.js'
import { acmEstimate } from './pricing.js'
import { changeRecords, normName, type RecordSet } from './route53.js'

/**
 * aws.acm_certificate — a public certificate validated by DNS. After RequestCertificate the
 * Hub reads the validation CNAMEs and UPSERTs them into the chosen Route 53 zone (`zone` ref;
 * leave it empty to validate by hand). Issuance itself takes AWS a few minutes: the resource
 * reads `PENDING_VALIDATION` until then. The validation records are left in place on delete
 * (other certificates for the same name share them).
 */

interface Cert {
  CertificateArn?: string
  DomainName?: string
  SubjectAlternativeNames?: string[]
  Status?: string
  DomainValidationOptions?: Array<{
    DomainName?: string
    ResourceRecord?: { Name?: string; Type?: string; Value?: string }
  }>
}

const validationRecords = (cert: Cert) => {
  const seen = new Set<string>()
  const out: Array<{ name: string; type: string; value: string }> = []
  for (const o of cert.DomainValidationOptions ?? []) {
    const r = o.ResourceRecord
    if (!r?.Name || !r.Type || !r.Value) continue
    const key = `${r.Name}|${r.Type}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push({ name: normName(r.Name), type: r.Type, value: r.Value })
  }
  return out
}

async function certObserved(
  ctx: ProviderContext,
  cert: Cert,
  region: string
): Promise<Observed | null> {
  const arn = cert.CertificateArn
  if (!arn) return null
  const tr = await awsJson(ctx, 'ListTagsForCertificate', { CertificateArn: arn }, { region })
  const tags: Record<string, string> = {}
  for (const x of (tr.Tags as Array<{ Key: string; Value?: string }> | undefined) ?? [])
    tags[x.Key] = x.Value ?? ''
  const domain = cert.DomainName ?? ''
  return observed(
    'aws.acm_certificate',
    arn,
    region,
    domain,
    {
      domain,
      alternative_names: (cert.SubjectAlternativeNames ?? []).filter((n) => n !== domain),
      validation_records: validationRecords(cert)
    },
    tags,
    cert.Status ?? null
  )
}

const describe = async (
  ctx: ProviderContext,
  arn: string,
  region: string
): Promise<Cert | null> => {
  const r = await orNull(() =>
    awsJson(ctx, 'DescribeCertificate', { CertificateArn: arn }, { region })
  )
  return (r?.Certificate as Cert | undefined) ?? null
}

export const acmCertificateDef: AwsTypeDef = {
  spec: {
    key: 'aws.acm_certificate',
    label: 'ACM certificate',
    scope: 'app',
    nameField: 'domain',
    fields: [
      regionField,
      {
        key: 'domain',
        label: 'Domain name',
        kind: 'string',
        required: true,
        createOnly: true,
        replaceOnChange: true
      },
      {
        key: 'alternative_names',
        label: 'Other names',
        kind: 'list',
        createOnly: true,
        replaceOnChange: true,
        items: { key: 'name', label: 'Name', kind: 'string' }
      },
      {
        key: 'zone',
        label: 'Route 53 zone for validation',
        kind: 'ref',
        refType: 'aws.route53_zone',
        createOnly: true,
        help: 'Validation records are written here. Leave empty to validate by hand.'
      },
      {
        key: 'validation_records',
        label: 'Validation records',
        kind: 'list',
        readOnly: true,
        items: { key: 'record', label: 'Record', kind: 'object' }
      }
    ],
    estimate: acmEstimate,
    capabilities: cap(),
    reversible: false,
    refs: [{ field: 'zone', type: 'aws.route53_zone', required: false }],
    risk: riskOf()
  },
  probe: {
    need: 'acm:ListCertificates',
    run: (ctx, region) => awsJson(ctx, 'ListCertificates', { MaxItems: 1 }, { region })
  },
  async observe(ctx, id, region) {
    const cert = await describe(ctx, id, region)
    return cert ? certObserved(ctx, cert, region) : null
  },
  async list(ctx, region, token): Promise<AwsListPage> {
    const r = await awsJson(
      ctx,
      'ListCertificates',
      { MaxItems: 50, NextToken: token ?? undefined },
      { region }
    )
    const out: Observed[] = []
    for (const s of (r.CertificateSummaryList as Array<{ CertificateArn: string }> | undefined) ??
      []) {
      const cert = await describe(ctx, s.CertificateArn, region)
      const o = cert && (await certObserved(ctx, cert, region))
      if (o) out.push(o)
    }
    return { items: out, next: (r.NextToken as string | undefined) ?? null }
  },
  opData: (ctx, desired, _o, kind) =>
    kind === 'create' || kind === 'replace'
      ? {
          clientToken: `nivaro${desired?.resourceId ?? 0}${ctx.now().getTime()}`
            .replace(/[^A-Za-z0-9]/g, '')
            .slice(0, 32)
        }
      : {},
  async create(ctx, desired, region, op) {
    const f = desired.fields
    const names = Array.isArray(f.alternative_names) ? (f.alternative_names as string[]) : []
    const r = await awsJson(
      ctx,
      'RequestCertificate',
      {
        DomainName: f.domain,
        SubjectAlternativeNames: names.length ? names : undefined,
        ValidationMethod: 'DNS',
        IdempotencyToken: String(op.data?.clientToken ?? '').slice(0, 32) || undefined,
        Tags: keyValueTags(hubTags(desired.tags))
      },
      { region }
    )
    const arn = r.CertificateArn as string | undefined
    if (!arn)
      throw new ProviderError('AWS_BAD_ANSWER', 'RequestCertificate answered no ARN.', {
        retryable: true
      })
    const zone = typeof desired.refs.zone === 'string' ? desired.refs.zone : ''
    if (zone) {
      // AWS fills the validation records in a few seconds.
      const cert = await waitFor(
        ctx,
        async () => {
          const c = await describe(ctx, arn, region)
          const want = 1 + names.length
          return c &&
            validationRecords(c).length > 0 &&
            (c.DomainValidationOptions ?? []).length >= want
            ? c
            : null
        },
        { tries: 10, delayMs: 3000 }
      )
      const records = cert ? validationRecords(cert) : []
      if (!records.length)
        throw new ProviderError(
          'VALIDATION_PENDING',
          'AWS has not published the validation records yet.',
          { retryable: true }
        )
      const sets: RecordSet[] = records.map((x) => ({
        name: x.name,
        type: x.type,
        ttl: 300,
        values: [x.value]
      }))
      await changeRecords(
        ctx,
        zone,
        sets.map((record) => ({ action: 'UPSERT' as const, record }))
      )
    }
    return arn
  },
  async update(ctx, id, region, desired) {
    await awsJson(
      ctx,
      'AddTagsToCertificate',
      { CertificateArn: id, Tags: keyValueTags(hubTags(desired.tags)) },
      { region }
    )
  },
  async remove(ctx, id, region) {
    await awsJson(ctx, 'DeleteCertificate', { CertificateArn: id }, { region })
  }
}

export const acmDefs: AwsTypeDef[] = [acmCertificateDef]
