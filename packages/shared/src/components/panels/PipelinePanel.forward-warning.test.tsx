// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NivaroProvider } from '../../context'
import { PipelineTransitionButtons } from './PipelinePanel'

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
  instanceAnswer = INSTANCE
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

const STATES = [
  { id: 'S-START', key: 'started', label: 'Started', color: null, sort: 0 },
  { id: 'S-L1', key: 'l1', label: 'L1 Review', color: null, sort: 1 }
]
const INSTANCE = {
  instance: {
    id: 'i-1',
    current_state: 'S-START',
    current_state_obj: STATES[0],
    completed_at: null
  },
  states: STATES,
  available_transitions: [
    {
      id: 't-submit',
      label: 'Submit',
      from_state: 'S-START',
      to_state: 'S-L1',
      comment_mode: 'none'
    }
  ],
  all_transitions: [],
  history: [],
  binding: { id: 1, template: 'tpl', collection: 'workflows', state_field: null }
}

let instanceAnswer: typeof INSTANCE = INSTANCE

function render(lines: Array<{ label: string; text: string; tone: string }>) {
  const calls: Cmd[] = []
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      calls.push(cmd)
      if (cmd._path.endsWith('/approval-brief'))
        return {
          data: {
            entered_at: '2026-11-06T00:00:00Z',
            days_in_state: 0,
            revisions: 0,
            field_changes: [],
            changed_total: 0,
            comments: 0,
            addendums: { count: 0, cost_impact: 0 },
            edited_by: [],
            lines
          }
        }
      if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET')
        return { data: instanceAnswer }
      return { data: { ok: true } }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <PipelineTransitionButtons collection='workflows' item='372967' />
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
  return { calls }
}

const flush = () => act(async () => {})
const until = async (ok: () => boolean) => {
  for (let i = 0; i < 40 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
}
const moves = (calls: Cmd[]) =>
  calls.filter((c) => c._method === 'POST' && c._path.endsWith('/transition'))
const button = (text: string) =>
  [...document.querySelectorAll('button')].find((b) => b.textContent?.trim() === text) as
    | HTMLButtonElement
    | undefined

describe('Submit with a forecast warning (army6 D6)', () => {
  it('a forecast over the requisition opens the confirm with "Submit anyway"; nothing moves until it', async () => {
    const { calls } = render([
      { label: 'Forecast', text: 'Over $55,000 — above the requisition', tone: 'warn' }
    ])
    await until(() => !!button('Submit'))
    await act(async () => button('Submit')?.click())
    await until(() => !!document.querySelector('[data-forward-warning]'))
    expect(moves(calls)).toHaveLength(0)
    expect(document.querySelector('[data-forward-warning]')?.textContent).toContain(
      'Forecast: Over $55,000'
    )
    await act(async () => button('Submit anyway')?.click())
    await flush()
    expect(moves(calls)).toHaveLength(1)
  })

  it('a matching workflow submits on one click', async () => {
    const { calls } = render([
      { label: 'Forecast', text: 'Matches invoiced · fully forecast', tone: 'ok' }
    ])
    await until(() => !!button('Submit'))
    await act(async () => button('Submit')?.click())
    await until(() => moves(calls).length > 0)
    expect(moves(calls)).toHaveLength(1)
    expect(document.querySelector('[data-forward-warning]')).toBeNull()
  })
})

describe('a step that appears where the last one was (army6 M19)', () => {
  it('cannot be pressed by the second click of a double click', async () => {
    const { calls } = render([])
    await until(() => !!button('Submit'))
    // The move lands: the next answer offers the next step in the same slot.
    instanceAnswer = {
      ...INSTANCE,
      instance: { ...INSTANCE.instance, current_state: 'S-L1', current_state_obj: STATES[1] },
      available_transitions: [
        {
          id: 't-wh',
          label: 'Submit to Warehouse',
          from_state: 'S-L1',
          to_state: 'S-START',
          comment_mode: 'none'
        }
      ]
    }
    await act(async () => button('Submit')?.click())
    await until(() => !!button('Submit to Warehouse') && !button('Submit to Warehouse')?.disabled)
    expect(moves(calls)).toHaveLength(1)
    const fresh = button('Submit to Warehouse')
    expect(fresh?.getAttribute('data-fresh')).toBe('true')
    await act(async () => fresh?.click())
    await flush()
    expect(moves(calls)).toHaveLength(1)
  })
})
