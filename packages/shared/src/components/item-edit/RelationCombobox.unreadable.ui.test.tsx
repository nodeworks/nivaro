// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { RelatedItemLabel, RelationCombobox } from './RelationCombobox'
import { RelatedMissingLabel } from './related-missing'

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
/** Holds the /access-explain answer back until the test lets it go. */
let explainGate: Promise<void> | null = null

afterEach(() => {
  explain = 'scope'
  explainCalls = 0
  explainGate = null
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
  await show(<Host initial={initial} disabled={opts.disabled} />)
}

async function show(node: React.ReactNode) {
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
        if (explainGate) await explainGate
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
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  )
  await tick()
}

const field = () => document.querySelector<HTMLElement>('[data-related-unavailable-field]')
const label = () => document.querySelector<HTMLElement>('[data-related-unavailable]')
/** The words on screen; the reason a screen reader hears sits after them, out of sight. */
const words = () => label()?.firstChild?.textContent
const settling = () => document.querySelector<HTMLElement>('[data-related-unavailable-settling]')
const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
const panel = () => document.querySelector('[data-nvr-combobox-panel]')
const options = () => [...document.querySelectorAll<HTMLElement>('[role="option"]')]

describe('RelationCombobox — a value the reader cannot open', () => {
  it('says it is outside their access, with the reason, as text and not as a button', async () => {
    await mount(102)

    expect(words()).toBe('Not available to you')
    expect(label()?.dataset.relatedUnavailable).toBe('no-access')
    // The tip repeats the words: a narrow grid cell cuts them to "Not availa…".
    expect(label()?.dataset.tip).toBe(`Not available to you. ${SCOPE_SENTENCE}`)
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

  // Design review 2026-11-12: the box is input-shaped, so a click anywhere on
  // it has to open the list; only the small "Change" did.
  it('opens the list from a click anywhere on the field, and closes it again', async () => {
    await mount(102)

    expect(field()?.className).toContain('cursor-pointer')
    await act(async () => label()?.click())
    await tick()
    expect(panel()).not.toBeNull()
    await act(async () => field()?.click())
    await tick()
    expect(panel()).toBeNull()
  })

  // A keyboard or screen-reader user lands on a button named only "Change":
  // the state and its reason are its description.
  it('"Change" is described by the state and the reason', async () => {
    await mount(102)

    const id = trigger()?.getAttribute('aria-describedby')
    expect(id).toBeTruthy()
    const described = document.getElementById(String(id))
    expect(described).toBe(label())
    expect(described?.textContent).toBe(`Not available to you. ${SCOPE_SENTENCE}`)
  })

  // One loading look: the usual button with its spinner until the server has
  // said which it was. It used to go spinner, then a grey box with a skeleton,
  // then the words.
  it('waits for the reason on the usual loading button', async () => {
    let release = () => {}
    explainGate = new Promise<void>((r) => {
      release = r
    })
    await mount(102)

    expect(field()).toBeNull()
    expect(settling()).toBeNull()
    expect(trigger()?.querySelector('.animate-spin')).not.toBeNull()

    release()
    await tick()
    expect(trigger()?.textContent).toBe('Change')
    expect(words()).toBe('Not available to you')
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

    expect(words()).toBe('Not available to you')
    expect(field()?.querySelector('button')).toBeNull()
    expect(document.querySelector('button')).toBeNull()
    // Nothing to open: the box is not offered as something to click.
    expect(field()?.className).not.toContain('cursor-pointer')
    await act(async () => field()?.click())
    await tick()
    expect(panel()).toBeNull()
  })

  it('a removed record still reads as not found', async () => {
    explain = 'gone'
    await mount(102)

    expect(words()).toBe('Record not found')
    expect(label()?.dataset.relatedUnavailable).toBe('not-found')
    // The server's own sentence, not a fixed "was removed".
    expect(label()?.dataset.tip).toBe('Record not found. This record does not exist.')
  })

  it('covers both when the reason cannot be read, and asks only once', async () => {
    explain = 'fail'
    await mount(102)

    expect(words()).toBe('Record not found')
    expect(label()?.dataset.tip).toBe(
      'Record not found. It may have been deleted, or it is outside what you can see.'
    )
    expect(explainCalls).toBe(1)
  })

  it('a value the reader can open is the usual picker button', async () => {
    await mount(25)

    expect(field()).toBeNull()
    expect(trigger()?.textContent).toContain('2A')
    expect(explainCalls).toBe(0)
  })

  // A label on its own (the read view) waits with the same skeleton the read
  // view shows while the row loads, so the wait is one look and not two.
  it('a label on its own waits with the read view’s skeleton, or the caller’s', async () => {
    explainGate = new Promise<void>(() => {})
    await show(
      <>
        <RelatedMissingLabel error={notFound()} collection='unit_types' id={102} />
        <RelatedMissingLabel
          error={notFound()}
          collection='unit_types'
          id={102}
          settlingClassName='h-3 w-3'
        />
      </>
    )

    const waits = [...document.querySelectorAll('[data-related-unavailable-settling]')]
    expect(waits.map((w) => w.className)).toEqual([
      'inline-block h-3.5 w-20 animate-pulse rounded bg-slate-100 align-middle dark:bg-[hsl(var(--nvr-skeleton))]',
      'h-3 w-3'
    ])
    expect(label()).toBeNull()
  })

  // The summary's value (RelatedItemLabel) loads with a small spinner: it
  // keeps that one look while the reason is asked for.
  it('a summary value keeps its spinner until the reason is in', async () => {
    let release = () => {}
    explainGate = new Promise<void>((r) => {
      release = r
    })
    await show(<RelatedItemLabel collection='unit_types' id={102} explainMissing />)

    expect(settling()).toBeNull()
    expect(document.querySelector('.animate-spin')).not.toBeNull()

    release()
    await tick()
    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(words()).toBe('Not available to you')
  })
})
