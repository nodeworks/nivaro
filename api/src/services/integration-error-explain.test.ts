import { afterEach, describe, expect, it } from 'vitest'
import {
  clearIntegrationErrorExplainers,
  explainIntegrationError,
  fixLinkFor,
  matchField,
  registerIntegrationErrorExplainers
} from './integration-error-explain.js'

const base = {
  partner: 'Fusion',
  apiId: 7,
  collection: 'purchase_orders',
  item: '4471',
  recordLabel: '4471',
  fields: [{ field: 'supplier_site' }, { field: 'po_number' }, { field: 'amount' }]
}

afterEach(() => clearIntegrationErrorExplainers())

describe('explainIntegrationError — core rules', () => {
  it('reads a 2xx whose body says ERROR as a rejection naming the record field', () => {
    const out = explainIntegrationError({
      ...base,
      httpStatus: 200,
      error: 'Supplier site missing',
      body: { status: 'ERROR', message: 'Supplier site missing' }
    })
    expect(out?.cause).toBe('body_rejection')
    expect(out?.sentence).toBe(
      'Fusion answered OK (HTTP 200) but rejected Purchase order 4471 inside its reply: Supplier site missing'
    )
    expect(out?.field).toBe('supplier_site')
    expect(out?.fix).toEqual({
      kind: 'record',
      collection: 'purchase_orders',
      item: '4471',
      field: 'supplier_site'
    })
    expect(out?.fix_link).toBe('/collections/purchase_orders/4471?focus=supplier_site')
  })

  it('a 2xx with an OK body and no error is not a failure', () => {
    expect(explainIntegrationError({ ...base, httpStatus: 200, body: { status: 'OK' } })).toBeNull()
  })

  it('a 2xx body with success:false is a rejection even without stored error text', () => {
    const out = explainIntegrationError({
      ...base,
      httpStatus: 201,
      body: { success: false, errors: [{ field: 'PoNumber', message: 'already used' }] }
    })
    expect(out?.cause).toBe('body_rejection')
    expect(out?.field).toBe('po_number')
  })

  it('401 / 403 → the external API credentials', () => {
    const a = explainIntegrationError({ ...base, httpStatus: 401, error: 'HTTP 401: {}' })
    expect(a?.cause).toBe('credentials')
    expect(a?.fix).toEqual({ kind: 'external_api', id: 7, section: 'auth' })
    expect(a?.fix_link).toBe('/external-apis/7')
    const b = explainIntegrationError({ ...base, error: 'HTTP 403: {"message":"Forbidden"}' })
    expect(b?.cause).toBe('credentials')
    expect(b?.sentence).toContain('not allowed')
  })

  it('404 → the endpoint path', () => {
    const out = explainIntegrationError({ ...base, httpStatus: 404, endpoint: '/fscm/po' })
    expect(out?.cause).toBe('not_found')
    expect(out?.sentence).toContain('/fscm/po')
    expect(out?.fix).toEqual({ kind: 'external_api', id: 7, section: 'endpoints' })
  })

  it('422 with a field name in the message → that field on the record', () => {
    const out = explainIntegrationError({
      ...base,
      error: 'HTTP 422: {"detail":"Supplier Site is required"}'
    })
    expect(out?.cause).toBe('validation')
    expect(out?.sentence).toBe('Fusion rejected Purchase order 4471: Supplier Site is required')
    expect(out?.fix_label).toBe('Fix Supplier Site on the record')
  })

  it('timeouts and unreachable hosts', () => {
    expect(
      explainIntegrationError({ ...base, error: 'The operation was aborted due to timeout' })?.cause
    ).toBe('timeout')
    const u = explainIntegrationError({
      ...base,
      error: 'fetch failed (Error: connect ECONNREFUSED)'
    })
    expect(u?.cause).toBe('unreachable')
    expect(u?.sentence).toBe('Could not reach Fusion: it refused the connection.')
  })

  it('429 and 5xx', () => {
    expect(explainIntegrationError({ ...base, httpStatus: 429 })?.cause).toBe('rate_limited')
    const d = explainIntegrationError({ ...base, httpStatus: 503 })
    expect(d?.cause).toBe('partner_down')
    expect(d?.fix_link).toBe('/integration-health?tab=partners')
  })

  it('masks token-shaped text the partner echoed', () => {
    const out = explainIntegrationError({
      ...base,
      httpStatus: 400,
      body: { message: 'bad token Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD' }
    })
    expect(out?.sentence).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })
})

describe('extension rules', () => {
  it('a partner rule answers before the core rules, only for its partner', () => {
    registerIntegrationErrorExplainers(
      [
        {
          id: 'supplier-site',
          partner: 'fusion',
          match: (_i, f) =>
            /supplier site/.test(f.text)
              ? {
                  sentence: `Fusion rejected PO ${_i.recordLabel}: supplier site missing`,
                  cause: 'validation'
                }
              : null
        }
      ],
      'efp-ops'
    )
    const hit = explainIntegrationError({
      ...base,
      httpStatus: 400,
      error: 'Supplier site missing'
    })
    expect(hit?.sentence).toBe('Fusion rejected PO 4471: supplier site missing')
    expect(hit?.rule).toBe('ext:efp-ops:supplier-site')
    const other = explainIntegrationError({
      ...base,
      partner: 'MWF',
      httpStatus: 400,
      error: 'Supplier site missing'
    })
    expect(other?.rule).toBe('core:validation')
  })

  it('a rule that throws is skipped', () => {
    registerIntegrationErrorExplainers([
      {
        id: 'boom',
        match: () => {
          throw new Error('x')
        }
      }
    ])
    expect(explainIntegrationError({ ...base, httpStatus: 500 })?.rule).toBe('core:partner-down')
  })
})

describe('helpers', () => {
  it('matchField prefers the longest name and ignores short ones', () => {
    expect(
      matchField(
        'Supplier site number invalid',
        [],
        [{ field: 'supplier_site' }, { field: 'supplier_site_number' }, { field: 'id' }]
      )?.field
    ).toBe('supplier_site_number')
    expect(matchField('id is bad', [], [{ field: 'id' }])).toBeNull()
  })

  it('fixLinkFor payload templates', () => {
    expect(fixLinkFor({ kind: 'payload_template', api_id: 3, key: 'po.create' })).toBe(
      '/external-apis/3/payloads/po.create'
    )
  })
})
