import { describe, expect, it, vi } from 'vitest'

vi.mock('../../../db/index.js', () => ({ db: Object.assign(vi.fn(), { raw: vi.fn() }) }))

import {
  collectRiskValues,
  filterNamesOrigin,
  parseOriginFilter,
  translateVirtualKeys
} from '../../../services/virtual-filters.js'

const NOW = new Date('2026-09-27T12:00:00Z')

describe('parseOriginFilter', () => {
  it('reads a bare name, a list and a comma list as "a write of these exists"', () => {
    expect(parseOriginFilter('integration')).toMatchObject({
      include: true,
      origins: ['integration']
    })
    expect(parseOriginFilter(['import', 'integration'])?.origins).toEqual(['import', 'integration'])
    expect(parseOriginFilter('import, machine')?.origins).toEqual(['import', 'machine'])
  })

  it('reads operators from the value and from the condition', () => {
    expect(parseOriginFilter({ _nin: ['person'] })).toMatchObject({
      include: false,
      origins: ['person']
    })
    expect(parseOriginFilter(['person'], '_nin')?.include).toBe(false)
    expect(parseOriginFilter({ _nin: ['person'] }, '_in')?.include).toBe(true)
  })

  it('narrows by window, account and kind of write', () => {
    const f = parseOriginFilter(
      {
        _in: ['integration'],
        days: 7,
        by: '7A0411F3-C687-40E5-ADF5-614157CF88EC',
        action: ['update', 'drop']
      },
      undefined,
      NOW
    )
    expect(f?.since?.toISOString()).toBe('2026-09-20T12:00:00.000Z')
    expect(f?.by).toBe('7A0411F3-C687-40E5-ADF5-614157CF88EC')
    expect(f?.actions).toEqual(['update'])
    expect(parseOriginFilter({ _in: ['import'], since: '2026-09-21' })?.since?.toISOString()).toBe(
      '2026-09-21T00:00:00.000Z'
    )
  })

  it('answers null when nothing usable is named, so the caller narrows to nothing', () => {
    expect(parseOriginFilter('robot')).toBeNull()
    expect(parseOriginFilter({})).toBeNull()
    expect(parseOriginFilter(null)).toBeNull()
    expect(parseOriginFilter(['person'], '_contains')).toBeNull()
    expect(parseOriginFilter({ _in: ['person'], by: 'not-a-uuid' })?.by).toBeNull()
  })
})

describe('translateVirtualKeys', () => {
  it('renames the GraphQL spellings at every depth and leaves the rest', () => {
    expect(
      translateVirtualKeys({
        _state: { _in: ['started'] },
        name: { _contains: 'x' },
        _or: [{ _origin: { _nin: ['person'] } }, { lines: { _some: { _addendums: 'active' } } }],
        tags: { _some: { name: { _eq: 'a' }, _link: { _state: { _eq: 1 } } } }
      })
    ).toEqual({
      $state: { _in: ['started'] },
      name: { _contains: 'x' },
      _or: [{ $origin: { _nin: ['person'] } }, { lines: { _some: { $addendums: 'active' } } }],
      tags: { _some: { name: { _eq: 'a' }, _link: { _state: { _eq: 1 } } } }
    })
    expect(translateVirtualKeys(undefined)).toBeUndefined()
  })

  it('does not look inside a virtual filter for field names', () => {
    expect(translateVirtualKeys({ _origin: { _in: ['import'], days: 3 } })).toEqual({
      $origin: { _in: ['import'], days: 3 }
    })
  })
})

describe('priming walkers', () => {
  it('find highlight-rule values and origin filters at any depth', () => {
    const f = {
      _and: [{ $at_risk: [3, 4] }, { lines: { _some: { $at_risk: 'any' } } }],
      $origin: { _in: ['import'] }
    }
    expect(collectRiskValues(f)).toEqual([[3, 4], 'any'])
    expect(filterNamesOrigin(f)).toBe(true)
    expect(filterNamesOrigin({ name: { _eq: 'x' } })).toBe(false)
  })
})
