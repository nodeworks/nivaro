import { describe, expect, it } from 'vitest'
import { type M2MAliasInfo, prefillAliasLinks, templateLinks } from './ItemEditForm'
import type { CMSRelation } from './item-edit/types'

// inventory_request.internal_contact ("Ship-To Contact"): an M2A alias through
// inventory_request_internal_contact.item (users or additional emails).
const rel = (r: Partial<CMSRelation>) => r as CMSRelation
const relations: CMSRelation[] = [
  rel({
    id: 440,
    many_collection: 'inventory_request_internal_contact',
    many_field: 'inventory_request_id',
    one_collection: 'inventory_request',
    one_field: 'internal_contact',
    junction_field: 'item'
  }),
  rel({
    id: 439,
    many_collection: 'inventory_request_internal_contact',
    many_field: 'item',
    one_collection: null,
    one_field: null,
    one_collection_field: 'collection',
    one_allowed_collections: ['additional_emails', 'directus_users'] as never,
    junction_field: null
  }),
  // An O2M alias (no junction) — never staged as links.
  rel({
    id: 500,
    many_collection: 'inventory_request_items',
    many_field: 'inventory_request',
    one_collection: 'inventory_request',
    one_field: 'items',
    junction_field: null
  }),
  rel({
    id: 501,
    many_collection: 'inventory_request_items',
    many_field: 'unit',
    one_collection: 'units',
    junction_field: null
  })
]

describe('prefill names an M2M/M2A alias as a plain value', () => {
  it('stages an M2A contact given as an id array', () => {
    expect(
      prefillAliasLinks({ internal_contact: ['U-1'], name: 'x' }, relations, 'inventory_request')
    ).toEqual([{ field: 'internal_contact', stagingKey: 'internal_contact', ids: ['U-1'] }])
  })

  it('takes one id, or {id}/{item} objects', () => {
    expect(prefillAliasLinks({ internal_contact: 'U-1' }, relations, 'inventory_request')).toEqual([
      { field: 'internal_contact', stagingKey: 'internal_contact', ids: ['U-1'] }
    ])
    expect(
      prefillAliasLinks(
        { internal_contact: [{ id: 'U-1' }, { item: 'U-2', collection: 'directus_users' }] },
        relations,
        'inventory_request'
      )[0].ids
    ).toEqual(['U-1', 'U-2'])
  })

  it('leaves plain fields, O2M aliases and __links alone', () => {
    expect(
      prefillAliasLinks(
        { name: 'x', items: [{ unit: 1 }], __links: { internal_contact: ['U-1'] } },
        relations,
        'inventory_request'
      )
    ).toEqual([])
  })
})

describe('save as template keeps M2M/M2A links', () => {
  const aliases = new Map<string, M2MAliasInfo>([
    [
      'internal_contact',
      {
        manyCollection: 'inventory_request_internal_contact',
        manyField: 'inventory_request_id',
        junctionField: 'item',
        stagingKey: 'internal_contact'
      }
    ]
  ])
  it('harvests the effective links as __links', () => {
    expect(
      templateLinks(
        [{ field: 'internal_contact' }],
        aliases,
        { internal_contact: { known: true, ids: ['U-1'] } },
        relations
      )
    ).toEqual({ internal_contact: ['U-1'] })
  })
  it('skips hidden, unknown or empty aliases', () => {
    expect(
      templateLinks(
        [{ field: 'internal_contact', hidden: true }],
        aliases,
        { internal_contact: { known: true, ids: ['U-1'] } },
        relations
      )
    ).toBeNull()
    expect(
      templateLinks(
        [{ field: 'internal_contact' }],
        aliases,
        { internal_contact: { known: false, ids: [] } },
        relations
      )
    ).toBeNull()
  })
})
