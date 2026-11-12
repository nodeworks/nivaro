import { describe, expect, it } from 'vitest'
import { getActiveLayout } from '../lib/commands'
import { fetchSchema } from './useFormSchema'

// Twin of packages/shared/src/hooks/useFormSchema.optional-layout.test.ts: the react
// package's own form schema read asks "which form?" as optional, and a collection without a
// form (200, no data) shows every field.

type Cmd = { _method?: string; _path?: string; _params?: Record<string, unknown> }

function fakeClient(active: unknown) {
  const seen: Cmd[] = []
  return {
    seen,
    client: {
      request: async (cmd: Cmd) => {
        seen.push(cmd)
        if (cmd._path === '/collections/warehouses')
          return {
            data: {
              collection: 'warehouses',
              fields: [
                { field: 'id', type: 'integer' },
                { field: 'name', type: 'string' }
              ],
              relations: []
            }
          }
        if (cmd._path === '/collection-layouts/active') {
          if (active instanceof Error) throw active
          return { data: active }
        }
        throw new Error(`unexpected ${cmd._path}`)
      }
    }
  }
}

describe('the "which form" read (react package)', () => {
  it('is asked as optional, whatever else it names', () => {
    const cmd = getActiveLayout({ collection: 'warehouses', slug: 'short' }) as unknown as Cmd
    expect(cmd._path).toBe('/collection-layouts/active')
    expect(cmd._params).toEqual({ collection: 'warehouses', slug: 'short', optional: 1 })
  })

  it('fetchSchema asks it that way and shows every field when there is no form', async () => {
    const { client, seen } = fakeClient(null)
    const schema = await fetchSchema(client as never, 'warehouses', false)
    const ask = seen.find((c) => c._path === '/collection-layouts/active')
    expect(ask?._params).toMatchObject({ collection: 'warehouses', optional: 1 })
    expect(schema.fields.map((f) => f.field)).toEqual(['id', 'name'])
  })

  it('an older server that still answers 404 gives the same form', async () => {
    const { client } = fakeClient(new Error('404'))
    const schema = await fetchSchema(client as never, 'warehouses', false)
    expect(schema.fields.map((f) => f.field)).toEqual(['id', 'name'])
  })
})
