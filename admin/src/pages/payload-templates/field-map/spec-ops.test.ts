import { describe, expect, it } from 'vitest'
import type { Field, MapSpec } from '../api'
import {
  addField,
  duplicateField,
  findField,
  latchLocks,
  lockState,
  moveField,
  moveFieldTo,
  removeField,
  renameKey,
  renameListAlias,
  setType,
  structuralIssues,
  updateField,
  updateValue
} from './spec-ops'
import { emptyHistory, recordHistory, redoHistory, undoHistory } from './useSpecHistory'

function f(id: string, key: string, extra: Partial<Field> = {}): Field {
  return {
    id,
    key,
    type: 'text',
    include: 'always',
    value: { source: 'fixed', value: '' },
    ...extra
  }
}

function spec(fields: Field[]): MapSpec {
  return { v: 1, fields }
}

let n = 0
const ids = () => `new${++n}`
const none = new Set<string>()

const base = () =>
  spec([
    f('a', 'efp_state'),
    f('b', 'po_number'),
    {
      id: 'g',
      key: 'lines',
      type: 'list',
      include: 'always',
      list: { source: 'context.materials', item: 'line' },
      children: [f('c1', 'qty'), f('c2', 'sku'), f('c3', 'uom')]
    },
    f('d', 'note')
  ])

const keysOf = (fields: Field[]) => fields.map((x) => x.key)

describe('addField', () => {
  it('addField inserts after the row and returns its id', () => {
    const s = base()
    const res = addField(s, { after: 'a', key: 'requestor' }, ids)
    expect(keysOf(res.spec.fields)).toEqual([
      'efp_state',
      'requestor',
      'po_number',
      'lines',
      'note'
    ])
    expect(res.id).toMatch(/^new/)
    expect(findField(res.spec, res.id)?.field.key).toBe('requestor')
    // untouched siblings keep their identity (memoized rows do not re-render)
    expect(res.spec.fields[0]).toBe(s.fields[0])
    expect(s.fields).toHaveLength(4)
  })

  it('inserts after a nested row inside its own group', () => {
    const res = addField(base(), { after: 'c1' }, ids)
    const g = findField(res.spec, 'g')?.field
    expect(g?.children?.map((x) => x.id)).toEqual(['c1', res.id, 'c2', 'c3'])
  })

  it('appends to a group when given a parent', () => {
    const res = addField(base(), { parent: 'g', key: 'price' }, ids)
    expect(keysOf(findField(res.spec, 'g')?.field.children ?? [])).toEqual([
      'qty',
      'sku',
      'uom',
      'price'
    ])
  })

  it('never reuses an id', () => {
    const s = base()
    const one = addField(s, { after: 'a' })
    const two = addField(one.spec, { after: 'a' })
    expect(one.id).not.toBe(two.id)
    expect(new Set([one.id, two.id, 'a', 'b', 'g', 'c1', 'c2', 'c3', 'd']).size).toBe(9)
  })
})

describe('locked fields', () => {
  const lockedKeys = ['efp_state', 'lines.sku']
  const locked = latchLocks(base(), lockedKeys)

  it('removeField refuses a locked field', () => {
    const s = base()
    const res = removeField(s, 'a', locked)
    expect(res.ok).toBe(false)
    expect(res.spec).toBe(s)
    if (!res.ok) expect(res.reason).toMatch(/efp_state/)
  })

  it('removeField refuses a group holding a locked field', () => {
    const res = removeField(base(), 'g', locked)
    expect(res.ok).toBe(false)
  })

  it('removeField keeps the one field of a plain-values list', () => {
    const s = spec([
      {
        id: 'g',
        key: 'pos',
        type: 'list',
        include: 'always',
        list: { source: 'context.pos', item: 'po', scalar: true },
        children: [f('only', '')]
      }
    ])
    expect(removeField(s, 'only', new Set()).ok).toBe(false)
  })

  it('removeField removes an unlocked field', () => {
    const res = removeField(base(), 'b', locked)
    expect(res.ok).toBe(true)
    expect(keysOf(res.spec.fields)).toEqual(['efp_state', 'lines', 'note'])
  })

  it('renameKey refuses a locked field', () => {
    const s = base()
    const res = renameKey(s, 'a', 'state', locked)
    expect(res.ok).toBe(false)
    expect(res.spec).toBe(s)
    expect(renameKey(s, 'c2', 'item', locked).ok).toBe(false)
    expect(renameKey(s, 'g', 'rows', locked).ok).toBe(false)
  })

  it('renameKey renames an unlocked field', () => {
    const res = renameKey(base(), 'b', 'po', locked)
    expect(res.ok).toBe(true)
    expect(res.spec.fields[1].key).toBe('po')
  })

  it('setType refuses a locked field but its value source may change', () => {
    const s = base()
    expect(setType(s, 'a', 'number', locked).ok).toBe(false)
    const v = updateValue(s, 'a', { source: 'builtin', name: 'state.label' })
    expect(findField(v, 'a')?.field.value).toEqual({ source: 'builtin', name: 'state.label' })
  })

  it('a field flagged locked in the spec is locked too', () => {
    const s = spec([f('x', 'id', { locked: true })])
    const ids = latchLocks(s, [])
    expect(removeField(s, 'x', ids).ok).toBe(false)
    expect(lockState(s, ids).get('x')?.self).toBe(true)
  })

  it('typing through a locked name never locks the row', () => {
    // po_number is renamed letter by letter through "efp_state" and on to "efp_state_2".
    let s = base()
    const ids = latchLocks(s, lockedKeys)
    for (const k of ['e', 'efp', 'efp_state', 'efp_state_', 'efp_state_2']) {
      const r = renameKey(s, 'b', k, ids)
      expect(r.ok).toBe(true)
      s = r.spec
    }
    expect(s.fields[1].key).toBe('efp_state_2')
    // and while it held the locked name it stayed removable, the original stayed locked
    const mid = renameKey(base(), 'b', 'efp_state', ids).spec
    expect(removeField(mid, 'b', ids).ok).toBe(true)
    expect(removeField(mid, 'a', ids).ok).toBe(false)
  })

  it('a duplicate of a locked key can be removed', () => {
    const s = duplicateField(base(), 'a', ids).spec
    const latched = latchLocks(s, lockedKeys)
    const copy = s.fields[1]
    // the copy is renamed back onto the locked name — still just a duplicate
    const dup = renameKey(s, copy.id, 'efp_state', latched).spec
    expect(removeField(dup, copy.id, latched).ok).toBe(true)
    expect(renameKey(dup, copy.id, 'other', latched).ok).toBe(true)
    expect(removeField(dup, 'a', latched).ok).toBe(false)
  })

  it('latches one row per locked path; a reload keeps the row it had', () => {
    const s = spec([f('x', 'efp_state'), f('y', 'efp_state')])
    expect([...latchLocks(s, ['efp_state'])]).toEqual(['x'])
    // the second row was the latched one before the reload
    expect([...latchLocks(s, ['efp_state'], new Set(['y']))]).toEqual(['y'])
  })

  it('lockState marks locked rows and the groups that hold them', () => {
    const st = lockState(base(), locked)
    expect(locked.size).toBe(2)
    expect(st.get('a')).toEqual({ self: true, inside: false })
    expect(st.get('c2')).toEqual({ self: true, inside: false })
    expect(st.get('g')).toEqual({ self: false, inside: true })
    expect(st.get('b')).toBeUndefined()
  })
})

describe('moveField', () => {
  it('moveField reorders within a group', () => {
    const s = base()
    const down = moveField(s, 'c1', 1)
    expect(down.ok).toBe(true)
    expect(keysOf(findField(down.spec, 'g')?.field.children ?? [])).toEqual(['sku', 'qty', 'uom'])
    const up = moveField(down.spec, 'c3', -1)
    expect(keysOf(findField(up.spec, 'g')?.field.children ?? [])).toEqual(['sku', 'uom', 'qty'])
    // top level untouched by a nested move
    expect(keysOf(up.spec.fields)).toEqual(keysOf(s.fields))
  })

  it('stops at the ends of its group (never leaves it)', () => {
    const s = base()
    const r = moveField(s, 'c1', -1)
    expect(r.ok).toBe(false)
    expect(r.spec).toBe(s)
    expect(moveField(s, 'd', 1).ok).toBe(false)
  })

  it('moveFieldTo drops onto a sibling and refuses another group', () => {
    const s = base()
    const r = moveFieldTo(s, 'a', 'd')
    expect(keysOf(r.spec.fields)).toEqual(['po_number', 'lines', 'note', 'efp_state'])
    const across = moveFieldTo(s, 'a', 'c2')
    expect(across.ok).toBe(false)
    if (!across.ok) expect(across.code).toBe('other_group')
    const same = moveFieldTo(s, 'a', 'a')
    expect(same.ok).toBe(false)
    if (!same.ok) expect(same.code).toBe('same_place')
    expect(across.spec).toBe(s)
  })
})

describe('other ops', () => {
  it('setType to a list starts a list spec and drops the value', () => {
    const r = setType(base(), 'b', 'list', none)
    const x = findField(r.spec, 'b')?.field
    expect(x?.type).toBe('list')
    expect(x?.value).toBeUndefined()
    expect(x?.list).toEqual({ source: '', item: 'line' })
    expect(x?.children).toEqual([])
  })

  it('setType from a group to text drops children and starts a value', () => {
    const r = setType(base(), 'g', 'text', none)
    const x = findField(r.spec, 'g')?.field
    expect(x?.children).toBeUndefined()
    expect(x?.list).toBeUndefined()
    expect(x?.value).toEqual({ source: 'fixed', value: '' })
  })

  it('duplicateField copies with fresh ids, a free key and no lock', () => {
    const s = spec([f('a', 'x', { locked: true }), f('b', 'x_copy')])
    const r = duplicateField(s, 'a', ids)
    expect(keysOf(r.spec.fields)).toEqual(['x', 'x_copy_2', 'x_copy'])
    expect(r.spec.fields[1].locked).toBeUndefined()
    expect(r.spec.fields[1].id).toBe(r.id)
    const g = duplicateField(base(), 'g', ids)
    const copy = findField(g.spec, g.id)?.field
    expect(copy?.children?.map((c) => c.id).some((id) => ['c1', 'c2', 'c3'].includes(id))).toBe(
      false
    )
  })

  it('updateField on an unknown id returns the same spec', () => {
    const s = base()
    expect(updateField(s, 'nope', { note: 'x' })).toBe(s)
  })
})

describe('renameListAlias', () => {
  it('rewrites every path inside the list that reads the alias', () => {
    const s = spec([
      {
        id: 'g',
        key: 'lines',
        type: 'list',
        include: 'always',
        list: {
          source: 'context.materials',
          item: 'line',
          where: [{ field: 'line.qty', op: 'gt', value: 0 }],
          sort: '-line.id'
        },
        children: [
          f('a', 'qty', {
            value: {
              source: 'path',
              path: 'line.qty',
              fallbacks: [{ source: 'path', path: 'line.q2' }]
            }
          }),
          f('b', 'f', {
            value: { source: 'formula', liquid: '{{ line.x | upcase }} {{ pipeline.y }}' }
          }),
          f('c', 'sw', {
            include: { when: [{ field: 'line.flag', op: 'nnull', value: null }] },
            value: {
              source: 'switch',
              cases: [
                {
                  when: [{ field: 'line.k', op: 'eq', value: 1 }],
                  value: { source: 'path', path: 'line' }
                }
              ]
            }
          }),
          f('d', 'other', { value: { source: 'path', path: 'record.line_count' } })
        ]
      }
    ])
    const { spec: r, rewrote } = renameListAlias(s, 'g', 'line', 'row')
    expect(rewrote).toBe(true)
    const g = findField(r, 'g')?.field
    expect(g?.list?.item).toBe('row')
    expect(g?.list?.where?.[0].field).toBe('row.qty')
    expect(g?.list?.sort).toBe('-row.id')
    const kids = g?.children ?? []
    expect(kids[0].value).toEqual({
      source: 'path',
      path: 'row.qty',
      fallbacks: [{ source: 'path', path: 'row.q2' }]
    })
    expect((kids[1].value as { liquid: string }).liquid).toBe(
      '{{ row.x | upcase }} {{ pipeline.y }}'
    )
    expect(kids[2].include).toEqual({ when: [{ field: 'row.flag', op: 'nnull', value: null }] })
    const sw = kids[2].value as { cases: { when: { field: string }[]; value: { path: string } }[] }
    expect(sw.cases[0].when[0].field).toBe('row.k')
    expect(sw.cases[0].value.path).toBe('row')
    expect(kids[3].value).toEqual({ source: 'path', path: 'record.line_count' })
  })

  it('only sets the alias when the old or new name is empty', () => {
    const s = base()
    const r = renameListAlias(s, 'g', 'line', '')
    expect(r.rewrote).toBe(false)
    expect(findField(r.spec, 'g')?.field.list?.item).toBe('')
  })
})

describe('renameListAlias safety', () => {
  const nested = () =>
    spec([
      {
        id: 'outer',
        key: 'orders',
        type: 'list',
        include: 'always',
        list: { source: 'context.orders', item: 'order' },
        children: [
          {
            id: 'g',
            key: 'lines',
            type: 'list',
            include: 'always',
            list: { source: 'order.lines', item: 'line' },
            children: [
              f('a', 'qty', { value: { source: 'path', path: 'line.qty' } }),
              f('r', 'rec', { value: { source: 'path', path: 'record.id' } }),
              {
                id: 'inner',
                key: 'parts',
                type: 'list',
                include: 'always',
                list: {
                  source: 'line.parts',
                  item: 'part',
                  sort: '-line.rank',
                  where: [{ field: 'line.ok', op: 'eq', value: 1 }]
                },
                children: [f('p', 'pn', { value: { source: 'path', path: 'line.code' } })]
              },
              {
                id: 'shadow',
                key: 'subs',
                type: 'list',
                include: 'always',
                list: { source: 'line.subs', item: 'line', sort: 'line.n' },
                children: [f('s', 'sn', { value: { source: 'path', path: 'line.name' } })]
              }
            ]
          }
        ]
      }
    ])

  it('a reserved or outer name only sets the name and rewrites nothing', () => {
    for (const bad of ['record', 'context', 'state', 'list', 'order', 'part']) {
      const r = renameListAlias(nested(), 'g', 'line', bad)
      expect(r.rewrote).toBe(false)
      const g = findField(r.spec, 'g')?.field
      expect(g?.list?.item).toBe(bad)
      expect(findField(r.spec, 'a')?.field.value).toEqual({ source: 'path', path: 'line.qty' })
      expect(findField(r.spec, 'r')?.field.value).toEqual({ source: 'path', path: 'record.id' })
    }
  })

  it('typing "rec" → "record" → "records" rewrites from the last safe name only', () => {
    let s = nested()
    let last = 'line'
    for (const typed of ['rec', 'record', 'records']) {
      const r = renameListAlias(s, 'g', last, typed)
      if (r.rewrote) last = typed
      s = r.spec
    }
    expect(last).toBe('records')
    expect(findField(s, 'a')?.field.value).toEqual({ source: 'path', path: 'records.qty' })
    // record.id was never captured by the alias
    expect(findField(s, 'r')?.field.value).toEqual({ source: 'path', path: 'record.id' })
  })

  it('never rewrites away from an unsafe name: rows already called "record" stay put', () => {
    const s = spec([
      {
        id: 'g',
        key: 'lines',
        type: 'list',
        include: 'always',
        list: {
          source: 'context.lines',
          item: 'record',
          where: [{ field: 'record.ok', op: 'eq', value: 1 }],
          sort: 'record.n'
        },
        children: [
          f('a', 'id', { value: { source: 'path', path: 'record.id' } }),
          f('b', 'f', { value: { source: 'formula', liquid: '{{ record.x }}' } })
        ]
      }
    ])
    const r = renameListAlias(s, 'g', 'record', 'records')
    expect(r.rewrote).toBe(false)
    const g = findField(r.spec, 'g')?.field
    expect(g?.list?.item).toBe('records')
    expect(g?.list?.where?.[0].field).toBe('record.ok')
    expect(g?.list?.sort).toBe('record.n')
    expect(findField(r.spec, 'a')?.field.value).toEqual({ source: 'path', path: 'record.id' })
    expect((findField(r.spec, 'b')?.field.value as { liquid: string }).liquid).toBe(
      '{{ record.x }}'
    )
    // leaving an outer list's row name is unsafe too
    expect(renameListAlias(nested(), 'g', 'order', 'row').rewrote).toBe(false)
  })

  it("rewrites a nested list's source, filter and sort, but not inside a list that reuses the name", () => {
    const { spec: s } = renameListAlias(nested(), 'g', 'line', 'row')
    const inner = findField(s, 'inner')?.field
    expect(inner?.list?.source).toBe('row.parts')
    expect(inner?.list?.sort).toBe('-row.rank')
    expect(inner?.list?.where?.[0].field).toBe('row.ok')
    expect(findField(s, 'p')?.field.value).toEqual({ source: 'path', path: 'row.code' })
    const shadow = findField(s, 'shadow')?.field
    expect(shadow?.list?.source).toBe('row.subs') // read in our scope
    expect(shadow?.list?.sort).toBe('line.n') // its own rows
    expect(findField(s, 's')?.field.value).toEqual({ source: 'path', path: 'line.name' })
  })
})

describe('structuralIssues', () => {
  it('flags empty and duplicate sibling keys only among siblings', () => {
    const s = spec([
      f('a', 'id'),
      f('b', 'id'),
      f('c', ''),
      {
        id: 'g',
        key: 'lines',
        type: 'list',
        include: 'always',
        list: { source: '', item: 'line' },
        children: [f('d', 'id')]
      }
    ])
    const issues = structuralIssues(s)
    expect(issues.get('a')?.[0].code).toBe('duplicate_key')
    expect(issues.get('b')?.[0].message).toMatch(/already called/)
    expect(issues.get('c')?.[0].code).toBe('empty_key')
    expect(issues.get('d')).toBeUndefined()
    expect(issues.get('g')?.map((i) => i.code)).toContain('list_no_source')
  })

  it('ignores the key of a plain-values list child', () => {
    const s = spec([
      {
        id: 'g',
        key: 'po_numbers',
        type: 'list',
        include: 'always',
        list: { source: 'context.pos', item: 'po', scalar: true },
        children: [f('d', '')]
      }
    ])
    expect(structuralIssues(s).size).toBe(0)
  })

  it('flags a list item named like a scope key', () => {
    const s = spec([
      {
        id: 'g',
        key: 'l',
        type: 'list',
        include: 'always',
        list: { source: 'context.x', item: 'record' },
        children: []
      }
    ])
    expect(structuralIssues(s).get('g')?.[0].code).toBe('alias_reserved')
  })

  it('flags stray spaces and a bad pattern', () => {
    const s = spec([f('a', ' id'), f('b', 'code', { rules: { pattern: '([a-z' } })])
    const issues = structuralIssues(s)
    expect(issues.get('a')?.[0].code).toBe('key_spaces')
    expect(issues.get('b')?.[0].code).toBe('bad_pattern')
  })
})

describe('undo / redo', () => {
  it('undo/redo restore previous specs', () => {
    const s0 = base()
    const s1 = renameKey(s0, 'b', 'po', none).spec
    const s2 = removeField(s1, 'd', none).spec
    let h = emptyHistory()
    h = recordHistory(h, s0)
    h = recordHistory(h, s1)
    const u1 = undoHistory(h, s2)
    expect(u1?.spec).toBe(s1)
    const u2 = undoHistory(u1!.history, u1!.spec)
    expect(u2?.spec).toBe(s0)
    expect(undoHistory(u2!.history, u2!.spec)).toBeNull()
    const r1 = redoHistory(u2!.history, u2!.spec)
    expect(r1?.spec).toBe(s1)
    const r2 = redoHistory(r1!.history, r1!.spec)
    expect(r2?.spec).toBe(s2)
    expect(redoHistory(r2!.history, r2!.spec)).toBeNull()
  })

  it('a new change after undo drops the redo stack', () => {
    const s0 = base()
    const s1 = renameKey(s0, 'b', 'po', none).spec
    let h = recordHistory(emptyHistory(), s0)
    const u = undoHistory(h, s1)!
    h = recordHistory(u.history, u.spec)
    expect(h.future).toHaveLength(0)
  })

  it('coalesces a burst of edits to the same input into one step', () => {
    const s0 = base()
    const s1 = renameKey(s0, 'b', 'p', none).spec
    const s2 = renameKey(s1, 'b', 'po', none).spec
    let h = recordHistory(emptyHistory(), s0, 'key:b', 1000)
    h = recordHistory(h, s1, 'key:b', 1400)
    expect(h.past).toHaveLength(1)
    expect(undoHistory(h, s2)?.spec).toBe(s0)
    // a pause starts a new step
    h = recordHistory(h, s2, 'key:b', 4000)
    expect(h.past).toHaveLength(2)
  })
})
