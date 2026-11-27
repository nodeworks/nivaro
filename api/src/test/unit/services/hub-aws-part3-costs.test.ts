import { describe, expect, it, vi } from 'vitest'

// Hub providers Task 30: estimates of the ECR, SES and Secrets Manager types against recorded
// Price List answers. Nothing reaches real AWS.

vi.mock('../../../services/hub/providers/pricing/cache.js', () => ({
  PRICE_CACHE_MS: 7 * 24 * 3600 * 1000,
  readCachedPrice: vi.fn(async () => null),
  writeCachedPrice: vi.fn(async () => undefined)
}))

const { awsProvider } = await import('../../../services/hub/providers/aws/adapter.js')
const P = await import('../../../services/hub/providers/aws/pricing-part3.js')
const registry = await import('../../../services/hub/providers/registry.js')
const { CORE_PROVIDERS } = await import('../../../services/hub/providers/index.js')
const { missingEstimates } = await import('../../../services/hub/providers/pricing/index.js')
const H = await import('./hub-aws-harness.js')

registry.resetProvidersForTest()
registry.registerProvider(awsProvider)

const answers =
  (over: Record<string, string> = {}) =>
  (call: { body: string }) => {
    const body = JSON.parse(call.body)
    const code = body.ServiceCode as string
    const family = (body.Filters ?? []).find(
      (f: { Field: string }) => f.Field === 'productFamily'
    )?.Value
    const place = (body.Filters ?? []).find(
      (f: { Field: string }) => f.Field === 'regionCode'
    )?.Value
    if (place && place !== 'us-east-1') return 'pricing-empty.json'
    const key = `${code}|${family}`
    if (key in over) return over[key]
    if (code === 'AmazonECR') return 'pricing-ecr-storage.json'
    if (code === 'AWSSecretsManager')
      return family === 'API Request' ? 'pricing-secret-api.json' : 'pricing-secret-month.json'
    if (code === 'AmazonSES') return 'pricing-ses-email.json'
    return 'pricing-empty.json'
  }

const h = (extra: Record<string, unknown> = {}) =>
  H.harness({ 'pricing:GetProducts': answers(), ...extra } as never)
const want = (type: string, fields: Record<string, unknown>) => H.desired(type, fields)

describe('estimate from recorded price answer (ECR, SES, Secrets Manager)', () => {
  it('ECR: storage is the measured image size at the listed GB-month price', async () => {
    const x = h({ 'ecr:DescribeImages': 'ecr-describe-images.json' })
    const e = await P.ecrRepositoryEstimate(
      x.ctx,
      null,
      H.observedOf({ type: 'aws.ecr_repository', externalId: 'shop/api' })
    )
    // 1 GiB + 2 GiB at 10 cents.
    expect(e).toMatchObject({ basis: 'usage', confidence: 'usage_varies', monthlyCents: 30 })
    expect(e.lines[0]).toMatchObject({
      qty: 3,
      unit: 'GB-month',
      unitCents: 10,
      source: 'measured'
    })
    expect(e.note).toMatch(/\$0\.10 per GB-month/)
  })

  it('ECR: a repository that is not made yet is the price and "plus usage", no lines', async () => {
    const e = await P.ecrRepositoryEstimate(
      h().ctx,
      want('aws.ecr_repository', { name: 'x' }),
      null
    )
    expect(e.lines).toEqual([])
    expect(e.monthlyCents).toBe(0)
    expect(e.note).toMatch(/Billed by use/)
    expect(e.priceAsOf).toBe('2026-11-20')
  })

  it('Secrets Manager: a secret-month line and the API price per 10,000 calls in the note', async () => {
    const e = await P.secretEstimate(h().ctx, want('aws.secret', { name: 'shop/db' }), null)
    expect(e).toMatchObject({ basis: 'usage', confidence: 'usage_varies', monthlyCents: 40 })
    expect(e.lines[0]).toMatchObject({ qty: 1, unit: 'secret-month', unitCents: 40 })
    expect(e.note).toMatch(/\$0\.05 per 10,000 API calls/)
  })

  it('Secrets Manager: a secret waiting for deletion costs nothing from now', async () => {
    const e = await P.secretEstimate(
      h().ctx,
      null,
      H.observedOf({ type: 'aws.secret', externalId: 'arn', status: 'pending_deletion' })
    )
    expect(e.monthlyCents).toBe(0)
  })

  it('SES: identity, set and IAM user are free; mail is the price per 1,000 emails', async () => {
    const e = await P.sesIdentityEstimate(
      h().ctx,
      want('aws.ses_identity', { domain: 'a.com' }),
      null
    )
    expect(e).toMatchObject({ basis: 'usage', monthlyCents: 0 })
    expect(e.note).toMatch(/\$0\.10 per 1,000 emails/)
    expect((await P.sesConfigurationSetEstimate()).basis).toBe('free')
    expect((await P.sesSmtpUserEstimate()).basis).toBe('free')
  })

  it('falls back to the dated bundled table when AWS lists no price, and never throws', async () => {
    const dead = H.harness({
      'pricing:GetProducts': { status: 403, file: 'pricing-error-denied.json' }
    } as never)
    const e = await P.secretEstimate(dead.ctx, want('aws.secret', { name: 's' }), null)
    expect(e.monthlyCents).toBe(40)
    expect(e.note).toMatch(/bundled list of 2026-11-26/)
    const noRegion = await P.secretEstimate(
      H.harness({ 'pricing:GetProducts': answers() } as never, { region: null }).ctx,
      null,
      null
    )
    expect(noRegion.confidence).toBe('unknown')
    const eu = H.harness({ 'pricing:GetProducts': 'pricing-empty.json' } as never, {
      region: 'eu-west-1'
    })
    expect(
      (await P.secretEstimate(eu.ctx, want('aws.secret', { region: 'eu-west-1', name: 's' }), null))
        .confidence
    ).toBe('unknown')
  })

  it('every type of the three adapters is estimated (the guard sees no gap)', () => {
    expect(missingEstimates(CORE_PROVIDERS)).toEqual([])
    for (const k of [
      'aws.ecr_repository',
      'aws.ecr_lifecycle_policy',
      'aws.ses_identity',
      'aws.ses_configuration_set',
      'aws.ses_smtp_user',
      'aws.secret'
    ])
      expect(awsProvider.types.find((t) => t.key === k)?.estimate, k).toBeTypeOf('function')
  })
})
