import { describe, expect, it } from 'vitest'
import { HUB_MASK } from '../hub-api'
import type { ProviderTypes } from '../providers/providers-api'
import { type PartDraft, partProblems, partsPayload, partTypeInfo } from './ProviderParts'

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
