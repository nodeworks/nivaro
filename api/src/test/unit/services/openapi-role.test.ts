import { describe, expect, it, vi } from 'vitest'
import type { CollectionAccess } from '../../../services/openapi-role.js'
import type { CMSCollection, CMSField } from '../../../types.js'

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))

const { generateOpenApi } = await import('../../../routes/dev-tools.js')
const { narrowOpenApiForRole, pickPolicy, describeRowFilter } = await import(
  '../../../services/openapi-role.js'
)

type Schema = {
  properties: Record<string, Record<string, unknown>>
  required?: string[]
}
type Doc = {
  paths: Record<string, Record<string, { description?: string; requestBody?: unknown }>>
  components: { schemas: Record<string, Schema> }
}

const col = (collection: string) =>
  ({ collection, singular: null, display_name: collection }) as unknown as CMSCollection
const fld = (collection: string, field: string, required = false) =>
  ({ collection, field, type: 'string', required, note: null }) as unknown as CMSField

const collections = [col('articles'), col('secrets')]
const fields = new Map<string, CMSField[]>([
  [
    'articles',
    [
      fld('articles', 'id'),
      fld('articles', 'title', true),
      fld('articles', 'body'),
      fld('articles', 'internal')
    ]
  ],
  ['secrets', [fld('secrets', 'id'), fld('secrets', 'value')]]
])
const spec = generateOpenApi(collections, fields, 'Test')

function access(entries: Record<string, Partial<CollectionAccess>>) {
  return new Map(
    Object.entries(entries).map(([k, v]) => [
      k,
      {
        read: false,
        create: false,
        update: false,
        delete: false,
        rowFilters: {},
        scopeNotes: [],
        ...v
      } as CollectionAccess
    ])
  )
}

describe('narrowOpenApiForRole', () => {
  it('drops collections and operations the role has no policy for', () => {
    const out = narrowOpenApiForRole(spec, {
      role: { id: 'r', name: 'Reader', admin_access: false },
      access: access({ articles: { read: null }, secrets: {} })
    }) as unknown as Doc
    expect(Object.keys(out.paths)).toEqual(['/items/articles', '/items/articles/{id}'])
    expect(Object.keys(out.paths['/items/articles'])).toEqual(['get'])
    expect(Object.keys(out.paths['/items/articles/{id}'])).toEqual(['get'])
    expect(out.components.schemas.Secrets).toBeUndefined()
  })

  it('splits readable vs writable fields into response and request schemas', () => {
    const out = narrowOpenApiForRole(spec, {
      role: { id: 'r', name: 'Editor', admin_access: false },
      access: access({
        articles: { read: ['title', 'body'], create: ['title', 'internal'], update: ['title'] }
      })
    }) as unknown as Doc
    const read = out.components.schemas.Articles
    expect(Object.keys(read.properties).sort()).toEqual(['body', 'id', 'title'])
    expect(read.properties.body.readOnly).toBe(true)
    expect(read.properties.title.readOnly).toBeUndefined()
    const create = out.components.schemas.ArticlesCreate
    expect(Object.keys(create.properties).sort()).toEqual(['internal', 'title'])
    expect(create.properties.internal.writeOnly).toBe(true)
    expect(create.required).toEqual(['title'])
    const update = out.components.schemas.ArticlesUpdate
    expect(Object.keys(update.properties)).toEqual(['title'])
    expect(JSON.stringify(out.paths['/items/articles'].post.requestBody)).toContain(
      'ArticlesCreate'
    )
    expect(JSON.stringify(out.paths['/items/articles/{id}'].patch.requestBody)).toContain(
      'ArticlesUpdate'
    )
  })

  it('notes row filters and User Scopes on each operation', () => {
    const out = narrowOpenApiForRole(spec, {
      role: { id: 'r', name: 'Scoped', admin_access: false },
      access: access({
        articles: {
          read: null,
          rowFilters: { read: [{ field: 'owner', op: 'eq', value: '$CURRENT_USER' }] },
          scopeNotes: ['Zone: restricted.']
        }
      })
    }) as unknown as Doc
    const d = out.paths['/items/articles'].get.description ?? ''
    expect(d).toContain('only rows where owner is the calling user')
    expect(d).toContain('User Scopes')
  })

  it('an admin role keeps every operation', () => {
    const out = narrowOpenApiForRole(spec, {
      role: { id: 'r', name: 'Admin', admin_access: true },
      access: access({
        articles: { read: null, create: null, update: null, delete: true },
        secrets: { read: null, create: null, update: null, delete: true }
      })
    }) as unknown as Doc
    expect(Object.keys(out.paths['/items/secrets/{id}']).sort()).toEqual(['delete', 'get', 'patch'])
  })
})

describe('helpers', () => {
  it('pickPolicy prefers the exact collection over the wildcard', () => {
    const ps = [
      { collection: '*', action: 'read', id: 1 },
      { collection: 'articles', action: 'read', id: 2 }
    ]
    expect(pickPolicy(ps, 'read', 'articles')?.id).toBe(2)
    expect(pickPolicy(ps, 'read', 'other')?.id).toBe(1)
    expect(pickPolicy(ps, 'update', 'articles')).toBeNull()
  })

  it('describeRowFilter reads as a sentence', () => {
    expect(
      describeRowFilter([
        { field: 'status', op: 'in', value: ['a', 'b'] },
        { field: 'deleted_at', op: 'null' }
      ])
    ).toBe('status is one of a, b and deleted_at is empty')
  })
})
