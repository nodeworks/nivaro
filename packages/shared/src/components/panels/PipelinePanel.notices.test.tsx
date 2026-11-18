// @vitest-environment jsdom
import type { NivaroClient } from '@nivaro/sdk'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ItemEditAuthContext, NivaroProvider } from '../../context'
import type { SendStatusFact } from '../../lib/send-status'
import type { MoveProblem } from './BackgroundMove'
import { ExternalRequestsChip } from './ExternalRequestsChip'
import { PipelinePanel } from './PipelinePanel'
import type { HeldAutoTransition } from './pipeline-notices'

/**
 * One refused automatic push used to read three times on the record's pipeline row (the
 * run's problem, the send-status line and the "Needs a person" strip). It reads once now;
 * events that are not the same stay separate.
 */

type Cmd = { _method: string; _path: string; _params?: Record<string, unknown> }

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

const now = Date.now()
const at = (offset = 0) => new Date(now + offset).toISOString()
const PARTNER = 'The projectId:USNED GENESIS CAP LABOR 2022 is not valid the customer:COMC120.'
const STORED = `Auto-submit (MDSi): submission failed — HTTP 400: "${PARTNER}"`
const STATES = [
  { id: 'S-WH', key: 'warehouse', label: 'Warehouse', color: null, sort: 1 },
  { id: 'S-ORD', key: 'order', label: 'Order sent', color: null, sort: 2 }
]
const PROBLEM: MoveProblem = {
  id: 71,
  transition_id: 't-auto',
  transition_label: 'Auto-submit (MDSi)',
  started_at: at(-3000),
  started_by: null,
  started_by_name: null,
  mode: 'auto',
  result: 'refused',
  reason: STORED,
  finished_at: at(-2000)
}
const HELD: HeldAutoTransition = {
  transition_id: 'T-AUTO',
  transition_label: 'Auto-submit (MDSi)',
  error_class: 'validation',
  error: STORED,
  attempts: 1,
  first_failed_at: at(-2000),
  last_failed_at: at(-2000),
  retry_at: null
}
const SEND: SendStatusFact = {
  id: 900,
  api: 'MDSi',
  status: 'failed',
  started_at: at(-2500),
  finished_at: at(-2100),
  external_ref: null,
  error_class: 'validation',
  reason: `HTTP 400: "${PARTNER}"`,
  answer_by: null,
  usual_answer_ms: null
}

function render(scene: {
  problem?: MoveProblem | null
  held?: HeldAutoTransition[]
  sends?: SendStatusFact[]
  chip?: boolean
}) {
  const client = {
    url: '',
    getToken: () => null,
    request: vi.fn(async (cmd: Cmd) => {
      if (cmd._path === '/erp-submissions/send-status') return { data: { 42: scene.sends ?? [] } }
      if (cmd._path.startsWith('/erp-submissions/orders/')) return { data: [] }
      if (cmd._path.startsWith('/integration-obligations/')) return { data: [] }
      if (cmd._path.endsWith('/owners')) return { data: [] }
      if (cmd._path.endsWith('/owners/all') || cmd._path.endsWith('/creator')) return { data: null }
      if (cmd._path.startsWith('/pipelines/instance/') && cmd._method === 'GET')
        return {
          data: {
            instance: {
              id: 'i-1',
              current_state: 'S-WH',
              current_state_obj: STATES[0],
              completed_at: null
            },
            states: STATES,
            available_transitions: [
              {
                id: 't-hand',
                label: 'Send by hand',
                from_state: 'S-WH',
                to_state: 'S-ORD',
                comment_mode: 'none'
              }
            ],
            all_transitions: [],
            history: [],
            binding: { id: 1, template: 'tpl', collection: 'orders', state_field: null },
            running_move: null,
            last_move_problem: scene.problem ?? null,
            auto_held: scene.held ?? []
          }
        }
      return { data: { ok: true } }
    })
  } as unknown as NivaroClient
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  act(() =>
    root.render(
      <QueryClientProvider client={qc}>
        <NivaroProvider client={client}>
          <ItemEditAuthContext.Provider value={{ isAdmin: true, userId: 'U-1' }}>
            {scene.chip && <ExternalRequestsChip collection='orders' itemId='42' />}
            <PipelinePanel collection='orders' item='42' defaultExpanded />
          </ItemEditAuthContext.Provider>
        </NivaroProvider>
      </QueryClientProvider>
    )
  )
}

const until = async (ok: () => boolean) => {
  for (let i = 0; i < 80 && !ok(); i++) await act(() => new Promise((r) => setTimeout(r, 10)))
}
const notices = () => [...document.querySelectorAll('[data-pipeline-event]')] as HTMLElement[]
/** How often the partner's sentence shows, outside the folded "Details for support". */
const shownTimes = (phrase: string) => {
  const clone = document.body.cloneNode(true) as HTMLElement
  for (const d of clone.querySelectorAll('details')) d.remove()
  return (clone.textContent ?? '').split(phrase).length - 1
}

describe('the pipeline row says one refused automatic push once', () => {
  it('the run, the held move and the refused send merge into one amber notice', async () => {
    render({ problem: PROBLEM, held: [HELD], sends: [SEND] })
    await until(() => notices().length > 0 && !!notices()[0].textContent?.includes('MDSi refused'))
    expect(notices()).toHaveLength(1)
    const n = notices()[0]
    expect(n.textContent).toContain(
      'Auto-submit (MDSi) did not go through. The record was not moved.'
    )
    expect(n.textContent).toContain('MDSi refused it at')
    expect(n.textContent).toContain('Or move the record by hand.')
    // No second strip for the hold, no separate line for the send, no old problem row.
    expect(document.querySelector('[data-send-state]')).toBeNull()
    expect(document.querySelectorAll('[data-move-problem]')).toHaveLength(1)
    expect(document.querySelectorAll('[data-pipeline-auto-held]')).toHaveLength(1)
    // The partner's sentence is on screen once (the stored answer stays folded for support).
    expect(shownTimes('is not valid the customer')).toBe(1)
    // The header chip stays.
    expect(document.querySelector('[data-pipeline-auto-held-pill]')).not.toBeNull()
  })

  it('offers Open Integrations when the record has an Integrations chip, and it opens it', async () => {
    render({ problem: PROBLEM, held: [HELD], sends: [SEND], chip: true })
    await until(() => !!document.querySelector('[data-pipeline-event-integrations]'))
    const open = document.querySelector('[data-pipeline-event-integrations]') as HTMLButtonElement
    await act(async () => open.click())
    await until(() => !!document.querySelector('[role="dialog"]'))
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain('Integrations')
  })

  it('no chip on the page: no Open Integrations button', async () => {
    render({ problem: PROBLEM, held: [HELD], sends: [SEND] })
    await until(() => notices().length > 0)
    expect(document.querySelector('[data-pipeline-event-integrations]')).toBeNull()
  })

  it('a hold of another transition and an unrelated send stay separate', async () => {
    render({
      problem: PROBLEM,
      held: [
        {
          ...HELD,
          transition_id: 'T-SYNC',
          transition_label: 'Sync (Ledger)',
          error: 'Sync (Ledger): submission failed — HTTP 400: "Closed period."'
        }
      ],
      sends: [
        {
          ...SEND,
          id: 901,
          api: 'Ledger',
          reason: 'HTTP 400: "Other words."',
          finished_at: at(-60 * 60_000)
        }
      ]
    })
    await until(() => notices().length > 0 && !!document.querySelector('[data-send-state]'))
    // The run alone keeps its own row; the Ledger hold is its own notice; the send its own line.
    expect(document.querySelectorAll('[data-move-problem]')).toHaveLength(1)
    expect(notices()).toHaveLength(1)
    expect(notices()[0].textContent).toContain('Sync (Ledger) did not go through')
    expect(document.querySelectorAll('[data-send-state]')).toHaveLength(1)
  })
})
