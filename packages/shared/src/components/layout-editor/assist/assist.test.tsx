// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, useState } from 'react'
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
import { AskPanel, plainText } from './AskPanel'
import type { AskTurn } from './assist-api'
import { jumpToSetting, targetFor } from './jump'
import { ProposalsButton } from './ProposalsButton'
import {
  contentWords,
  isWhereQuestion,
  searchSettings,
  settingEntry,
  settingsIndex
} from './settings-index'
;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown }

const group = (key: string, sort: number) =>
  ({ ...newGroup(key, key[0].toUpperCase() + key.slice(1), 'section', null), sort }) as GroupRow
const place = (field: string, group_key: string | null, sort: number) =>
  ({ ...newPlacement(field, group_key), sort }) as PlacementRow

const bundle: LayoutBundle = {
  layout: { id: 9, collection: 'orders', name: 'Default' },
  rev: 'r1',
  groups: [group('details', 0), group('money', 1)],
  placements: [
    place('zone', 'details', 0),
    place('amount', 'money', 0),
    place('__comments__', null, 2)
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
  for (let i = 0; i < 50 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

const adminHost = {
  isAdmin: true,
  navigate: () => {},
  warning: null,
  recordLink: (c: string, id: string) => `/collections/${c}/${id}`
}

describe('settings index (#2676)', () => {
  it('holds Form settings and inspector controls, never retired or editor-less rows', () => {
    const index = settingsIndex()
    expect(settingEntry('layout.disable_comments')?.home).toBe('form_settings')
    expect(settingEntry('field.required')).toMatchObject({ home: 'inspector', place: 'Rules' })
    expect(index.some((e) => /no editor today/i.test(e.label))).toBe(false)
    expect(new Set(index.map((e) => e.key)).size).toBe(index.length)
  })

  it('places a question by its words', () => {
    expect(contentWords('Where do I turn off comments?')).toEqual(['comment'])
    expect(searchSettings('where do I turn off comments?')[0].entry.key).toBe(
      'layout.disable_comments'
    )
    const mandatory = searchSettings('how do I make a field mandatory', 'grouped').map(
      (h) => h.entry.key
    )
    expect(mandatory).toContain('field.required')
    expect(searchSettings('where is it?')).toEqual([])
  })

  it('tells a where-question from a question about records', () => {
    expect(isWhereQuestion('Where do I turn off comments?')).toBe(true)
    expect(isWhereQuestion('how can I hide the PDF button')).toBe(true)
    expect(isWhereQuestion("Why can't Finance see Zone on record 284212?")).toBe(false)
  })
})

describe('answers as plain text', () => {
  it('drops Markdown emphasis, headings and rules', () => {
    expect(plainText('## Why\n**Zone** is *locked*.\n\n---\n- see Rules')).toBe(
      'Why\nZone is locked.\n\n- see Rules'
    )
    expect(plainText('2 * 3 = 6')).toBe('2 * 3 = 6')
  })
})

describe('jump to a setting (#2676)', () => {
  it('picks what an inspector control applies to, preferring the selection', () => {
    const req = settingEntry('field.required')!
    expect(targetFor(req, bundle, [])).toEqual({
      kind: 'field',
      field: 'zone',
      group_key: 'details'
    })
    expect(
      targetFor(req, bundle, [{ kind: 'field', field: 'amount', group_key: 'money' }])
    ).toEqual({ kind: 'field', field: 'amount', group_key: 'money' })
    expect(targetFor(settingEntry('group.label')!, bundle, [])).toEqual({
      kind: 'group',
      key: 'details'
    })
    expect(targetFor(settingEntry('widget.remove')!, bundle, [])).toEqual({
      none: 'This form has no widgets'
    })
  })

  it('opens Form settings and flashes the control', async () => {
    const editor = document.createElement('div')
    host.appendChild(editor)
    const openSettings = vi.fn(() => {
      editor.innerHTML =
        '<div data-form-settings="grouped"><div data-setting="layout.disable_comments"><button role="switch">x</button></div></div>'
    })
    const res = await jumpToSetting(settingEntry('layout.disable_comments')!, {
      bundle,
      selection: [],
      select: vi.fn(),
      openSettings,
      openAddPanel: vi.fn(),
      root: editor
    })
    expect(res).toEqual({ ok: true })
    expect(openSettings).toHaveBeenCalled()
    const el = editor.querySelector('[data-setting="layout.disable_comments"]') as HTMLElement
    expect(el.hasAttribute('data-setting-found')).toBe(true)
    expect(document.activeElement).toBe(el.querySelector('[role="switch"]'))
  })

  it('selects a field, switches to the tab and flashes the inspector control', async () => {
    const editor = document.createElement('div')
    host.appendChild(editor)
    const select = vi.fn(() => {
      editor.innerHTML =
        '<aside data-editor-inspector><div role="tab" aria-selected="true">Look</div><div role="tab" aria-selected="false">Rules</div><div data-panel-body></div></aside>'
      const rules = editor.querySelectorAll('[role="tab"]')[1] as HTMLElement
      rules.addEventListener('click', () => {
        editor.querySelector('[data-panel-body]')!.innerHTML =
          '<div data-setting="field.required"><button role="switch">r</button></div>'
      })
    })
    const res = await jumpToSetting(settingEntry('field.required')!, {
      bundle,
      selection: [],
      select,
      openSettings: vi.fn(),
      openAddPanel: vi.fn(),
      root: editor
    })
    expect(res).toEqual({ ok: true })
    expect(select).toHaveBeenCalledWith({ kind: 'field', field: 'zone', group_key: 'details' })
    expect(
      editor.querySelector('[data-setting="field.required"]')?.hasAttribute('data-setting-found')
    ).toBe(true)
  })
})

describe('AskPanel (#2695 #2676)', () => {
  function renderPanel(client: { request: (c: Cmd) => Promise<unknown> }, jump = vi.fn()) {
    let thread: AskTurn[] = []
    const onCite = vi.fn()
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const Harness = () => {
      const [t, setT] = useState<AskTurn[]>([])
      thread = t
      return (
        <AskPanel
          layoutId={9}
          layoutName='Default'
          kind='grouped'
          bundle={bundle}
          thread={t}
          setThread={setT}
          jump={jump}
          onCite={onCite}
        />
      )
    }
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client as never}>
            <LayoutEditorHostContext.Provider value={adminHost}>
              <Harness />
            </LayoutEditorHostContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    return { onCite, jump, thread: () => thread }
  }

  const type = async (text: string) => {
    const input = host.querySelector('[data-ask-input]') as HTMLTextAreaElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!
      set.call(input, text)
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => {
      ;(host.querySelector('form') as HTMLFormElement).requestSubmit()
    })
  }

  it('places a where-question by its words without asking the AI, and jumps', async () => {
    const request = vi.fn(async (c: Cmd) => (c._path === '/roles' ? { data: [] } : { data: null }))
    const jump = vi.fn(async () => ({ ok: true as const }))
    renderPanel({ request }, jump)
    await type('Where do I turn off comments?')
    await settle(() => !!host.querySelector('[data-ask-found]'))
    expect(host.querySelector('[data-ask-found]')?.getAttribute('data-ask-found')).toBe('search')
    expect(request.mock.calls.some(([c]) => c._path.includes('find-setting'))).toBe(false)
    await act(async () => {
      ;(host.querySelector('[data-ask-jump="layout.disable_comments"]') as HTMLElement).click()
    })
    expect(jump).toHaveBeenCalledWith(expect.objectContaining({ key: 'layout.disable_comments' }))
  })

  it('asks the AI with the draft, shows the answer and its citations', async () => {
    const request = vi.fn(async (c: Cmd) => {
      if (c._path === '/roles') return { data: [{ id: 'R1', name: 'Finance' }] }
      if (c._path === '/ai-design/layouts/9/ask')
        return {
          data: {
            answer: 'Details is hidden for Finance.',
            cites: [
              { kind: 'field', field: 'zone', label: 'Zone' },
              { kind: 'record', id: '284212' }
            ],
            tools: []
          }
        }
      return { data: null }
    })
    const { onCite } = renderPanel({ request })
    await type("Why can't Finance see Zone on record 284212?")
    await settle(() => !!host.querySelector('[data-ask-answer]'))
    const call = request.mock.calls.find(([c]) => c._path === '/ai-design/layouts/9/ask')![0]
    expect((call._body as { draft: { layout: { id: number } } }).draft.layout.id).toBe(9)
    expect(host.querySelector('[data-ask-answer]')?.textContent).toContain(
      'Details is hidden for Finance.'
    )
    await act(async () => {
      ;(host.querySelector('[data-ask-cite="field"]') as HTMLElement).click()
    })
    expect(onCite).toHaveBeenCalledWith({ kind: 'field', field: 'zone', label: 'Zone' })
  })

  it('says plainly when AI is not set up', async () => {
    const request = vi.fn(async (c: Cmd) => {
      if (c._path === '/roles') return { data: [] }
      throw Object.assign(new Error('AI is not configured'), {
        status: 503,
        response: { error: 'AI is not configured' }
      })
    })
    renderPanel({ request })
    await type('Which roles get this form?')
    await settle(() => !!host.querySelector('[role="alert"]'))
    expect(host.querySelector('[role="alert"]')?.textContent).toMatch(/AI is not set up here/)
  })
})

describe('ProposalsButton (#2694)', () => {
  it('tries a proposal on the canvas as one draft step, then keeps it', async () => {
    const proposal = {
      id: '11111111-1111-1111-1111-111111111111',
      layout_id: 9,
      note: 'Zone belongs with money',
      status: 'proposed',
      created_at: new Date().toISOString(),
      proposer: { name: 'Rob', via: 'Claude (connected app)' },
      ops: [
        {
          op: 'move',
          from: { field: 'zone', group_key: 'details' },
          to_group_key: 'money',
          index: 1
        }
      ],
      sentences: ['Move Zone from Details to Money'],
      dropped: [],
      conflict: null
    }
    const request = vi.fn(async (c: Cmd) => {
      if (c._path === '/ai-design/layouts/9/proposals') return { data: [proposal] }
      return { data: { id: proposal.id, status: 'applied' } }
    })
    const draft = { bundle, apply: vi.fn(), undo: vi.fn(), autosave: false }
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={{ request } as never}>
            <LayoutEditorHostContext.Provider value={adminHost}>
              <ProposalsButton layoutId={9} draft={draft} />
            </LayoutEditorHostContext.Provider>
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await settle(() => !!host.querySelector('[data-layout-proposals]'))
    const button = host.querySelector('[data-layout-proposals]') as HTMLElement
    expect(button.getAttribute('data-layout-proposals')).toBe('1')
    await act(async () => button.click())
    const tryBtn = document.querySelector('[data-proposal-try]') as HTMLElement
    expect(document.querySelector('[data-proposal]')?.textContent).toContain(
      'Move Zone from Details to Money'
    )
    await act(async () => tryBtn.click())
    expect(draft.apply).toHaveBeenCalledWith(proposal.ops, { label: 'Proposal from Rob' })
    await act(async () => (document.querySelector('[data-proposal-keep]') as HTMLElement).click())
    await settle(() =>
      request.mock.calls.some(([c]) => c._path.endsWith(`/proposals/${proposal.id}/resolve`))
    )
    const resolve = request.mock.calls.find(([c]) => c._path.endsWith('/resolve'))![0]
    expect(resolve._body).toEqual({ outcome: 'applied' })
  })

  it('shows nothing to a non-admin', () => {
    const request = vi.fn(async () => ({ data: [] }))
    const qc = new QueryClient()
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={{ request } as never}>
            <ProposalsButton
              layoutId={9}
              draft={{ bundle, apply: vi.fn(), undo: vi.fn(), autosave: false }}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    expect(host.innerHTML).toBe('')
    expect(request).not.toHaveBeenCalled()
  })
})
