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

function render(props: { term: string; enabled?: boolean }, exact: typeof HIT | null = HIT) {
  const calls: Cmd[] = []
  const navigate = vi.fn()
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      return { data: { exact, records: exact ? [exact] : [] } }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const ui = (p: { term: string; enabled?: boolean }) => (
    <QueryClientProvider client={qc}>
      <NivaroProvider client={client}>
        <NavigationContext.Provider
          value={{ navigate, itemUrl: (t) => `/records/${t.collection}/${t.itemId}` }}
        >
          <FoundElsewhere term={p.term} enabled={p.enabled ?? true} />
        </NavigationContext.Provider>
      </NivaroProvider>
    </QueryClientProvider>
  )
  act(() => root.render(ui(props)))
  return {
    calls,
    navigate,
    rerender: (p: { term: string; enabled?: boolean }) => act(() => root.render(ui(p)))
  }
}

const settle = async () => {
  for (let i = 0; i < 5; i++) await act(() => new Promise((r) => setTimeout(r, 5)))
}
const hint = () => host.querySelector('[data-found-elsewhere]') as HTMLElement | null

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
    const { calls, navigate } = render({ term: 'CR26INV-33345' })
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
    a.rerender({ term: 'CR26INV-33345', enabled: false })
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
