import { describe, expect, it } from 'vitest'
import { buildCopyAs, conditionsToFilter, graphqlLiteral, graphqlSelection } from './copy-as'

describe('conditionsToFilter', () => {
  it('folds a dotted path into nested objects and ANDs several', () => {
    const f = conditionsToFilter(
      JSON.stringify([
        { path: ['project', 'name'], op: '_contains', value: 'CMTS' },
        { path: ['is_on_hold'], op: '_eq', value: true }
      ])
    )
    expect(f).toEqual({
      _and: [{ project: { name: { _contains: 'CMTS' } } }, { is_on_hold: { _eq: true } }]
    })
  })
  it('turns an or group into _or and keeps a single condition bare', () => {
    expect(
      conditionsToFilter(
        JSON.stringify([
          {
            or: [
              { path: ['a'], op: '_eq', value: 1 },
              { path: ['b'], op: '_eq', value: 2 }
            ]
          }
        ])
      )
    ).toEqual({ _or: [{ a: { _eq: 1 } }, { b: { _eq: 2 } }] })
  })
  it('answers null for nothing, garbage or an empty list', () => {
    expect(conditionsToFilter(undefined)).toBeNull()
    expect(conditionsToFilter('nope')).toBeNull()
    expect(conditionsToFilter('[]')).toBeNull()
  })
})

describe('graphqlLiteral', () => {
  it('leaves keys bare, quotes strings and renames virtual keys', () => {
    const lit = graphqlLiteral({ $state: { _in: ['started'] }, n: 3, ok: true, none: null })
    expect(lit).toContain('_state: {')
    expect(lit).toContain('_in: ["started"]')
    expect(lit).toContain('n: 3')
    expect(lit).toContain('none: null')
    expect(lit).not.toContain('"n"')
  })
})

describe('graphqlSelection', () => {
  it('always starts with id, nests dotted keys and drops synthetic columns', () => {
    const sel = graphqlSelection(
      ['name', 'project.name', 'project.project_id', '__state__', 'id'],
      1
    )
    expect(sel.split('\n')[0]).toBe('  id')
    expect(sel).toContain('  project {\n    name\n    project_id\n  }')
    expect(sel).not.toContain('__state__')
    expect(sel.match(/^\s*id$/gm)?.length).toBe(1)
  })
})

describe('buildCopyAs', () => {
  const list = buildCopyAs({
    origin: 'https://cms.example.com',
    collection: 'workflows',
    list: {
      conditions: JSON.stringify([{ path: ['is_on_hold'], op: '_eq', value: true }]),
      search: "o'hara",
      sort: '-id',
      limit: 25,
      page: 3
    },
    fields: ['workflow_id']
  })
  it('never carries a real token', () => {
    for (const s of Object.values(list)) expect(s).toContain('NIVARO_TOKEN')
  })
  it('curl url-encodes every parameter and survives a quote', () => {
    expect(list.curl).toContain('curl -G "https://cms.example.com/api/items/workflows"')
    expect(list.curl).toContain("--data-urlencode 'search=o'\\''hara'")
    expect(list.curl).toContain("--data-urlencode 'page=3'")
    expect(list.curl).toContain("--data-urlencode 'conditions=[")
  })
  it('the SDK call takes the filter form and the page', () => {
    expect(list.sdk).toContain("readItems('workflows', {")
    expect(list.sdk).toContain('"filter": {')
    expect(list.sdk).toContain('"page": 3')
    expect(list.sdk).toContain('"sort": [\n      "-id"\n    ]')
  })
  it('the GraphQL document pages by offset and reads the total beside the rows', () => {
    expect(list.graphql).toContain('workflows(filter: {')
    expect(list.graphql).toContain('offset: 50')
    expect(list.graphql).toContain('workflows_metadata(')
    expect(list.graphql).toContain('    workflow_id')
  })
  it('a record renders the by-id forms', () => {
    const rec = buildCopyAs({
      origin: 'https://x',
      collection: 'projects',
      itemId: '7904',
      fields: ['name']
    })
    expect(rec.curl).toBe(
      'curl "https://x/api/items/projects/7904" \\\n  -H "Authorization: Bearer $NIVARO_TOKEN"'
    )
    expect(rec.sdk).toContain('readItem(\'projects\', "7904")')
    expect(rec.graphql).toContain('projects_by_id(id: "7904") {\n    id\n    name\n  }')
    expect(
      rec.graphql.startsWith(
        '# POST https://x/api/graphql\n# Authorization: Bearer $NIVARO_TOKEN\nquery {'
      )
    ).toBe(true)
  })
})
