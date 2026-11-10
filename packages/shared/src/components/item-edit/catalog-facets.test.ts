import { describe, expect, it } from 'vitest'
import {
  type FacetDef,
  facetOptions,
  facetResults,
  facetRowMatches,
  facetsComplete,
  setFacetPick
} from './catalog-facets'

const FACETS: FacetDef[] = [
  { key: 'color', label: 'Color' },
  { key: 'end_a', label: 'End A' },
  { key: 'end_b', label: 'End B' },
  { key: 'kind', label: 'Kind' }
]
const PAIR: [string, string] = ['end_a', 'end_b']
const row = (item: number, color: string, a: string, b: string, kind: string, size: number) => ({
  item,
  color,
  end_a: a,
  end_b: b,
  kind,
  size: `${size}M`,
  size_value: size
})
const ROWS = [
  row(1, 'Yellow', 'SC/A', 'LC/A', 'SIM', 5),
  row(2, 'Yellow', 'LC/A', 'SC/A', 'SIM', 3),
  row(3, 'Yellow', 'LC/A', 'SC/A', 'SIM', 10),
  row(4, 'Yellow', 'LC/A', 'LC/A', 'DUP', 2),
  row(5, 'Red', 'SC/A', 'LC/U', 'DUP', 0.5),
  row(6, 'Aqua', 'LC/U', 'LC/U', 'DUP', 1),
  row(7, 'Yellow', 'SC/A', 'LC/A', 'DUP', 5)
]

describe('symmetric pair — the order of the two ends never matters', () => {
  it('SC/A + LC/A matches SC/A-LC/A and LC/A-SC/A rows alike', () => {
    const picks = { end_a: 'SC/A', end_b: 'LC/A' }
    const swapped = { end_a: 'LC/A', end_b: 'SC/A' }
    const hit = ROWS.filter((r) => facetRowMatches(r, picks, FACETS, PAIR)).map((r) => r.item)
    const hitSwapped = ROWS.filter((r) => facetRowMatches(r, swapped, FACETS, PAIR)).map(
      (r) => r.item
    )
    expect(hit).toEqual([1, 2, 3, 7])
    expect(hitSwapped).toEqual(hit)
  })

  it('a same-connector pick (LC/A + LC/A) does not match LC/A-SC/A', () => {
    const hit = ROWS.filter((r) =>
      facetRowMatches(r, { end_a: 'LC/A', end_b: 'LC/A' }, FACETS, PAIR)
    )
    expect(hit.map((r) => r.item)).toEqual([4])
  })

  it('with one end picked, the other end offers whatever sits opposite it', () => {
    expect(facetOptions(ROWS, { end_a: 'SC/A' }, FACETS, 'end_b', PAIR)).toEqual(['LC/A', 'LC/U'])
    // picking the "second" end first works the same way round
    expect(facetOptions(ROWS, { end_b: 'SC/A' }, FACETS, 'end_a', PAIR)).toEqual(['LC/A', 'LC/U'])
  })

  it('with no end picked, both ends of every matching row are offered', () => {
    expect(facetOptions(ROWS, { color: 'Yellow' }, FACETS, 'end_a', PAIR)).toEqual(['LC/A', 'SC/A'])
  })
})

describe('every pick narrows the others', () => {
  it('color narrows connectors and kind', () => {
    expect(facetOptions(ROWS, { color: 'Red' }, FACETS, 'end_a', PAIR)).toEqual(['LC/U', 'SC/A'])
    expect(facetOptions(ROWS, { color: 'Aqua' }, FACETS, 'kind', PAIR)).toEqual(['DUP'])
  })

  it('kind narrows color', () => {
    expect(facetOptions(ROWS, { kind: 'SIM' }, FACETS, 'color', PAIR)).toEqual(['Yellow'])
  })

  it('changing a pick drops picks it made impossible, keeps the rest', () => {
    const picks = setFacetPick(
      ROWS,
      { end_a: 'LC/U', end_b: 'LC/U' },
      FACETS,
      'color',
      'Yellow',
      PAIR
    )
    expect(picks).toEqual({ color: 'Yellow', end_a: undefined, end_b: undefined })
    const keep = setFacetPick(ROWS, { end_a: 'SC/A' }, FACETS, 'color', 'Yellow', PAIR)
    expect(keep.end_a).toBe('SC/A')
  })
})

describe('results', () => {
  it('lists every matching row, sizes in numeric order', () => {
    const picks = { color: 'Yellow', end_a: 'LC/A', end_b: 'SC/A', kind: 'SIM' }
    expect(facetsComplete(picks, FACETS)).toBe(true)
    const out = facetResults(ROWS, picks, FACETS, {
      itemKey: 'item',
      labelKey: 'size',
      sortKey: 'size_value',
      symmetric: PAIR
    })
    expect(out.map((r) => r.size)).toEqual(['3M', '5M', '10M'])
  })

  it('a row without an item id is never offered', () => {
    const out = facetResults([{ ...ROWS[0], item: null }], {}, FACETS, {
      itemKey: 'item',
      labelKey: 'size'
    })
    expect(out).toEqual([])
  })

  it('incomplete picks are not complete', () => {
    expect(facetsComplete({ color: 'Red' }, FACETS)).toBe(false)
    expect(facetsComplete({}, [])).toBe(false)
  })
})
