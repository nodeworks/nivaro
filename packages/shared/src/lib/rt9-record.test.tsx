// @vitest-environment jsdom
import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { helpChipText, helpChipTip } from '../components/item-edit/RecordHelpChip'
import { becauseWords, causeSentence, causeShown, changeWords } from './derived-causes'
import {
  __stopLiveLinkLabels,
  addChange,
  depsOfQuery,
  depTouched,
  FLUSH_MS,
  linkDepsOfPaths,
  realFields,
  templateFields,
  useLiveLinkLabels
} from './live-link-labels'
import { type CollectionUpdateEvent, type RealtimeAdapter, RealtimeContext } from './realtime'
import {
  __remoteUploads,
  __resetRemoteUploads,
  applyRemoteUpload,
  remoteUploadsFor,
  uploadSentence
} from './upload-presence'

// ─── #8 linked names ─────────────────────────────────────────────────────────

describe('linked-record names follow renames (rt9 #8)', () => {
  it('reads what a cached query shows', () => {
    expect(depsOfQuery(['relation-single', 'projects', '7', 'name'], null, undefined)).toEqual([
      { collection: 'projects', ids: ['7'] }
    ])
    expect(
      depsOfQuery(
        ['cbv-resolved', 'workflows', '1,2', 'project.name'],
        {
          rows: { 1: { 'project.name': { ids: ['7'] } }, 2: { 'project.name': { ids: ['8'] } } },
          targets: { 'project.name': 'projects' }
        },
        undefined
      )
    ).toEqual([{ collection: 'projects', ids: ['7', '8'], fields: ['name'] }])
    expect(
      depsOfQuery(['x'], null, { linkLabels: [{ collection: 'vendors', ids: ['3'] }] })
    ).toEqual([{ collection: 'vendors', ids: ['3'] }])
    expect(depsOfQuery(['item', 'projects', '7'], null, undefined)).toEqual([])
  })

  it('only a change to a name field of a shown record counts', () => {
    const dep = { collection: 'projects', ids: ['7'] }
    const name = ['name', 'number']
    const burst = (...evs: Array<[unknown, string[] | null]>) => {
      const p = new Map()
      for (const [item, fields] of evs) addChange(p, item, fields)
      return p
    }
    expect(depTouched(dep, burst([7, ['name']]), name)).toBe(true)
    expect(depTouched(dep, burst([7, ['budget']]), name)).toBe(false)
    // Another record's rename in the same burst does not count for this one.
    expect(depTouched(dep, burst([8, ['name']], [7, ['budget']]), name)).toBe(false)
    expect(depTouched(dep, burst(['*', null]), name)).toBe(true)
    expect(depTouched(dep, burst([7, null]), name)).toBe(true)
    // No template known: any field may be the name.
    expect(depTouched(dep, burst([7, ['budget']]), null)).toBe(true)
  })

  it('reads template fields, aspects and heading paths', () => {
    expect(templateFields('{{number}} – {{ vendor.name }}')).toEqual(['number', 'vendor'])
    expect(templateFields(null)).toBeNull()
    expect(
      realFields({ collection: 'p', item: 1, changed_fields: ['$comments'] } as never)
    ).toEqual([])
    expect(realFields({ collection: 'p', item: 1 } as never)).toBeNull()
    expect(
      linkDepsOfPaths(
        'workflows',
        ['project.name', 'vendor.name'],
        { project: { id: 7 }, vendor: 3 },
        [
          { many_collection: 'workflows', many_field: 'project', one_collection: 'projects' },
          { many_collection: 'workflows', many_field: 'vendor', one_collection: 'vendors' }
        ]
      )
    ).toEqual([
      { collection: 'projects', ids: ['7'], fields: ['name'] },
      { collection: 'vendors', ids: ['3'], fields: ['name'] }
    ])
  })

  afterEach(() => {
    __stopLiveLinkLabels()
    vi.useRealTimers()
  })

  it('a rename of a shown record re-reads its label once; other records and fields do not', async () => {
    vi.useFakeTimers()
    const listeners = new Map<string, (ev: CollectionUpdateEvent) => void>()
    const adapter = {
      subscribeCollections: (names: string[], cb: (ev: CollectionUpdateEvent) => void) => {
        for (const n of names) listeners.set(n, cb)
        return () => {
          for (const n of names) listeners.delete(n)
        }
      },
      on: () => () => {},
      emit: () => {}
    } as unknown as RealtimeAdapter
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    qc.setQueryData(['collection-meta', 'projects'], { display_template: '{{name}}' })
    let reads = 0
    function Chip() {
      useLiveLinkLabels()
      const { data } = useQuery({
        queryKey: ['relation-single', 'projects', '7', 'name'],
        queryFn: async () => {
          reads++
          return { id: 7, name: `P${reads}` }
        },
        staleTime: 60_000
      })
      return <span>{data?.name}</span>
    }
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    const root = createRoot(document.createElement('div'))
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <RealtimeContext.Provider value={adapter}>
            <Chip />
          </RealtimeContext.Provider>
        </QueryClientProvider>
      )
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(400)
    })
    expect(reads).toBe(1)
    const send = listeners.get('projects')
    expect(send).toBeTypeOf('function')
    await act(async () => {
      send?.({ collection: 'projects', item: 8, changed_fields: ['name'] } as never)
      send?.({ collection: 'projects', item: 7, changed_fields: ['budget'] } as never)
      send?.({ collection: 'projects', item: 7, changed_fields: ['$comments'] } as never)
      await vi.advanceTimersByTimeAsync(FLUSH_MS + 50)
    })
    expect(reads).toBe(1)
    await act(async () => {
      send?.({ collection: 'projects', item: 7, changed_fields: ['name'] } as never)
      send?.({ collection: 'projects', item: 7, changed_fields: ['name'] } as never)
      await vi.advanceTimersByTimeAsync(FLUSH_MS + 50)
    })
    expect(reads).toBe(2)
    act(() => root.unmount())
  })
})

// ─── #10 derived values ──────────────────────────────────────────────────────

describe('derived values explain themselves (rt9 #10)', () => {
  it('says how a date moved', () => {
    expect(changeWords({ from: '2026-11-12', to: '2026-11-14' }, 'date')).toBe('Moved 2 days later')
    expect(changeWords({ from: '2026-11-14', to: '2026-11-13' }, 'date')).toBe(
      'Moved 1 day earlier'
    )
    expect(
      changeWords({ from: '2026-11-14T10:00:00Z', to: '2026-11-14T13:00:00Z' }, 'timestamp')
    ).toBe('Moved 3 hours later')
    expect(changeWords({ from: null, to: '2026-11-14' }, 'date')).toBe('Filled in')
  })

  it('says how a number moved', () => {
    expect(changeWords({ from: 1000, to: 2200 }, 'decimal')).toBe('Up 1,200')
    expect(changeWords({ from: 50, to: 20.5 }, 'float')).toBe('Down 29.5')
    expect(changeWords({ from: 'a', to: 'b' }, 'string')).toBe('Changed')
  })

  it('names the cause in plain words', () => {
    const own = { field: 'po_due', label: 'PO due date', own: true }
    const other = {
      field: 'amount',
      label: 'Amount',
      collection_label: 'Line',
      record_label: 'Line 4',
      own: false
    }
    const hidden = { field: 'amount', label: 'Amount', collection_label: 'Line', own: false }
    expect(becauseWords([own])).toBe('because PO due date changed')
    expect(becauseWords([other])).toBe('because Amount on Line 4 changed')
    expect(becauseWords([hidden])).toBe('because a Line’s Amount changed')
    expect(becauseWords([own, other, hidden])).toBe(
      'because PO due date, Amount on Line 4 and 1 other changed'
    )
    expect(
      causeSentence(
        {
          field: 'need_by',
          kind: 'computed',
          from: '2026-11-12',
          to: '2026-11-14',
          at: new Date().toISOString(),
          inputs: [own]
        },
        'date'
      )
    ).toBe('Moved 2 days later because PO due date changed')
  })

  it('old notes are not shown', () => {
    const now = Date.parse('2026-11-15T12:00:00Z')
    expect(causeShown({ at: '2026-11-15T09:00:00Z' }, now)).toBe(true)
    expect(causeShown({ at: '2026-11-10T09:00:00Z' }, now)).toBe(false)
  })
})

// ─── #9 upload progress ─────────────────────────────────────────────────────

describe('co-viewers’ uploads (rt9 #9)', () => {
  afterEach(() => __resetRemoteUploads())

  it('keeps one entry per upload, updates its percent and drops it on finish', () => {
    const base = { collection: 'workflows', item: '5', user_name: 'Beth', upload: 'u1' }
    applyRemoteUpload({ ...base, name: 'quote.pdf', phase: 'start', state: 'start', pct: 0 })
    applyRemoteUpload({ ...base, name: 'quote.pdf', phase: 'progress', state: 'start', pct: 60 })
    let list = remoteUploadsFor(currentList(), 'workflows', '5')
    expect(list).toHaveLength(1)
    expect(uploadSentence(list[0])).toBe('Beth is uploading “quote.pdf” (60%)')
    applyRemoteUpload({ ...base, phase: 'cancel', state: 'done' })
    list = remoteUploadsFor(currentList(), 'workflows', '5')
    expect(list).toHaveLength(0)
  })

  it('a hidden name reads "a file"; older servers (no id, no percent) still work', () => {
    applyRemoteUpload({
      collection: 'workflows',
      item: '5',
      user_name: 'Beth',
      upload: 'u2',
      name: 'a file',
      name_hidden: true,
      phase: 'progress',
      pct: 30
    })
    applyRemoteUpload({
      collection: 'workflows',
      item: '5',
      user_name: 'Al',
      name: 'x.png',
      state: 'start'
    })
    const list = remoteUploadsFor(currentList(), 'workflows', '5')
    expect(list.map(uploadSentence)).toEqual([
      'Beth is uploading a file (30%)',
      'Al is uploading “x.png”'
    ])
  })
})

const currentList = () => __remoteUploads()

// ─── #19 help requested ─────────────────────────────────────────────────────

describe('help requested chip (rt9 #19)', () => {
  it('names the requester only when the viewer may see the request', () => {
    expect(helpChipText({ open: 0, tickets: [] })).toBeNull()
    expect(helpChipText({ open: 1, tickets: [] })).toBe('Help requested')
    const t = {
      id: 3,
      title: 'Wrong project',
      status: 'in_progress',
      requested_by: 'Beth Ames',
      requested_by_id: 'U1',
      assignee: 'Sam Lee',
      created_at: null
    }
    expect(helpChipText({ open: 2, tickets: [t] })).toBe('Help requested by Beth Ames +1')
    expect(helpChipTip({ open: 1, tickets: [t] })).toBe('“Wrong project” · Sam Lee is on it')
    expect(helpChipTip({ open: 1, tickets: [] })).toBe(
      'Someone asked the support team for help with this record.'
    )
  })
})
