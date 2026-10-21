// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import {
  type GroupRow,
  type LayoutBundle,
  newGroup,
  newPlacement,
  type PlacementRow
} from '../../../lib/layout-ops'
import { LayoutEditorHostContext } from '../host'
import { AiToolsButton } from './AiToolsButton'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown }

const bundle: LayoutBundle = {
  layout: { id: 5, collection: 'invoices' },
  rev: 'r1',
  groups: [{ ...newGroup('main', 'Main', 'section', null), sort: 0 } as GroupRow],
  placements: [
    { ...newPlacement('vendor', 'main'), sort: 0 } as PlacementRow,
    { ...newPlacement('amount', 'main'), sort: 1 } as PlacementRow
  ]
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
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const q = (sel: string) => document.body.querySelector(sel) as HTMLElement | null
const button = (text: string) =>
  [...document.body.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined

function mount(client: { request: (c: Cmd) => Promise<unknown> }, isAdmin = true) {
  const apply = vi.fn()
  const onPins = vi.fn()
  const onSelect = vi.fn()
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditorHostContext.Provider
            value={{ isAdmin, navigate: () => {}, warning: null, recordLink: () => '' }}
          >
            <AiToolsButton
              collection='invoices'
              layoutId={5}
              bundle={bundle}
              apply={apply}
              previewRecordShown={false}
              onPins={onPins}
              onSelect={onSelect}
            />
          </LayoutEditorHostContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return { apply, onPins, onSelect }
}

describe('AiToolsButton', () => {
  it('is admin-only', () => {
    mount({ request: vi.fn(async () => ({ data: [] })) }, false)
    expect(q('[data-ai-tools-trigger]')).toBeNull()
  })

  it('After autofill: ticks often-corrected fields and applies the highlight as one batch', async () => {
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        if (cmd._path === '/ai-design/layouts/5/autofill-corrections')
          return {
            data: {
              days: 90,
              documents: 12,
              min_proposed: 3,
              corrected_share: 0.25,
              fields: [
                { field: 'vendor', proposed: 12, corrected: 6, kept: 6, share: 0.5, suggest: true },
                {
                  field: 'amount',
                  proposed: 12,
                  corrected: 1,
                  kept: 11,
                  share: 0.08,
                  suggest: false
                },
                {
                  field: 'po_number',
                  proposed: 9,
                  corrected: 5,
                  kept: 4,
                  share: 0.55,
                  suggest: true
                }
              ]
            }
          }
        if (cmd._path === '/field-config/invoices')
          return { data: [{ field: 'vendor', label: 'Supplier' }] }
        return { data: [] }
      })
    }
    const { apply } = mount(client)
    await act(async () => q('[data-ai-tools-trigger]')?.click())
    await settle(() => !!q('[data-ai-tools-tab="autofill"]'))
    await act(async () => q('[data-ai-tools-tab="autofill"]')?.click())
    await settle(() => !!q('[data-autofill-tuning]'))
    const text = q('[data-autofill-tuning]')?.textContent ?? ''
    expect(text).toContain('From 12 records')
    expect(text).toContain('Supplier')
    expect(text).toContain('changed 6 of 12')
    const boxes = [...document.body.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')]
    // vendor ticked; amount not; po_number is not on this form.
    expect(boxes.map((b) => [b.checked, b.disabled])).toEqual([
      [true, false],
      [false, false],
      [false, true]
    ])

    await act(async () => q('[data-autofill-highlight]')?.click())
    expect(q('[data-autofill-plan]')?.textContent).toContain(
      'Highlight Supplier when the form is filled from a document'
    )
    await act(async () => q('[data-autofill-apply]')?.click())
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0]).toEqual([
      {
        op: 'update_placement',
        at: { field: 'vendor', group_key: 'main' },
        patch: { overrides: { autofill_check: true } }
      }
    ])
    expect(apply.mock.calls[0][1]).toEqual({
      label: 'Highlight fields often corrected after autofill'
    })
  })

  it('Visual critique: sends section boxes, lists comments and pins them', async () => {
    const editor = document.createElement('div')
    editor.setAttribute('data-layout-editor', '')
    const main = document.createElement('main')
    const section = document.createElement('div')
    section.setAttribute('data-design-target', 'group:main')
    main.appendChild(section)
    editor.appendChild(main)
    host.appendChild(editor)
    const editorRoot = createRoot(editor.appendChild(document.createElement('div')))
    const client = {
      request: vi.fn(async (cmd: Cmd) => {
        if (cmd._path === '/ai-design/layouts/5/visual-critique')
          return {
            data: {
              summary: 'Tidy overall.',
              comments: [
                {
                  id: 'ai:0',
                  section: 'main',
                  topic: 'density',
                  severity: 'medium',
                  comment: 'Main is crowded.',
                  suggestion: 'Split it.',
                  source: 'ai'
                }
              ],
              dropped: [],
              used_image: false,
              image_skipped: 'provider',
              ai_configured: true
            }
          }
        return { data: [] }
      })
    }
    const onPins = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() => {
      editorRoot.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <LayoutEditorHostContext.Provider
              value={{ isAdmin: true, navigate: () => {}, warning: null, recordLink: () => '' }}
            >
              <AiToolsButton
                collection='invoices'
                layoutId={5}
                bundle={bundle}
                apply={vi.fn()}
                previewRecordShown
                onPins={onPins}
                onSelect={vi.fn()}
              />
            </LayoutEditorHostContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    })
    await act(async () => q('[data-ai-tools-trigger]')?.click())
    await settle(() => !!q('[data-ai-tools-tab="critique"]'))
    await act(async () => q('[data-ai-tools-tab="critique"]')?.click())
    expect(q('[data-visual-critique]')?.textContent).toContain('no picture')
    await act(async () => q('[data-critique-run]')?.click())
    await settle(() => !!q('[data-critique-comment]'))
    const call = client.request.mock.calls.find(
      (c) => (c[0] as Cmd)._path === '/ai-design/layouts/5/visual-critique'
    )?.[0] as Cmd
    const body = call._body as { sections: Array<{ key: string }>; image?: string }
    expect(body.sections.map((s) => s.key)).toEqual(['main'])
    // A preview record is on the canvas: no picture leaves the browser.
    expect(body.image).toBeUndefined()
    expect(q('[data-critique-comment="main"]')?.textContent).toContain('Main is crowded.')
    expect(document.body.textContent).toContain('does not read pictures')
    const pins = onPins.mock.calls.at(-1)?.[0]
    expect(pins).toEqual([
      {
        target: { kind: 'group', key: 'main' },
        text: 'Design: density',
        tone: 'violet',
        tip: 'Main is crowded. Split it.'
      }
    ])
    act(() => editorRoot.unmount())
    expect(button('Clear marks on the canvas')).toBeUndefined()
  })
})
