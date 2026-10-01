// api/src/test/unit/services/traffic-entities.test.ts
import { describe, expect, it } from 'vitest'
import {
  callerKeyFor,
  classifyRequest,
  entityKey,
  normalizePath,
  routeTemplate
} from '../../../services/traffic-entities.js'

const c = (method: string, path: string, extra: Record<string, unknown> = {}) =>
  classifyRequest({ method, path, ...extra })

describe('classifyRequest — items', () => {
  it('maps the collection routes by method', () => {
    expect(c('GET', '/api/items/workflows')).toEqual({
      lane: 'items',
      entity: 'workflows',
      kind: 'read',
      down: ['db']
    })
    expect(c('GET', '/api/items/workflows?limit=25&page=2')?.kind).toBe('read')
    expect(c('POST', '/api/items/workflows')?.kind).toBe('create')
    expect(c('POST', '/api/items/forecasts/bulk')?.kind).toBe('create')
    expect(c('PATCH', '/api/items/workflows/371407')?.kind).toBe('update')
    expect(c('DELETE', '/api/items/workflows/1')?.kind).toBe('delete')
    expect(c('POST', '/api/items/workflows/bulk-delete')?.kind).toBe('delete')
    expect(c('POST', '/api/items/workflows/aggregate')?.kind).toBe('read')
    expect(c('GET', '/api/items/workflows/HQ26-79667/resolve-paths')?.entity).toBe('workflows')
    expect(c('POST', '/api/items/workflows/371407/child-summary')?.kind).toBe('read')
    expect(c('POST', '/api/items/workflows/371407/duplicate')?.kind).toBe('update')
  })
  it('routes system collections to the system lane', () => {
    expect(c('GET', '/api/items/nivaro_notifications')?.lane).toBe('system')
    expect(c('GET', '/api/items/directus_users')?.lane).toBe('system')
  })
  it('maps pipeline transitions onto the record collection', () => {
    expect(c('POST', '/api/pipelines/instance/workflows/371407/transition')).toEqual({
      lane: 'items',
      entity: 'workflows',
      kind: 'update',
      down: ['db']
    })
    expect(c('GET', '/api/pipelines/instance/workflows/371407')?.kind).toBe('read')
  })
})

describe('classifyRequest — other lanes', () => {
  it('widgets, pages, queries, inbound, files', () => {
    expect(c('POST', '/api/widgets-internal/5/render')).toEqual({
      lane: 'widgets',
      entity: '5',
      kind: 'read',
      down: ['db']
    })
    expect(c('POST', '/api/widgets-internal/5/action')?.kind).toBe('update')
    expect(c('POST', '/api/pages/budget-overview/widget-data')).toEqual({
      lane: 'pages',
      entity: 'budget-overview',
      kind: 'read',
      down: ['db']
    })
    expect(c('GET', '/api/pages/forecasting')?.lane).toBe('pages')
    expect(c('POST', '/api/custom-queries/rpt-budget-health/execute')).toEqual({
      lane: 'queries',
      entity: 'rpt-budget-health',
      kind: 'read',
      down: ['db']
    })
    expect(c('POST', '/api/inbound/mwf-shipments')).toEqual({
      lane: 'inbound',
      entity: 'mwf-shipments',
      kind: 'update',
      down: ['db']
    })
    expect(c('POST', '/api/files/upload')).toEqual({
      lane: 'files',
      entity: 'upload',
      kind: 'create',
      down: ['store', 'db']
    })
    expect(c('POST', '/files')?.entity).toBe('upload')
    expect(c('GET', '/api/files/3f2a7c1e-1111-4222-8333-444455556666')?.entity).toBe('download')
    expect(c('GET', '/api/files/3f2a7c1e-1111-4222-8333-444455556666/meta')?.kind).toBe('read')
    expect(c('PATCH', '/api/files/3f2a7c1e-1111-4222-8333-444455556666')?.entity).toBe('metadata')
    expect(c('DELETE', '/api/files/3f2a7c1e-1111-4222-8333-444455556666')?.kind).toBe('delete')
  })
  it('extension routes win when an extension id is supplied', () => {
    expect(c('GET', '/api/efp/warehouses/integrations', { extensionId: 'efp-ops' })).toEqual({
      lane: 'extension',
      entity: 'efp-ops',
      kind: 'read',
      down: ['db']
    })
    expect(c('POST', '/api/efp/repairs/x/run', { extensionId: 'efp-ops' })?.kind).toBe('update')
  })
  it('everything else under /api is lane other keyed by its first segment', () => {
    expect(c('GET', '/api/notifications/count')).toEqual({
      lane: 'other',
      entity: 'notifications',
      kind: 'read',
      down: ['db']
    })
    expect(c('POST', '/api/queues/abc/claim')?.kind).toBe('create')
  })
})

describe('classifyRequest — graphql', () => {
  it('names the entity after the operation and the kind after the mutation prefix', () => {
    expect(c('POST', '/graphql', { graphqlOperation: 'workflows', graphqlKind: 'query' })).toEqual({
      lane: 'graphql',
      entity: 'workflows',
      kind: 'read',
      down: ['db']
    })
    expect(
      c('POST', '/api/graphql', {
        graphqlOperation: 'create_forecasts_items',
        graphqlKind: 'mutation'
      })?.kind
    ).toBe('create')
    expect(
      c('POST', '/graphql', {
        graphqlOperation: 'delete_workflows_files_items',
        graphqlKind: 'mutation'
      })?.kind
    ).toBe('delete')
    expect(
      c('POST', '/graphql', { graphqlOperation: 'update_workflows_item', graphqlKind: 'mutation' })
        ?.kind
    ).toBe('update')
  })
  it('graphql anonymous: an unnamed document is one shared entity', () => {
    expect(c('POST', '/graphql', { graphqlOperation: null })?.entity).toBe('anonymous')
    expect(c('POST', '/graphql', { graphqlOperation: 'bad name!' })?.entity).toBe('anonymous')
    expect(c('GET', '/graphql')).toBeNull()
    expect(c('GET', '/api/graphql')?.lane).toBe('other')
  })
  it('items rules win over an extension id (R29d)', () => {
    expect(c('GET', '/api/items/workflows', { extensionId: 'efp-ops' })?.lane).toBe('items')
  })
})

describe('classifyRequest — malformed paths and id segments', () => {
  it('malformed paths never throw and never mint an entity', () => {
    expect(c('GET', '')).toBeNull()
    expect(c('GET', '/admin')).toBeNull()
    expect(c('GET', '/api/health/detailed')).toBeNull()
    expect(c('GET', '/api/traffic-map/snapshot')).toBeNull()
    expect(c('GET', '/api/items/')).toEqual({
      lane: 'other',
      entity: 'items',
      kind: 'read',
      down: ['db']
    })
    expect(c('GET', '/api/items/%20x')?.lane).toBe('other')
    expect(c('GET', '//api//items//workflows')?.entity).toBe('workflows')
    const long = c('GET', `/api/${'z'.repeat(2000)}`)
    expect(long?.lane).toBe('other')
    expect((long?.entity.length ?? 999) <= 120).toBe(true)
    expect(c('get', '/api/items/workflows')?.kind).toBe('read')
  })
  it('id segments: a number, uuid or "new" is never an entity; a non-slug folds to other', () => {
    expect(c('GET', '/api/items/workflows/371407')?.entity).toBe('workflows')
    expect(c('POST', '/api/pages/371407/widget-data')?.lane).toBe('other')
    expect(c('POST', '/api/widgets-internal/abc/render')?.lane).toBe('other')
    expect(c('GET', '/api/pages/3f2a7c1e-1111-4222-8333-444455556666')?.lane).toBe('other')
    expect(c('POST', '/api/inbound/Bad Key')?.lane).toBe('other')
  })
})

describe('classifier fix round 1', () => {
  it('caps every entity at 120 chars', () => {
    expect((c('GET', `/api/items/${'a'.repeat(128)}`)?.entity ?? '').length).toBeLessThanOrEqual(
      120
    )
    expect(
      (c('GET', `/api/pipelines/instance/${'a'.repeat(128)}/1`)?.entity ?? '').length
    ).toBeLessThanOrEqual(120)
    const w = c('POST', `/api/widgets-internal/${'1'.repeat(200)}/render`)
    expect(w?.lane).toBe('other')
    expect((w?.entity ?? '').length).toBeLessThanOrEqual(120)
  })
  it('async bulk poll is a read; POST bulk is create', () => {
    expect(c('GET', '/api/items/forecasts/bulk/abc123')?.kind).toBe('read')
    expect(c('POST', '/api/items/forecasts/bulk')?.kind).toBe('create')
  })
  it('sys prefix is system; non-NAME collection with sub-path is other/items', () => {
    expect(c('GET', '/api/items/sysdiagrams')?.lane).toBe('system')
    expect(c('GET', '/api/items/Bad-Name/12/resolve-paths')).toEqual({
      lane: 'other',
      entity: 'items',
      kind: 'read',
      down: ['db']
    })
  })
})

describe('helpers', () => {
  it('normalizePath, entityKey, routeTemplate, callerKeyFor', () => {
    expect(normalizePath('/api/items/workflows/?x=1')).toBe('/api/items/workflows')
    expect(entityKey('items', 'workflows')).toBe('items/workflows')
    expect(routeTemplate('PATCH', '/api/items/workflows/371407')).toBe(
      'PATCH /api/items/workflows/:id'
    )
    expect(routeTemplate('GET', '/api/files/3f2a7c1e-1111-4222-8333-444455556666/meta')).toBe(
      'GET /api/files/:id/meta'
    )
    expect(routeTemplate('POST', '/graphql', 'workflows')).toBe('POST /graphql · workflows')
    expect(callerKeyFor({ authMethod: 'api_key', apiKeyId: 7 })).toBe('k7')
    expect(callerKeyFor({ authMethod: 'session', userId: 'ab12' })).toBe('uAB12')
    expect(callerKeyFor({ authMethod: 'key_sim', apiKeyId: 7, userId: 'ab12' })).toBe('uAB12')
    expect(callerKeyFor({ authMethod: 'masquerade', userId: 'x' })).toBe('uX')
    expect(callerKeyFor({})).toBe('anon')
    expect(callerKeyFor({ authMethod: null, userId: null })).toBe('anon')
  })
})
