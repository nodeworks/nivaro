// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, createElement, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  cellSearchTexts,
  extraSearchRows,
  GRID_READ_LIMIT,
  GRID_SEARCH_LIMIT,
  GridSearchBox,
  type GridServerSearch,
  matchRanges,
  pendingRowVisibility,
  searchWords,
  textMatchesWords,
  useGridChildTotal,
  useGridServerSearch
} from './grid-search'
import type { CMSField } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const col = (over: Partial<CMSField>): CMSField =>
  ({ field: 'f', type: 'string', interface: 'input', ...over }) as CMSField

/** The text the grid's client filter searches for one row (as InlineTableField builds it). */
const rowText = (
  row: Record<string, unknown>,
  cols: CMSField[],
  labels: Record<string, Record<string, string>> = {}
) =>
  cols
    .flatMap((c) =>
      cellSearchTexts(c, row[c.field], { m2oLabel: labels[c.field]?.[String(row[c.field])] })
    )
    .join('\n')

describe('grid search — client filter', () => {
  it('splits the search into lowercased words, every one of which must match', () => {
    expect(searchWords('  Unit  42 unit ')).toEqual(['unit', '42'])
    expect(searchWords('')).toEqual([])
    expect(textMatchesWords('Rack A\nUnit 42', ['unit', 'rack'])).toBe(true)
    expect(textMatchesWords('Rack A\nUnit 42', ['unit', 'shelf'])).toBe(false)
    expect(textMatchesWords('anything', [])).toBe(true)
  })

  it('finds a row by the LABEL a relation cell shows, not only its id', () => {
    const cols = [col({ field: 'model', type: 'integer', interface: 'select-dropdown-m2o' })]
    const labels = { model: { '7': 'Cisco CBR-8' } }
    expect(textMatchesWords(rowText({ model: 7 }, cols, labels), searchWords('cbr-8'))).toBe(true)
    expect(textMatchesWords(rowText({ model: 8 }, cols, labels), searchWords('cbr-8'))).toBe(false)
  })

  it('finds a row by a choice label, Yes/No, a formatted date or a formatted number', () => {
    const status = col({
      field: 'status',
      interface: 'select-dropdown',
      options: { choices: [{ text: 'In Service', value: 'in_service' }] } as never
    })
    expect(cellSearchTexts(status, 'in_service')).toContain('In Service')
    expect(cellSearchTexts(col({ type: 'boolean' }), true)).toContain('Yes')
    expect(cellSearchTexts(col({ type: 'boolean' }), false)).toContain('No')
    expect(cellSearchTexts(col({ type: 'date' }), '2026-06-30')).toContain('Jun 30, 2026')
    const amount = col({ type: 'decimal', options: { format: 'currency' } as never })
    const texts = cellSearchTexts(amount, '1234.5')
    expect(texts).toContain('1234.5')
    expect(texts).toContain('1,234.5')
    expect(texts.some((t) => t.startsWith('$1,234.5'))).toBe(true)
    expect(cellSearchTexts(col({ type: 'integer' }), 25000)).toContain('25,000')
  })

  it('an empty cell or an object value adds nothing; presence columns read Yes/No', () => {
    expect(cellSearchTexts(col({}), null)).toEqual([])
    expect(cellSearchTexts(col({}), '')).toEqual([])
    expect(cellSearchTexts(col({}), [1, 2])).toEqual([])
    const presence = col({ interface: 'relation-path', options: { display: 'presence' } as never })
    expect(cellSearchTexts(presence, null)).toEqual(['No'])
    expect(cellSearchTexts(presence, 'PO-1')).toEqual(['Yes'])
  })
})

describe('grid search — unsaved rows', () => {
  it('unsaved rows the person added stay in view (dimmed) when they do not match', () => {
    expect(
      pendingRowVisibility({ name: 'x' }, { searching: true, matches: false, editing: false })
    ).toBe('dim')
    expect(
      pendingRowVisibility({ name: 'x' }, { searching: true, matches: true, editing: false })
    ).toBe('show')
    expect(
      pendingRowVisibility({ name: 'x' }, { searching: false, matches: false, editing: false })
    ).toBe('show')
  })
  it('the row being edited always shows', () => {
    expect(
      pendingRowVisibility(
        { __prefilled: true },
        { searching: true, matches: false, editing: true }
      )
    ).toBe('show')
  })
  it('a prefilled row (an addendum seeding the saved lines) is searched like a saved one', () => {
    expect(
      pendingRowVisibility(
        { __prefilled: true },
        { searching: true, matches: false, editing: false }
      )
    ).toBe('hide')
  })
})

describe('grid search — rows found by the server', () => {
  it('adds only rows the grid does not already hold, held rows after found ones', () => {
    const loaded = [{ id: 1 }, { id: 2 }]
    const found = [{ id: 2 }, { id: 900 }, { id: 901 }]
    expect(extraSearchRows(loaded, found, [{ id: 901 }, { id: 950 }]).map((r) => r.id)).toEqual([
      900, 901, 950
    ])
    expect(extraSearchRows(loaded, undefined)).toEqual([])
  })
})

// ── Server search for a grid holding a partial set ─────────────────────────
type Cmd = { _method: string; _path: string; _params?: Record<string, unknown> }

function mountHook<T>(useIt: () => T): { get: () => T; unmount: () => void } {
  const el = document.createElement('div')
  const root = createRoot(el)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let last: T
  function Probe() {
    last = useIt()
    return null
  }
  act(() => {
    root.render(createElement(QueryClientProvider, { client: qc }, createElement(Probe)))
  })
  return { get: () => last, unmount: () => act(() => root.unmount()) }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => await new Promise((r) => setTimeout(r, 0)))
}

describe('useGridServerSearch', () => {
  afterEach(() => vi.restoreAllMocks())

  it('asks the grid’s own child read with the list `search`, as the viewer', async () => {
    const calls: Cmd[] = []
    const client = {
      request: async (cmd: Cmd) => {
        calls.push(cmd)
        return { data: [{ id: 901, name: 'Unit 4242' }], total: 3 }
      }
    } as never
    const filter = { unit_type: { _eq: '17' } }
    const h = mountHook<GridServerSearch>(() =>
      useGridServerSearch({
        client,
        collection: 'units',
        filter,
        query: 'unit 4242',
        enabled: true,
        version: 1
      })
    )
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]._method).toBe('GET')
    expect(calls[0]._path).toBe('/items/units')
    expect(calls[0]._params).toEqual({
      filter: JSON.stringify(filter),
      search: 'unit 4242',
      limit: GRID_SEARCH_LIMIT
    })
    expect(h.get().rows).toEqual([{ id: 901, name: 'Unit 4242' }])
    expect(h.get().total).toBe(3)
    h.unmount()
  })

  it('never asks while the grid holds every row, or with an empty search', async () => {
    const request = vi.fn(async () => ({ data: [] }))
    const client = { request } as never
    const a = mountHook(() =>
      useGridServerSearch({
        client,
        collection: 'units',
        filter: {},
        query: 'x',
        enabled: false,
        version: 1
      })
    )
    const b = mountHook(() =>
      useGridServerSearch({
        client,
        collection: 'units',
        filter: {},
        query: '  ',
        enabled: true,
        version: 1
      })
    )
    await flush()
    expect(request).not.toHaveBeenCalled()
    expect(a.get().rows).toBeUndefined()
    expect(b.get().rows).toBeUndefined()
    a.unmount()
    b.unmount()
  })

  it('reports a failed search instead of throwing', async () => {
    const client = {
      request: async () => {
        throw Object.assign(new Error('boom'), { status: 500 })
      }
    } as never
    const h = mountHook(() =>
      useGridServerSearch({
        client,
        collection: 'units',
        filter: {},
        query: 'x',
        enabled: true,
        version: 1
      })
    )
    await flush()
    expect(h.get().error).toBeTruthy()
    expect(h.get().rows).toBeUndefined()
    h.unmount()
  })

  it('counts every child of a partial grid with a one-row read', async () => {
    const calls: Cmd[] = []
    const client = {
      request: async (cmd: Cmd) => {
        calls.push(cmd)
        return { data: [{ id: 1 }], total: 2341 }
      }
    } as never
    const h = mountHook(() =>
      useGridChildTotal({
        client,
        collection: 'units',
        filter: { a: 1 },
        enabled: true,
        version: 1
      })
    )
    await flush()
    expect(calls[0]._params).toEqual({ filter: '{"a":1}', fields: 'id', limit: 1 })
    expect(h.get()).toBe(2341)
    h.unmount()
    expect(GRID_READ_LIMIT).toBe(200)
  })
})

// ── The box and the marks ───────────────────────────────────────────────────
describe('GridSearchBox', () => {
  it('shows "N of M rows", and Esc clears the search', () => {
    const el = document.createElement('div')
    document.body.appendChild(el)
    const root = createRoot(el)
    const onChange = vi.fn()
    function Box(props: { value: string }) {
      const ref = useRef<HTMLInputElement | null>(null)
      return createElement(GridSearchBox, {
        value: props.value,
        onChange,
        inputRef: ref,
        searching: props.value !== '',
        shown: 12,
        total: 2341,
        loaded: 200,
        loadedOf: 2341
      })
    }
    act(() => root.render(createElement(Box, { value: '' })))
    expect(el.textContent).toContain('200 of 2,341 loaded')
    act(() => root.render(createElement(Box, { value: 'unit' })))
    expect(el.textContent).toContain('12 of 2,341 rows')
    const input = el.querySelector('input') as HTMLInputElement
    act(() => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    expect(onChange).toHaveBeenCalledWith('')
    act(() => root.unmount())
    el.remove()
  })
})

describe('matchRanges', () => {
  it('marks every occurrence of every word inside the cells, case-insensitively', () => {
    const td = document.createElement('td')
    td.innerHTML = '<span>Unit 42</span> — <button>UNIT rack</button>'
    const ranges = matchRanges([td], ['unit', 'rack'])
    expect(ranges.map((r) => r.toString())).toEqual(['Unit', 'UNIT', 'rack'])
    expect(matchRanges([td], [])).toEqual([])
  })
})
