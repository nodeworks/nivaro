// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useMemo, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { M2MSingleSelectCombobox } from './M2MCombobox'
import { M2MStagingContext, type M2MStagingCtx } from './M2MStagingContext'
import { foldStagedLinks } from './staged-links'
import type { CMSRelation } from './types'

// Prod 2026-11-17, workflow 372787 (Zone, max one value): Zone 2 (stored as junction
// row 482894) → Zone 3 → Zone 2 again. The second pick found no stored link (the row
// was staged for removal) and staged a NEW link to Zone 2, so the save sent
// `divisions: {create: [3], delete: [3]}` and the server took Zone 2 off.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => {}
;(globalThis as Record<string, unknown>).ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const REL = {
  id: 1,
  many_collection: 'workflows_divisions',
  many_field: 'workflows_id',
  one_collection: 'workflows',
  one_field: 'divisions',
  junction_field: 'divisions_id'
} as unknown as CMSRelation
const OTHER = {
  id: 2,
  many_collection: 'workflows_divisions',
  many_field: 'divisions_id',
  one_collection: 'divisions',
  junction_field: 'workflows_id'
} as unknown as CMSRelation
const ZONES = [
  { id: 2, short_name: 'Zone 1' },
  { id: 3, short_name: 'Zone 2' },
  { id: 4, short_name: 'Zone 3' }
]
const STORED = { id: 482894, divisions_id: 3 }

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})
const settle = async (until: () => boolean, rounds = 200) => {
  for (let i = 0; i < rounds && !until(); i++)
    await act(async () => new Promise((r) => setTimeout(r, 10)))
}

describe('M2MSingleSelectCombobox re-pick', () => {
  it('picking the stored value back after another one leaves nothing to change', async () => {
    const client = {
      url: 'http://test',
      getToken: () => null,
      request: vi.fn(async (cmd: { _path: string }) => {
        if (cmd._path === '/collections/divisions')
          return { data: { display_template: '{{short_name}}' } }
        if (cmd._path === '/items/workflows_divisions') return { data: [STORED] }
        if (cmd._path === '/items/divisions') return { data: ZONES }
        return { data: [] }
      })
    }
    const state = { links: [] as unknown[], unlinks: new Set<unknown>() }
    function Host() {
      const [links, setLinks] = useState<unknown[]>([])
      const [unlinks, setUnlinks] = useState<Set<unknown>>(new Set())
      state.links = links
      state.unlinks = unlinks
      const staging = useMemo<M2MStagingCtx>(
        () => ({
          getStagedLinks: () => links,
          getStagedUnlinks: () => unlinks,
          stageLink: (_k, id) => setLinks((p) => (p.includes(id) ? p : [...p, id])),
          unstageLink: (_k, id) => setLinks((p) => p.filter((x) => String(x) !== String(id))),
          stageUnlink: (_k, id) => setUnlinks((p) => new Set([...p, id])),
          unstageUnlink: (_k, id) =>
            setUnlinks((p) => new Set([...p].filter((x) => String(x) !== String(id))))
        }),
        [links, unlinks]
      )
      return (
        <M2MStagingContext.Provider value={staging}>
          <M2MSingleSelectCombobox relation={REL} parentId='372787' allRelations={[REL, OTHER]} />
        </M2MStagingContext.Provider>
      )
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
            <Host />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const pick = async (label: string) => {
      const trigger = host.querySelector<HTMLButtonElement>('button')
      await act(async () => trigger?.click())
      await settle(() =>
        [...document.querySelectorAll('[cmdk-item]')].some((e) => e.textContent?.includes(label))
      )
      const item = [...document.querySelectorAll<HTMLElement>('[cmdk-item]')].find((e) =>
        e.textContent?.includes(label)
      )
      expect(item, document.body.innerHTML.slice(0, 1500)).toBeTruthy()
      await act(async () => item?.click())
      await settle(() => false, 10)
    }
    await settle(() => client.request.mock.calls.length > 0)
    await pick('Zone 3')
    expect(state.links).toEqual([4])
    expect([...state.unlinks]).toEqual([482894])
    await pick('Zone 2')
    expect(state.links).toEqual([])
    expect([...state.unlinks]).toEqual([])

    // And what the save would send for it: nothing for the Zone.
    const payload: Record<string, unknown> = {}
    foldStagedLinks({
      collection: 'workflows',
      relations: [REL, OTHER],
      links: new Map([['divisions', state.links]]),
      unlinks: new Map([['divisions', state.unlinks]]),
      payload,
      isNew: false,
      committed: () => [STORED]
    })
    expect(payload.divisions).toBeUndefined()
  }, 15_000)
})
