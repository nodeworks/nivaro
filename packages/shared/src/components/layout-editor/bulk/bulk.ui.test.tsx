// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import type { LayoutDraft } from '../useLayoutDraft'
import { BulkRun } from './BulkRun'
import { type MacroRecorder, useMacroRecorder } from './useMacroRecorder'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

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

const click = async (sel: string) => {
  const el = host.querySelector(sel) as HTMLElement | null
  expect(el, sel).not.toBeNull()
  await act(async () => {
    el?.click()
  })
}

const PREVIEW = {
  label: 'Place Fusion Number after PO Number',
  values: null,
  forms: [
    {
      layout_id: 1,
      name: 'Standard',
      layout_type: 'grouped',
      rev: 'a',
      status: 'change',
      reason: null,
      changes: ['Moves Fusion Number after PO Number'],
      notes: [],
      ops_count: 1
    },
    {
      layout_id: 2,
      name: 'Capital',
      layout_type: 'grouped',
      rev: 'b',
      status: 'skip',
      reason: 'PO Number is not on this form',
      changes: [],
      notes: [],
      ops_count: 0
    },
    {
      layout_id: 3,
      name: 'Open now',
      layout_type: 'grouped',
      rev: 'c',
      status: 'change',
      reason: null,
      changes: ['Adds Fusion Number after PO Number in "Main"'],
      notes: [],
      ops_count: 1
    }
  ]
}

describe('BulkRun', () => {
  it('previews per form, leaves the unsaved form out, applies with the revs and undoes', async () => {
    const calls: Cmd[] = []
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path.endsWith('/bulk/preview')) return { data: PREVIEW }
        if (cmd._path.endsWith('/bulk/apply'))
          return {
            data: {
              label: PREVIEW.label,
              forms: [
                {
                  layout_id: 1,
                  name: 'Standard',
                  status: 'applied',
                  reason: null,
                  version_id: 77,
                  rev: 'a2'
                }
              ]
            }
          }
        return { data: { forms: [{ layout_id: 1, status: 'restored', reason: null }] } }
      })
    }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    await act(async () => {
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <BulkRun
              collection='po'
              action={{
                kind: 'change',
                change: { type: 'place_after', field: 'fusion_number', anchor: 'po_number' }
              }}
              labels={{ fusion_number: 'Fusion Number' }}
              dirtyLayoutId={3}
              applyLabel={(n) => `Apply to ${n}`}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await click('[data-bulk-preview]')
    await settle(() => !!host.querySelector('[data-bulk-preview-list]'))
    const text = host.textContent ?? ''
    expect(text).toContain('Changes 2 forms · 1 skipped')
    expect(text).toContain('PO Number is not on this form')
    expect(text).toContain('has unsaved changes here')
    // The dirty form starts unticked; the skipped one cannot be ticked.
    const boxes = [...host.querySelectorAll('input[type=checkbox]')] as HTMLInputElement[]
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, true],
      [false, false]
    ])
    expect(host.querySelector('[data-bulk-apply]')?.textContent).toBe('Apply to 1')

    await click('[data-bulk-apply]')
    await settle(() => !!host.querySelector('[data-bulk-result]'))
    const apply = calls.find((c) => c._path.endsWith('/bulk/apply'))
    expect(apply?._body).toMatchObject({
      collection: 'po',
      layout_ids: [1],
      revs: { 1: 'a', 2: 'b', 3: 'c' }
    })

    await click('[data-bulk-undo]')
    await settle(() => host.textContent?.includes('Undone') ?? false)
    const undo = calls.find((c) => c._path.endsWith('/bulk/undo'))
    expect(undo?._body).toEqual({
      collection: 'po',
      items: [{ layout_id: 1, version_id: 77, rev: 'a2' }]
    })
  })
})

describe('useMacroRecorder', () => {
  const bundle: LayoutBundle = {
    layout: { id: 1, collection: 'po', name: 'Form', layout_type: 'grouped' },
    groups: [{ ...newGroup('g1', 'Main', 'section', null), sort: 0 }],
    placements: [
      { ...newPlacement('a', 'g1'), sort: 0 },
      { ...newPlacement('b', 'g1'), sort: 1 }
    ],
    rev: 'r'
  }

  it('writes down applies only while recording, and Undo takes the last one off', async () => {
    const raw = {
      bundle,
      apply: vi.fn(),
      undo: vi.fn(),
      redo: vi.fn(),
      canUndo: true,
      canRedo: true
    } as unknown as LayoutDraft
    let out: { draft: LayoutDraft; recorder: MacroRecorder } | null = null
    function Probe() {
      out = useMacroRecorder(raw)
      return null
    }
    await act(async () => root.render(<Probe />))
    const get = () => out as unknown as { draft: LayoutDraft; recorder: MacroRecorder }
    const width = { op: 'update_placement' as const, at: { field: 'a', group_key: 'g1' } }

    await act(async () => get().draft.apply([{ ...width, patch: { col_span: 6 } }]))
    expect(get().recorder.steps).toEqual([])
    expect(raw.apply).toHaveBeenCalledTimes(1)

    await act(async () => get().recorder.start(1))
    await act(async () => get().draft.apply([{ ...width, patch: { col_span: 4 } }]))
    await act(async () =>
      get().draft.apply([{ op: 'remove', at: { field: 'b', group_key: 'g1' } }], {
        label: 'Remove b'
      })
    )
    expect(get().recorder.steps.map((s) => s.op)).toEqual(['update_placement', 'remove'])

    await act(async () => get().draft.undo())
    expect(get().recorder.steps.map((s) => s.op)).toEqual(['update_placement'])
    expect(raw.undo).toHaveBeenCalledTimes(1)
    await act(async () => get().draft.redo())
    expect(get().recorder.steps.map((s) => s.op)).toEqual(['update_placement', 'remove'])

    await act(async () => get().recorder.stop())
    await act(async () => get().draft.apply([{ ...width, patch: { col_span: 3 } }]))
    expect(get().recorder.steps).toHaveLength(2)
    expect(get().recorder.recording).toBe(false)
  })
})
