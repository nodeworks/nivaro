// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { AiTextTools } from './AiTextTools'
import type { TextResult } from './types'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: unknown }

const BUNDLE: LayoutBundle = {
  layout: { id: 9, collection: 'orders', name: 'Main', layout_type: 'grouped' },
  groups: [{ ...newGroup('details', 'Details', 'section', null), sort: 0 }],
  placements: [
    { ...newPlacement('po', 'details'), sort: 0 },
    { ...newPlacement('status', 'details'), sort: 1 }
  ],
  rev: 'r1'
}

const CHOICES: TextResult = {
  tool: 'choices',
  dropped: 1,
  ai_used: true,
  proposals: [
    {
      id: 'choices:status',
      tool: 'choices',
      target: { kind: 'placement', field: 'status', group_key: 'details' },
      key: 'choices',
      place: 'Choices of Status',
      before: null,
      after: 'Pending approval',
      base: null,
      sentence: 'Relabel 1 choice of Status: “$t:pending” → “Pending approval”',
      source: 'ai',
      choices: {
        all: [{ text: 'Pending approval', value: 'pending' }],
        changed: [{ value: 'pending', before: '$t:pending', after: 'Pending approval' }],
        from: 'field'
      }
    },
    {
      id: 'placeholders:po',
      tool: 'choices',
      target: { kind: 'placement', field: 'po', group_key: 'details' },
      key: 'placeholder',
      place: 'Placeholder of PO',
      before: null,
      after: 'e.g. PO-471829',
      base: null,
      sentence: 'Show “e.g. PO-471829” in the empty PO input',
      source: 'rules'
    }
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

async function mount(opts: { ai?: boolean; fail503?: boolean } = {}) {
  const calls: Cmd[] = []
  const apply = vi.fn()
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.endsWith('/text/locales'))
        return { data: { locales: ['fr'], default_locale: 'en', ai_configured: opts.ai ?? true } }
      if (opts.fail503) throw { status: 503, response: { error: 'AI is not configured' } }
      if (cmd._path.endsWith('/text/choices')) return { data: CHOICES }
      return { data: { field: 'status', changed: 1 } }
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <AiTextTools layoutId={9} bundle={BUNDLE} collection='orders' apply={apply} />
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  await settle(() => calls.some((c) => c._path.endsWith('/locales')))
  return { calls, apply }
}

const click = async (sel: string) => {
  const el = host.querySelector(sel) as HTMLElement
  await act(async () => el.click())
}

describe('AiTextTools', () => {
  it('lists proposals as sentences and applies them through the draft as one step', async () => {
    const { apply } = await mount()
    await click('[data-ai-text-tool="choices"]')
    await settle(() => !!host.querySelector('[data-ai-text-proposal]'))
    const t = host.textContent ?? ''
    expect(t).toContain('Relabel 1 choice of Status')
    expect(t).toContain('1 AI suggestion left out')
    await click('[data-ai-text-apply]')
    expect(apply).toHaveBeenCalledTimes(1)
    const [ops, { label }] = apply.mock.calls[0]
    expect(ops).toHaveLength(2)
    expect(label).toBe('AI choice labels: 2 changes')
  })

  it('sends field-bound choice labels to the field, not the draft', async () => {
    const { apply, calls } = await mount()
    await click('[data-ai-text-tool="choices"]')
    await settle(() => !!host.querySelector('[data-ai-text-proposal]'))
    const fieldBtn = [...host.querySelectorAll('[aria-pressed]')].find((b) =>
      b.textContent?.includes('The field')
    ) as HTMLElement
    await act(async () => fieldBtn.click())
    await click('[data-ai-text-apply]')
    await settle(() => calls.some((c) => c._path.endsWith('/text/choices/field')))
    const field = calls.find((c) => c._path.endsWith('/text/choices/field'))
    expect(field?._body).toEqual({
      field: 'status',
      choices: [{ value: 'pending', text: 'Pending approval' }]
    })
    expect(apply.mock.calls[0][0]).toHaveLength(1)
  })

  it('turns off AI-only tools when AI is not set up and explains a 503', async () => {
    await mount({ ai: false, fail503: true })
    const intros = host.querySelector('[data-ai-text-tool="intros"]') as HTMLButtonElement
    expect(intros.disabled).toBe(true)
    await click('[data-ai-text-tool="reading"]')
    await settle(() => host.textContent?.includes('AI is not set up here') ?? false)
    expect(host.textContent).toContain('still work from rules')
  })
})
