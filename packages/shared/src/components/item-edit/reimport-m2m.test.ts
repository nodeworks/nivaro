import { describe, expect, it } from 'vitest'
import { planReimportM2m } from './reimport-m2m'

const existing = [
  { junctionId: 541347, target: '2026' },
  { junctionId: 541348, target: '2025' }
]

describe('planReimportM2m', () => {
  it('overwrite replaces the stored set with the imported one', () => {
    expect(planReimportM2m(existing, [2027], 'overwrite')).toEqual({
      link: ['2027'],
      unlink: [541347, 541348]
    })
  })

  it('overwrite keeps a value that is already linked and only unlinks the rest', () => {
    expect(planReimportM2m(existing, ['2026'], 'overwrite')).toEqual({
      link: [],
      unlink: [541348]
    })
  })

  it('fill_empty adds only when nothing is linked yet', () => {
    expect(planReimportM2m(existing, [2027], 'fill_empty')).toEqual({ link: [], unlink: [] })
    expect(planReimportM2m([], [2027], 'fill_empty')).toEqual({ link: ['2027'], unlink: [] })
  })

  it('skip changes nothing', () => {
    expect(planReimportM2m(existing, [2027], 'skip')).toEqual({ link: [], unlink: [] })
  })

  it('an import that names no value leaves the stored links alone', () => {
    expect(planReimportM2m(existing, [], 'overwrite')).toEqual({ link: [], unlink: [] })
    expect(planReimportM2m(existing, [null, ''], 'overwrite')).toEqual({ link: [], unlink: [] })
  })

  it('de-duplicates imported ids and already-duplicated stored links', () => {
    const dup = [
      { junctionId: 1, target: '2026' },
      { junctionId: 2, target: '2026' }
    ]
    expect(planReimportM2m(dup, [2026, '2026'], 'overwrite')).toEqual({ link: [], unlink: [2] })
  })
})
