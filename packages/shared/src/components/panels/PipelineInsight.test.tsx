// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import {
  durWords,
  type SignOffSummary,
  SignOffSummaryLines,
  signOffLine,
  timingWords,
  type VisitTiming
} from './PipelineInsight'
import { PipelinePanel } from './PipelinePanel'

// Rob 2026-11-13: #15 the sign-off line, #18 waiting vs working per visit.

const H = 3_600_000
const THREE: SignOffSummary = {
  kind: 'branches',
  title: null,
  required: 3,
  signed: 2,
  waiting: [{ label: 'Finance', names: ['Ana Ruiz'], more: 0 }],
  signers: [
    { label: 'Legal', name: 'Ben Ko', at: '2026-11-12T15:00:00.000Z' },
    { label: 'Security', name: 'Former user', at: '2026-11-12T16:00:00.000Z' }
  ]
}

const visit = (v: Partial<VisitTiming>): VisitTiming => ({
  history_id: 1,
  state: 'S',
  entered_at: '2026-11-10T10:00:00.000Z',
  left_at: '2026-11-12T13:00:00.000Z',
  current: false,
  waiting_ms: 0,
  working_ms: 0,
  first_touch_at: null,
  first_touch_kind: null,
  owners_known: true,
  ...v
})

describe('signOffLine', () => {
  it('says how many signed and who it waits on', () => {
    expect(signOffLine(THREE)).toBe('2 of 3 signed — waiting on Ana Ruiz (Finance)')
  })
  it('several open branches, capped names, a branch nobody owns', () => {
    expect(
      signOffLine({
        ...THREE,
        signed: 0,
        waiting: [
          { label: 'Finance', names: ['Ana Ruiz', 'Ben Ko'], more: 2 },
          { label: 'Legal', names: [], more: 0 }
        ]
      })
    ).toBe('0 of 3 signed — waiting on Ana Ruiz, Ben Ko +2 (Finance), Legal')
  })
})

describe('timingWords', () => {
  it('"waited 2 d, worked 3 h"', () => {
    expect(timingWords(visit({ waiting_ms: 48 * H, working_ms: 3 * H }))).toBe(
      'waited 2 d, worked 3 h'
    )
  })
  it('an open visit nobody touched, and a move made at once', () => {
    expect(timingWords(visit({ current: true, waiting_ms: 5 * H }))).toBe(
      'waiting 5 h so far — nobody has touched it'
    )
    expect(timingWords(visit({ waiting_ms: 30 * 60_000 }))).toBe(
      'waited 30 min, then moved on at once'
    )
  })
  it('durWords rounds to the unit people read', () => {
    expect(durWords(20_000)).toBe('under a minute')
    expect(durWords(47 * H)).toBe('47 h')
    expect(durWords(80 * H)).toBe('3 d')
  })
})

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

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 300 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
}

describe('SignOffSummaryLines', () => {
  it('one line with the signers on hover and in the expanded list', () => {
    act(() => root.render(<SignOffSummaryLines summaries={[THREE]} />))
    const line = host.querySelector('[data-sign-off-line]')
    expect(line?.textContent).toBe('2 of 3 signed — waiting on Ana Ruiz (Finance)')
    const btn = host.querySelector('[data-sign-off] button') as HTMLButtonElement
    expect(btn.getAttribute('data-tip')).toContain('Signed: Legal — Ben Ko')
    expect(btn.getAttribute('data-tip')).toContain('Security — Former user')
    act(() => btn.click())
    const detail = host.querySelector('[data-sign-off-detail]')
    expect(detail?.textContent).toContain('Legal')
    expect(detail?.textContent).toContain('waiting on Ana Ruiz')
  })

  it('a step with a single approver shows nothing new', () => {
    act(() =>
      root.render(<SignOffSummaryLines summaries={[{ ...THREE, required: 1, signed: 0 }]} />)
    )
    expect(host.querySelector('[data-sign-offs]')).toBeNull()
    act(() => root.render(<SignOffSummaryLines summaries={[]} />))
    expect(host.querySelector('[data-sign-offs]')).toBeNull()
  })
})

describe('PipelinePanel', () => {
  const STATES = [
    { id: 'S-DRAFT', key: 'draft', label: 'Draft', color: '#64748b', sort: 0, is_initial: true },
    { id: 'S-REV', key: 'review', label: 'Review', color: '#6366f1', sort: 1 },
    { id: 'S-DONE', key: 'done', label: 'Done', color: '#10b981', sort: 2, is_terminal: true }
  ]
  const hist = (id: number, from: string | null, to: string, ts: string) => ({
    id,
    from_state: from,
    to_state: to,
    from_state_label: STATES.find((s) => s.id === from)?.label ?? '',
    to_state_label: STATES.find((s) => s.id === to)?.label ?? '',
    from_state_color: null,
    to_state_color: STATES.find((s) => s.id === to)?.color ?? null,
    user_email: 'kim@x.test',
    first_name: 'Kim',
    last_name: 'Lo',
    comment: null,
    timestamp: ts
  })
  const DATA = {
    instance: {
      id: 'i-1',
      current_state: 'S-REV',
      current_state_obj: STATES[1],
      completed_at: null
    },
    states: STATES,
    available_transitions: [],
    blocked_transitions: [],
    all_transitions: [],
    history: [
      hist(2, 'S-DRAFT', 'S-REV', '2026-11-10T10:00:00.000Z'),
      hist(1, null, 'S-DRAFT', '2026-11-09T10:00:00.000Z')
    ],
    binding: { id: 1, template: 'tpl', collection: 'orders', state_field: null },
    sign_offs: [THREE]
  }
  const TIMING: VisitTiming[] = [
    visit({ history_id: 1, waiting_ms: 20 * H, working_ms: 4 * H }),
    visit({
      history_id: 2,
      current: true,
      left_at: null,
      waiting_ms: 48 * H,
      working_ms: 3 * H,
      first_touch_at: '2026-11-12T10:00:00.000Z',
      first_touch_kind: 'comment'
    })
  ]

  it('shows the sign-off line, splits the bar, and times each visit in the history', async () => {
    const paths: string[] = []
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async (cmd: { _method: string; _path: string }) => {
        paths.push(cmd._path)
        if (cmd._path.endsWith('/step-timing')) return { data: TIMING }
        if (cmd._path.endsWith('/owners')) return { data: [] }
        if (cmd._path.endsWith('/owners/all') || cmd._path.endsWith('/creator'))
          return { data: null }
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
            <PipelinePanel collection='orders' item='42' defaultExpanded />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    await until(() => !!document.querySelector('[data-sign-off-line]'))
    expect(document.querySelector('[data-sign-off-line]')?.textContent).toBe(
      '2 of 3 signed — waiting on Ana Ruiz (Finance)'
    )
    await until(() => !!document.querySelector('[data-step-timing="split"]'))
    expect(paths.filter((p) => p.endsWith('/step-timing'))).toHaveLength(1)
    expect(document.querySelectorAll('[data-step-waiting]').length).toBe(2)
    const current = document.querySelector('[data-step-visit="2"]')
    expect(current?.getAttribute('data-tip')).toContain('waited 2 d, worked 3 h so far')

    const historyBtn = [...document.querySelectorAll('button')].find((b) =>
      b.textContent?.includes('Transition history')
    )
    act(() => historyBtn?.click())
    await until(() => !!document.querySelector('[data-history-timing="1"]'))
    expect(document.querySelector('[data-history-timing="1"]')?.textContent).toBe(
      'In Draft: waited 20 h, worked 4 h'
    )
    // Same read for the bar and the history.
    expect(paths.filter((p) => p.endsWith('/step-timing'))).toHaveLength(1)
  })
})
