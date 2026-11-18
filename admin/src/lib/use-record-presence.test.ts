import { describe, expect, it } from 'vitest'
import { distinctViewers, pruneEditing, REMOTE_EDIT_TTL_MS } from './use-record-presence'

describe('distinctViewers', () => {
  it('lists a person once however many tabs, devices or processes they view from', () => {
    const beth = { id: '67266972-6C36-43DB-B87E-34E24944B83A', name: 'Beth Lawson' }
    const sam = { id: 'dc9830c0-9b49-42e6-8fdc-c4699e22f20c', name: 'Sam Rivera' }
    expect(
      distinctViewers([
        beth,
        sam,
        { ...beth },
        { id: beth.id.toLowerCase(), name: 'Beth Lawson' },
        { id: sam.id.toUpperCase(), name: 'Sam Rivera' }
      ])
    ).toEqual([beth, sam])
  })

  it('keeps the order first seen and tolerates an empty or missing list', () => {
    expect(distinctViewers(undefined)).toEqual([])
    expect(distinctViewers([])).toEqual([])
    const a = { id: 'a', name: 'A' }
    const b = { id: 'b', name: 'B' }
    expect(distinctViewers([b, a, b])).toEqual([b, a])
  })
})

describe('pruneEditing (20 s mark TTL, like efp-new)', () => {
  const beth = { id: 'B', name: 'Beth' }
  const sam = { id: 's', name: 'Sam' }
  it('drops a mark not confirmed within the TTL and keeps the object when nothing lapses', () => {
    const editing = { total: beth, notes: sam }
    const seen = new Map([
      ['total', 1_000],
      ['notes', 1_000 + REMOTE_EDIT_TTL_MS]
    ])
    expect(pruneEditing(editing, seen, 1_000 + REMOTE_EDIT_TTL_MS - 1)).toBe(editing)
    expect(pruneEditing(editing, seen, 1_000 + REMOTE_EDIT_TTL_MS)).toEqual({ notes: sam })
  })
  it("drops the marks of someone who left the record", () => {
    const editing = { total: beth, notes: sam }
    const seen = new Map([
      ['total', 5],
      ['notes', 5]
    ])
    expect(pruneEditing(editing, seen, 10, REMOTE_EDIT_TTL_MS, new Set(['s']))).toEqual({
      notes: sam
    })
  })
})
