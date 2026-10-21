// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import type { GroupRow, LayoutBundle, PlacementRow } from '../../../lib/layout-ops'
import { layoutDraftKeys } from '../useLayoutDraft'
import { ImpactButton, TestingButton } from './TestingPanels'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
Element.prototype.scrollIntoView ??= () => {}

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown>; _body?: any }

const group = (key: string, extra: Partial<GroupRow> = {}): GroupRow => ({
  id: 1,
  key,
  parent_key: null,
  sort: 0,
  label: key,
  type: 'section',
  icon: null,
  is_collapsed: false,
  tab_mode: null,
  hide_when_empty: false,
  visibility_mode: null,
  summary_fields: null,
  summary_hide_empty: false,
  swap_config: null,
  skip_if_filled: null,
  content: null,
  content_tone: null,
  visible_when: null,
  hidden_for_roles: null,
  locked_for_roles: null,
  read_width: null,
  ...extra
})
const place = (field: string, extra: Partial<PlacementRow> = {}): PlacementRow => ({
  field,
  group_key: 'main',
  sort: 0,
  label_override: null,
  is_visible: true,
  default_expanded: true,
  col_span: null,
  overrides: null,
  show_row_revisions: false,
  allow_revision_restore: null,
  lock_conditions: null,
  input_bindings: null,
  widget_id: null,
  show_approval_chain: false,
  ...extra
})
const bundleWith = (zoneVisible: boolean, conditions: unknown): LayoutBundle => ({
  layout: { id: 5, collection: 'orders', name: 'Main', layout_type: 'grouped', conditions },
  groups: [group('main')],
  placements: [place('title'), place('zone', { is_visible: zoneVisible })],
  rev: 'r1'
})
const PINNED = { testing: { records: [{ item: '7', role_id: null }] } }

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
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const body = () => document.body.textContent ?? ''

async function mount(which: 'impact' | 'testing', draft: LayoutBundle, apply = vi.fn()) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collection-layouts/5/test-records')
        return {
          data: {
            results: [
              {
                item: '7',
                role_id: null,
                found: true,
                role: null,
                saved: { layout_id: 5, name: 'Main', why: 'The default form' },
                draft: { layout_id: 5, name: 'Main', why: 'The default form' },
                values: {},
                access: null
              }
            ]
          }
        }
      if (cmd._path === '/collection-layouts/5/walkthrough-access')
        return {
          data: {
            role: { id: 'R1', name: 'Requester', admin_access: false },
            role_may_open: true,
            can_create: true,
            create_fields: ['title'],
            hidden_fields: [],
            new_record_form: { layout_id: 5, name: 'Main' },
            column_defaults: []
          }
        }
      if (cmd._path === '/field-config/orders/project')
        return {
          data: [
            { field: 'title', label: 'Title', required: true, group_key: 'main' },
            { field: 'zone', label: 'Zone', required: true, group_key: 'main' }
          ]
        }
      if (cmd._path === '/collections/orders') return { data: { display_template: '{{title}}' } }
      if (cmd._path === '/items/orders') return { data: [{ id: 7, title: 'Acme order' }] }
      if (cmd._path === '/roles') return { data: [{ id: 'R1', name: 'Requester' }] }
      if (cmd._path === '/field-config/orders') return { data: [{ field: 'zone', label: 'Zone' }] }
      return { data: [] }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  qc.setQueryData(layoutDraftKeys.bundle(5), bundleWith(true, PINNED))
  const props = {
    collection: 'orders',
    layoutId: 5,
    bundle: draft,
    parent: null,
    apply,
    dirty: true,
    fields: [{ field: 'zone', label: 'Zone' }]
  }
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          {which === 'impact' ? <ImpactButton {...props} /> : <TestingButton {...props} />}
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return { calls, apply }
}

describe('Check impact (#2647)', () => {
  it('lists what the unsaved changes do to the pinned records, and the form cost', async () => {
    const { calls } = await mount('impact', bundleWith(false, PINNED))
    await act(async () => (host.querySelector('[data-editor-impact]') as HTMLElement).click())
    // The record's label arrives after the impact list; wait for both.
    await settle(() => body().includes('Record Acme order loses the Zone field'))
    expect(body()).toContain('Record Acme order loses the Zone field')
    const sent = calls.find((c) => c._path === '/collection-layouts/5/test-records')
    expect(sent?._method).toBe('POST')
    expect(sent?._body.records).toEqual([{ item: '7', role_id: null }])
    expect(sent?._body.draft).toMatchObject({ layout_type: 'grouped', is_active: false })
    await settle(() => body().includes('requests when it opens'))
    expect(body()).toContain('≈ 5 requests when it opens (limit 40)')
    expect(calls.every((c) => c._method !== 'PATCH')).toBe(true)
  })
})

describe('Test popover', () => {
  it('pins a record as one layout_update that keeps the role list', async () => {
    const { apply } = await mount('testing', bundleWith(true, { role_ids: ['R1'] }))
    await act(async () => (host.querySelector('[data-editor-testing]') as HTMLElement).click())
    const search = document.querySelector(
      '[aria-label="Search records to pin"]'
    ) as HTMLInputElement
    expect(search).toBeTruthy()
    await settle(() => body().includes('Acme order'))
    const option = [...document.querySelectorAll('button')].find(
      (b) => b.textContent === 'Acme order'
    ) as HTMLButtonElement
    await act(async () => option.click())
    const pin = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Pin'
    ) as HTMLButtonElement
    await act(async () => pin.click())
    expect(apply).toHaveBeenCalledWith(
      [
        {
          op: 'layout_update',
          patch: {
            conditions: { role_ids: ['R1'], testing: { records: [{ item: '7', role_id: null }] } }
          }
        }
      ],
      { label: 'Pin a test record' }
    )
  })

  it('the walkthrough stops where a required field cannot be filled', async () => {
    await mount('testing', bundleWith(true, PINNED))
    await act(async () => (host.querySelector('[data-editor-testing]') as HTMLElement).click())
    const tab = document.querySelector('[data-testing-tab="walk"]') as HTMLElement
    await act(async () => tab.click())
    await settle(() => !!document.querySelector('[data-walk-result]'))
    // The role may write Title only: Zone (required, no default) stops it at Save.
    expect(document.querySelector('[data-walk-result]')?.getAttribute('data-walk-result')).toBe(
      'blocked'
    )
    expect(body()).toContain('Stops at Save: Zone is required, but Requester may not write it.')
    expect(body()).toContain('Title — fills it in')
  })
})
