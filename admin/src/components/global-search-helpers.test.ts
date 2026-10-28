import { beforeEach, describe, expect, it } from 'vitest'
import {
  altDigit,
  commandRequest,
  extraHref,
  extraTabs,
  forgetRecentSearch,
  isNewTabEnter,
  nextRecall,
  personMeta,
  pushRecentRecord,
  pushRecentSearch,
  queryChips,
  readRecentRecords,
  readRecentSearches,
  recordFromPath,
  recordsCsv,
  type SearchCommand,
  type SearchRecord,
  sortRecords,
  toCsv,
  whyMatched
} from './global-search-helpers'

// Node test env: a tiny in-memory localStorage.
beforeEach(() => {
  const store = new Map<string, string>()
  ;(globalThis as { localStorage?: Storage }).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: () => null,
    length: 0
  } as Storage
})

const rec = (p: Partial<SearchRecord>): SearchRecord => ({
  collection: 'workflows',
  id: 1,
  label: 'WF-1',
  snippet: '',
  ...p
})

describe('recents', () => {
  it('keeps the last 8 opened records, newest first, one copy each', () => {
    for (let i = 1; i <= 10; i++)
      pushRecentRecord({ collection: 'wf', id: String(i), label: `#${i}` })
    pushRecentRecord({ collection: 'wf', id: '5', label: '#5 again' })
    const list = readRecentRecords()
    expect(list).toHaveLength(8)
    expect(list[0]).toMatchObject({ id: '5', label: '#5 again' })
    expect(list.filter((r) => r.id === '5')).toHaveLength(1)
  })

  it('keeps the last 5 searches, case-insensitively deduped, and forgets one', () => {
    for (const q of ['po 1', 'PO 1', 'a', 'vendor', 'acme', 'units', 'zones']) pushRecentSearch(q)
    expect(readRecentSearches()).toEqual(['zones', 'units', 'acme', 'vendor', 'PO 1'])
    expect(forgetRecentSearch('acme')).toEqual(['zones', 'units', 'vendor', 'PO 1'])
  })

  it('survives garbage in storage', () => {
    localStorage.setItem('nvr_palette_recent_records', '{nope')
    expect(readRecentRecords()).toEqual([])
    localStorage.setItem('nvr_palette_recent_searches', JSON.stringify([1, '', 'ok']))
    expect(readRecentSearches()).toEqual(['ok'])
  })

  it('reads a record from its path, never /new', () => {
    expect(recordFromPath('/collections/workflows/42')).toEqual({
      collection: 'workflows',
      id: '42'
    })
    expect(recordFromPath('/collections/workflows/new')).toBeNull()
    expect(recordFromPath('/settings')).toBeNull()
  })

  it('recalls searches with ↑ like a shell', () => {
    const r = ['c', 'b', 'a']
    expect(nextRecall(r, '')).toBe('c')
    expect(nextRecall(r, 'c')).toBe('b')
    expect(nextRecall(r, 'a')).toBeNull()
    expect(nextRecall(r, 'typed')).toBeNull()
    expect(nextRecall([], '')).toBeNull()
  })
})

describe('keyboard', () => {
  it('reads Alt+digit from the key code (Mac Option types a symbol)', () => {
    expect(altDigit({ altKey: true, code: 'Digit1' })).toBe(0)
    expect(altDigit({ altKey: true, code: 'Numpad9' })).toBe(8)
    expect(altDigit({ altKey: true, code: 'Digit0' })).toBeNull()
    expect(altDigit({ altKey: false, code: 'Digit1' })).toBeNull()
    expect(altDigit({ altKey: true, metaKey: true, code: 'Digit1' })).toBeNull()
  })

  it('opens in a new tab on Cmd/Ctrl+Enter only', () => {
    expect(isNewTabEnter({ key: 'Enter', metaKey: true, ctrlKey: false })).toBe(true)
    expect(isNewTabEnter({ key: 'Enter', metaKey: false, ctrlKey: true })).toBe(true)
    expect(isNewTabEnter({ key: 'Enter', metaKey: false, ctrlKey: false })).toBe(false)
  })
})

describe('whyMatched', () => {
  it('says exact first, then the field and value, else nothing', () => {
    expect(whyMatched(rec({ exact: true, matched_label: 'ID' }))).toBe('Exact ID match')
    expect(whyMatched(rec({ matched_label: 'Vendor', matched_value: 'Acme' }))).toBe('Vendor: Acme')
    expect(whyMatched(rec({ matched_field: 'po_number' }))).toBe('Matched Po number')
    expect(whyMatched(rec({}))).toBeNull()
  })
})

describe('extra kinds', () => {
  it('lists only kinds with hits, in a fixed order', () => {
    const hit = { kind: 'x', id: '1', label: 'L', href: '/x' }
    const tabs = extraTabs({ files: [hit], comments: [hit, hit], chat: [] })
    expect(tabs.map((t) => [t.key, t.count])).toEqual([
      ['extra:comments', '2'],
      ['extra:files', '1']
    ])
    expect(extraTabs(undefined)).toEqual([])
  })

  it('maps efp-new record links onto admin paths unless admin_href is given', () => {
    const base = { kind: 'comment', id: '1', label: 'L' }
    expect(extraHref({ ...base, href: '/records/wf/9?comment=3' })).toBe(
      '/collections/wf/9?comment=3'
    )
    expect(extraHref({ ...base, href: '/records/wf/9', admin_href: '/a' })).toBe('/a')
    expect(extraHref({ ...base, href: '/help-videos?watch=2' })).toBe('/help-videos?watch=2')
  })
})

describe('personMeta', () => {
  it('joins role, zones and title, capping zones', () => {
    expect(personMeta({ role_name: 'PM', zones: ['A', 'B', 'C', 'D'], title: 'Lead' })).toBe(
      'PM · A, B +2 · Lead'
    )
    expect(personMeta({ email: 'a@x' })).toBe('a@x')
    expect(personMeta({})).toBe('')
  })
})

describe('queryChips', () => {
  const label = (s: string) => (s === 'workflows' ? 'Workflows' : s)
  it('shows the scope and each filter, and the text without each', () => {
    const chips = queryChips(
      'wf: vendor:acme amount:"12,500" pump',
      {
        text: 'pump',
        scope: 'workflows',
        filters: [
          { field: 'vendor', label: 'Vendor', op: 'contains', value: 'acme' },
          { field: 'amount', label: 'Amount', op: 'gte', value: '$12,500' }
        ]
      },
      label
    )
    expect(chips.map((c) => c.label)).toEqual(['Workflows', 'Vendor ∋ acme', 'Amount ≥ $12,500'])
    expect(chips[0].without).toBe('vendor:acme amount:"12,500" pump')
    expect(chips[1].without).toBe('wf: amount:"12,500" pump')
    expect(chips[2].without).toBe('wf: vendor:acme pump')
  })

  it('matches a filter typed by its label slug, and gives null when not found', () => {
    const chips = queryChips(
      'project_type:new',
      {
        text: '',
        scope: null,
        filters: [
          { field: 'type_id', label: 'Project type', op: 'eq', value: 'New' },
          { field: 'x', label: 'Gone', op: 'eq', value: '1' }
        ]
      },
      label
    )
    expect(chips[0].without).toBe('')
    expect(chips[1].without).toBeNull()
    expect(queryChips('x', null, label)).toEqual([])
  })
})

describe('commandRequest', () => {
  const cmd = (p: Partial<SearchCommand>): SearchCommand => ({
    id: 'c1',
    label: 'Do',
    kind: 'transition',
    collection: 'workflows',
    item: '7',
    confirm: 'Sure?',
    payload: {},
    ...p
  })

  it('runs a transition through the pipeline route with the note', () => {
    expect(commandRequest(cmd({ payload: { transition_id: 't9' } }), ' ok ')).toEqual({
      kind: 'post',
      url: '/pipelines/instance/workflows/7/transition',
      body: { transition_id: 't9', comment: 'ok' }
    })
  })

  it('runs a hold through the registry route (db or code)', () => {
    expect(commandRequest(cmd({ kind: 'hold', payload: { key: 'on_hold' } }))).toEqual({
      kind: 'post',
      url: '/bulk-actions/run',
      body: { collection: 'workflows', ids: ['7'], reason: null, key: 'on_hold' }
    })
    expect(
      commandRequest(cmd({ kind: 'hold', payload: { key: 'hold', source: 'code' } }), 'why')
    ).toEqual({
      kind: 'post',
      url: '/bulk-actions/hold/execute',
      body: { collection: 'workflows', ids: ['7'], reason: 'why' }
    })
  })

  it('assigns through the owners route and creates by navigating', () => {
    expect(commandRequest(cmd({ kind: 'assign', payload: { user_id: 'u1' } }))).toEqual({
      kind: 'post',
      url: '/pipelines/instance/workflows/7/owners',
      body: { user: 'u1' }
    })
    expect(commandRequest(cmd({ kind: 'create', item: undefined }))).toEqual({
      kind: 'navigate',
      path: '/collections/workflows/new'
    })
  })

  it('refuses what it cannot run', () => {
    expect(commandRequest(cmd({ payload: {} }))).toBeNull()
    expect(
      commandRequest(cmd({ kind: 'assign', item: undefined, payload: { user: 'u' } }))
    ).toBeNull()
    expect(commandRequest(cmd({ kind: 'hold', payload: null }))).toBeNull()
  })
})

describe('csv + sort', () => {
  it('escapes quotes, commas and formula starts', () => {
    expect(
      toCsv(
        ['a', 'b'],
        [
          ['x,y', 'say "hi"'],
          ['=1+1', null]
        ]
      )
    ).toBe('a,b\r\n"x,y","say ""hi"""\r\n\'=1+1,')
    expect(
      recordsCsv([rec({ matched_label: 'Vendor', matched_value: 'Acme', snippet: 's' })])
    ).toBe(
      'Collection,ID,Label,Matched field,Matched value,Snippet,Updated\r\nworkflows,1,WF-1,Vendor,Acme,s,'
    )
  })

  it('sorts newest first on the loaded rows, undated last', () => {
    const rows = [
      rec({ id: 1 }),
      rec({ id: 2, updated_at: '2026-10-01T00:00:00Z' }),
      rec({ id: 3, updated_at: '2026-10-20T00:00:00Z' })
    ]
    expect(sortRecords(rows, 'newest').map((r) => r.id)).toEqual([3, 2, 1])
    expect(sortRecords(rows, 'relevance')).toBe(rows)
  })
})
