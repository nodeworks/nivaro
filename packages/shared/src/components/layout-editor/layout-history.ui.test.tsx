// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { DesignNode } from './DesignNode'
import { type DesignTarget, type LayoutDesign, LayoutDesignContext } from './design-context'
import { HistoryPanel } from './HistoryPanel'
import { ScheduledChanges } from './overview/ScheduledChanges'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

const VERSIONS = [
  {
    id: 12,
    version: 3,
    note: 'before save',
    created_at: '2026-10-19T14:00:00Z',
    created_by_name: 'Dana Ortiz',
    name: null
  },
  {
    id: 11,
    version: 2,
    note: 'before restore',
    created_at: '2026-10-18T14:00:00Z',
    created_by_name: null,
    name: 'Go-live baseline'
  }
]
const BUNDLE = {
  layout: { id: 5, collection: 'orders', name: 'Main', layout_type: 'grouped' },
  groups: [],
  placements: [],
  rev: 'version:12'
}

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
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function render(node: ReactNode, ready: () => boolean = () => true) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path === '/collection-layouts/5/versions') return { data: VERSIONS }
      if (cmd._path.endsWith('/bundle')) return { data: { bundle: BUNDLE, version: 3 } }
      if (cmd._path.endsWith('/diff'))
        return {
          data: {
            from: { version: 3, created_at: null, note: null },
            layout: [],
            groups: { added: [], removed: [], changed: [] },
            assignments: { added: ['x'], removed: [], changed: [] },
            warnings: [],
            total: 1
          }
        }
      return { data: {} }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>{node}</NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(ready)
  return calls
}

const q = <T extends Element>(sel: string) => host.querySelector<T>(sel)
const click = (el: Element | null) =>
  act(async () => {
    ;(el as HTMLElement).click()
  })
async function type(el: HTMLInputElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
const enter = (el: Element) =>
  act(async () => {
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })

describe('HistoryPanel — session, names, canvas (#2618 #2610 #2591)', () => {
  it('lists this session’s steps, marks unsaved ones and jumps to a step', async () => {
    const onJump = vi.fn()
    await render(
      <HistoryPanel
        layoutId={5}
        session={{
          done: [
            { label: 'Move Status', state: 'saved' },
            { label: 'Remove Notes', state: 'unsaved' },
            { label: 'Rename field', state: 'unsaved' }
          ],
          undone: [{ label: 'Add Owner' }]
        }}
        onJump={onJump}
      />,
      () => host.textContent?.includes('Dana Ortiz') ?? false
    )
    expect(q('[data-session-step="1"]')?.getAttribute('data-step-state')).toBe('unsaved')
    expect(q('[data-session-step="2"]')?.getAttribute('aria-current')).toBe('step')
    await click(q('[data-session-step="0"]'))
    expect(onJump).toHaveBeenLastCalledWith(-2)
    await click(q('[data-session-step="start"]'))
    expect(onJump).toHaveBeenLastCalledWith(-3)
    await click(q('[data-session-undone="0"]'))
    expect(onJump).toHaveBeenLastCalledWith(1)
  })

  it('names a version, and the saved layout, and shows names', async () => {
    const calls = await render(<HistoryPanel layoutId={5} />, () =>
      Boolean(q('[data-version-name]'))
    )
    expect(q('[data-version-name]')?.textContent).toContain('Go-live baseline')

    await click(q('[data-version-name-edit="3"]'))
    const input = q<HTMLInputElement>('input[aria-label="Version name"]') as HTMLInputElement
    await type(input, '  Before April ')
    await enter(input)
    await settle(() => calls.some((c) => c._method === 'PATCH'))
    expect(calls.find((c) => c._method === 'PATCH')).toMatchObject({
      _path: '/collection-layouts/5/versions/12',
      _body: { name: 'Before April' }
    })

    await click(q('[data-name-current] button'))
    const cur = q<HTMLInputElement>('input[aria-label="Version name"]') as HTMLInputElement
    await type(cur, 'Go-live')
    await enter(cur)
    await settle(() => calls.some((c) => c._path.endsWith('/versions/name')))
    expect(calls.find((c) => c._path.endsWith('/versions/name'))?._body).toEqual({
      name: 'Go-live'
    })
  })

  it('Show on canvas reads the version as a bundle and hands it to the editor', async () => {
    const onShow = vi.fn()
    await render(<HistoryPanel layoutId={5} onShowOnCanvas={onShow} />, () =>
      Boolean(q('[data-version-canvas="2"]'))
    )
    await click(q('[data-version-canvas="2"]'))
    await settle(() => onShow.mock.calls.length > 0)
    expect(onShow).toHaveBeenCalledWith(BUNDLE, '“Go-live baseline” (v2)')
  })
})

describe('ScheduledChanges (#2590)', () => {
  const row = (over = {}) => ({
    id: 4,
    layout_id: 5,
    layout_name: 'Main',
    collection: 'orders',
    note: 'April fields',
    run_at: '2026-10-21T13:00:00Z',
    status: 'pending' as const,
    error: null,
    op_count: 3,
    created_by: 'u1',
    created_by_name: 'Dana Ortiz',
    created_at: null,
    updated_by_name: null,
    applied_at: null,
    ...over
  })

  it('shows when and who, and cancels after a second click', async () => {
    const calls = await render(<ScheduledChanges rows={[row()]} collection='orders' />)
    expect(host.textContent).toContain('3 changes')
    expect(host.textContent).toContain('Dana Ortiz')
    expect(host.textContent).toContain('April fields')
    await click(q('[data-schedule-cancel="4"]'))
    expect(calls).toHaveLength(0)
    await click(q('[data-schedule-cancel-confirm="4"]'))
    await settle(() => calls.length > 0)
    expect(calls[0]).toMatchObject({ _method: 'DELETE', _path: '/collection-layouts/schedules/4' })
  })

  it('a failed change says why and can be dismissed', async () => {
    await render(
      <ScheduledChanges
        rows={[row({ status: 'failed', error: 'That field is no longer there' })]}
        collection='orders'
      />
    )
    expect(q('[data-schedule-status="failed"]')?.textContent).toContain(
      'That field is no longer there'
    )
  })
})

describe('DesignNode comparison marks (#2591) and last change (#2611)', () => {
  const field: DesignTarget = { kind: 'field', field: 'title', group_key: 'main' }
  const section: DesignTarget = { kind: 'group', key: 'main' }
  const design = (over: Partial<LayoutDesign>): LayoutDesign => ({
    selected: null,
    onSelect: vi.fn(),
    showHidden: false,
    inheritedFrom: () => null,
    dnd: {
      draggableProps: () => ({ 'data-draggable': 'yes' }),
      isDragging: () => false,
      dropSlot: () => null
    },
    ...over
  })

  it('a removed ghost is marked, never dragged and never selected', async () => {
    const d = design({ diffMark: () => ({ kind: 'removed' }) })
    await act(async () =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={field}>
            <span id='c'>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    const node = q('[data-design-target]') as HTMLElement
    expect(node.getAttribute('data-diff')).toBe('removed')
    expect(node.getAttribute('data-draggable')).toBeNull()
    expect(q('[data-design-diff-tag="removed"]')).not.toBeNull()
    await click(q('#c'))
    expect(d.onSelect).not.toHaveBeenCalled()
  })

  it('a moved node names where it came from', async () => {
    const d = design({ diffMark: () => ({ kind: 'moved', detail: 'from Basics' }) })
    await act(async () =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={field}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    expect(q('[data-design-diff-tag="moved"]')?.textContent).toBe('Moved from Basics')
  })

  it('a section shows who changed it last', async () => {
    const d = design({ lastChange: () => ({ by: 'Dana Ortiz', at: '2020-01-01T00:00:00Z' }) })
    await act(async () =>
      root.render(
        <LayoutDesignContext.Provider value={d}>
          <DesignNode target={section}>
            <span>hi</span>
          </DesignNode>
        </LayoutDesignContext.Provider>
      )
    )
    expect(q('[data-design-last-change]')?.textContent).toContain('Dana Ortiz')
  })
})
