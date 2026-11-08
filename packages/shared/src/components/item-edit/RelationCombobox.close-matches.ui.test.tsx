// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { onlyCloseMatches } from './picker-search'
import { RelationCombobox } from './RelationCombobox'

// army11 f3 LOW: picker search had no typo tolerance ("able cmmunications"
// → No results). The server's typo pass (fix11-search: `typo=1`, rows marked
// `fuzzy`) answers close matches only when the exact search finds nothing; the
// picker says they are guesses and never picks one on Enter alone.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _path: string; _params?: Record<string, unknown> }
const VENDORS = [
  { id: 1, name: 'ACI COMMUNICATIONS INC' },
  { id: 2, name: 'GRAYBAR ELECTRIC COMPANY' }
]

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
const tick = async () => {
  for (let i = 0; i < 15; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 300 && !until(); i++)
    await act(async () => new Promise((r) => setTimeout(r, 10)))
}

let current: unknown = null
let typoAsked = false
function Host() {
  const [v, setV] = useState<unknown>(null)
  current = v
  return <RelationCombobox collection='vendors' value={v} onChange={setV} />
}

async function mount() {
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._path === '/collections/vendors')
        return { data: { display_template: '{{name}}', relations: [] } }
      if (cmd._path === '/items/vendors') {
        const s = String(cmd._params?.search ?? '').toLowerCase()
        if (!s) return { data: VENDORS }
        const exact = VENDORS.filter((r) => r.name.toLowerCase().includes(s))
        if (exact.length) return { data: exact }
        if (cmd._params?.typo === '1') {
          typoAsked = true
          if (s.includes('cmmunications'))
            return { data: [{ ...VENDORS[0], fuzzy: true }], meta: { fuzzy: true } }
        }
        return { data: [] }
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
          <Host />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await tick()
}

const trigger = () => document.querySelector<HTMLButtonElement>('button[aria-haspopup="listbox"]')
const input = () => document.querySelector<HTMLInputElement>('[data-nvr-combobox-panel] input')
function type(el: HTMLInputElement, text: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(el, text)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

describe('picker close matches (typo pass)', () => {
  it('a typo shows "did you mean" with the close match, and Enter does not pick a guess', async () => {
    await mount()
    await act(async () => trigger()?.click())
    await tick()
    await act(async () => type(input() as HTMLInputElement, 'able cmmunications'))
    // Slow under a full-suite run: wait for the answer, not a fixed time.
    await settle(() => !!document.querySelector('[data-picker-close-matches]'))
    expect(typoAsked).toBe(true)
    expect(document.querySelector('[data-picker-close-matches]')?.textContent).toContain(
      'did you mean'
    )
    const opts = [...document.querySelectorAll('[role="option"]')].map((b) => b.textContent)
    expect(opts.some((t) => t?.includes('ACI COMMUNICATIONS INC'))).toBe(true)
    await act(async () =>
      input()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    await tick()
    expect(current).toBeNull()
  })

  it('an exact match shows as before, with no "did you mean"', async () => {
    await mount()
    await act(async () => trigger()?.click())
    await tick()
    await act(async () => type(input() as HTMLInputElement, 'graybar'))
    await settle(() =>
      [...document.querySelectorAll('[role="option"]')].some((b) =>
        b.textContent?.includes('GRAYBAR')
      )
    )
    await settle(() => [...document.querySelectorAll('[role="option"]')].length === 1)
    expect(document.querySelector('[data-picker-close-matches]')).toBeNull()
  })
})

describe('onlyCloseMatches', () => {
  it('true only when every row is a typo-pass guess', () => {
    expect(onlyCloseMatches([{ id: 1, fuzzy: true }])).toBe(true)
    expect(onlyCloseMatches([{ id: 1, fuzzy: true }, { id: 2 }])).toBe(false)
    expect(onlyCloseMatches([])).toBe(false)
  })
})
