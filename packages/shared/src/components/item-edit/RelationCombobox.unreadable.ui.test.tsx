// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { RelationCombobox } from './RelationCombobox'

// Production review 2026-11-12: a unit type the form filled from the picked
// unit was outside the person's access, so the read answered 404 and the
// picker's own button read "Record not found" — a broken record with a control
// that led nowhere. A value the reader cannot open now says which it is (hidden
// from them, or removed) as plain text, and the only control is the one that
// lets them choose another value.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

const ROWS = [
  { id: 25, name: '2A' },
  { id: 101, name: 'ME' }
]
const SCOPE_SENTENCE = 'This record is outside your access. Your Zone access covers Zone 1.'

let root: Root | null = null
let current: unknown = null
/** What GET /access-explain answers for the hidden id; 'fail' = the call errors. */
let explain: 'scope' | 'gone' | 'fail' = 'scope'
let explainCalls = 0

afterEach(() => {
  explain = 'scope'
  explainCalls = 0
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const tick = async () => {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

function Host({ initial, disabled }: { initial: unknown; disabled?: boolean }) {
  const [v, setV] = useState<unknown>(initial)
  current = v
  return <RelationCombobox collection='unit_types' value={v} onChange={setV} disabled={disabled} />
}

const notFound = () =>
  Object.assign(new Error('Request failed with status code 404'), {
    status: 404,
    response: { status: 404, data: { error: 'Not found' } }
  })

async function mount(initial: unknown, opts: { disabled?: boolean } = {}) {
  current = initial
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._path === '/collections/unit_types')
        return { data: { display_template: '{{name}}', relations: [] } }
      if (cmd._path === '/items/unit_types') {
        const filter = cmd._params?.filter ? JSON.parse(String(cmd._params.filter)) : null
        const rows =
          filter?.id?._eq !== undefined
            ? ROWS.filter((r) => String(r.id) === String(filter.id._eq))
            : ROWS
        return { data: rows }
      }
      if (cmd._path === '/access-explain/unit_types/102') {
        explainCalls++
        if (explain === 'fail') throw new Error('Request failed with status code 500')
        return {
          data:
            explain === 'gone'
              ? {
                  access: false,
                  reasons: [{ type: 'not_found', message: 'This record does not exist.' }]
                }
              : { access: false, reasons: [{ type: 'scope', message: SCOPE_SENTENCE }] }
        }
      }
      const one = /^\/items\/unit_types\/(\d+)$/.exec(cmd._path)
      if (one) {
        const row = ROWS.find((r) => String(r.id) === one[1])
        if (!row) throw notFound()
        return { data: row }
      }
      return { data: null }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <Host initial={initial} disabled={opts.disabled} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await tick()
}

const field = () => document.querySelector<HTMLElement>('[data-related-unavailable-field]')
const label = () => document.querySelector<HTMLElement>('[data-related-unavailable]')
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
const panel = () => document.querySelector('[data-nvr-combobox-panel]')
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]

describe('RelationCombobox — a value the reader cannot open', () => {
  it('says it is outside their access, with the reason, as text and not as a button', async () => {
    await mount(102)

    expect(label()?.textContent).toBe('Not available to you')
    expect(label()?.dataset.relatedUnavailable).toBe('no-access')
    expect(label()?.dataset.tip).toBe(SCOPE_SENTENCE)
    expect(label()?.closest('button')).toBeNull()
    expect(field()?.textContent).not.toContain('Record not found')
    expect(field()?.textContent).not.toContain('102')
  })

  it('offers one control, named for what it does, that opens the list', async () => {
    await mount(102)

    expect(field()?.querySelectorAll('button')).toHaveLength(1)
    expect(trigger()?.textContent).toBe('Change')
    await act(async () => trigger()?.click())
    await tick()
    expect(panel()).not.toBeNull()
    expect(options().map((o) => o.textContent)).toEqual(expect.arrayContaining(['2A', 'ME']))
  })

  it('a pick replaces the hidden value and the field reads normally again', async () => {
    await mount(102)
    await act(async () => trigger()?.click())
    await tick()

    await act(async () =>
      options()
        .find((o) => o.textContent === 'ME')
        ?.click()
    )
    await tick()

    expect(current).toBe(101)
    expect(field()).toBeNull()
    expect(trigger()?.textContent).toContain('ME')
  })

  it('a locked field shows the words and no control at all', async () => {
    await mount(102, { disabled: true })

    expect(label()?.textContent).toBe('Not available to you')
    expect(field()?.querySelector('button')).toBeNull()
    expect(document.querySelector('button')).toBeNull()
  })

  it('a removed record still reads as not found', async () => {
    explain = 'gone'
    await mount(102)

    expect(label()?.textContent).toBe('Record not found')
    expect(label()?.dataset.relatedUnavailable).toBe('not-found')
    expect(label()?.dataset.tip).toBe('This record was removed.')
  })

  it('covers both when the reason cannot be read, and asks only once', async () => {
    explain = 'fail'
    await mount(102)

    expect(label()?.textContent).toBe('Record not found')
    expect(label()?.dataset.tip).toBe(
      'It may have been deleted, or it is outside what you can see.'
    )
    expect(explainCalls).toBe(1)
  })

  it('a value the reader can open is the usual picker button', async () => {
    await mount(25)

    expect(field()).toBeNull()
    expect(trigger()?.textContent).toContain('2A')
    expect(explainCalls).toBe(0)
  })
})
