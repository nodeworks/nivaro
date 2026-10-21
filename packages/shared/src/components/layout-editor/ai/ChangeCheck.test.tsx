// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { applyLayoutOps, type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { type LayoutEditorHost, LayoutEditorHostContext } from '../host'
import type { DraftStatus } from '../useLayoutDraft'
import { rebaseAssistOps, savedJustNow, slimBundle } from './assist-ops'
import { AiChangeCheck } from './ChangeCheck'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const BASE: LayoutBundle = {
  layout: { id: 5, collection: 'orders' },
  groups: [{ ...newGroup('money', 'Money', 'section', null), sort: 0 }],
  placements: [
    { ...newPlacement('amount', 'money'), sort: 0, overrides: { label: 'Total', note: 'old' } }
  ],
  rev: 'r1'
}

describe('assist ops', () => {
  it('merges an overrides patch into the placement as it is now', () => {
    const [op] = rebaseAssistOps(
      [
        {
          op: 'update_placement',
          at: { field: 'amount', group_key: 'money' },
          patch: { overrides: { note: 'new' } }
        }
      ],
      BASE
    )
    expect(op).toMatchObject({ patch: { overrides: { label: 'Total', note: 'new' } } })
  })

  it('adds roles to the section list as it is now, without repeats', () => {
    const b = applyLayoutOps(BASE, [
      { op: 'group_update', key: 'money', patch: { hidden_for_roles: '["a"]' } }
    ])
    const [op] = rebaseAssistOps(
      [{ op: 'group_update', key: 'money', patch: { hidden_for_roles: '["A","b"]' } }],
      b
    )
    expect(op).toEqual({
      op: 'group_update',
      key: 'money',
      patch: { hidden_for_roles: '["a","b"]' }
    })
  })

  it('knows a manual save from a discard or autosave', () => {
    expect(savedJustNow(2, 0, 'saving', false)).toBe(true)
    expect(savedJustNow(2, 0, 'saved', false)).toBe(true)
    expect(savedJustNow(2, 0, 'idle', false)).toBe(false) // discard
    expect(savedJustNow(2, 0, 'saving', true)).toBe(false)
    expect(savedJustNow(0, 0, 'saved', false)).toBe(false)
  })

  it('slims a bundle to what the check reads', () => {
    const s = slimBundle(BASE)
    expect(Object.keys(s.placements[0]).sort()).toEqual(
      [
        'field',
        'group_key',
        'is_visible',
        'label_override',
        'lock_conditions',
        'overrides',
        'sort',
        'widget_id'
      ].sort()
    )
  })
})

let root: Root
let el: HTMLDivElement
beforeEach(() => {
  el = document.createElement('div')
  document.body.appendChild(el)
  root = createRoot(el)
})
afterEach(() => {
  act(() => root.unmount())
  el.remove()
  document.body.innerHTML = ''
})

type Cmd = { _path: string; _body?: { before: unknown; after: unknown } }

const HOST: LayoutEditorHost = {
  isAdmin: true,
  navigate: () => {},
  warning: null,
  recordLink: () => ''
}

function draftOf(bundle: LayoutBundle, unsavedCount: number, status: DraftStatus) {
  return { bundle, status, unsavedCount, autosave: false, unsavedOps: () => [] }
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await act(async () => {})
}

describe('AiChangeCheck', () => {
  function setup(answer: unknown, admin = true) {
    const calls: Cmd[] = []
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (answer instanceof Error) throw answer
        return { data: answer }
      })
    }
    const render = (bundle: LayoutBundle, unsaved: number, status: DraftStatus) =>
      act(() =>
        root.render(
          <NivaroProvider client={client as never}>
            <LayoutEditorHostContext.Provider value={{ ...HOST, isAdmin: admin }}>
              <AiChangeCheck layoutId={5} draft={draftOf(bundle, unsaved, status)} />
            </LayoutEditorHostContext.Provider>
          </NivaroProvider>
        )
      )
    return { calls, render }
  }

  const hidden = applyLayoutOps(BASE, [
    {
      op: 'update_placement',
      at: { field: 'amount', group_key: 'money' },
      patch: { is_visible: false }
    }
  ])

  it('checks on Save with the last saved layout and the new one, and opens warnings', async () => {
    const { calls, render } = setup({
      status: 'checked',
      changes: ['Hid "Total" on this form'],
      warnings: [
        {
          message: 'Finance must fill Total before Approve.',
          field: 'amount',
          field_label: 'Total',
          section: null,
          section_label: null,
          roles: ['Finance']
        }
      ],
      dropped: 1
    })
    render(BASE, 0, 'idle')
    expect(el.querySelector('[data-ai-change-check]')).toBeNull()
    render(hidden, 1, 'idle')
    expect(el.querySelector('[data-ai-change-check]')?.textContent).toContain('Check')
    render(hidden, 0, 'saving')
    await flush()
    expect(calls).toHaveLength(1)
    expect(calls[0]._path).toBe('/ai-design/layouts/5/check-changes')
    const body = calls[0]._body as { before: LayoutBundle; after: LayoutBundle }
    expect(body.before.placements[0].is_visible).toBe(true)
    expect(body.after.placements[0].is_visible).toBe(false)
    expect(el.querySelector('[data-ai-change-check]')?.textContent).toContain('1 to look at')
    const panel = document.querySelector('[data-ai-change-check-panel]')
    expect(panel?.textContent).toContain('Finance must fill Total before Approve.')
    expect(panel?.textContent).toContain('Roles: Finance')
    expect(panel?.textContent).toContain('Left out 1 remark')
    expect(panel?.textContent).toContain('never blocks Save')
  })

  it('stays silent after a trivial save, a discard, or without AI', async () => {
    const trivial = setup({ status: 'skipped', reason: 'trivial', changes: ['Renamed'] })
    trivial.render(BASE, 0, 'idle')
    trivial.render(hidden, 1, 'idle')
    trivial.render(hidden, 0, 'saved')
    await flush()
    expect(trivial.calls).toHaveLength(1)
    expect(el.querySelector('[data-ai-change-check]')).toBeNull()

    trivial.render(BASE, 1, 'idle')
    trivial.render(BASE, 0, 'idle') // discard
    await flush()
    expect(trivial.calls).toHaveLength(1)

    act(() => root.unmount())
    root = createRoot(el)
    const noAi = setup(Object.assign(new Error('no ai'), { status: 503 }))
    noAi.render(BASE, 0, 'idle')
    noAi.render(hidden, 1, 'idle')
    noAi.render(hidden, 0, 'saving')
    await flush()
    expect(el.querySelector('[data-ai-change-check]')).toBeNull()
  })

  it('is admin-only', () => {
    const { render } = setup({}, false)
    render(hidden, 2, 'idle')
    expect(el.querySelector('[data-ai-change-check]')).toBeNull()
  })
})
