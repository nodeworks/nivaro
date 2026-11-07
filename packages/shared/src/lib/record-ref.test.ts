import { describe, expect, it, vi } from 'vitest'
import {
  aliasSegmentOf,
  friendlyIdFieldOf,
  friendlyIdOf,
  recordRefLabel,
  rowMenuRef,
  shareableRecordId
} from './record-ref'

const meta = { friendly_id_field: 'workflow_id' }

describe('record refs (#776)', () => {
  it('names a record by its friendly id, else #id', () => {
    expect(recordRefLabel(meta, { id: 7, workflow_id: 'CM26-7' }, 7)).toBe('CM26-7')
    // never the row id (army 6 M52)
    expect(recordRefLabel(meta, { id: 7, workflow_id: '' }, 7, 'workflows')).toBe(
      'No workflow number'
    )
    expect(recordRefLabel({}, { id: 7 }, 7)).toBe('No record number')
    expect(
      recordRefLabel(
        meta,
        { id: 360291, workflow_id: null, description: 'IG Net2.0 Circuit Engineer 2H 2025 ' },
        360291,
        'workflows'
      )
    ).toBe('No workflow number · IG Net2.0 Circuit Engineer 2H 2025')
    expect(recordRefLabel({}, null, 5, 'inventory_request')).toBe('No inventory request number')
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

// army 7 N7/M52 — the row ⋯ menu copied and named the row id ("367714").
describe('rowMenuRef', () => {
  it('copies and names the queue row’s friendly label, never its row id', () => {
    expect(rowMenuRef({ label: 'PW26-76166', id: 367714 })).toEqual({
      copy: 'PW26-76166',
      name: 'PW26-76166'
    })
  })
  it('has nothing to copy for a record with no number, but still names it', () => {
    const r = rowMenuRef({ label: 'No workflow number · IG Net2.0', id: 360291 })
    expect(r.copy).toBeNull()
    expect(r.name).toBe('No workflow number · IG Net2.0')
  })
  it('reads the friendly id column from a browser row', () => {
    expect(
      rowMenuRef({ meta, row: { id: 367714, workflow_id: 'PW26-76166' }, id: 367714 })
    ).toEqual({ copy: 'PW26-76166', name: 'PW26-76166' })
  })
  it('a blank friendly id copies nothing and reads "No … number"', () => {
    const r = rowMenuRef({
      meta,
      row: { id: 360291, workflow_id: null, description: 'IG Net2.0' },
      id: 360291,
      collection: 'workflows'
    })
    expect(r.copy).toBeNull()
    expect(r.name).toBe('No workflow number · IG Net2.0')
  })
  it('keeps the row id where the collection names no friendly id column', () => {
    expect(rowMenuRef({ meta: {}, row: { id: 12 }, id: 12 })).toEqual({ copy: '12', name: '12' })
  })

  it('copies nothing while the collection metadata is not loaded yet', () => {
    expect(rowMenuRef({ id: 'abc' })).toEqual({ copy: null, name: 'this record' })
  })
})
