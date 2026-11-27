import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HUB_MASK } from '../hub-api'
import type { ProviderTypes } from '../providers/providers-api'
import {
  envPartsProblem,
  PART_TYPES,
  type PartDraft,
  partProblems,
  partsPayload,
  partTypeInfo,
  signinRule
} from './ProviderParts'

// Task 11: Create app's per-environment provider parts — what the request carries.

const types = {
  risk_flags: [],
  providers: [
    {
      key: 'auth0',
      label: 'Auth0',
      connection: { fields: [] },
      types: [
        {
          key: 'auth0.application',
          label: 'Application',
          scope: 'app',
          fields: [
            { key: 'name', label: 'Name', kind: 'string', required: true },
            { key: 'callbacks', label: 'Callbacks', kind: 'list', items: { kind: 'string' } }
          ],
          capabilities: {},
          reversible: true,
          refs: [],
          name_field: 'name',
          has_cost_class: false
        }
      ]
    },
    {
      key: 'aws',
      label: 'AWS',
      connection: { fields: [] },
      types: [
        {
          key: 'aws.rds_instance',
          label: 'RDS instance',
          scope: 'app',
          fields: [
            { key: 'name', label: 'Name', kind: 'string', required: true },
            { key: 'master_password', label: 'Password', kind: 'secret', required: true }
          ],
          capabilities: {},
          reversible: false,
          refs: [],
          name_field: 'name',
          has_cost_class: true
        }
      ]
    }
  ]
} as unknown as ProviderTypes

const part = (over: Partial<PartDraft>): PartDraft => ({
  uid: 'p',
  type: 'auth0.application',
  connectionId: 3,
  values: {},
  ...over
})

describe('provider parts', () => {
  it('leaves empty values out so Auth0 takes the environment’s addresses', () => {
    expect(
      partsPayload([part({ values: { name: 'shop-staging', callbacks: [] } })], types)
    ).toEqual([{ connection_id: 3, type: 'auth0.application', fields: { name: 'shop-staging' } }])
  })

  it('a preview carries the mask, never the secret; create carries the value once', () => {
    const p = part({
      type: 'aws.rds_instance',
      values: { name: 'shop-db', master_password: 'test-secret-rds-0000' }
    })
    expect(partsPayload([p], types, { mask: true })[0].fields.master_password).toBe(HUB_MASK)
    expect(partsPayload([p], types)[0].fields.master_password).toBe('test-secret-rds-0000')
  })

  it('a part without a type or connection is not sent and says why', () => {
    expect(partsPayload([part({ type: '' }), part({ connectionId: null })], types)).toEqual([])
    expect(partProblems(part({ type: '' }), null)['']).toMatch(/what to make/)
    expect(partProblems(part({ connectionId: null }), null)['']).toMatch(/connection/)
    const info = partTypeInfo(types, 'auth0.application')
    expect(partProblems(part({ values: { name: '' } }), info).name).toBeTruthy()
  })
})

const API = join(import.meta.dirname, '../../../../../api/src/services/hub/create')

describe('Task 33 parts (Entra, managed Redis, Sentry, Anthropic)', () => {
  it('offers every part type the API accepts', () => {
    const src = readFileSync(join(API, 'provider-parts.ts'), 'utf8')
    const block = src.slice(
      src.indexOf('CREATE_PROVIDER_TYPES = ['),
      src.indexOf('] as const', src.indexOf('CREATE_PROVIDER_TYPES = ['))
    )
    const api = [...block.matchAll(/'([a-z0-9-]+\.[a-z0-9_]+)'/g)].map((m) => m[1])
    expect(api.length).toBeGreaterThanOrEqual(9)
    expect([...PART_TYPES].sort()).toEqual([...api].sort())
  })

  it('refuses together what the API refuses, in its words', () => {
    const docker = { kind: 'docker', stackRedis: 'external' }
    const e = (type: PartDraft['type']) => ({ type })
    expect(envPartsProblem([e('entra.app_registration')], docker)).toBeNull()
    expect(
      envPartsProblem([e('entra.app_registration')], { kind: 'gitlab', stackRedis: null })
    ).toMatch(/Docker driver/)
    expect(
      envPartsProblem([e('entra.app_registration'), e('entra.app_registration')], docker)
    ).toBe('One Entra app registration per environment.')
    expect(envPartsProblem([e('upstash.redis_database'), e('redis-cloud.database')], docker)).toBe(
      'One managed Redis per environment.'
    )
    expect(
      envPartsProblem([e('upstash.redis_database')], { kind: 'docker', stackRedis: 'bundled' })
    ).toMatch(/Redis set to external/)
    // Sentry and Anthropic are not stack-bound: any kind.
    expect(
      envPartsProblem([e('sentry.project'), e('anthropic.workspace')], {
        kind: 'github',
        stackRedis: null
      })
    ).toBeNull()
    // The texts are the API's own (a drift fails here).
    const src = readFileSync(join(API, 'provider-parts.ts'), 'utf8')
    for (const t of [
      'One Entra app registration per environment.',
      'One managed Redis per environment.',
      'A managed Redis needs the stack’s Redis set to external (the Hub fills REDIS_URL).'
    ])
      expect(src).toContain(t)
  })

  it('sign-in is optional only when every Docker environment makes an Entra registration', () => {
    const entra = part({ type: 'entra.app_registration', connectionId: 5 })
    const none = { issuer: '', clientId: '', clientSecret: '' }
    expect(signinRule({ kind: 'docker', envParts: [[entra], [entra]], ...none })).toMatchObject({
      entraEnvs: 2,
      entraEverywhere: true,
      omitSignin: true
    })
    // One environment without: sign-in is needed (BAD_SIGNIN otherwise).
    expect(signinRule({ kind: 'docker', envParts: [[entra], []], ...none })).toMatchObject({
      entraEnvs: 1,
      entraEverywhere: false,
      omitSignin: false
    })
    // A part with no connection is not sent, so it does not count.
    expect(
      signinRule({
        kind: 'docker',
        envParts: [[part({ type: 'entra.app_registration', connectionId: null })]],
        ...none
      }).omitSignin
    ).toBe(false)
    // Not Docker: Entra parts are refused there, sign-in stays required.
    expect(signinRule({ kind: 'gitlab', envParts: [[entra]], ...none }).omitSignin).toBe(false)
    // Something typed is always sent (and checked in full).
    expect(
      signinRule({ kind: 'docker', envParts: [[entra]], ...none, clientId: 'abc' }).omitSignin
    ).toBe(false)
    expect(signinRule({ kind: 'shared', envParts: [[]], ...none }).omitSignin).toBe(true)
  })
})
