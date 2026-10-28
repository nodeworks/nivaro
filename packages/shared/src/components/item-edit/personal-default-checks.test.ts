import { describe, expect, it, vi } from 'vitest'
import { makePersonalDefaultChecks } from './personal-default-checks'
import type { CMSField, CMSRelation } from './types'

function f(name: string, over: Partial<CMSField> = {}): CMSField {
  return {
    field: name,
    type: 'string',
    interface: 'input',
    label: name,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: null,
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    ...over
  }
}
function rel(id: number, over: Partial<CMSRelation>): CMSRelation {
  return {
    id,
    one_collection: null,
    one_field: null,
    many_collection: null,
    many_field: null,
    junction_field: null,
    ...over
  }
}

const FIELDS = [
  f('region', { interface: 'select-dropdown-m2o' }),
  f('ship_to', {
    interface: 'select-dropdown-m2o',
    options: { option_filter: { active: { _eq: true } } },
    dependency_config: { cascade_filters: [{ parent_field: 'region', filter_column: 'region' }] }
  }),
  f('tags', { interface: 'list-m2m' }),
  f('status', {
    interface: 'select-dropdown',
    options: { choices: [{ value: 'open', text: 'Open' }] }
  }),
  f('qty', { type: 'integer' })
]
const RELATIONS = [
  rel(1, { many_collection: 'orders', many_field: 'region', one_collection: 'regions' }),
  rel(2, { many_collection: 'orders', many_field: 'ship_to', one_collection: 'locations' }),
  rel(3, {
    many_collection: 'orders_tags',
    many_field: 'orders_id',
    one_collection: 'orders',
    one_field: 'tags',
    junction_field: 'tags_id'
  }),
  rel(4, {
    many_collection: 'orders_tags',
    many_field: 'tags_id',
    one_collection: 'tags',
    junction_field: 'orders_id'
  })
]

function checks(found: string[]) {
  const request = vi.fn(async (_cmd: unknown) => ({ data: found.map((id) => ({ id })) }))
  const c = makePersonalDefaultChecks({
    client: { request } as never,
    collection: 'orders',
    fields: FIELDS,
    relations: RELATIONS,
    readValue: (x) => ({ region: '10' })[x as 'region']
  })
  return { ...c, request }
}

describe('personal default re-validation', () => {
  it('M2O: asks the picker query with the option filter and the cascade', async () => {
    const c = checks(['100'])
    expect(await c.revalidate('ship_to', '100')).toBe(true)
    const cmd = c.request.mock.calls[0][0] as unknown as {
      _path: string
      _params: { filter: string; picker: string }
    }
    expect(cmd._path).toBe('/items/locations')
    expect(cmd._params.picker).toBe('1')
    expect(JSON.parse(cmd._params.filter)).toEqual({
      _and: [{ id: { _in: ['100'] } }, { active: { _eq: true } }, { region: { _eq: '10' } }]
    })
  })

  it('a value the picker no longer offers is refused', async () => {
    expect(await checks([]).revalidate('ship_to', '100')).toBe(false)
  })

  it('M2M: every id must still be pickable', async () => {
    const c = checks(['7'])
    expect(await c.revalidate('tags', ['7', '8'])).toBe(false)
    expect((c.request.mock.calls[0][0] as unknown as { _path: string })._path).toBe('/items/tags')
    expect(await checks(['7', '8']).revalidate('tags', ['7', '8'])).toBe(true)
  })

  it('choices and scalars are checked without a request', async () => {
    const c = checks([])
    expect(await c.revalidate('status', 'open')).toBe(true)
    expect(await c.revalidate('status', 'gone')).toBe(false)
    expect(await c.revalidate('qty', '4')).toBe(true)
    expect(await c.revalidate('qty', 'four')).toBe(false)
    expect(c.request).not.toHaveBeenCalled()
  })

  it('labels a choice by its text', async () => {
    expect(await checks([]).valueLabel('status', 'open')).toBe('Open')
  })
})

describe('fix round 1', () => {
  function withClient(
    answer: (cmd: { _path: string; _params?: Record<string, unknown> }) => unknown
  ) {
    return makePersonalDefaultChecks({
      client: {
        request: async (cmd: unknown) => answer(cmd as { _path: string })
      } as never,
      collection: 'orders',
      fields: FIELDS,
      relations: RELATIONS,
      readValue: () => undefined
    })
  }

  it('a re-check that could not run answers null, not "refused"', async () => {
    const c = withClient(() => {
      throw new Error('offline')
    })
    expect(await c.revalidate('ship_to', '100')).toBeNull()
  })

  it('a refused template read still labels by what the picker shows', async () => {
    const c = withClient((cmd) => {
      if (cmd._path === '/collections/locations')
        throw Object.assign(new Error('no'), { status: 403 })
      return { data: [{ id: '100', name: 'Cambridge' }] }
    })
    expect(await c.valueLabel('ship_to', '100')).toBe('Cambridge')
  })

  it('only an id to show: no label', async () => {
    const c = withClient((cmd) =>
      cmd._path === '/collections/locations' ? { data: {} } : { data: [{ id: '100' }] }
    )
    expect(await c.valueLabel('ship_to', '100')).toBeNull()
    const gone = withClient((cmd) =>
      cmd._path === '/collections/locations' ? { data: {} } : { data: [] }
    )
    expect(await gone.valueLabel('ship_to', '100')).toBeNull()
  })
})

describe('fix round 2', () => {
  it('people are labelled through /users/:id (non-admins cannot read /items/<users>)', async () => {
    for (const target of ['directus_users', 'nivaro_users']) {
      const paths: string[] = []
      const c = makePersonalDefaultChecks({
        client: {
          request: async (cmd: unknown) => {
            const p = (cmd as { _path: string })._path
            paths.push(p)
            if (p === '/users/u7')
              return { data: { id: 'u7', first_name: 'Ann', last_name: 'Lee' } }
            throw Object.assign(new Error('Forbidden'), { status: 403 })
          }
        } as never,
        collection: 'orders',
        fields: [f('owner', { interface: 'select-dropdown-m2o' })],
        relations: [
          rel(9, { many_collection: 'orders', many_field: 'owner', one_collection: target })
        ],
        readValue: () => undefined
      })
      expect(await c.valueLabel('owner', 'u7')).toBe('Ann Lee')
      expect(paths.some((p) => p.startsWith(`/items/${target}`))).toBe(false)
    }
  })
})
