// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { FieldStateMatrix } from './FieldStateMatrix'
import { RoleSectionMatrix } from './RoleSectionMatrix'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown }

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
  document.body.replaceChildren()
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const bundle = (parentId: number | null = null): LayoutBundle => ({
  layout: { id: 5, collection: 'po', name: 'Rush', parent_layout_id: parentId },
  groups: [{ ...newGroup('main', 'Main', 'section', null), sort: 0 }],
  placements: [
    { ...newPlacement('title', 'main'), sort: 0 },
    { ...newPlacement('total', 'main'), sort: 1 }
  ],
  rev: '1'
})

const parentBundle: LayoutBundle = {
  layout: { id: 1, collection: 'po', name: 'Base order' },
  groups: [newGroup('main', 'Main', 'section', null), newGroup('money', 'Money', 'section', null)],
  placements: [newPlacement('total', 'main'), newPlacement('fee', 'money')],
  rev: '1'
}

async function mount(node: (apply: ReturnType<typeof vi.fn>) => React.ReactNode) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/pipelines')
        return { data: [{ id: 'p1', name: 'Approval', collections: ['po'] }] }
      if (cmd._path === '/pipelines/p1')
        return {
          data: {
            states: [
              { id: 's1', key: 'draft', label: 'Draft' },
              { id: 's2', key: 'done', label: 'Done' }
            ],
            transitions: [{ id: 't1', label: 'Submit', from_state: 's1', requirements: null }]
          }
        }
      if (cmd._path === '/roles')
        return {
          data: [
            { id: 'ADM', name: 'Administrator', admin_access: true },
            { id: 'FIN', name: 'Finance', admin_access: false }
          ]
        }
      if (cmd._path === '/collections/po') return { data: { fields: [], relations: [] } }
      return { data: {} }
    })
  }
  const apply = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{node(apply)}</NivaroProvider>
      </QueryClientProvider>
    )
  })
  return { calls, apply }
}

const cell = (key: string) =>
  document.querySelector<HTMLButtonElement>(`[data-matrix-cell="${key}"]`)
const choice = (v: string) =>
  document.querySelector<HTMLButtonElement>(`[data-matrix-menu] [data-matrix-choice="${v}"]`)

describe('FieldStateMatrix', () => {
  it('locks a field in a state through the draft', async () => {
    const { apply } = await mount((apply) => (
      <FieldStateMatrix
        bundle={bundle()}
        parent={null}
        collection='po'
        apply={apply}
        onSelect={() => {}}
      />
    ))
    await settle(() => !!cell('total\u0001main|draft'))
    await act(async () => cell('total\u0001main|draft')?.click())
    await settle(() => !!choice('readonly'))
    expect(choice('hidden')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => choice('readonly')?.click())
    expect(apply).toHaveBeenCalledWith(
      [
        {
          op: 'update_placement',
          at: { field: 'total', group_key: 'main' },
          patch: {
            lock_conditions: JSON.stringify([
              { type: 'pipeline_state', pipeline_id: 'p1', state_keys: ['draft'] }
            ])
          }
        }
      ],
      { label: 'Total: read-only in Draft' }
    )
  })

  it('required in a state asks the move out of it (saved to the pipeline)', async () => {
    const { apply, calls } = await mount((apply) => (
      <FieldStateMatrix
        bundle={bundle()}
        parent={null}
        collection='po'
        apply={apply}
        onSelect={() => {}}
      />
    ))
    await settle(() => !!cell('title\u0001main|draft'))
    // Nothing leaves Done: Required is not offered there.
    await act(async () => cell('title\u0001main|done')?.click())
    await settle(() => !!choice('required'))
    expect(choice('required')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => cell('title\u0001main|draft')?.click())
    await settle(() => choice('required')?.getAttribute('aria-disabled') == null)
    await act(async () => choice('required')?.click())
    await settle(() => calls.some((c) => c._method === 'PATCH'))
    expect(apply).not.toHaveBeenCalled()
    const save = calls.find((c) => c._method === 'PATCH')
    expect(save?._path).toBe('/pipelines/transitions/t1')
    expect(save?._body).toEqual({ requirements: [{ type: 'record_fields', fields: ['title'] }] })
  })

  it('marks overrides and inherited fields; inherited cells are locked', async () => {
    const { apply } = await mount((apply) => (
      <FieldStateMatrix
        bundle={bundle(1)}
        parent={parentBundle}
        collection='po'
        apply={apply}
        onSelect={() => {}}
      />
    ))
    await settle(() => !!document.querySelector('[data-inherit="inherited"]'))
    expect(
      document.querySelector('[data-matrix-row="total"] [data-inherit="override"]')
    ).not.toBeNull()
    expect(cell('fee\u0001money|*')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () =>
      document
        .querySelector<HTMLButtonElement>('[data-matrix-row="total"] [data-inherit-action="reset"]')
        ?.click()
    )
    expect(apply).toHaveBeenCalledWith(
      [{ op: 'remove', at: { field: 'total', group_key: 'main' } }],
      { label: 'Reset Total to Base order' }
    )
  })
})

describe('RoleSectionMatrix', () => {
  it('hides a section from a role; admin columns are locked', async () => {
    const { apply } = await mount((apply) => (
      <RoleSectionMatrix bundle={bundle()} parent={null} apply={apply} onSelect={() => {}} />
    ))
    await settle(() => !!cell('main|FIN'))
    expect(cell('main|ADM')?.getAttribute('aria-disabled')).toBe('true')
    await act(async () => cell('main|FIN')?.click())
    await settle(() => !!choice('hidden'))
    await act(async () => choice('hidden')?.click())
    expect(apply).toHaveBeenCalledWith(
      [
        {
          op: 'group_update',
          key: 'main',
          patch: { hidden_for_roles: '["FIN"]', locked_for_roles: null }
        }
      ],
      { label: 'Hide Main from Finance' }
    )
  })
})
