import { describe, expect, it } from 'vitest'
import { validateReviewListConfig } from '../../../services/review-list.js'

const base = {
  host_collection: 'invoices',
  collection: 'invoices',
  group_by: 'invoice_id',
  status: {
    field: 'efp_review_status',
    options: [{ value: 'approved', label: 'Approve', color: 'green' }]
  }
}

describe('review_list sibling mode', () => {
  it('accepts sibling_field with an empty path on the host collection', () => {
    expect(
      validateReviewListConfig({ ...base, path: [], sibling_field: 'invoice_id' }, [])
    ).toBeNull()
  })
  it('rejects sibling mode across collections or combined with a path', () => {
    expect(
      validateReviewListConfig(
        { ...base, host_collection: 'workflows', path: [], sibling_field: 'invoice_id' },
        []
      )
    ).toMatch(/host_collection/)
    expect(
      validateReviewListConfig(
        { ...base, path: [{ kind: 'm2o', field: 'purchase_order' }], sibling_field: 'invoice_id' },
        []
      )
    ).toMatch(/mutually exclusive/)
    expect(validateReviewListConfig({ ...base, path: [], sibling_field: 'bad field' }, [])).toMatch(
      /identifier/
    )
  })
  it('still requires a path without sibling_field', () => {
    expect(validateReviewListConfig({ ...base, path: [] }, [])).toMatch(/path must be/)
  })
  it('validates enrich_endpoint as an API path', () => {
    expect(
      validateReviewListConfig(
        { ...base, path: [], sibling_field: 'invoice_id', enrich_endpoint: 'https://x' },
        []
      )
    ).toMatch(/enrich_endpoint/)
    expect(
      validateReviewListConfig(
        {
          ...base,
          path: [],
          sibling_field: 'invoice_id',
          enrich_endpoint: '/efp/invoice-approvals/enrich'
        },
        []
      )
    ).toBeNull()
  })
})
