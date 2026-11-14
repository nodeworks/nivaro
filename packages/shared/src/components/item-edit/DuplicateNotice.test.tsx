// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DrilldownContext, NivaroProvider } from '../../context'
import { ImportDuplicatesNotice } from '../imports/ImportDuplicatesNotice'
import {
  DUPLICATE_DEBOUNCE_MS,
  type DuplicateHint,
  DuplicateNotice,
  useDuplicateCheck,
  watchedValues
} from './DuplicateNotice'

// Rob 2026-11-13: a new record whose name already exists says so under the field.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const tick = async () => {
  for (let i = 0; i < 10; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

const hint = (over: Partial<DuplicateHint> = {}): DuplicateHint => ({
  collection: 'unit_types',
  noun: 'unit type',
  blocks: false,
  matches: [
    { id: '7', label: 'MX480', value: 'MX480', match: 'exact', score: 1 },
    { id: '8', label: 'MX-480 B', value: 'MX-480 B', match: 'close', score: 0.7 }
  ],
  ...over
})

function mount(node: React.ReactNode) {
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  act(() => root?.render(node))
  return host
}

describe('DuplicateNotice', () => {
  it('exact copy in amber with Open (a new tab without a drill-down host); near one quiet', () => {
    const host = mount(<DuplicateNotice field='name' hint={hint()} />)
    const exact = host.querySelector('[data-duplicate-kind="exact"]')
    expect(exact?.textContent).toContain('Already exists:')
    expect(exact?.textContent).toContain('MX480')
    expect(exact?.textContent).toContain('(unit type)')
    expect(exact?.className).toContain('text-amber-700')
    const open = [...(exact?.querySelectorAll('a') ?? [])].find((a) => a.textContent === 'Open')
    expect(open?.getAttribute('href')).toBe('/collections/unit_types/7')
    expect(open?.getAttribute('target')).toBe('_blank')
    const close = host.querySelector('[data-duplicate-kind="close"]')
    expect(close?.textContent).toContain('Similar:')
    expect(close?.textContent).toContain('MX-480 B')
    expect(close?.className).toContain('text-slate-500')
  })

  it('opens the drill-down sheet when the host has one (the draft stays put)', () => {
    const open = vi.fn()
    const host = mount(
      <DrilldownContext.Provider value={{ open }}>
        <DuplicateNotice field='name' hint={hint()} />
      </DrilldownContext.Provider>
    )
    const btn = [...host.querySelectorAll('button')].find((b) => b.textContent === 'Open')
    act(() => btn?.click())
    expect(open).toHaveBeenCalledWith({ collection: 'unit_types', itemId: '7', title: 'MX480' })
  })

  it('says saving is refused where the collection blocks exact copies', () => {
    const host = mount(<DuplicateNotice field='name' hint={hint({ blocks: true })} />)
    expect(host.textContent).toContain('Saving a copy is not allowed here')
  })
})

describe('watchedValues', () => {
  it('only the compared fields, trimmed, two characters or more', () => {
    expect(watchedValues(['name'], { name: ' MX480 ', other: 'x' })).toBe('{"name":"MX480"}')
    expect(watchedValues(['name'], { name: 'M' })).toBe('')
    expect(watchedValues([], { name: 'MX480' })).toBe('')
  })
})

describe('useDuplicateCheck', () => {
  function Harness({
    draft,
    enabled = true
  }: {
    draft: Record<string, unknown>
    enabled?: boolean
  }) {
    const hints = useDuplicateCheck({ collection: 'unit_types', enabled, draft })
    return (
      <div>
        {Object.entries(hints).map(([f, h]) => (
          <DuplicateNotice key={f} field={f} hint={h} />
        ))}
      </div>
    )
  }
  function setup() {
    const calls: Cmd[] = []
    const client = {
      url: 'http://test',
      getToken: () => null,
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path === '/duplicates/unit_types')
          return {
            data: { enabled: true, fields: ['name'], block_exact: false, label: 'Unit Type' }
          }
        if (cmd._path === '/duplicates/unit_types/check')
          return {
            data: {
              enabled: true,
              fields: ['name'],
              block_exact: false,
              label: 'Unit Type',
              matches: {
                name: [{ id: '7', label: 'MX480', value: 'MX480', match: 'exact', score: 1 }]
              }
            }
          }
        return { data: null }
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const render = (draft: Record<string, unknown>, enabled = true) =>
      act(() =>
        root?.render(
          <QueryClientProvider client={qc}>
            <NivaroProvider client={client as never}>
              <Harness draft={draft} enabled={enabled} />
            </NivaroProvider>
          </QueryClientProvider>
        )
      )
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    return { calls, render, host }
  }

  it('asks once the typing settles and shows the notice under the field', async () => {
    const { calls, render, host } = setup()
    render({ name: 'mx' })
    render({ name: 'mx48' })
    render({ name: 'mx480' })
    await tick()
    expect(calls.filter((c) => c._path.endsWith('/check'))).toHaveLength(0)
    await act(async () => new Promise((r) => setTimeout(r, DUPLICATE_DEBOUNCE_MS + 50)))
    await tick()
    const checks = calls.filter((c) => c._path.endsWith('/check'))
    expect(checks).toHaveLength(1)
    expect(checks[0]._params).toEqual({ values: '{"name":"mx480"}' })
    expect(host.querySelector('[data-duplicate-notice="name"]')?.textContent).toContain(
      'Already exists:'
    )
    expect(host.textContent).toContain('(unit type)')
  })

  it('never asks for a record being edited (enabled false)', async () => {
    const { calls, render } = setup()
    render({ name: 'mx480' }, false)
    await act(async () => new Promise((r) => setTimeout(r, DUPLICATE_DEBOUNCE_MS + 50)))
    await tick()
    expect(calls).toHaveLength(0)
  })
})

describe('ImportDuplicatesNotice', () => {
  it('counts the rows that would create a copy, with the first rows listed', () => {
    const host = mount(
      <ImportDuplicatesNotice
        dup={{
          fields: ['name'],
          exact_rows: 2,
          close_rows: 1,
          in_file_rows: 1,
          close: true,
          rows: [
            { row: 2, field: 'name', value: 'MX480', match: 'exact', existing_id: '7' },
            {
              row: 3,
              field: 'name',
              value: 'MX 480',
              match: 'close',
              existing_id: '7',
              existing_value: 'MX480'
            },
            { row: 5, field: 'name', value: 'Router', match: 'exact', first_row: 4 }
          ]
        }}
      />
    )
    const text = host.querySelector('[data-import-duplicates]')?.textContent ?? ''
    expect(text).toContain('4 new rows would create a duplicate')
    expect(text).toContain('2 copy an existing record')
    expect(text).toContain('1 nearly copies one')
    expect(text).toContain('1 repeats an earlier row')
    expect(host.querySelectorAll('[data-import-duplicate-row]')).toHaveLength(3)
    expect(text).toContain('looks like “MX480”')
    expect(text).toContain('repeats row 4')
    expect(text).toContain('First 3 shown.')
  })
  it('renders nothing when no row copies anything', () => {
    const host = mount(
      <ImportDuplicatesNotice
        dup={{
          fields: ['name'],
          exact_rows: 0,
          close_rows: 0,
          in_file_rows: 0,
          close: true,
          rows: []
        }}
      />
    )
    expect(host.querySelector('[data-import-duplicates]')).toBeNull()
  })
})
