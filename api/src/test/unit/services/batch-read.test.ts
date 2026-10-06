import { describe, expect, it } from 'vitest'
import { batchReadRefusal, parseBatchRead } from '../../../services/batch-read.js'

describe('parseBatchRead', () => {
  it('turns the GET string form into an ItemsQuery', () => {
    const r = parseBatchRead(
      {
        collection: 'regions',
        query: {
          fields: 'id,name',
          filter: '{"id":{"_gt":1}}',
          sort: '-id',
          limit: '5',
          count: '0'
        }
      },
      3
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.read.key).toBe('3')
    expect(r.read.id).toBeNull()
    expect(r.read.query).toMatchObject({
      fields: ['id', 'name'],
      filter: { id: { _gt: 1 } },
      sort: ['-id'],
      limit: 5,
      count: false
    })
  })

  it('accepts structured values and conditions', () => {
    const r = parseBatchRead(
      {
        key: 'k',
        collection: 'regions',
        query: {
          fields: ['id'],
          filter: { id: 1 },
          conditions: [{ path: ['id'], op: '_eq', value: 1 }]
        }
      },
      0
    )
    expect(r.ok && r.read.key).toBe('k')
    expect(r.ok && r.read.conditions).toBe('[{"path":["id"],"op":"_eq","value":1}]')
  })

  it('keeps only fields on a single-record read', () => {
    const r = parseBatchRead({ collection: 'regions', id: 4, query: { fields: 'id', limit: 9 } }, 0)
    expect(r.ok && r.read.id).toBe('4')
    expect(r.ok && r.read.query).toEqual({ fields: ['id'] })
  })

  it('refuses a malformed read', () => {
    expect(parseBatchRead({ collection: 'bad name' }, 0).ok).toBe(false)
    expect(parseBatchRead({ collection: 'regions', query: { filter: '{oops' } }, 0).ok).toBe(false)
    expect(parseBatchRead({ collection: 'regions', query: { picker: '1' } }, 0).ok).toBe(false)
    expect(parseBatchRead({ collection: 'regions', query: { limit: 'many' } }, 0).ok).toBe(false)
    expect(parseBatchRead({ collection: 'regions', id: { x: 1 } }, 0).ok).toBe(false)
  })
})

describe('batchReadRefusal', () => {
  it('maps the service errors to the GET statuses', () => {
    const forbidden = Object.assign(new Error('Forbidden'), { name: 'ForbiddenError' })
    expect(batchReadRefusal(forbidden)).toMatchObject({ status: 403, code: 'FORBIDDEN' })
    const missing = Object.assign(new Error('Collection "x" not found in registry'), {
      name: 'CollectionNotFoundError'
    })
    expect(batchReadRefusal(missing)).toMatchObject({ status: 404 })
    const refused = Object.assign(new Error('Unknown field'), {
      statusCode: 400,
      code: 'UNKNOWN_FIELD'
    })
    expect(batchReadRefusal(refused)).toEqual({
      status: 400,
      error: 'Unknown field',
      code: 'UNKNOWN_FIELD'
    })
    expect(batchReadRefusal(new Error('SELECT * FROM x - boom'))).toEqual({
      status: 500,
      error: 'The read failed',
      code: 'INTERNAL_SERVER_ERROR'
    })
  })
})
