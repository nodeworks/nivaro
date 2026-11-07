// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { peekTransitions, QueueItemSheet, type SheetItem } from './QueueItemSheet'

type Cmd = { _method: string; _path: string; _body?: Record<string, unknown> }

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
})

const ITEM: SheetItem = {
  collection: 'workflows',
  item_id: '372968',
  label: 'PW26-76166',
  state: 'l2',
  state_color: null,
  owners: [],
  sla_status: null,
  at_risk: false,
  aging_hours: 3,
  claimed_by: null,
  url: '/records/workflows/372968'
}

const INSTANCE = {
  instance: { id: 'i-1' },
  states: [
    { id: 's-l3', key: 'l3', label: 'L3 Review', color: null },
    { id: 's-draft', key: 'draft', label: 'Draft', color: null },
    { id: 's-cancel', key: 'canceled', label: 'Canceled', color: null },
    { id: 's-hold', key: 'hold', label: 'On Hold', color: null }
  ],
  available_transitions: [
    { id: 't-approve', label: 'Approve', to_state: 's-l3', in_row_menu: false },
    { id: 't-back', label: 'Send Back', to_state: 's-draft', comment_mode: 'required' },
    { id: 't-cancel', label: 'Cancel Workflow', to_state: 's-cancel', comment_mode: 'required' },
    { id: 't-hold', label: 'Put on hold', to_state: 's-hold', in_row_menu: true }
  ]
}

function render(extra: Partial<Parameters<typeof QueueItemSheet>[0]> = {}) {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET')
        return { data: INSTANCE }
      if (cmd._path === '/comments') return { data: [] }
      return { data: {} }
    })
  } as unknown as NivaroClient
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
            {...extra}
          />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls }
}

const flush = () => act(async () => {})
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 100 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 20)))
}
const moves = (calls: Cmd[]) =>
  calls.filter((c) => c._method === 'POST' && c._path.endsWith('/transition'))
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined

describe('peekTransitions', () => {
  it('drops form-only moves and keeps the ones an older server leaves unflagged', () => {
    expect(
      peekTransitions([
        { id: 'a', in_row_menu: false },
        { id: 'b', in_row_menu: true },
        { id: 'c' }
      ]).map((t) => t.id)
    ).toEqual(['b', 'c'])
  })
})

describe('QueueItemSheet moves (army6 H7)', () => {
  it('offers no form-only Approve', async () => {
    render()
    await until(() => !!button('Send Back'))
    expect(button('Send Back')).toBeTruthy()
    expect(button('Approve')).toBeUndefined()
  })

  it('a plain move asks "Move X to Y?" first and posts only on Confirm', async () => {
    const { calls } = render()
    await until(() => !!button('Send Back'))
    await act(async () => button('Put on hold')?.click())
    expect(moves(calls)).toHaveLength(0)
    expect(document.body.textContent).toContain('Move PW26-76166 to On Hold?')
    await act(async () => button('Keep')?.click())
    expect(moves(calls)).toHaveLength(0)
    expect(document.querySelector('[data-peek-confirm]')).toBeNull()

    await act(async () => button('Put on hold')?.click())
    await act(async () => button('Confirm')?.click())
    await flush()
    expect(moves(calls)).toHaveLength(1)
    expect(moves(calls)[0]._body).toEqual({ transition_id: 't-hold' })
  })

  it('Cancel asks for a reason; closing the ask moves nothing, a reason rides the move', async () => {
    const { calls } = render()
    await until(() => !!button('Send Back'))
    await act(async () => button('Cancel Workflow')?.click())
    await flush()
    expect(document.querySelector('textarea[aria-label="Note"]')).toBeTruthy()
    expect(moves(calls)).toHaveLength(0)
    // Cancel the note → nothing moves.
    await act(async () => button('Cancel')?.click())
    await flush()
    expect(moves(calls)).toHaveLength(0)

    await act(async () => button('Cancel Workflow')?.click())
    await flush()
    const ta = document.querySelector('textarea[aria-label="Note"]') as HTMLTextAreaElement
    await act(async () => {
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set
      set?.call(ta, 'Duplicate request')
      ta.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await act(async () => button('Move')?.click())
    await flush()
    expect(moves(calls)).toHaveLength(1)
    expect(moves(calls)[0]._body).toEqual({
      transition_id: 't-cancel',
      comment: 'Duplicate request'
    })
  })
})

// army 7 N7 — Peek labelled extra fields by their raw paths ("PROJECT TYPE → NAME").
describe('QueueItemSheet field labels', () => {
  it('labels extra fields as the list headers do, path only as the fallback', async () => {
    render({
      item: { ...ITEM, extra: { 'project_type.name': 'Growth', 'divisions.name': 'Z1' } },
      fieldLabel: (f) => (f === 'project_type.name' ? 'Project Type' : '')
    })
    await flush()
    const text = document.body.textContent ?? ''
    expect(text).toContain('Project Type')
    expect(text).not.toContain('→')
    // No alias: plain words, never the raw path.
    expect(text).toContain('Divisions')
  })
})
