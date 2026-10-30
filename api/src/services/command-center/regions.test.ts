import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/index.js', () => ({ db: {} }))

import { normalizeCcConfig } from './config.js'
import {
  detectFromMetadata,
  type MetaRelation,
  type PlacementMeta,
  regionPathFor
} from './regions.js'

/** A tenant shaped like the EFP data model, but every name is just data here. */
const efpLike: PlacementMeta = {
  collections: [
    { collection: 'sites', display_name: 'Sites', display_template: '{{name}}' },
    { collection: 'territories', display_name: null, display_template: '{{short_name}}' },
    { collection: 'site_territories', display_name: null, display_template: null },
    { collection: 'cost_centres', display_name: 'Cost centres', display_template: null },
    { collection: 'tickets', display_name: 'Tickets', display_template: null },
    { collection: 'nivaro_users', display_name: null, display_template: null }
  ],
  fields: [
    { collection: 'sites', field: 'id', type: 'integer' },
    { collection: 'sites', field: 'name', type: 'string' },
    { collection: 'sites', field: 'latitude', type: 'decimal' },
    { collection: 'sites', field: 'longitude', type: 'decimal' },
    { collection: 'sites', field: 'cost_centre', type: 'integer' },
    { collection: 'territories', field: 'id', type: 'integer' },
    { collection: 'territories', field: 'short_name', type: 'string' },
    { collection: 'cost_centres', field: 'code', type: 'string' },
    { collection: 'tickets', field: 'site', type: 'integer' },
    // System collections never count as geo, even with the field names.
    { collection: 'nivaro_users', field: 'office_lat', type: 'float' },
    { collection: 'nivaro_users', field: 'office_lng', type: 'float' }
  ],
  relations: [
    {
      many_collection: 'site_territories',
      many_field: 'site',
      one_collection: 'sites',
      junction_field: 'territory'
    },
    {
      many_collection: 'site_territories',
      many_field: 'territory',
      one_collection: 'territories',
      junction_field: 'site'
    },
    {
      many_collection: 'sites',
      many_field: 'cost_centre',
      one_collection: 'cost_centres',
      junction_field: null
    },
    {
      many_collection: 'tickets',
      many_field: 'site',
      one_collection: 'sites',
      junction_field: null
    }
  ],
  dimensions: [
    {
      name: 'territory',
      label: 'Territory',
      target_collection: 'territories',
      display_field: 'short_name',
      is_active: true
    }
  ]
}

describe('detectFromMetadata', () => {
  it('finds geo collections by a latitude/longitude pair and skips system tables', () => {
    const d = detectFromMetadata(efpLike)
    expect(d.geo.map((g) => g.key)).toEqual(['sites'])
    expect(d.geo[0]).toMatchObject({
      lat_field: 'latitude',
      lng_field: 'longitude',
      label: 'Sites'
    })
  })

  it('prefers the region collection a scope dimension targets, through the junction', () => {
    const d = detectFromMetadata(efpLike)
    expect(d.suggested?.source).toEqual({
      collection: 'territories',
      label_field: 'short_name',
      via: {
        kind: 'junction',
        junction: 'site_territories',
        region_field: 'territory',
        item_field: 'site',
        item_collection: 'sites'
      },
      scope_dimension: 'territory'
    })
    // The M2O to cost centres is listed for admins but not suggested over it.
    expect(d.regions.map((r) => r.source.collection)).toContain('cost_centres')
    expect(d.regions[0].description).toMatch(/Territory/)
  })

  it('accepts prefixed pairs (site_lat / site_lng) and an M2O region with a place-like name', () => {
    const d = detectFromMetadata({
      collections: [
        { collection: 'stores', display_name: null, display_template: null },
        { collection: 'sales_zones', display_name: 'Sales zones', display_template: null }
      ],
      fields: [
        { collection: 'stores', field: 'site_lat', type: 'float' },
        { collection: 'stores', field: 'site_lng', type: 'float' },
        { collection: 'stores', field: 'zone', type: 'integer' },
        { collection: 'sales_zones', field: 'name', type: 'string' }
      ],
      relations: [
        {
          many_collection: 'stores',
          many_field: 'zone',
          one_collection: 'sales_zones',
          junction_field: null
        }
      ],
      dimensions: []
    })
    expect(d.geo[0]).toMatchObject({ key: 'stores', lat_field: 'site_lat', lng_field: 'site_lng' })
    expect(d.suggested?.source).toMatchObject({
      collection: 'sales_zones',
      label_field: 'name',
      via: { kind: 'field', item_collection: 'stores', field: 'zone' },
      scope_dimension: null
    })
  })

  it('suggests nothing when no candidate reads like a region', () => {
    const d = detectFromMetadata({
      ...efpLike,
      relations: efpLike.relations.filter((r) => r.many_collection !== 'site_territories'),
      dimensions: []
    })
    expect(d.suggested).toBeNull()
    expect(d.regions.length).toBeGreaterThan(0)
  })

  it('answers no geo for a tenant without latitude/longitude fields', () => {
    const d = detectFromMetadata({
      ...efpLike,
      fields: efpLike.fields.filter((f) => !/itude$/.test(f.field))
    })
    expect(d.geo).toEqual([])
    expect(d.suggested).toBeNull()
  })
})

describe('regionPathFor', () => {
  const source = detectFromMetadata(efpLike).suggested!.source
  const rels: MetaRelation[] = [
    ...efpLike.relations,
    {
      many_collection: 'orders',
      many_field: 'territory',
      one_collection: 'territories',
      junction_field: null
    },
    {
      many_collection: 'projects_territories',
      many_field: 'projects_id',
      one_collection: 'projects',
      junction_field: 'territories_id'
    },
    {
      many_collection: 'projects_territories',
      many_field: 'territories_id',
      one_collection: 'territories',
      junction_field: 'projects_id'
    }
  ]
  it('the region collection itself', () => {
    expect(regionPathFor('territories', source, rels)).toEqual({ kind: 'self' })
  })
  it('the geo collection', () => {
    expect(regionPathFor('sites', source, rels)).toEqual({ kind: 'geo' })
  })
  it('a direct M2O to the region', () => {
    expect(regionPathFor('orders', source, rels)).toEqual({ kind: 'm2o', field: 'territory' })
  })
  it('an M2M to the region', () => {
    expect(regionPathFor('projects', source, rels)).toEqual({
      kind: 'm2m',
      junction: 'projects_territories',
      item_field: 'projects_id',
      region_field: 'territories_id'
    })
  })
  it('a link to a geo record', () => {
    expect(regionPathFor('tickets', source, rels)).toEqual({ kind: 'via_geo', field: 'site' })
  })
  it('cannot place an unrelated collection', () => {
    expect(regionPathFor('invoices', source, rels)).toBeNull()
  })
})

describe('CcConfig normalisation round trip', () => {
  it('keeps every field through save → read', () => {
    const source = detectFromMetadata(efpLike).suggested!.source
    const cfg = normalizeCcConfig({
      geo_collections: ['sites', 'bad name!', 'sites'],
      region: source,
      stuck_days: 12,
      role_defaults: {}
    })
    expect(cfg.geo_collections).toEqual(['sites'])
    expect(normalizeCcConfig(JSON.stringify(cfg))).toEqual(cfg)
    expect(cfg.region).toEqual(source)
  })
  it('keeps "no regions" (false) and drops a malformed source to auto (null)', () => {
    expect(normalizeCcConfig({ region: false }).region).toBe(false)
    expect(
      normalizeCcConfig({ region: { collection: 'x', via: { kind: 'junction' } } }).region
    ).toBeNull()
    expect(normalizeCcConfig({ stuck_days: 0 }).stuck_days).toBe(7)
  })
})
