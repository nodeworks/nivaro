// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { QueueItemSheet, type SheetItem, sheetTransitionBody } from './QueueItemSheet'

// P7 (realtime gaps 2026-11-17): a 409 RECORD_LOCKED from the queue sheet was a generic
// "Transition failed" — PipelinePanel names the holder and offers "move anyway".
const toasts = vi.hoisted(() => ({
  warning: [] as Array<{ msg: string; opts: { action?: { label: string; onClick: () => void } } }>
}))
vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn((msg: string, opts: never) => toasts.warning.push({ msg, opts }))
  })
}))

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

const ITEM: SheetItem = {
  collection: 'workflows',
  item_id: '9',
  label: 'PW26-1',
  state: 'l2',
  state_color: null,
  owners: [],
  sla_status: null,
  at_risk: false,
  aging_hours: 1,
  claimed_by: null,
  url: '/records/workflows/9'
}
const INSTANCE = {
  instance: { id: 'i-1' },
  states: [{ id: 's-hold', key: 'hold', label: 'On Hold', color: null }],
  available_transitions: [{ id: 't-hold', label: 'Put on hold', to_state: 's-hold' }]
}
const locked = Object.assign(new Error('409'), {
  response: {
    status: 409,
    data: {
      code: 'RECORD_LOCKED',
      move_anyway: true,
      locked_by_name: 'Beth Ray',
      error: 'Beth Ray is editing this record right now.'
    }
  }
})

describe('sheetTransitionBody', () => {
  it('carries lock_ack only when the person chose to move anyway', () => {
    expect(sheetTransitionBody('t', 'why')).toEqual({ transition_id: 't', comment: 'why' })
    expect(sheetTransitionBody('t', undefined, true)).toEqual({
      transition_id: 't',
      lock_ack: true
    })
  })
})

describe('QueueItemSheet — someone else is editing the record', () => {
  it('names the holder and moves it anyway on request', async () => {
    const calls: Cmd[] = []
    let refuse = true
    const client = {
      url: '',
      getToken: () => null,
      request: vi.fn(async (cmd: Cmd) => {
        calls.push(cmd)
        if (cmd._path.endsWith('/transition')) {
          if (refuse) {
            refuse = false
            throw locked
          }
          return { data: {} }
        }
        if (cmd._path.startsWith('/pipelines/instance/')) return { data: INSTANCE }
        if (cmd._path === '/comments') return { data: [] }
        return { data: {} }
      })
    } as unknown as NivaroClient
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    act(() =>
      root.render(
        <QueryClientProvider client={qc}>
          <NivaroProvider client={client}>
            <QueueItemSheet
              item={ITEM}
              onOpenChange={() => {}}
              onClaim={() => {}}
              onRelease={() => {}}
              refetchItems={() => {}}
            />
          </NivaroProvider>
        </QueryClientProvider>
      )
    )
    const button = (t: string) =>
      [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === t)
    for (let i = 0; i < 100 && !button('Put on hold'); i++)
      await act(() => new Promise((r) => setTimeout(r, 20)))
    await act(async () => button('Put on hold')?.click())
    await act(async () => button('Confirm')?.click())
    for (let i = 0; i < 50 && toasts.warning.length === 0; i++)
      await act(() => new Promise((r) => setTimeout(r, 20)))
    expect(toasts.warning[0]?.msg).toBe('Beth Ray is editing this record right now.')
    expect(toasts.warning[0]?.opts.action?.label).toBe('Put on hold anyway')
    await act(async () => toasts.warning[0]?.opts.action?.onClick())
    await act(() => new Promise((r) => setTimeout(r, 20)))
    const moves = calls.filter((c) => c._method === 'POST' && c._path.endsWith('/transition'))
    expect(moves).toHaveLength(2)
    expect(moves[1]._body).toEqual({ transition_id: 't-hold', lock_ack: true })
    act(() => root.unmount())
    host.remove()
  })
})
