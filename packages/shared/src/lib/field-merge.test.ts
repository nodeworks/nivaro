import { describe, expect, it } from 'vitest'
import {
  autoMerge,
  diffTextBlocks,
  fieldMergeKind,
  mergedSet,
  mergedText,
  mergeSetValues,
  setItemKey,
  setItems,
  setValueLike,
  textNeedsPicks
} from './field-merge'

describe('fieldMergeKind', () => {
  it('long text interfaces merge by line, rich text by paragraph', () => {
    expect(fieldMergeKind({ interface: 'textarea' }, 'a', 'b')).toBe('text')
    expect(fieldMergeKind({ interface: 'markdown' }, 'a', 'b')).toBe('text')
    expect(fieldMergeKind({ interface: 'wysiwyg' }, '<p>a</p>', '<p>b</p>')).toBe('rich')
    expect(fieldMergeKind({ interface: 'input-rich-text-html' }, '', '')).toBe('rich')
  })
  it('multi-value fields merge as sets', () => {
    expect(fieldMergeKind({ interface: 'tags' }, '["a"]', '["b"]')).toBe('set')
    expect(fieldMergeKind({ interface: 'select-multiple-dropdown' }, ['a'], ['b'])).toBe('set')
    expect(fieldMergeKind({ type: 'json' }, ['a', 1], ['b'])).toBe('set')
    expect(fieldMergeKind({ type: 'csv', interface: 'x' }, 'a,b', 'c')).toBe('set')
  })
  it('numbers, dates, single choices and links never merge', () => {
    expect(fieldMergeKind({ type: 'integer', interface: 'input' }, 1, 2)).toBe('none')
    expect(fieldMergeKind({ type: 'decimal' }, '1.5', '2')).toBe('none')
    expect(
      fieldMergeKind({ type: 'date', interface: 'datetime' }, '2026-01-01', '2026-02-01')
    ).toBe('none')
    expect(fieldMergeKind({ interface: 'select-dropdown', type: 'string' }, 'a', 'b')).toBe('none')
    expect(fieldMergeKind({ interface: 'select-dropdown-m2o', type: 'uuid' }, 'x', 'y')).toBe(
      'none'
    )
    expect(fieldMergeKind({ type: 'boolean' }, true, false)).toBe('none')
  })
  it('a list of objects is not a set', () => {
    expect(fieldMergeKind({ type: 'json' }, [{ a: 1 }], [{ a: 2 }])).toBe('none')
    expect(fieldMergeKind({ interface: 'tags' }, '[{"a":1}]', '["b"]')).toBe('none')
  })
  it('plain text with line breaks merges by line; one-liners do not', () => {
    expect(fieldMergeKind({ type: 'text', interface: 'input' }, 'a\nb', 'a')).toBe('text')
    expect(fieldMergeKind({ type: 'string', interface: 'input' }, 'Acme', 'Acme Ltd')).toBe('none')
  })
})

describe('set merge', () => {
  it('reads every stored shape', () => {
    expect(setItems(['a', 'b'])).toEqual(['a', 'b'])
    expect(setItems('["a","b"]')).toEqual(['a', 'b'])
    expect(setItems('a, b')).toEqual(['a', 'b'])
    expect(setItems(null)).toEqual([])
    expect(setValueLike(['a'], ['x'])).toEqual(['a'])
    expect(setValueLike(['a', 'b'], '["x"]')).toBe('["a","b"]')
    expect(setValueLike(['a', 'b'], 'x,y')).toBe('a,b')
    expect(setValueLike([], '["x"]')).toBeNull()
  })
  it('unions additions from both sides', () => {
    const items = mergeSetValues(['a'], ['a', 'mine'], ['a', 'theirs'])
    expect(mergedSet(items)).toEqual(['a', 'theirs', 'mine'])
    expect(items.find((i) => i.value === 'mine')?.addedBy).toBe('mine')
    expect(items.find((i) => i.value === 'theirs')?.addedBy).toBe('theirs')
  })
  it('honours a removal by either side and lists it so it can be put back', () => {
    const items = mergeSetValues(['a', 'b', 'c'], ['a', 'c', 'x'], ['a', 'b'])
    // I removed b, they removed c, I added x.
    expect(mergedSet(items)).toEqual(['a', 'x'])
    const b = items.find((i) => i.value === 'b')
    const c = items.find((i) => i.value === 'c')
    expect(b?.removedBy).toBe('mine')
    expect(c?.removedBy).toBe('theirs')
    expect(b?.keep).toBe(false)
    // The person keeps c after all.
    const flips = new Map([[setItemKey('c'), true]])
    expect(mergedSet(items, flips)).toEqual(['a', 'c', 'x'])
  })
  it('without a base is a plain union', () => {
    expect(mergedSet(mergeSetValues(undefined, ['a', 'b'], ['b', 'c']))).toEqual(['b', 'c', 'a'])
  })
  it('something both removed is not offered', () => {
    expect(mergeSetValues(['a', 'b'], ['a'], ['a']).map((i) => i.value)).toEqual(['a'])
  })
  it('keeps numbers apart from their string spelling', () => {
    expect(mergedSet(mergeSetValues([], [1], ['1']))).toEqual(['1', 1])
  })
})

describe('text merge', () => {
  const base = 'Intro\nStep one\nStep two\nOutro'
  it('takes the side that changed a line when only one did', () => {
    const mine = 'Intro\nStep one (checked)\nStep two\nOutro'
    const theirs = 'Intro\nStep one\nStep two\nOutro, signed'
    const hunks = diffTextBlocks(base, mine, theirs, false)
    expect(textNeedsPicks(hunks)).toBe(false)
    expect(mergedText(hunks, new Map(), false)).toBe(
      'Intro\nStep one (checked)\nStep two\nOutro, signed'
    )
  })
  it('a line both changed is a conflict the person picks; default keeps both', () => {
    const mine = 'Intro\nStep one — mine\nStep two\nOutro'
    const theirs = 'Intro\nStep one — theirs\nStep two\nOutro'
    const hunks = diffTextBlocks(base, mine, theirs, false)
    expect(textNeedsPicks(hunks)).toBe(true)
    const idx = hunks.findIndex((h) => h.conflict)
    expect(mergedText(hunks, new Map(), false)).toBe(
      'Intro\nStep one — mine\nStep one — theirs\nStep two\nOutro'
    )
    expect(mergedText(hunks, new Map([[idx, 'theirs']]), false)).toBe(theirs)
    expect(mergedText(hunks, new Map([[idx, 'mine']]), false)).toBe(mine)
  })
  it('a deletion on one side and an addition on the other both land', () => {
    const mine = 'Intro\nStep two\nOutro' // I deleted step one
    const theirs = 'Intro\nStep one\nStep two\nStep three\nOutro' // they added step three
    const out = autoMerge('text', base, mine, theirs)
    expect(out).toBe('Intro\nStep two\nStep three\nOutro')
  })
  it('neighbouring changed lines are judged one by one', () => {
    const b = 'Survey\nOrder cabinet\nBook crew for Tuesday'
    const mine = 'Survey\nOrder cabinet (42U)\nBook crew for Tuesday'
    const theirs = 'Survey\nOrder cabinet (24U)\nBook crew for Wednesday'
    const hunks = diffTextBlocks(b, mine, theirs, false)
    expect(hunks.filter((h) => h.conflict)).toHaveLength(1)
    const idx = hunks.findIndex((h) => h.conflict)
    expect(mergedText(hunks, new Map([[idx, 'mine']]), false)).toBe(
      'Survey\nOrder cabinet (42U)\nBook crew for Wednesday'
    )
  })
  it('rich text merges per paragraph', () => {
    const b = '<p>One</p><p>Two</p><p>Three</p>'
    const mine = '<p>One!</p><p>Two</p><p>Three</p>'
    const theirs = '<p>One</p><p>Two</p><p>Three</p><p>Four</p>'
    expect(autoMerge('rich', b, mine, theirs)).toBe('<p>One!</p><p>Two</p><p>Three</p><p>Four</p>')
  })
  it('without a base every difference is the person’s pick', () => {
    const hunks = diffTextBlocks(undefined, 'a\nb', 'a\nc', false)
    expect(hunks.filter((h) => h.conflict)).toHaveLength(1)
  })
  it('identical text is one shared hunk', () => {
    const hunks = diffTextBlocks('x', 'a\nb', 'a\nb', false)
    expect(hunks).toHaveLength(1)
    expect(hunks[0].same).toBe(true)
  })
})

describe('autoMerge', () => {
  it('sets come back in the field’s own shape', () => {
    expect(autoMerge('set', '["a"]', '["a","b"]', '["a","c"]')).toBe('["a","c","b"]')
  })
  it('a field that cannot merge keeps the person’s value', () => {
    expect(autoMerge('none', 1, 2, 3)).toBe(2)
  })
})

describe('rich text merge kinds (round 8 review)', () => {
  it("the record form's rich_text interfaces merge by paragraph", () => {
    expect(fieldMergeKind({ interface: 'rich_text', type: 'text' }, '<p>a</p>', '<p>b</p>')).toBe(
      'rich'
    )
    expect(fieldMergeKind({ interface: 'rich-text-html' }, '<p>a</p>', '<p>b</p>')).toBe('rich')
  })
  it('with no field meta yet, paragraph markup on both sides is still rich text', () => {
    expect(fieldMergeKind(null, '<p>a</p><p>b</p>', '<p>a</p><p>c</p>')).toBe('rich')
    expect(fieldMergeKind(null, 'plain', 'other')).toBe('none')
  })
})
