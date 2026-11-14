// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { TipLayer } from '../TipLayer'
import { blockedGroupTip, withBlockedMoves } from './BlockedMove'
import { PipelinePanel, PipelineTransitionButtons } from './PipelinePanel'

// Rob 2026-11-13 (FDX25INV-37713): a move the person cannot make right now is
// drawn disabled in its place, its reason as an instant tip (hover AND focus),
// and a press never reaches the transition route.

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

const OWNER_WHY =
  'Only the owner of Warehouse Submission can make this move. No one owns Warehouse Submission on this record yet — an administrator can make it, or ask to be made the owner.'
const STATES = [
  { id: 'S-DRAFT', key: 'draft', label: 'Draft', color: null, sort: 0 },
  { id: 'S-WH', key: 'warehouse', label: 'Warehouse Submission', color: null, sort: 3 },
  { id: 'S-DONE', key: 'done', label: 'Submitted', color: null, sort: 4 },
  { id: 'S-X', key: 'canceled', label: 'Canceled', color: null, sort: 9 }
]
const move = <T extends { id: string; label: string }>(row: T) => ({
  from_state: 'S-WH',
  comment_mode: 'none',
  color: null,
  group_label: null,
  ...row
})
const DATA = {
  instance: { id: 'i-1', current_state: 'S-WH', current_state_obj: STATES[1], completed_at: null },
  states: STATES,
  available_transitions: [
    move({ id: 't-back', label: 'Send Back', to_state: 'S-DRAFT', sort: 1 }),
    move({ id: 't-cancel', label: 'Cancel Workflow', to_state: 'S-X', sort: 5 })
  ],
  blocked_transitions: [
    move({
      id: 't-submit',
      label: 'Submit to Warehouse',
      to_state: 'S-DONE',
      sort: 2,
      blocked: { code: 'OWNER', reason: OWNER_WHY }
    })
  ],
  all_transitions: [],
  history: [],
  binding: { id: 1, template: 'tpl', collection: 'inventory_request', state_field: null }
}

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
  vi.restoreAllMocks()
})

function render(ui: 'header' | 'panel') {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.endsWith('/owners')) return { data: [] }
      if (cmd._path.endsWith('/owners/all') || cmd._path.endsWith('/creator')) return { data: null }
      if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET')
        return { data: DATA }
      return { data: null }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <TipLayer />
          {ui === 'header' ? (
            <PipelineTransitionButtons collection='inventory_request' item='37713' />
          ) : (
            <PipelinePanel collection='inventory_request' item='37713' defaultExpanded />
          )}
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls }
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
}
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined
const tipShown = (text: string) =>
  [...document.body.querySelectorAll('div')].some((d) => d.textContent === text)

describe('withBlockedMoves', () => {
  it('puts held-back moves in the pipeline’s own order, never twice', () => {
    const out = withBlockedMoves(DATA.available_transitions, [
      ...DATA.blocked_transitions,
      { ...DATA.available_transitions[0], blocked: { code: 'ROLE', reason: 'x' } }
    ])
    expect(out.map((t) => t.id)).toEqual(['t-back', 't-submit', 't-cancel'])
  })

  it('a group with one reason says it once; different reasons name each target', () => {
    const a = { blocked: { code: 'OWNER', reason: 'A' } }
    expect(blockedGroupTip([a, a], () => 'x')).toBe('A')
    expect(
      blockedGroupTip([a, { blocked: { code: 'ROLE', reason: 'B' } }], (i) => ['L1', 'L2'][i])
    ).toBe('L1: A\nL2: B')
  })
})

describe.each(['header', 'panel'] as const)('a held-back move in the %s', (ui) => {
  it('is drawn disabled in its place, says why, and a press calls nothing', async () => {
    const { calls } = render(ui)
    await until(() => !!button('Submit to Warehouse'))
    const submit = button('Submit to Warehouse')
    expect(submit).toBeDefined()
    expect(submit?.getAttribute('aria-disabled')).toBe('true')
    expect(submit?.getAttribute('data-tip')).toBe(OWNER_WHY)
    expect(submit?.getAttribute('data-move-unavailable')).toBe('OWNER')
    // Between the moves on offer, in the pipeline's order.
    const order = [...document.querySelectorAll('button')]
      .map((b) => b.textContent?.trim())
      .filter((t) => ['Send Back', 'Submit to Warehouse', 'Cancel Workflow'].includes(t ?? ''))
    expect(order).toEqual(['Send Back', 'Submit to Warehouse', 'Cancel Workflow'])

    // Hover shows the reason; so does keyboard focus.
    await act(async () => {
      submit?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(tipShown(OWNER_WHY)).toBe(true)
    await act(async () => {
      document.body.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }))
    })
    expect(tipShown(OWNER_WHY)).toBe(false)
    await act(async () => submit?.focus())
    expect(tipShown(OWNER_WHY)).toBe(true)

    await act(async () => submit?.click())
    await act(() => new Promise((r) => setTimeout(r, 30)))
    expect(calls.filter((c) => c._method === 'POST')).toEqual([])
    // No confirm step opened for it either.
    expect(document.body.textContent).not.toContain('Confirming')
  })
})
