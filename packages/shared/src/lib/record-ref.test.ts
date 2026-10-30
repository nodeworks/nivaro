import { describe, expect, it, vi } from 'vitest'
import {
  aliasSegmentOf,
  friendlyIdFieldOf,
  friendlyIdOf,
  recordRefLabel,
  shareableRecordId
} from './record-ref'

const meta = { friendly_id_field: 'workflow_id' }

describe('record refs (#776)', () => {
  it('names a record by its friendly id, else #id', () => {
    expect(recordRefLabel(meta, { id: 7, workflow_id: 'CM26-7' }, 7)).toBe('CM26-7')
    expect(recordRefLabel(meta, { id: 7, workflow_id: '' }, 7)).toBe('#7')
    expect(recordRefLabel({}, { id: 7 }, 7)).toBe('#7')
    expect(recordRefLabel(null, null, null)).toBe('')
  })

  it('ignores a field that is id or not a plain column', () => {
    expect(friendlyIdFieldOf({ friendly_id_field: 'id' })).toBeNull()
    expect(friendlyIdFieldOf({ friendly_id_field: 'a.b' })).toBeNull()
    expect(friendlyIdOf({ friendly_id_field: 'x' }, { x: { nested: 1 } })).toBeNull()
  })

  it('alias segment mirrors the server resolver', () => {
    expect(aliasSegmentOf(meta, { workflow_id: 'CM26-7' })).toBe('CM26-7')
    // url_alias_fields win over the friendly id and join with '-'.
    expect(
      aliasSegmentOf({ ...meta, url_alias_fields: ['region', 'num'] }, { region: 'HQ', num: 12 })
    ).toBe('HQ-12')
    expect(aliasSegmentOf({ url_alias_fields: '["slug"]' }, { slug: 'pump-a' })).toBe('pump-a')
    // A value that reads as a key is never used as an alias.
    expect(aliasSegmentOf(meta, { workflow_id: '12345' })).toBeNull()
    expect(aliasSegmentOf({ url_alias_fields: ['a', 'b'] }, { a: 'x' })).toBeNull()
  })

  it('a share link uses the alias only when it opens this very record', async () => {
    const client = { request: vi.fn() }
    client.request.mockResolvedValueOnce({ data: { id: 7 } })
    expect(await shareableRecordId(client, 'workflows', meta, { workflow_id: 'CM26-7' }, 7)).toBe(
      'CM26-7'
    )
    // A duplicate business id resolves to another (lower) record: keep the id.
    client.request.mockResolvedValueOnce({ data: { id: 3 } })
    expect(await shareableRecordId(client, 'workflows', meta, { workflow_id: 'CM26-7' }, 7)).toBe(
      '7'
    )
    client.request.mockRejectedValueOnce(new Error('404'))
    expect(await shareableRecordId(client, 'workflows', meta, { workflow_id: 'CM26-7' }, 7)).toBe(
      '7'
    )
    expect(await shareableRecordId(client, 'workflows', {}, { workflow_id: 'CM26-7' }, 7)).toBe('7')
  })
})
