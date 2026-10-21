// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { applyLayoutOps, type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { type LayoutEditorHost, LayoutEditorHostContext } from '../host'
import { AiFormsButton } from './AiFormsButton'
import { MeaningSuggestions } from './MeaningSuggestions'
import { stashBuild } from './pending'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown }

const bundle: LayoutBundle = {
  layout: { id: 9, collection: 'returns', name: 'Main', layout_type: 'grouped' },
  groups: [{ ...newGroup('main', 'Main', 'section', null), sort: 0 }],
  placements: [{ ...newPlacement('reason', 'main'), sort: 0 }],
  rev: 'r1'
}

const FIELDS = [
  { field: 'reason', label: 'Reason' },
  { field: 'amount', label: 'Amount' },
  { field: 'manager', label: 'Manager' }
]

const host: LayoutEditorHost = {
  isAdmin: true,
  navigate: () => {},
  warning: null,
  recordLink: () => ''
}

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
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

function makeClient(answers: Record<string, unknown>) {
  return {
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._path.startsWith('/field-config/')) return { data: FIELDS }
      if (cmd._path in answers) return answers[cmd._path]
      return { data: [] }
    }),
    getToken: () => 't',
    url: ''
  }
}

async function mount(client: ReturnType<typeof makeClient>, ui: ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditorHostContext.Provider value={host}>{ui}</LayoutEditorHostContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
}

const byText = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.includes(text)) as
    | HTMLButtonElement
    | undefined

describe('AiFormsButton', () => {
  it('rebuilds the draft from a description: review first, then one draft batch', async () => {
    const client = makeClient({
      '/ai-design/layouts/compose': {
        data: {
          form: {
            name: 'Returns',
            layout: 'steps',
            groups: [
              { label: 'Request', fields: ['reason', 'amount'], source: null },
              { label: 'Approval', fields: ['manager'], source: null }
            ],
            locks: [],
            requirements: [],
            candidates: [],
            dropped: ['Cost centre'],
            explanation: 'Two steps.'
          }
        }
      }
    })
    const apply = vi.fn()
    await mount(
      client,
      <AiFormsButton
        collection='returns'
        layoutId={9}
        draft={{ bundle, apply }}
        onOpenLayout={() => {}}
      />
    )
    act(() => (document.querySelector('[data-ai-forms-trigger]') as HTMLButtonElement).click())
    act(() => byText('From a description')?.click())
    const ta = document.querySelector('[data-ai-compose-text]') as HTMLTextAreaElement
    act(() => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
        ta,
        'a returns form with a manager approval step'
      )
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(document.querySelector('[data-ai-compose-run]') as HTMLButtonElement).click()
    })
    await settle(() => !!document.querySelector('[data-ai-review]'))
    const call = client.request.mock.calls.find((c) => c[0]._path === '/ai-design/layouts/compose')
    expect(call?.[0]._body).toEqual({
      collection: 'returns',
      text: 'a returns form with a manager approval step'
    })
    const review = document.querySelector('[data-ai-review]')?.textContent ?? ''
    expect(review).toContain('Add step "Request": add Amount; move in Reason')
    expect(review).toContain('Remove the empty section "Main"')
    expect(review).toContain('no field for: Cost centre')
    expect(apply).not.toHaveBeenCalled()

    act(() => (document.querySelector('[data-ai-apply]') as HTMLButtonElement).click())
    expect(apply).toHaveBeenCalledTimes(1)
    const [ops, opts] = apply.mock.calls[0]
    expect(opts).toEqual({ label: 'Rebuild with AI' })
    const out = applyLayoutOps(bundle, ops)
    expect(out.groups.map((g) => g.key)).toEqual(['request', 'approval'])
  })

  it('applies a build waiting for this layout once its bundle is there', async () => {
    const apply = vi.fn()
    stashBuild(9, {
      label: 'Build with AI',
      plan: () => ({
        ops: [{ op: 'place', field: 'amount', group_key: 'main', index: 1 }],
        steps: ['x'],
        notes: []
      }),
      done: 'done'
    })
    await mount(
      makeClient({}),
      <AiFormsButton
        collection='returns'
        layoutId={9}
        draft={{ bundle, apply }}
        onOpenLayout={() => {}}
      />
    )
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][1]).toEqual({ label: 'Build with AI' })
  })
})

describe('MeaningSuggestions', () => {
  it('suggests a section for each unplaced field and adds them as one batch', async () => {
    const client = makeClient({
      '/ai-design/layouts/9/sections-by-meaning': {
        data: {
          suggestions: [
            { field: 'amount', group_key: 'main', reason: 'Money with the request' },
            { field: 'manager', group_key: 'main', reason: null }
          ],
          dropped: 0
        }
      }
    })
    const apply = vi.fn()
    await mount(client, <MeaningSuggestions bundle={bundle} collection='returns' apply={apply} />)
    await settle(() => !!document.querySelector('[data-ai-meaning-ask]'))
    expect(document.querySelector('[data-ai-meaning]')?.textContent).toContain(
      '2 fields are not on this form'
    )
    await act(async () => {
      ;(document.querySelector('[data-ai-meaning-ask]') as HTMLButtonElement).click()
    })
    await settle(() => !!document.querySelector('[data-ai-meaning-list]'))
    const body = client.request.mock.calls.find(
      (c) => c[0]._path === '/ai-design/layouts/9/sections-by-meaning'
    )?.[0]._body
    expect(body).toEqual({
      groups: [{ key: 'main', label: 'Main', fields: ['reason'] }],
      fields: ['amount', 'manager']
    })
    act(() => (document.querySelector('[data-ai-meaning-all]') as HTMLButtonElement).click())
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply.mock.calls[0][0]).toEqual([
      { op: 'place', field: 'amount', group_key: 'main', index: 1 },
      { op: 'place', field: 'manager', group_key: 'main', index: 2 }
    ])
    expect(apply.mock.calls[0][1]).toEqual({ label: 'Place 2 fields by meaning' })
  })
})
