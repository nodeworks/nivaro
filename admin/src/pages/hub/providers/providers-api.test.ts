import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

// Hub providers (Task 3): the pure helpers the provider screens build their requests from, and
// the guard that every refusal the engine and store can answer has plain words here.

vi.mock('@/lib/api', () => ({
  api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), delete: vi.fn() }
}))

const {
  connectionBody,
  connectionValues,
  displayValue,
  fieldErrors,
  fieldLabel,
  isResumable,
  fieldsPayload,
  groupByProvider,
  healthTone,
  PROVIDER_CODE_COPY,
  providerError,
  providerKeys,
  resourceState,
  shortValue,
  usedBy,
  valuesOf
} = await import('./providers-api')
const { HUB_MASK } = await import('../hub-api')

type Fields = Parameters<typeof connectionBody>[0]
type Specs = Parameters<typeof fieldErrors>[0]

const connFields: Fields = [
  { key: 'org', label: 'Organisation', kind: 'string', required: true },
  { key: 'regions', label: 'Regions', kind: 'list' },
  { key: 'app_id', label: 'App id', kind: 'number' },
  { key: 'private_key', label: 'Private key', kind: 'text', secret: true },
  { key: 'webhook_secret', label: 'Webhook secret', kind: 'string', secret: true }
]

const resource = (over: Record<string, unknown> = {}) =>
  ({
    id: 1,
    connection_id: 2,
    provider: 'github',
    type: 'github.repository',
    external_id: 'R_1',
    name: 'web',
    scope: 'app',
    app_id: 4,
    environment_id: 5,
    desired: {},
    observed: { type: 'github.repository', externalId: 'R_1', name: 'web', fields: {}, tags: {} },
    drift: false,
    observed_at: '2026-11-26T10:00:00Z',
    tags: {},
    refs: [],
    created_by: null,
    adopted: false,
    deleted_at: null,
    created_at: null,
    updated_at: null,
    ...over
  }) as Parameters<typeof resourceState>[0]

describe('connection secrets', () => {
  it('a stored secret starts at the mask and an unset one empty', () => {
    const v = connectionValues(connFields, {
      config: { org: 'acme', regions: ['us-east-1'] },
      secret_keys: ['private_key']
    } as never)
    expect(v.private_key).toBe(HUB_MASK)
    expect(v.webhook_secret).toBe('')
    expect(v.org).toBe('acme')
  })

  it('sends only the secrets the person typed: mask = keep, cleared = remove', () => {
    const body = connectionBody(
      connFields,
      {
        org: 'acme',
        regions: ['us-east-1', ''],
        app_id: '42',
        private_key: HUB_MASK,
        webhook_secret: 'test-secret-new'
      },
      ['private_key']
    )
    expect(body.secrets).toEqual({ webhook_secret: 'test-secret-new' })
    expect(body.config).toEqual({ org: 'acme', regions: ['us-east-1'], app_id: 42 })
    expect(JSON.stringify(body.config)).not.toContain('secret')

    const cleared = connectionBody(connFields, { org: 'a', private_key: '' }, ['private_key'])
    expect(cleared.secrets).toEqual({ private_key: null })
    // Empty and never stored: nothing to send.
    expect(connectionBody(connFields, { org: 'a', webhook_secret: '' }, []).secrets).toEqual({})
  })
})

const specs: Specs = [
  { key: 'name', label: 'Name', kind: 'string', required: true, pattern: '[a-z][a-z0-9-]*' },
  { key: 'size', label: 'Size', kind: 'number', min: 1, max: 10 },
  { key: 'private', label: 'Private', kind: 'boolean' },
  { key: 'region', label: 'Region', kind: 'string', createOnly: true, required: true },
  { key: 'arn', label: 'ARN', kind: 'string', readOnly: true },
  { key: 'token', label: 'Token', kind: 'secret', required: true },
  { key: 'vpc', label: 'VPC', kind: 'ref', refType: 'aws.vpc' },
  {
    key: 'rules',
    label: 'Rules',
    kind: 'list',
    items: {
      key: 'rule',
      label: 'Rule',
      kind: 'object',
      fields: [{ key: 'port', label: 'Port', kind: 'number', required: true, min: 1, max: 65535 }]
    }
  }
]

describe('generic resource form', () => {
  it('checks required, ranges, patterns and nested items; skips read-only and locked', () => {
    const e = fieldErrors(
      specs,
      {
        name: 'Bad Name',
        size: '20',
        region: '',
        token: '',
        rules: [{ port: '' }, { port: '80' }]
      },
      'create'
    )
    expect(e).toEqual({
      name: 'Not in the right form',
      size: 'At most 10',
      region: 'Required',
      token: 'Required',
      'rules.0.port': 'Required'
    })
    // An update keeps the stored secret (mask) and cannot change a createOnly field.
    const u = fieldErrors(specs, { name: 'web', token: HUB_MASK, region: '' }, 'update')
    expect(u).toEqual({})
  })

  it('create sends every value; update sends only what changed; a secret only when typed', () => {
    const create = fieldsPayload(
      specs,
      {
        name: 'web',
        size: '3',
        private: true,
        region: 'eu-west-1',
        token: 'test-secret-1',
        vpc: { resourceId: 9 },
        rules: [{ port: '443' }],
        arn: 'x'
      },
      'create'
    )
    expect(create).toEqual({
      name: 'web',
      size: 3,
      private: true,
      region: 'eu-west-1',
      token: 'test-secret-1',
      vpc: { resourceId: 9 },
      rules: [{ port: 443 }]
    })

    const r = resource({
      desired: {
        name: 'web',
        size: 3,
        private: false,
        region: 'eu-west-1',
        token: { secret: true, fingerprint: 'abc' },
        vpc: { resourceId: 9 },
        rules: [{ port: 443 }]
      }
    })
    const initial = valuesOf(specs, r)
    expect(initial.token).toBe(HUB_MASK)
    expect(initial.size).toBe('3')
    expect(fieldsPayload(specs, initial, 'update', initial)).toEqual({})
    const edited = { ...initial, size: '4', region: 'us-east-1' }
    expect(fieldsPayload(specs, edited, 'update', initial)).toEqual({ size: 4 })
    expect(fieldsPayload(specs, { ...initial, token: 'test-secret-2' }, 'update', initial)).toEqual(
      { token: 'test-secret-2' }
    )
  })

  it("an adopted resource's provider ids never fill a ref picker", () => {
    const r = resource({
      desired: null,
      observed: {
        type: 'x',
        externalId: 'sg-1',
        name: null,
        fields: { vpc: 'vpc-123', name: 'sg' },
        tags: {}
      }
    })
    const v = valuesOf(specs, r)
    expect(v.vpc).toBeNull()
    expect(v.name).toBe('sg')
  })
})

describe('resource state', () => {
  it('gone beats drift beats in sync; never checked is its own state', () => {
    expect(resourceState(resource())).toBe('ok')
    expect(resourceState(resource({ drift: true }))).toBe('drift')
    expect(resourceState(resource({ drift: true, observed: null }))).toBe('gone')
    expect(resourceState(resource({ observed_at: null }))).toBe('unchecked')
  })

  it('maps provider lifecycle words to tones', () => {
    expect(healthTone('available')).toBe('ok')
    expect(healthTone('in_use')).toBe('ok')
    expect(healthTone('creating')).toBe('live')
    expect(healthTone('failed')).toBe('down')
    expect(healthTone('archived')).toBe('neutral')
    expect(healthTone(null)).toBe('neutral')
  })

  it('groups by provider label and counts who uses a shared resource', () => {
    const rows = [
      resource({ id: 1, provider: 'vercel', name: 'site' }),
      resource({ id: 2, provider: 'aws', name: 'b' }),
      resource({ id: 3, provider: 'aws', name: 'a', refs: [{ field: 'vpc', resourceId: 9 }] })
    ]
    const g = groupByProvider(rows, (p) => ({ aws: 'AWS', vercel: 'Vercel' })[p] ?? p)
    expect(g.map((x) => [x.label, x.rows.map((r) => r.name)])).toEqual([
      ['AWS', ['a', 'b']],
      ['Vercel', ['site']]
    ])
    expect(usedBy(9, rows).map((r) => r.id)).toEqual([3])
  })

  it('short values never print an object wholesale', () => {
    expect(shortValue(null)).toBe('—')
    expect(shortValue({ resourceId: 4 })).toBe('resource #4')
    expect(shortValue(['a', 'b'])).toBe('a, b')
    expect(shortValue('x'.repeat(100)).length).toBe(80)
  })
})

describe('query keys', () => {
  it('start with hub so live Hub updates refresh them', () => {
    const keys = [
      providerKeys.types(),
      providerKeys.connections(),
      providerKeys.appConnections(1),
      providerKeys.resources({}),
      providerKeys.changes({}),
      providerKeys.change(1),
      providerKeys.unmanaged(1, 't', null)
    ]
    for (const k of keys) expect(String(k[0]).startsWith('hub')).toBe(true)
  })
})

const ROOT = join(import.meta.dirname, '../../../../..')
const read = (f: string) => readFileSync(join(ROOT, f), 'utf8')

describe('every refusal has plain words', () => {
  it('each RESOURCE_CHANGE_CODES code of the engine contract', () => {
    const src = read('api/src/services/hub/providers/engine/contract.ts')
    const block = src.slice(
      src.indexOf('RESOURCE_CHANGE_CODES = {'),
      src.indexOf('} as const', src.indexOf('RESOURCE_CHANGE_CODES = {'))
    )
    const codes = [...block.matchAll(/^\s+([A-Z][A-Z0-9_]+):/gm)].map((m) => m[1] as string)
    expect(codes.length).toBeGreaterThan(20)
    expect(codes.filter((c) => !PROVIDER_CODE_COPY[c])).toEqual([])
  })

  it('each store refusal', () => {
    const src = read('api/src/services/hub/providers/store.ts')
    const union = src.slice(
      src.indexOf('export type HubProviderStoreCode'),
      src.indexOf('export class HubProviderStoreError')
    )
    const codes = [...union.matchAll(/'([A-Z][A-Z0-9_]+)'/g)].map((m) => m[1] as string)
    expect(codes.length).toBeGreaterThan(0)
    expect(codes.filter((c) => !PROVIDER_CODE_COPY[c])).toEqual([])
  })

  it('a field refusal reads as the server’s own sentences', () => {
    const d = providerError(
      {
        response: {
          status: 400,
          data: {
            code: 'INVALID_FIELDS',
            error: 'Organisation is required.',
            details: { problems: ['Organisation is required.'] }
          }
        }
      },
      'Could not save'
    )
    expect(d.title).toBe('Some fields need fixing')
    expect(d.hint).toBe('Organisation is required.')
  })

  it('a provider code reads as words, never the code', () => {
    const d = providerError(
      { response: { status: 409, data: { code: 'SHARED_IN_USE', error: 'x' } } },
      'Could not plan'
    )
    expect(d.title).toBe('Other resources still use this')
    expect(d.title).not.toContain('SHARED_IN_USE')
  })
})

describe('Task 3b words', () => {
  const specs = [
    { key: 'enable_dns_support', label: 'DNS resolution', kind: 'boolean' },
    {
      key: 'rules',
      label: 'Rules',
      kind: 'list',
      items: {
        key: 'item',
        label: 'Rule',
        kind: 'object',
        fields: [{ key: 'port', label: 'Port', kind: 'number' }]
      }
    },
    { key: 'tier', label: 'Tier', kind: 'enum', options: [{ value: 'gp3', label: 'General SSD' }] }
  ] as Specs

  it('names a change by its field labels, item paths included', () => {
    expect(fieldLabel(specs, 'enable_dns_support')).toBe('DNS resolution')
    expect(fieldLabel(specs, 'rules.0.port')).toBe('Rules 1 · Port')
    expect(fieldLabel(specs, 'some_key')).toBe('some key')
    expect(fieldLabel(undefined, 'cidr')).toBe('cidr')
  })

  it('says On / Off and choice labels', () => {
    expect(displayValue(specs[0] as Specs[0], true)).toBe('On')
    expect(displayValue(null, false)).toBe('Off')
    expect(displayValue(specs[2] as Specs[0], 'gp3')).toBe('General SSD')
    expect(displayValue(null, '10.0.0.0/16')).toBe('10.0.0.0/16')
  })

  it('resume only where the engine resumes', () => {
    const step = (retryable: boolean) => ({
      index: 0,
      status: 'failed' as const,
      resourceId: null,
      before: null,
      result: null,
      snapshot: null,
      error: { code: 'X', message: 'x', retryable },
      startedAt: null,
      finishedAt: null
    })
    expect(isResumable('interrupted', [])).toBe(true)
    expect(isResumable('failed', [step(true)])).toBe(true)
    expect(isResumable('failed', [step(false)])).toBe(false)
    expect(isResumable('applied', [])).toBe(false)
  })

  it('a create that never reached the provider is its own state', () => {
    expect(
      resourceState(
        resource({
          external_id: null,
          pending_create: { change_id: 1, status: 'failed', resumable: false }
        })
      )
    ).toBe('create_failed')
    expect(
      resourceState(
        resource({
          external_id: null,
          pending_create: { change_id: 1, status: 'applying', resumable: false }
        })
      )
    ).toBe('creating')
  })

  it('AUTH_FAILED says to check the keys, never to wait', () => {
    const d = providerError(
      { response: { status: 502, data: { code: 'AUTH_FAILED', error: 'x' } } },
      'f'
    )
    expect(d.hint).toMatch(/Check this connection’s keys/)
    expect(d.hint).not.toMatch(/minute/)
  })
})
