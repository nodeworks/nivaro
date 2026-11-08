// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import type { M2MStagingCtx } from './M2MStagingContext'
import { M2MSummaryCount } from './SummaryPanel'
import type { CMSRelation } from './types'

// army9 b01/b02: on a NEW record the Summary rail read "Ship-To Contact · 1 item"
// for a person just picked (a many-to-any link: person or external contact),
// and the same person picked twice in two letter cases read twice.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let root: Root | null = null
afterEach(() => {
  act(() => root?.unmount())
  root = null
  document.body.replaceChildren()
})

const REL = {
  id: 1,
  many_collection: 'ir_contacts',
  many_field: 'inventory_request_id',
  one_collection: 'inventory_request',
  one_field: 'internal_contact',
  junction_field: 'item'
} as unknown as CMSRelation
const COMPANION = {
  id: 2,
  many_collection: 'ir_contacts',
  many_field: 'item',
  one_collection: null,
  one_collection_field: 'collection',
  one_allowed_collections: 'directus_users,contacts',
  junction_field: 'inventory_request_id'
} as unknown as CMSRelation

async function render(staged: unknown[]) {
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: { _path: string }) => {
      if (cmd._path === '/collections/nivaro_users')
        return { data: { display_template: '{{first_name}} {{last_name}}' } }
      if (/^\/items\/nivaro_users\//i.test(cmd._path))
        return { data: { id: 'ABC', first_name: 'Peter', last_name: 'Moniz' } }
      return { data: [] }
    })
  }
  const staging = {
    getStagedLinks: () => staged,
    getStagedUnlinks: () => new Set()
  } as unknown as M2MStagingCtx
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
  await act(async () =>
    root?.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <M2MSummaryCount
            relation={REL}
            parentId='new'
            allRelations={[REL, COMPANION]}
            staging={staging}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  for (let i = 0; i < 12; i++) await act(async () => new Promise((r) => setTimeout(r, 0)))
}

describe('Summary rail many-to-any pick on a new record', () => {
  it('names the person picked, not "1 item"', async () => {
    await render(['ABC'])
    expect(document.body.textContent).toContain('Peter Moniz')
    expect(document.body.textContent).not.toContain('1 item')
  })
  it('the same person in two letter cases reads once', async () => {
    await render(['ABC', 'abc'])
    expect(document.body.textContent?.match(/Peter Moniz/g)).toHaveLength(1)
  })
})
