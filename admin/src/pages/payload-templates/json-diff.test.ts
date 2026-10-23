import { describe, expect, it } from 'vitest'
import {
  countChanges,
  diffLines,
  jsonErrorAt,
  jsonErrorOffset,
  pathChanges,
  prettyBody,
  segmentDiff,
  shortValue
} from './json-diff'

describe('prettyBody', () => {
  it('keeps text as it is and pretty-prints JSON', () => {
    expect(prettyBody('{{ x }}')).toBe('{{ x }}')
    expect(prettyBody({ a: 1 })).toBe('{\n  "a": 1\n}')
    expect(prettyBody(null)).toBe('null')
    expect(prettyBody(undefined)).toBe('')
  })
})

describe('diffLines', () => {
  it('marks one changed line between a shared head and tail', () => {
    const a = prettyBody({ a: 1, b: 2, c: 3 })
    const b = prettyBody({ a: 1, b: 5, c: 3 })
    const out = diffLines(a, b)
    expect(out).not.toBeNull()
    expect(out?.filter((l) => l.kind !== 'same')).toEqual([
      { kind: 'del', text: '  "b": 2,' },
      { kind: 'add', text: '  "b": 5,' }
    ])
    expect(countChanges(out ?? [])).toEqual({ added: 1, removed: 1 })
  })

  it('treats an empty side as nothing (every line added)', () => {
    const out = diffLines('', 'x\ny')
    expect(out).toEqual([
      { kind: 'add', text: 'x' },
      { kind: 'add', text: 'y' }
    ])
  })

  it('returns every line unchanged for equal texts', () => {
    const out = diffLines('a\nb', 'a\nb')
    expect(out?.every((l) => l.kind === 'same')).toBe(true)
  })

  it('gives up (null) when the changed middle is too large', () => {
    const a = Array.from({ length: 3000 }, (_, i) => `a${i}`).join('\n')
    const b = Array.from({ length: 3000 }, (_, i) => `b${i}`).join('\n')
    expect(diffLines(a, b)).toBeNull()
  })

  it('stays cheap for a small edit in a very long body', () => {
    const lines = Array.from({ length: 20000 }, (_, i) => `l${i}`)
    const b = [...lines]
    b[10000] = 'changed'
    const out = diffLines(lines.join('\n'), b.join('\n'))
    expect(out && countChanges(out)).toEqual({ added: 1, removed: 1 })
  })
})

describe('segmentDiff', () => {
  it('folds long unchanged runs and keeps context around changes', () => {
    const a = Array.from({ length: 20 }, (_, i) => `l${i}`)
    const b = [...a]
    b[10] = 'X'
    const segs = segmentDiff(diffLines(a.join('\n'), b.join('\n')) ?? [], 2)
    expect(segs.map((s) => [s.kind, s.lines.length])).toEqual([
      ['fold', 8],
      ['lines', 6],
      ['fold', 7]
    ])
  })

  it('never folds one or two lines', () => {
    const segs = segmentDiff(
      [
        { kind: 'same', text: 'a' },
        { kind: 'same', text: 'b' },
        { kind: 'add', text: 'c' }
      ],
      0
    )
    expect(segs).toEqual([
      {
        kind: 'lines',
        lines: [
          { kind: 'same', text: 'a' },
          { kind: 'same', text: 'b' },
          { kind: 'add', text: 'c' }
        ]
      }
    ])
  })
})

describe('pathChanges', () => {
  it('lists added, removed and changed paths in order', () => {
    const { changes, total } = pathChanges(
      { a: 1, b: { c: 'x', d: [1, 2] }, gone: true },
      { a: 1, b: { c: 'y', d: [1] }, 'odd key': 3 }
    )
    expect(total).toBe(4)
    expect(changes).toEqual([
      { path: 'b.c', kind: 'changed', before: 'x', after: 'y' },
      { path: 'b.d[1]', kind: 'removed', before: 2 },
      { path: 'gone', kind: 'removed', before: true },
      { path: '["odd key"]', kind: 'added', after: 3 }
    ])
  })

  it('reports a type change as one change and caps the list', () => {
    expect(pathChanges({ a: [1] }, { a: { x: 1 } }).changes).toEqual([
      { path: 'a', kind: 'changed', before: [1], after: { x: 1 } }
    ])
    const many = pathChanges(
      Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`k${i}`, i])),
      {},
      3
    )
    expect(many.total).toBe(10)
    expect(many.changes).toHaveLength(3)
  })

  it('names a whole-body change', () => {
    expect(pathChanges('a', 'b').changes[0].path).toBe('(whole body)')
    expect(pathChanges({ a: 1 }, { a: 1 }).total).toBe(0)
  })
})

describe('shortValue', () => {
  it('quotes strings and trims long values', () => {
    expect(shortValue('x')).toBe('"x"')
    expect(shortValue(undefined)).toBe('—')
    expect(shortValue('a'.repeat(100), 10)).toBe('"aaaaaaaa…')
  })
})

describe('jsonErrorAt', () => {
  it('reads the position from the parser message', () => {
    const text = '{\n  "a": 1,\n  }'
    let err: unknown
    try {
      JSON.parse(text)
    } catch (e) {
      err = e
    }
    const at = jsonErrorAt(text, err)
    expect(at?.line).toBe(3)
  })

  it('points at the trailing comma, the bad token and the missing close', () => {
    expect(jsonErrorAt('{\n  "a": 1,\n}', null)).toEqual({ line: 3, column: 1 })
    expect(jsonErrorAt('{"a": tru}', null)).toEqual({ line: 1, column: 7 })
    expect(jsonErrorAt('[1, 2', null)).toEqual({ line: 1, column: 6 })
    expect(jsonErrorAt('{"a": "x\\q"}', null)?.column).toBe(10)
    expect(jsonErrorOffset('{"a": [1, {"b": null}], "c": -1.5e3}')).toBeNull()
    expect(jsonErrorOffset('{} x')).toBe(3)
  })
})
