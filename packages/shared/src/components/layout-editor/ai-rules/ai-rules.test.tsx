// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../../context'
import { type LayoutBundle, newGroup, newPlacement } from '../../../lib/layout-ops'
import { LayoutEditorHostContext } from '../host'
import type { RuleAnswer, ValidationAnswer } from './api'
import { mergeCascadeRules, previewFilter } from './CascadeWriter'
import { RuleWriter } from './RuleWriter'
import { failWords, ValidationSuggest } from './ValidationSuggest'

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
  document.body.innerHTML = ''
})

async function settle(until: () => boolean) {
  for (let i = 0; i < 60 && !until(); i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 10))
    })
  }
}

async function click(el: Element | null | undefined) {
  expect(el, 'element to click').toBeTruthy()
  await act(async () => {
    ;(el as HTMLElement).click()
  })
}

function typeInto(el: HTMLTextAreaElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
  act(() => {
    setter?.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

async function render(node: ReactNode, respond: (cmd: Cmd) => unknown) {
  const calls: Cmd[] = []
  const client = {
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      return respond(cmd)
    })
  }
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  await act(async () => {
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client as never}>
          <LayoutEditorHostContext.Provider
            value={{
              isAdmin: true,
              navigate: () => {},
              warning: null,
              recordLink: (c, id) => `/r/${c}/${id}`
            }}
          >
            {node}
          </LayoutEditorHostContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  })
  return { calls }
}

const bundle = (): LayoutBundle => ({
  layout: { id: 4, collection: 'orders', name: 'Default', layout_type: 'grouped' },
  groups: [
    { ...newGroup('steps', 'Steps', 'container', null), sort: 0 },
    { ...newGroup('shipping', 'Shipping', 'tab', 'steps'), sort: 0 }
  ],
  placements: [{ ...newPlacement('ship_to', 'shipping'), sort: 0 }],
  rev: 'r'
})

describe('cascade preview helpers (#2674)', () => {
  it('merges one rule per parent, the new one winning', () => {
    const a = {
      parent_field: 'zone',
      filter_column: 'zone',
      clear_on_parent_change: true,
      clear_on_unavailable: false
    }
    const b = {
      parent_field: 'year',
      filter_column: 'year',
      clear_on_parent_change: true,
      clear_on_unavailable: false
    }
    const a2 = { ...a, filter_column: 'zone_id' }
    expect(mergeCascadeRules([a, b], [a2])).toEqual([b, a2])
  })

  it('compiles the picker filter as the form does: option filter ∧ cascade, tokens resolved', () => {
    const rules = [
      {
        parent_field: 'zone',
        filter_column: 'zone',
        clear_on_parent_change: true,
        clear_on_unavailable: false
      }
    ]
    const record = { id: 9, zone: { id: 3 }, year: 2026 }
    expect(previewFilter(rules, { year: { _eq: '$parent.year' } }, record, '9')).toEqual({
      _and: [{ year: { _eq: 2026 } }, { zone: { _eq: 3 } }]
    })
    expect(previewFilter(rules, null, { id: 9, zone: null }, '9')).toBeUndefined()
  })
})

describe('validation suggestion words (#2680)', () => {
  it('says how many values would fail', () => {
    expect(failWords(0, 1200, false)).toBe('Every one of 1,200 values passes')
    expect(failWords(3, 5000, true)).toBe('3 of the newest 5,000 values would fail')
  })
})

describe('RuleWriter (#2673)', () => {
  it('asks, shows the tested sentence, and applies ONE draft batch', async () => {
    const answer: RuleAnswer = {
      proposal: {
        kind: 'step',
        group: 'shipping',
        conditions: [{ field: 'is_sparing', op: 'neq', value: 'true' }]
      },
      ops: [
        {
          op: 'group_update',
          key: 'shipping',
          patch: { visible_when: '[{"field":"is_sparing","op":"neq","value":"true"}]' }
        }
      ],
      sentence: 'Show the step Shipping only when Is Sparing is not yes',
      replaces: null,
      explanation: null,
      dropped: ['a condition on "nope", which is not a field here'],
      notes: [],
      test: { checked: 500, matched: 320, current: null, roles: [] }
    }
    const apply = vi.fn()
    const { calls } = await render(
      <RuleWriter
        layoutId={4}
        target={{ kind: 'step', group: 'shipping' }}
        bundle={bundle()}
        apply={apply}
      />,
      () => ({ data: answer })
    )
    await click(document.querySelector('[data-ai-rule-trigger="step"]'))
    await settle(() => !!document.querySelector('[data-ai-rule-input]'))
    typeInto(
      document.querySelector('[data-ai-rule-input]') as HTMLTextAreaElement,
      'hide shipping when sparing'
    )
    await click(document.querySelector('[data-ai-rule-ask]'))
    await settle(() => !!document.querySelector('[data-ai-rule-result]'))
    expect(calls[0]._path).toBe('/ai-design/layouts/4/rule')
    expect(calls[0]._body).toEqual({
      text: 'hide shipping when sparing',
      target: { kind: 'step', group: 'shipping' }
    })
    const text = document.querySelector('[data-ai-rule-result]')?.textContent ?? ''
    expect(text).toContain('Show the step Shipping only when Is Sparing is not yes')
    expect(text).toContain('Shows on 320 of the newest 500 records; hidden on 180.')
    expect(text).toContain('Left out (1)')
    await click(document.querySelector('[data-ai-rule-apply]'))
    expect(apply).toHaveBeenCalledTimes(1)
    expect(apply).toHaveBeenCalledWith(answer.ops, { label: answer.sentence })
  })

  it('a refused answer shows the error and offers no Apply', async () => {
    await render(
      <RuleWriter
        layoutId={4}
        target={{ kind: 'lock', field: 'ship_to' }}
        bundle={bundle()}
        apply={vi.fn()}
      />,
      () => {
        throw Object.assign(new Error('Only steps can show and hide'), { status: 422 })
      }
    )
    await click(document.querySelector('[data-ai-rule-trigger="lock"]'))
    await settle(() => !!document.querySelector('[data-ai-rule-input]'))
    typeInto(document.querySelector('[data-ai-rule-input]') as HTMLTextAreaElement, 'hide it')
    await click(document.querySelector('[data-ai-rule-ask]'))
    await settle(() => !!document.querySelector('[data-ai-rule-error]'))
    expect(document.querySelector('[data-ai-rule-error]')?.textContent).toContain(
      'Only steps can show and hide'
    )
    expect(document.querySelector('[data-ai-rule-apply]')).toBeNull()
  })
})

describe('ValidationSuggest (#2680)', () => {
  it('lists checks with fail counts and hands applied ones to the global writer', async () => {
    const data: ValidationAnswer = {
      field: 'po_number',
      label: 'PO Number',
      kind: 'text',
      checked: 5000,
      empty: 40,
      capped: true,
      current: [{ type: 'max', value: 20 }],
      suggestions: [
        {
          rule: { type: 'regex', value: '^PO\\-\\d{6}$' },
          sentence: 'Values must match the pattern ^PO\\-\\d{6}$',
          source: 'pattern',
          fails: 12
        },
        {
          rule: { type: 'min', value: 9, message: 'Too short' },
          sentence: 'At least 9 characters',
          source: 'ai',
          fails: 0
        }
      ],
      ai_configured: true,
      ai_error: null
    }
    const onApply = vi.fn()
    const { calls } = await render(
      <ValidationSuggest layoutId={4} field='po_number' onApply={onApply} />,
      () => ({ data })
    )
    await click(document.querySelector('[data-ai-validation-trigger]'))
    await settle(() => !!document.querySelector('[data-ai-validation-list]'))
    expect(calls[0]).toMatchObject({
      _path: '/ai-design/layouts/4/validation',
      _body: { field: 'po_number' }
    })
    const fails = [...document.querySelectorAll('[data-ai-validation-fails]')].map(
      (e) => e.textContent
    )
    expect(fails).toEqual([
      '12 of the newest 4,960 values would fail',
      'Every one of the newest 4,960 values passes'
    ])
    await click(document.querySelector('[data-ai-validation-apply="1"]'))
    expect(onApply).toHaveBeenCalledWith(
      [{ type: 'min', value: 9, message: 'Too short' }],
      [{ type: 'max', value: 20 }],
      'Check PO Number: At least 9 characters'
    )
    // One left: no "Apply all" for a single pending suggestion.
    expect(document.querySelector('[data-ai-validation-apply-all]')).toBeNull()
  })
})
