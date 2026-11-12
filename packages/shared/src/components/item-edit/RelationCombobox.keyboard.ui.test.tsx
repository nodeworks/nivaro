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
  searchDelay = 0
  listDelay = 0
  forbiddenIds = []
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const tick = async () => {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

let current: unknown = null
let rowsNow: Array<Record<string, unknown>> = ROWS
/** A slow server search (ms) — keeps "Enter before the answer" deterministic. */
let searchDelay = 0
/** Delay (ms) on the unsearched first list. */
let listDelay = 0
/** Row reads by id answer 403 for these ids (outside the reader's scope). */
let forbiddenIds: string[] = []
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
        if (search && searchDelay) await new Promise((r) => setTimeout(r, searchDelay))
        const filter = cmd._params?.filter ? JSON.parse(String(cmd._params.filter)) : null
        if (!search && !filter && listDelay) await new Promise((r) => setTimeout(r, listDelay))
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
      if (one && forbiddenIds.includes(one[1]))
        throw Object.assign(new Error('Forbidden'), { status: 403, response: { status: 403 } })
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

// army9 b01 HIGH: typing a project number on a CLOSED picker kept only the
// first digit ("201943" → "2"), and Enter then picked the first project with a
// 2 in it (203430). Keys that reach the trigger after it opened — before focus
// moved into the search box — are now added to the search, and an Enter typed
// before the answer arrives waits for it.
describe('RelationCombobox typing on a closed picker', () => {
  const PROJECTS = [
    { id: 1, name: '203430 - 27-NNO-WEST-HE-SE' },
    { id: 2, name: '201943 - 26-WEST-POWER' },
    { id: 3, name: '202706 - 26-EAST-BLT' }
  ]
  /** A key as the browser delivers it: keydown on whatever has focus, then —
   *  unless prevented — the character lands in a focused text box. */
  function press(k: string) {
    const target = (document.activeElement ?? document.body) as HTMLElement
    const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
    target.dispatchEvent(ev)
    if (!ev.defaultPrevented && target instanceof HTMLInputElement && k.length === 1)
      type(target, target.value + k)
  }
  // Small act() steps: React renders between them, as it would in a browser
  // (one long act() holds every render until it ends).
  const settle = async () => {
    for (let t = 0; t < 500 + searchDelay * 2; t += 100)
      await act(async () => new Promise((r) => setTimeout(r, 100)))
    await tick()
  }

  it('a fast burst of digits keeps every digit and Enter picks that project', async () => {
    await mount(null, { rows: PROJECTS })
    searchDelay = 800
    await act(async () => trigger()?.focus())
    for (const k of '201943') await act(async () => press(k))
    expect(search()?.value).toBe('201943')
    // Enter before the search answered: nothing is picked meanwhile (never
    // the first project with a 2 in it)…
    await act(async () => press('Enter'))
    expect(current).toBeNull()
    // …and the project typed is picked once the answer is in.
    await settle()
    expect(current).toBe(2)
    expect(panel()).toBeNull()
  })

  it('keys that still land on the trigger after it opened are added, not dropped', async () => {
    await mount(null, { rows: PROJECTS })
    const t = trigger() as HTMLButtonElement
    await act(async () => t.focus())
    // Every key to the trigger, as when the page is too busy to move focus.
    for (const k of '201943') await act(async () => key(t, k))
    expect(search()?.value).toBe('201943')
    await settle()
    expect(options()).toEqual(['201943 - 26-WEST-POWER'])
    await act(async () => key(t, 'Enter'))
    expect(current).toBe(2)
  })

  it('key-by-key typing with pauses keeps every digit', async () => {
    await mount(null, { rows: PROJECTS })
    await act(async () => trigger()?.focus())
    for (const k of '201943') {
      await act(async () => press(k))
      await act(async () => new Promise((r) => setTimeout(r, 150)))
    }
    expect(search()?.value).toBe('201943')
    await settle()
    expect(options()).toEqual(['201943 - 26-WEST-POWER'])
    await act(async () => press('Enter'))
    expect(current).toBe(2)
  })

  it('Backspace on the trigger edits the search; a pinned default never steals Enter', async () => {
    await mount(null, { rows: PROJECTS, pinned: { id: 1 } })
    const t = trigger() as HTMLButtonElement
    await act(async () => t.focus())
    for (const k of '2019434') await act(async () => key(t, k))
    await act(async () => key(t, 'Backspace'))
    expect(search()?.value).toBe('201943')
    await act(async () => key(t, 'Enter'))
    await settle()
    expect(current).toBe(2)
  })

  it('typing more after Enter drops the waiting pick', async () => {
    await mount(null, { rows: PROJECTS })
    searchDelay = 800
    await act(async () => trigger()?.focus())
    for (const k of '20') await act(async () => press(k))
    await act(async () => press('Enter'))
    await act(async () => press('2'))
    await settle()
    expect(current).toBeNull()
    expect(search()?.value).toBe('202')
  })
})

// army9 review L1 / L2 / M7.
describe('RelationCombobox review fixes', () => {
  it('Enter on an empty box while the first list loads never picks the lone pinned Default', async () => {
    listDelay = 2000
    await mount(null, { pinned: { id: 3794 } })
    await act(async () => trigger()?.focus())
    await act(async () => key(trigger() as HTMLButtonElement, 'ArrowDown'))
    await tick()
    await act(async () => key((search() ?? trigger()) as HTMLElement, 'Enter'))
    expect(current).toBeNull()
  })

  it('a space on the trigger never starts a search', async () => {
    await mount()
    await act(async () => trigger()?.focus())
    await act(async () => key(trigger() as HTMLButtonElement, '2'))
    const t = trigger() as HTMLButtonElement
    await act(async () => key(t, ' '))
    await act(async () => key(t, ' '))
    expect(search()?.value).toBe('2 ')
  })

  it('a value the reader cannot open says so, never its number', async () => {
    forbiddenIds = ['4034']
    await mount(4034)
    await tick()
    // The words sit beside the picker's control, not on it (the control says "Change").
    const field = document.querySelector('[data-related-unavailable-field]')
    expect(field?.textContent).toContain('Not available to you')
    expect(field?.textContent).not.toContain('4034')
  })
})
