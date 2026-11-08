// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { M2MCombobox } from './M2MCombobox'
import { M2MStagingContext, type M2MStagingCtx } from './M2MStagingContext'
import type { CMSRelation } from './types'

// army11 typo pass on the multi pickers (Ship-To Contact, Additional Contacts):
// a typed search the exact read misses asks `typo=1`; close matches are listed
// under "did you mean", and Enter does not pick one.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => {}
;(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

// 250 people: more than one page, so typed text always goes to the server.
const PEOPLE = Array.from({ length: 250 }, (_, i) => ({ id: `u${i}`, name: `Person ${i}` }))
PEOPLE[7] = { id: 'u7', name: 'Kristina Davison' }

const REL = {
  id: 1,
  many_collection: 'ir_contacts',
  many_field: 'ir_id',
  one_collection: 'ir',
  one_field: 'contacts',
  junction_field: 'person'
} as unknown as CMSRelation
const OTHER = {
  id: 2,
  many_collection: 'ir_contacts',
  many_field: 'person',
  one_collection: 'people',
  junction_field: 'ir_id'
} as unknown as CMSRelation

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
const settle = async (until: () => boolean) => {
  for (let i = 0; i < 200 && !until(); i++)
    await act(async () => new Promise((r) => setTimeout(r, 10)))
}

describe('M2MCombobox close matches', () => {
  it('a typo lists close matches under "did you mean"; Enter does not stage one', async () => {
    const asked: Array<Record<string, unknown>> = []
    const client = {
      url: 'http://test',
      getToken: () => null,
      request: vi.fn(async (cmd: { _path: string; _params?: Record<string, unknown> }) => {
        if (cmd._path === '/collections/people') return { data: { display_template: '{{name}}' } }
        if (cmd._path === '/items/people') {
          const p = cmd._params ?? {}
          asked.push(p)
          const s = String(p.search ?? '').toLowerCase()
          if (!s) return { data: PEOPLE.slice(0, 200) }
          const exact = PEOPLE.filter((x) => x.name.toLowerCase().includes(s))
          if (exact.length) return { data: exact }
          if (p.typo === '1' && s === 'kristna') return { data: [{ ...PEOPLE[7], fuzzy: true }] }
          return { data: [] }
        }
        return { data: [] }
      })
    }
    const staged: unknown[] = []
    const staging: M2MStagingCtx = {
      getStagedLinks: () => staged,
      getStagedUnlinks: () => new Set(),
      stageLink: (_k, id) => staged.push(id),
      stageUnlink: () => {},
      unstageLink: () => {},
      unstageUnlink: () => {}
    }
    const host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)
    await act(async () =>
      root?.render(
        <QueryClientProvider
          client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
        >
          <NivaroProvider client={client as never}>
            <M2MStagingContext.Provider value={staging}>
              <M2MCombobox relation={REL} parentId='new' allRelations={[REL, OTHER]} />
            </M2MStagingContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const trigger = host.querySelector<HTMLElement>('[role="button"]')
    // Typing on the closed picker opens it with the text searched.
    for (const k of 'kristna')
      await act(async () =>
        trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }))
      )
    await settle(() => !!document.querySelector('[data-picker-close-matches]'))
    expect(asked.some((p) => p.typo === '1' && p.search === 'kristna')).toBe(true)
    expect(document.querySelector('[data-picker-close-matches]')?.textContent).toContain(
      'did you mean'
    )
    const input = document.querySelector<HTMLInputElement>('[cmdk-input]')
    await act(async () =>
      input?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    )
    await settle(() => false)
    expect(staged).toEqual([])
    // No guess is shown as the highlighted pick.
    expect(
      [...document.querySelectorAll('[cmdk-item]')].some(
        (e) => e.getAttribute('aria-selected') === 'true'
      )
    ).toBe(false)
  })
})
