// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { RelationCombobox } from './RelationCombobox'

// army8 b01 HIGH: the record-form picker ignored Escape / Enter / arrows, so the
// still-open list hung over the next field and the next click picked a row
// under it (a PO saved with a nameless ship-to "#5331"). Also: rows with no
// name are never offered, and no internal id is ever shown.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

const ROWS = [
  { id: 5331, name: null },
  { id: 3794, name: 'alameda.ca' },
  { id: 4034, name: 'augusta.ga' },
  { id: 9124, name: '2216magnolia.va' }
]

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const tick = async () => {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

let current: unknown = null
let rowsNow: Array<Record<string, unknown>> = ROWS
function Host({ initial, pinned }: { initial: unknown; pinned?: { id: unknown } | null }) {
  const [v, setV] = useState<unknown>(initial)
  current = v
  return (
    <form data-testid='form' onSubmit={(e) => e.preventDefault()}>
      <RelationCombobox collection='locations' value={v} onChange={setV} pinned={pinned} />
      <input data-testid='next' />
    </form>
  )
}

async function mount(
  initial: unknown = null,
  opts: { pinned?: { id: unknown } | null; rows?: Array<Record<string, unknown>> } = {}
) {
  current = initial
  rowsNow = opts.rows ?? ROWS
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._path === '/collections/locations')
        return { data: { display_template: '{{name}}', relations: [] } }
      if (cmd._path === '/items/locations') {
        const search = String(cmd._params?.search ?? '').toLowerCase()
        const filter = cmd._params?.filter ? JSON.parse(String(cmd._params.filter)) : null
        let rows = rowsNow
        if (filter?.id?._eq !== undefined)
          rows = rows.filter((r) => String(r.id) === String(filter.id._eq))
        if (search)
          rows = rows.filter((r) =>
            String(r.name ?? '')
              .toLowerCase()
              .includes(search)
          )
        return { data: rows }
      }
      const one = /^\/items\/locations\/(\d+)$/.exec(cmd._path)
      if (one) return { data: rowsNow.find((r) => String(r.id) === one[1]) ?? null }
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
          <Host initial={initial} pinned={opts.pinned} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await tick()
}

const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
const panel = () => document.querySelector('[data-nvr-combobox-panel]')
const search = () => document.querySelector<HTMLInputElement>('[data-nvr-combobox-panel] input')
const options = () =>
  [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].map((b) => b.textContent)

function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}
function type(el: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
  set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

async function open() {
  await act(async () => trigger()?.click())
  await tick()
  await act(async () => new Promise((r) => setTimeout(r, 40)))
}

describe('RelationCombobox keyboard', () => {
  it('Escape closes the open list and returns focus to the picker', async () => {
    await mount(3794)
    await open()
    expect(panel()).not.toBeNull()
    expect(document.activeElement).toBe(search())
    await act(async () => key(search() as HTMLInputElement, 'Escape'))
    expect(panel()).toBeNull()
    expect(document.activeElement).toBe(trigger())
    expect(current).toBe(3794)
  })

  it('focus moving to another field closes the list (it never waits over the next field)', async () => {
    await mount(3794)
    await open()
    const next = document.querySelector<HTMLInputElement>('[data-testid="next"]')
    await act(async () => next?.focus())
    expect(panel()).toBeNull()
    expect(current).toBe(3794)
  })

  it('never offers a nameless row and never shows an internal id', async () => {
    await mount()
    await open()
    expect(options()).toEqual(['2216magnolia.va', 'alameda.ca', 'augusta.ga'])
    expect(document.body.textContent).not.toContain('5331')
  })

  it('a nameless current value reads "Unnamed record", not its id', async () => {
    await mount(5331)
    expect(trigger()?.textContent).toContain('Unnamed record')
    expect(trigger()?.textContent).not.toContain('5331')
  })

  it('Enter picks the only match left by typing; arrows move the highlight', async () => {
    await mount()
    await open()
    await act(async () => type(search() as HTMLInputElement, 'augusta'))
    await act(async () => new Promise((r) => setTimeout(r, 400)))
    await tick()
    expect(options()).toEqual(['augusta.ga'])
    await act(async () => key(search() as HTMLInputElement, 'Enter'))
    expect(current).toBe(4034)
    expect(panel()).toBeNull()

    await open()
    const box = search() as HTMLInputElement
    await act(async () => key(box, 'ArrowDown'))
    await act(async () => key(box, 'ArrowDown'))
    expect(box.getAttribute('aria-activedescendant')).toBeTruthy()
    await act(async () => key(box, 'Enter'))
    expect(current).toBe(3794)
  })

  // army8 review H1: with a pinned Default, typing then Enter wrote the DEFAULT
  // (it sat at index 0 above the match) — silent wrong coding on money lines.
  it('with a pinned default, typing then Enter picks the match, not the default', async () => {
    await mount(null, { pinned: { id: 3794 } })
    await open()
    expect(options()[0]).toContain('alameda.ca')
    expect(options()[0]).toContain('Default')
    await act(async () => type(search() as HTMLInputElement, 'augusta'))
    await act(async () => new Promise((r) => setTimeout(r, 400)))
    await tick()
    expect(options()).toEqual(['augusta.ga'])
    await act(async () => key(search() as HTMLInputElement, 'Enter'))
    expect(current).toBe(4034)
  })

  it('the pinned default stays findable by typing its name', async () => {
    await mount(null, { pinned: { id: 3794 } })
    await open()
    await act(async () => type(search() as HTMLInputElement, 'alameda'))
    await act(async () => new Promise((r) => setTimeout(r, 400)))
    await tick()
    expect(options()).toHaveLength(1)
    expect(options()[0]).toContain('alameda.ca')
    await act(async () => key(search() as HTMLInputElement, 'Enter'))
    expect(current).toBe(3794)
  })

  it('with a pinned default and several matches, Enter picks the first match', async () => {
    await mount(null, { pinned: { id: 9124 } })
    await open()
    await act(async () => type(search() as HTMLInputElement, 'a'))
    await act(async () => new Promise((r) => setTimeout(r, 400)))
    await tick()
    // 'a' also matches the pinned row's name, so it stays listed — above the
    // highlight, which starts on the first real match.
    expect(options()[0]).toContain('2216magnolia.va')
    await act(async () => key(search() as HTMLInputElement, 'Enter'))
    expect(current).not.toBe(9124)
    expect([3794, 4034]).toContain(current)
  })

  // army8 review M1: a role whose access leaves out the label field gets rows
  // with no name — the picker must not go empty (it was the only way to fill it).
  it('when no row has a name, every row is listed as "Unnamed record" and pickable', async () => {
    await mount(null, {
      rows: [
        { id: 11, name: null },
        { id: 12, name: null }
      ]
    })
    await open()
    expect(options()).toEqual(['Unnamed record', 'Unnamed record'])
    expect(document.body.textContent).not.toContain('No results')
    const box = search() as HTMLInputElement
    await act(async () => key(box, 'ArrowDown'))
    await act(async () => key(box, 'Enter'))
    expect(current).toBe(11)
  })

  it('Enter in the search box never submits the surrounding form', async () => {
    await mount()
    await open()
    const ev = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    await act(async () => search()?.dispatchEvent(ev))
    expect(ev.defaultPrevented).toBe(true)
  })
})
