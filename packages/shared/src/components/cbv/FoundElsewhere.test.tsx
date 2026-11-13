// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NavigationContext, NivaroProvider } from '../../context'
import { FoundElsewhere, looksLikeIdentifier } from './FoundElsewhere'

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown> }

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

const HIT = {
  collection: 'inventory_request',
  display_name: 'Inventory Requests',
  id: 33345,
  label: 'CR26INV-33345',
  snippet: ''
}

type Props = { term: string; show?: boolean; ask?: boolean; collection?: string }

const FALLBACK = 'Try adjusting your search or filters.'

type Hit = Omit<typeof HIT, 'display_name'> & { display_name: string | null }

function render(props: Props, exact: Hit | null = HIT) {
  const calls: Cmd[] = []
  const navigate = vi.fn()
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      return { data: { exact, records: exact ? [exact] : [] } }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (p: Props) => (
    <QueryClientProvider client={qc}>
      <NivaroProvider client={client}>
        <NavigationContext.Provider
          value={{ navigate, itemUrl: (t) => `/records/${t.collection}/${t.itemId}` }}
        >
          <FoundElsewhere
            term={p.term}
            show={p.show ?? true}
            ask={p.ask}
            collection={p.collection}
            fallback={<p data-fallback=''>{FALLBACK}</p>}
          />
        </NavigationContext.Provider>
      </NivaroProvider>
    </QueryClientProvider>
  )
  act(() => root.render(ui(props)))
  return {
    calls,
    navigate,
    rerender: (p: Props) => act(() => root.render(ui(p)))
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 5)))
}
const hint = () => host.querySelector('[data-found-elsewhere]') as HTMLElement | null
const fallback = () => host.querySelector('[data-fallback]') as HTMLElement | null

describe('looksLikeIdentifier', () => {
  it('one token with a digit in it, long enough to be an id', () => {
    for (const id of [
      'CR26INV-33345',
      '102-300154799',
      '81307',
      '201994',
      'PW27-81452',
      'NB23/73483'
    ])
      expect(looksLikeIdentifier(id)).toBe(true)
  })
  it('not words, names, several tokens or a few characters', () => {
    for (const text of [
      'perry',
      'Perry Callis',
      'ab1',
      '12',
      'storm repair 2026',
      '',
      'CM26-80541 CM26-80554'
    ])
      expect(looksLikeIdentifier(text)).toBe(false)
  })
})

describe('FoundElsewhere — an empty list search says where the thing is', () => {
  it('offers the record another collection holds under that exact id, as a link', async () => {
    const { calls, navigate } = render({ term: 'CR26INV-33345', collection: 'workflows' })
    await settle()
    expect(hint()?.textContent).toBe('Found in Inventory Requests: CR26INV-33345')
    const link = hint()?.querySelector('a') as HTMLAnchorElement
    expect(link.getAttribute('href')).toBe('/records/inventory_request/33345')
    await act(async () => link.click())
    expect(navigate).toHaveBeenCalledWith('/records/inventory_request/33345')
    // One request, asked as the person (global search judges what they may read).
    expect(calls).toHaveLength(1)
    expect(calls[0]._path).toBe('/global-search')
    expect(calls[0]._params).toMatchObject({ q: 'CR26INV-33345' })
  })

  it('asks nothing for a term that is not an identifier, or while the list has rows', async () => {
    const a = render({ term: 'Perry Callis' })
    await settle()
    expect(a.calls).toHaveLength(0)
    expect(hint()).toBeNull()
    a.rerender({ term: 'CR26INV-33345', show: false })
    await settle()
    expect(a.calls).toHaveLength(0)
    expect(hint()).toBeNull()
  })

  it('shows nothing when no record carries that id', async () => {
    const { calls } = render({ term: '102-3001472430' }, null)
    await settle()
    expect(calls).toHaveLength(1)
    expect(hint()).toBeNull()
  })

  it('asks once per term, not again on a re-render', async () => {
    const r = render({ term: '81307' })
    await settle()
    r.rerender({ term: '81307' })
    await settle()
    expect(r.calls).toHaveLength(1)
  })
})

// Design review 2026-11-12: the line was inserted above "Clear all filters"
// when the lookup answered, so the button dropped and the link landed where the
// button had been; each background refetch of the list hid it and showed it again.
describe('FoundElsewhere — the line keeps one slot', () => {
  it('holds the usual hint until a hit is known, then takes its place', async () => {
    render({ term: 'CR26INV-33345' })
    expect(fallback()?.textContent).toBe(FALLBACK)
    expect(hint()).toBeNull()
    await settle()
    expect(hint()).not.toBeNull()
    expect(fallback()).toBeNull()
  })

  it('keeps the usual hint when there is nothing to say', async () => {
    const a = render({ term: 'Perry Callis' })
    await settle()
    expect(fallback()?.textContent).toBe(FALLBACK)
    a.rerender({ term: 'CR26INV-33345', show: false })
    await settle()
    expect(fallback()?.textContent).toBe(FALLBACK)
    const b = render({ term: '102-3001472430' }, null)
    await settle()
    expect(b.calls).toHaveLength(1)
    expect(fallback()?.textContent).toBe(FALLBACK)
  })

  it('does not ask while the list is still reading, and keeps a known hit through a refetch', async () => {
    const r = render({ term: 'CR26INV-33345', ask: false })
    await settle()
    expect(r.calls).toHaveLength(0)
    expect(fallback()).not.toBeNull()
    r.rerender({ term: 'CR26INV-33345', ask: true })
    await settle()
    expect(hint()).not.toBeNull()
    // The list refetches in the background: the hit stays where it is.
    r.rerender({ term: 'CR26INV-33345', ask: false })
    await settle()
    expect(hint()).not.toBeNull()
    expect(fallback()).toBeNull()
    expect(r.calls).toHaveLength(1)
  })

  it('a long label is cut on one line, never wrapped', async () => {
    render({ term: 'CR26INV-33345' })
    await settle()
    const link = hint()?.querySelector('a') as HTMLAnchorElement
    for (const c of ['inline-block', 'max-w-full', 'truncate', 'align-bottom'])
      expect(link.className.split(' ')).toContain(c)
  })
})

describe('FoundElsewhere — what the line says', () => {
  it('a hit in this list’s own collection is one its filters hide', async () => {
    render({ term: 'CR26INV-33345', collection: 'inventory_request' })
    await settle()
    expect(hint()?.textContent).toBe("Hidden by this list's filters: CR26INV-33345")
    expect(hint()?.querySelector('a')?.getAttribute('href')).toBe(
      '/records/inventory_request/33345'
    )
  })

  it('a collection with no display name is named in words, not by its table', async () => {
    render(
      { term: 'CR26INV-33345', collection: 'workflows' },
      { ...HIT, collection: 'inventory_request_line_items', display_name: null }
    )
    await settle()
    expect(hint()?.textContent).toBe('Found in Inventory Request Line Items: CR26INV-33345')
  })
})
