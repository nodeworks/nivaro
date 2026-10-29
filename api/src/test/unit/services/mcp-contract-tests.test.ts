import { describe, expect, it } from 'vitest'
import { compareInputSchema, compareShapes, shapeOf } from '../../../services/mcp-contract-tests.js'

describe('shapeOf', () => {
  it('keeps types and keys, never values', () => {
    expect(shapeOf({ id: 7, name: 'x', tags: ['a'], meta: null })).toEqual({
      t: 'object',
      keys: {
        id: { t: 'number' },
        name: { t: 'string' },
        tags: { t: 'array', of: { t: 'string' } },
        meta: { t: 'null' }
      }
    })
  })
  it('merges list items and marks a place that was null as nullable', () => {
    expect(shapeOf([{ a: 1 }, { a: null, b: 'x' }])).toEqual({
      t: 'array',
      of: { t: 'object', keys: { a: { t: 'number', n: true }, b: { t: 'string' } } }
    })
  })
})

describe('compareShapes', () => {
  const saved = shapeOf({ total: 3, data: [{ id: 1, title: 'a' }], meta: { page: 1 } })
  it('passes the same shape with other values', () => {
    expect(
      compareShapes(saved, shapeOf({ total: 9, data: [{ id: 5, title: 'b' }], meta: { page: 2 } }))
    ).toEqual({ problems: [], notes: [] })
  })
  it('fails a key that went away or a type that changed', () => {
    const v = compareShapes(saved, shapeOf({ total: '3', data: [] }))
    expect(v.problems).toEqual(['$.total was a number, now a string', '$.meta is gone'])
    expect(v.notes[0]).toMatch(/empty list/)
  })
  it('only notes a missing field inside data rows, and new keys', () => {
    const v = compareShapes(
      saved,
      shapeOf({ total: 1, data: [{ id: 1 }], meta: { page: 1 }, extra: 1 })
    )
    expect(v.problems).toEqual([])
    expect(v.notes).toEqual(['$.data[].title is not in this answer', '$ has new key: extra'])
  })
})

describe('compareInputSchema', () => {
  const schema = {
    type: 'object',
    properties: {
      collection: { type: 'string' },
      limit: { type: 'number' },
      sort: { type: 'string', enum: ['asc', 'desc'] }
    },
    required: ['collection']
  }
  it('passes arguments that still fit', () => {
    expect(compareInputSchema(schema, schema, { collection: 'projects', limit: 5 })).toEqual({
      problems: [],
      notes: []
    })
  })
  it('fails a new required input, a removed one and a changed type or value', () => {
    const now = {
      type: 'object',
      properties: {
        collection: { type: 'string' },
        sort: { type: 'string', enum: ['newest'] },
        view: { type: 'string' }
      },
      required: ['collection', 'view']
    }
    const v = compareInputSchema(schema, now, { collection: 'projects', limit: 5, sort: 'asc' })
    expect(v.problems).toEqual([
      'It now needs view, which this test does not give',
      'limit is no longer one of its inputs',
      'sort: "asc" is no longer allowed'
    ])
  })
  it('notes new optional inputs', () => {
    const now = { ...schema, properties: { ...schema.properties, fields: { type: 'array' } } }
    expect(compareInputSchema(schema, now, { collection: 'x' }).notes).toEqual([
      'New optional inputs: fields'
    ])
  })
})
