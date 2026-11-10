import { describe, expect, it, vi } from 'vitest'

vi.mock('../db/index.js', () => ({ db: vi.fn() }))
vi.mock('./items.js', () => ({ readItems: vi.fn(), readOne: vi.fn() }))
vi.mock('./collections.js', () => ({
  getCollection: vi.fn(),
  getFields: vi.fn(),
  getRelations: vi.fn()
}))
vi.mock('./global-search.js', () => ({ labelFor: vi.fn() }))

import type { CMSRelation } from '../types.js'
import { linkPlans } from './search-linked.js'

const rel = (r: Partial<CMSRelation>) => r as CMSRelation

// EFP shape: workflows ↔ purchase_orders through workflow_purchase_orders_junction,
// invoices.purchase_order → purchase_orders, purchase_orders.project/vendor → projects/vendors.
const RELS = [
  rel({
    many_collection: 'workflow_purchase_orders_junction',
    many_field: 'purchase_order',
    one_collection: 'purchase_orders',
    junction_field: 'workflow'
  }),
  rel({
    many_collection: 'workflow_purchase_orders_junction',
    many_field: 'workflow',
    one_collection: 'workflows',
    one_field: 'purchase_orders',
    junction_field: 'purchase_order'
  }),
  rel({
    many_collection: 'invoices',
    many_field: 'purchase_order',
    one_collection: 'purchase_orders'
  }),
  rel({ many_collection: 'purchase_orders', many_field: 'project', one_collection: 'projects' }),
  rel({ many_collection: 'purchase_orders', many_field: 'vendor', one_collection: 'vendors' }),
  rel({
    many_collection: 'purchase_orders',
    many_field: 'creator',
    one_collection: 'nivaro_users'
  }),
  rel({ many_collection: 'nivaro_activity', many_field: 'item', one_collection: 'purchase_orders' })
]

describe('linkPlans', () => {
  it('a PO lists its workflows (through the junction), its invoices, then what it points at', () => {
    const plans = linkPlans('purchase_orders', RELS)
    expect(plans.map((p) => `${p.kind}:${p.target}`)).toEqual([
      'm2m:workflows',
      'o2m:invoices',
      'm2o:projects',
      'm2o:vendors'
    ])
    expect(plans[0]).toMatchObject({
      junction: 'workflow_purchase_orders_junction',
      field: 'purchase_order',
      farField: 'workflow'
    })
  })

  it('never lists the junction itself or a system table', () => {
    const targets = linkPlans('purchase_orders', RELS).map((p) => p.target)
    expect(targets).not.toContain('workflow_purchase_orders_junction')
    expect(targets).not.toContain('nivaro_users')
    expect(targets).not.toContain('nivaro_activity')
  })

  it('a workflow lists its POs through the same junction from the other side', () => {
    const plans = linkPlans('workflows', RELS)
    expect(plans.map((p) => `${p.kind}:${p.target}`)).toEqual(['m2m:purchase_orders'])
    expect(plans[0]).toMatchObject({ field: 'workflow', farField: 'purchase_order' })
  })

  it('two FKs to one collection stay two groups', () => {
    const plans = linkPlans('locations', [
      rel({
        many_collection: 'workflows',
        many_field: 'billing_location',
        one_collection: 'locations'
      }),
      rel({
        many_collection: 'workflows',
        many_field: 'shipping_location',
        one_collection: 'locations'
      })
    ])
    expect(plans.map((p) => p.field)).toEqual(['billing_location', 'shipping_location'])
  })
})
