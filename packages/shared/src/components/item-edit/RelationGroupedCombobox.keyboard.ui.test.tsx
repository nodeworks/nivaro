// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { RelationGroupedCombobox } from './RelationGroupedCombobox'

// army9 b01: the grouped (Category) line picker ignored Enter and the arrow
// keys, and a project with no line categories showed a bare "No results".
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _path: string; _params?: Record<string, unknown> }
const ROWS = [
  { id: 1, group: { id: 10, name: 'Electrical' }, option: { id: 100, name: 'Materials' } },
  { id: 2, group: { id: 10, name: 'Electrical' }, option: { id: 101, name: 'Equipment' } },
  {
    id: 3,
    group: { id: 20, name: 'Professional Services' },
    option: { id: 200, name: 'Labor' }
  }
]

let root: Root | null = null
afterEach(() => {
  listDelay = 0
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
const tick = async () => {
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
let current: unknown = null
/** Delay (ms) on the option list — the first load still out. */
let listDelay = 0

async function mount(opts: {
  rows?: typeof ROWS
  filter?: Record<string, unknown>
  narrowedBy?: { labels: string[] }
  pinned?: { id: unknown } | null
}) {
  current = null
  const rows = opts.rows ?? ROWS
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._path === '/collections/categories')
        return {
          data: {
            display_template: '{{group.name}}',
            relations: [
              { many_field: 'group', one_collection: 'groups' },
              { many_field: 'option', one_collection: 'options' }
            ]
          }
        }
      if (cmd._path === '/collections/groups' || cmd._path === '/collections/options')
        return { data: { display_template: '{{name}}' } }
      if (cmd._path === '/items/categories') {
        if (listDelay) await new Promise((r) => setTimeout(r, listDelay))
        return { data: rows }
      }
      const one = /^\/items\/categories\/(\d+)$/.exec(cmd._path)
      if (one) return { data: rows.find((r) => String(r.id) === one[1]) ?? null }
      return { data: null }
    })
  }
  function Host() {
    const [v, setV] = useState<unknown>(null)
    current = v
    return (
      <form onSubmit={(e) => e.preventDefault()}>
        <RelationGroupedCombobox
          collection='categories'
          value={v}
          onChange={setV}
          groupField='group'
          optionField='option'
          extraFilter={opts.filter}
          narrowedBy={opts.narrowedBy}
          pinned={opts.pinned}
        />
      </form>
    )
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <Host />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await tick()
}

const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
const search = () => document.querySelector<HTMLInputElement>('input[role="combobox"]')
function key(el: Element, k: string) {
  el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}
function press(k: string) {
  const target = (document.activeElement ?? document.body) as HTMLElement
  const ev = new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true })
  target.dispatchEvent(ev)
  if (!ev.defaultPrevented && target instanceof HTMLInputElement && k.length === 1) {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      target,
      target.value + k
    )
    target.dispatchEvent(new Event('input', { bubbles: true }))
  }
}

describe('RelationGroupedCombobox keyboard', () => {
  it('typing on the closed picker searches; Enter picks the only match', async () => {
    await mount({})
    await act(async () => trigger()?.focus())
    for (const k of 'Serv') await act(async () => press(k))
    await tick()
    expect(search()?.value).toBe('Serv')
    await act(async () => press('Enter'))
    expect(current).toBe(3)
    expect(search()).toBeNull()
    expect(document.activeElement).toBe(trigger())
  })

  it('arrow keys move the highlight through open groups and Enter picks it', async () => {
    await mount({})
    await act(async () => trigger()?.focus())
    for (const k of 'Electrical') await act(async () => press(k))
    await tick()
    const box = search() as HTMLInputElement
    expect(box.getAttribute('aria-activedescendant')).toBeTruthy()
    await act(async () => key(box, 'ArrowDown'))
    await act(async () => key(box, 'Enter'))
    expect(current).toBe(2)
  })

  it('a pinned default never steals Enter from a typed match', async () => {
    await mount({ pinned: { id: 1 } })
    await act(async () => trigger()?.focus())
    for (const k of 'Labor') await act(async () => press(k))
    await tick()
    await act(async () => press('Enter'))
    expect(current).toBe(3)
  })

  it('an empty list narrowed by the record says what narrows it', async () => {
    await mount({ rows: [], filter: { project: { _eq: 1 } }, narrowedBy: { labels: ['Project'] } })
    await act(async () => trigger()?.click())
    await tick()
    const note = document.querySelector('[data-nvr-empty-narrowed]')
    expect(note?.textContent).toContain('Nothing set up for this Project yet')
    expect(note?.textContent).toContain('ask an administrator')
    expect(document.body.textContent).not.toContain('No results')
  })

  // army9 review H4: with a pinned Default, a typed miss or an Enter before
  // the list arrived wrote the Default silently.
  it('a typed miss never leaves the pinned Default for Enter to pick', async () => {
    await mount({ pinned: { id: 1 } })
    await act(async () => trigger()?.focus())
    for (const k of 'zzz') await act(async () => press(k))
    await tick()
    expect(document.querySelector('[data-nvr-pinned-option]')).toBeNull()
    await act(async () => press('Enter'))
    expect(current).toBeNull()
  })

  it('Enter while the list is still loading picks nothing', async () => {
    listDelay = 2000
    await mount({ pinned: { id: 1 } })
    await act(async () => trigger()?.focus())
    for (const k of 'ELEC') await act(async () => press(k))
    await act(async () => press('Enter'))
    expect(current).toBeNull()
  })

  it('the pinned Default is still found by typing its name', async () => {
    await mount({ pinned: { id: 3 } })
    await act(async () => trigger()?.focus())
    for (const k of 'Labor') await act(async () => press(k))
    await tick()
    await act(async () => press('Enter'))
    expect(current).toBe(3)
  })
})
