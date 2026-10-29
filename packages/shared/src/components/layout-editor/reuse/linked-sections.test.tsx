// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import {
  type LayoutBundle,
  type LayoutOp,
  newGroup,
  newPlacement,
  ungroupedGroup
} from '../../../lib/layout-ops'
import { LibraryRows } from './LibraryRows'
import {
  blockedLink,
  indexLinks,
  isLockedTarget,
  LinkedSectionNotice,
  LinkedSectionsProvider,
  type LinkedSectionsValue,
  linkOfTarget,
  publishWords,
  type SectionLink
} from './linked-sections'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// Linked sections (#3194): a library section placed as linked is read-only on
// the form and changes in the library, for every form that links it.

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { error: vi.fn(), success: vi.fn(), warning: vi.fn() })
}))

const ROOT = 'lib8_0a1b2c3d'
const bundle: LayoutBundle = {
  layout: { id: 3, collection: 'orders', layout_type: 'grouped' },
  groups: [
    { ...newGroup('main', 'Main', 'section', null), sort: 0 },
    { ...newGroup(ROOT, 'Address', 'container', null), sort: 1 },
    { ...newGroup('t1', 'Home', 'tab', ROOT), sort: 0 },
    ungroupedGroup(2)
  ],
  placements: [
    { ...newPlacement('title', 'main'), sort: 0 },
    { ...newPlacement('street', 't1'), sort: 0 }
  ],
  rev: 'r'
}
const link: SectionLink = {
  id: 1,
  template_id: 8,
  template_name: 'Address block',
  source_collection: 'orders',
  group_key: ROOT,
  field_map: {},
  confirmed: true,
  in_sync: true,
  linked_forms: 3
}

describe('which nodes a link covers', () => {
  const index = indexLinks(bundle, [link, { ...link, id: 2, group_key: 'lib8_gone0000' }])

  it('the section, its tabs and their fields; links whose section is not here are ignored', () => {
    expect([...index.roots]).toEqual([ROOT])
    expect(linkOfTarget(index, { kind: 'group', key: 't1' })).toBe(link)
    expect(linkOfTarget(index, { kind: 'field', field: 'street', group_key: 't1' })).toBe(link)
    expect(linkOfTarget(index, { kind: 'field', field: 'title', group_key: 'main' })).toBeNull()
  })

  it('locks what is inside, never the section itself (it still moves on the form)', () => {
    expect(isLockedTarget(index, { kind: 'group', key: ROOT }, null)).toBe(false)
    expect(isLockedTarget(index, { kind: 'group', key: 't1' }, null)).toBe(true)
    expect(isLockedTarget(index, { kind: 'field', field: 'street', group_key: 't1' }, null)).toBe(
      true
    )
    expect(isLockedTarget(index, { kind: 'group', key: 't1' }, ROOT)).toBe(false)
  })

  it('refuses changes inside, allows moving and removing the section', () => {
    const refused: LayoutOp[][] = [
      [{ op: 'place', field: 'zip', group_key: 't1', index: 0 }],
      [{ op: 'move', from: { field: 'street', group_key: 't1' }, to_group_key: 'main', index: 0 }],
      [{ op: 'move', from: { field: 'title', group_key: 'main' }, to_group_key: 't1', index: 0 }],
      [
        { op: 'update_placement', at: { field: 'street', group_key: 't1' }, patch: { col_span: 6 } }
      ],
      [{ op: 'group_update', key: ROOT, patch: { label: 'X' } }],
      [{ op: 'group_remove', key: 't1', placements: 'delete' }],
      [
        {
          op: 'group_create',
          key: 't2',
          label: 'T2',
          group_type: 'tab',
          parent_key: ROOT,
          index: 1
        }
      ]
    ]
    for (const ops of refused) expect(blockedLink(ops, index, null)).toBe(link)
    const allowed: LayoutOp[][] = [
      [{ op: 'group_move', key: ROOT, parent_key: null, index: 0 }],
      [{ op: 'group_remove', key: ROOT, placements: 'delete' }],
      [{ op: 'place', field: 'zip', group_key: 'main', index: 0 }]
    ]
    for (const ops of allowed) expect(blockedLink(ops, index, null)).toBeNull()
    // Open for editing: anything goes inside it.
    expect(blockedLink(refused[0], index, ROOT)).toBeNull()
  })

  it('says what a publish did', () => {
    expect(
      publishWords({
        template_id: 8,
        updated: [{ layout_id: 4, name: 'B' }],
        unchanged: 1,
        skipped: [{ layout_id: 5, name: 'C', reason: 'the form is frozen' }]
      })
    ).toEqual({
      text: '1 form updated, 1 already matched',
      skipped: 'Not updated: C (the form is frozen). Update them from their editors.'
    })
  })
})

type Cmd = { _method?: string; _path: string; _body?: any }

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
  for (let i = 0; i < 60 && !until(); i++)
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
}

function ctxValue(extra: Partial<LinkedSectionsValue> = {}): LinkedSectionsValue {
  return {
    layoutId: 3,
    bundle,
    links: [link],
    index: indexLinks(bundle, [link]),
    editing: null,
    setEditing: vi.fn(),
    rawApply: vi.fn(),
    save: vi.fn(async () => true),
    refresh: vi.fn(),
    ...extra
  }
}

async function render(client: unknown, node: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  })
}

const click = async (sel: string) => {
  await act(async () => {
    ;(document.querySelector(sel) as HTMLButtonElement | null)?.click()
  })
}

describe('placing a library section as linked', () => {
  it('plans with linked: true, applies it as one step and links the new section', async () => {
    const calls: Cmd[] = []
    const OPS = [
      {
        op: 'group_create',
        key: ROOT,
        label: 'Address',
        group_type: 'section',
        parent_key: null,
        index: 1
      }
    ]
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path === '/collection-layouts/templates')
          return {
            data: [
              {
                id: 8,
                kind: 'section',
                name: 'Address block',
                description: null,
                source_collection: 'orders',
                layout_type: null,
                fields: ['street'],
                sections: 1,
                linked_forms: 2
              }
            ]
          }
        if (cmd._path === '/collection-layouts/blocks/plan')
          return { linked_key: ROOT, ops: OPS, keys: {}, already: [], unmapped: [], dropped: [] }
        return { data: [] }
      })
    }
    const apply = vi.fn()
    const value = ctxValue({ links: [] })
    await render(
      client,
      <LinkedSectionsProvider value={value}>
        <LibraryRows
          bundle={bundle}
          collection='orders'
          selected={null}
          apply={apply}
          onSelect={vi.fn()}
          matches={() => true}
        />
      </LinkedSectionsProvider>
    )
    await settle(() => !!document.querySelector('[data-library-linked="8"]'))
    expect(document.body.textContent).toContain('linked on 2 forms')
    await click('[data-library-linked="8"]')
    await settle(() => calls.some((c) => c._path.endsWith('/section-links')))
    expect(calls.find((c) => c._path === '/collection-layouts/blocks/plan')?._body).toMatchObject({
      linked: true
    })
    expect(apply).toHaveBeenCalledWith(OPS, { label: 'Add Address block (linked)' })
    expect(calls.find((c) => c._path === '/collection-layouts/3/section-links')?._body).toEqual({
      template_id: 8,
      group_key: ROOT
    })
    expect(value.refresh).toHaveBeenCalled()
  })
})

describe('the linked section card', () => {
  it('offers Edit, Unlink and (when it differs) Update from the library', async () => {
    const value = ctxValue()
    const differs = { ...link, in_sync: false }
    const client = {
      request: vi.fn(async (cmd: Cmd) =>
        cmd._path.endsWith('/plan')
          ? { ops: [{ op: 'group_remove', key: ROOT, placements: 'delete' }], in_sync: false }
          : {}
      )
    }
    await render(
      client,
      <LinkedSectionsProvider value={value}>
        <LinkedSectionNotice link={differs} />
      </LinkedSectionsProvider>
    )
    expect(document.body.textContent).toContain('also on 2 forms')
    expect(document.querySelector('[data-linked-differs]')).not.toBeNull()
    await click('[data-linked-update]')
    await settle(() => (value.rawApply as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(value.rawApply).toHaveBeenCalledWith(
      [{ op: 'group_remove', key: ROOT, placements: 'delete' }],
      { label: 'Update Address block from the library' }
    )
    await click('[data-linked-edit]')
    expect(value.setEditing).toHaveBeenCalledWith(ROOT)
  })

  it('Publish saves the form, then sends the section to the library and the other forms', async () => {
    const calls: Cmd[] = []
    const value = ctxValue({ editing: ROOT })
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        return {
          data: {
            template_id: 8,
            updated: [{ layout_id: 4, name: 'B' }],
            unchanged: 1,
            skipped: []
          }
        }
      })
    }
    await render(
      client,
      <LinkedSectionsProvider value={value}>
        <LinkedSectionNotice link={link} />
      </LinkedSectionsProvider>
    )
    expect(document.querySelector('[data-linked-publish]')?.textContent).toBe('Publish to 3 forms')
    await click('[data-linked-publish]')
    await settle(() => calls.length > 0)
    expect(value.save).toHaveBeenCalled()
    expect(calls[0]).toMatchObject({
      _method: 'PUT',
      _path: '/collection-layouts/templates/8/content',
      _body: { layout_id: 3, group_key: ROOT }
    })
    await settle(() => (value.setEditing as ReturnType<typeof vi.fn>).mock.calls.length > 0)
    expect(value.setEditing).toHaveBeenCalledWith(null)
  })

  it('does not publish when the form could not be saved', async () => {
    const value = ctxValue({ editing: ROOT, save: vi.fn(async () => false) })
    const client = { request: vi.fn(async () => ({})) }
    await render(
      client,
      <LinkedSectionsProvider value={value}>
        <LinkedSectionNotice link={link} />
      </LinkedSectionsProvider>
    )
    await click('[data-linked-publish]')
    await settle(() => !!document.querySelector('[role=alert]'))
    expect(document.querySelector('[role=alert]')?.textContent).toMatch(/Save the form first/)
    expect(client.request).not.toHaveBeenCalled()
  })
})
