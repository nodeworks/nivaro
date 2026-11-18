// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../context'
import { ItemEditForm } from './ItemEditForm'
import type { CMSField } from './item-edit/types'

// GitLab issue sync on the record page (Task 12b): "Create GitLab issue" / "Link GitLab issue" in
// the More menu for people a connection lets create from records, the header chip for anyone who
// can read the record — and nothing at all while GitLab sync is off.
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function field(name: string, label: string, over: Partial<CMSField> = {}): CMSField {
  return {
    field: name,
    type: 'string',
    interface: 'input',
    label,
    required: false,
    hidden: false,
    readonly: false,
    sort: 0,
    group_key: null,
    options: null,
    computed_formula: null,
    computed_type: null,
    note: null,
    placeholder: null,
    repeater_schema: null,
    dependency_config: null,
    ...over
  }
}

const FIELD_CONFIG: CMSField[] = [
  field('title', 'Title', { group_key: 'main', sort: 0, layout_assigned: true }),
  field('amount', 'Amount', { group_key: 'main', sort: 1, layout_assigned: true })
]

type Cmd = { _method?: string; _path: string; _params?: Record<string, unknown> }

const CHIP = {
  iid: 482,
  web_url: 'https://gitlab.example.com/team/app/-/issues/482',
  state: 'opened',
  title: 'First'
}

function makeClient(gitlab: { on: boolean; creatable: unknown[]; chips: unknown[] }) {
  const calls: Cmd[] = []
  const client = {
    url: 'http://test',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      const p = cmd._path
      if (p === '/trackers/feature/public') return { data: { enabled: gitlab.on } }
      if (p === '/trackers/creatable') return { data: gitlab.creatable }
      if (p === '/trackers/links/for') return { data: gitlab.chips }
      if (p === '/collection-layouts/active')
        return {
          data: {
            layout: { id: 7, name: 'Order form', slug: 'order-form' },
            groups: [{ id: 1, key: 'main', label: 'Main', type: 'section', icon: null, sort: 0 }],
            assignments: [
              { field: 'title', sort: 0, group_key: 'main', is_visible: true },
              { field: 'amount', sort: 1, group_key: 'main', is_visible: true }
            ],
            ungrouped_sort: 99
          }
        }
      if (p === '/field-config/orders') return { data: FIELD_CONFIG }
      if (p === '/collections/orders') return { data: { display_name: 'Orders' } }
      if (p === '/items/orders/1') return { data: { id: 1, title: 'First', amount: '2' } }
      if (p.startsWith('/picker-exclusions/status/')) return { data: { excluded: false } }
      if ((cmd._method ?? 'GET').toUpperCase() !== 'GET') return { data: null }
      return { data: [] }
    })
  }
  return { client, calls }
}

class NoopObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
  takeRecords() {
    return []
  }
}
const g = globalThis as Record<string, unknown>
g.ResizeObserver ??= NoopObserver
g.IntersectionObserver ??= NoopObserver
window.matchMedia ??= ((q: string) => ({
  matches: false,
  media: q,
  onchange: null,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {},
  dispatchEvent: () => false
})) as typeof window.matchMedia
Element.prototype.scrollIntoView ??= () => {}
g.CSS ??= { escape: (v: string) => v }

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  for (const el of document.body.querySelectorAll('[data-nvr-header-menu-panel]')) el.remove()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 40 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function mountAndOpenMore(gitlab: { on: boolean; creatable: unknown[]; chips: unknown[] }) {
  const { client, calls } = makeClient(gitlab)
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <ItemEditAuthContext.Provider value={{ isAdmin: false, userId: 'U1' }}>
            <ItemEditForm collection='orders' itemId='1' documentTitle={false} />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  await settle(
    () =>
      host.querySelectorAll('[data-field]').length >= 2 &&
      !!host.querySelector('[data-nvr-header-menu-btn]')
  )
  await settle(() => calls.some((c) => c._path === '/trackers/feature/public'))
  if (gitlab.on) await settle(() => calls.some((c) => c._path === '/trackers/creatable'))
  await settle(() => false)
  const btn = host.querySelector('[data-nvr-header-menu-btn]') as HTMLButtonElement
  await act(async () => btn.click())
  const panel = () => document.body.querySelector('[data-nvr-header-menu-panel]')
  await settle(() => !!panel())
  return { calls, panel: panel as () => Element | null }
}

const CONN = { id: 3, name: 'GitLab', default_project_path: 'team/app' }

describe('GitLab on the record page', () => {
  it('a create_roles member gets Create / Link GitLab issue in the More menu', async () => {
    const { panel, calls } = await mountAndOpenMore({ on: true, creatable: [CONN], chips: [] })
    await settle(() => !!panel()?.querySelector('[data-record-gitlab-create]'))
    expect(panel()?.querySelector('[data-record-gitlab-create]')?.textContent).toContain(
      'Create GitLab issue'
    )
    expect(panel()?.querySelector('[data-record-gitlab-link]')?.textContent).toContain(
      'Link GitLab issue'
    )
    const creatable = calls.find((c) => c._path === '/trackers/creatable')
    expect(creatable?._params).toEqual({ source_kind: 'record' })
    const chips = calls.find((c) => c._path === '/trackers/links/for')
    expect(chips?._params).toEqual({ source_kind: 'record', source_id: 'orders:1' })
    // Create opens the popover beside the More button, on the create form
    await act(async () =>
      (panel()?.querySelector('[data-record-gitlab-create]') as HTMLButtonElement).click()
    )
    await settle(() => !!document.querySelector('[data-record-gitlab="create"]'))
    expect(
      document.querySelector('[data-record-gitlab="create"] input[aria-label="GitLab issue title"]')
    ).not.toBeNull()
  })

  it('GitLab sync off: no entries, no chip, no tracker reads past the switch', async () => {
    const { panel, calls } = await mountAndOpenMore({ on: false, creatable: [CONN], chips: [CHIP] })
    expect(panel()?.querySelector('[data-record-gitlab-create]')).toBeNull()
    expect(host.querySelector('[data-gitlab-chip]')).toBeNull()
    expect(calls.filter((c) => c._path.startsWith('/trackers')).map((c) => c._path)).toEqual([
      '/trackers/feature/public'
    ])
  })

  it('not allowed to create: no entries, but the linked chip shows in the header', async () => {
    const { panel } = await mountAndOpenMore({ on: true, creatable: [], chips: [CHIP] })
    await settle(() => !!host.querySelector('[data-gitlab-chip]'))
    expect(host.querySelector('[data-nvr-header-title] [data-gitlab-chip]')).not.toBeNull()
    expect(panel()?.querySelector('[data-record-gitlab-create]')).toBeNull()
    expect(panel()?.querySelector('[data-record-gitlab-link]')).toBeNull()
  })

  it('already linked: no Create / Link entries for a non-admin', async () => {
    const { panel } = await mountAndOpenMore({ on: true, creatable: [CONN], chips: [CHIP] })
    await settle(() => !!host.querySelector('[data-gitlab-chip]'))
    expect(panel()?.querySelector('[data-record-gitlab-create]')).toBeNull()
  })
})
