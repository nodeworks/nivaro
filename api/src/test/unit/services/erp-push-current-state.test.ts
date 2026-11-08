import { afterEach, describe, expect, it, vi } from 'vitest'

// "Send current data" for a transition push (army 11 — MWF's state push). Builds only: the
// partner is never called (callExternalApi mocked as a backstop and asserted untouched).

vi.mock('../../../db/index.js', () => ({ db: vi.fn() }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/external-apis.js', () => ({
  callExternalApi: vi.fn(),
  resolveInstanceRow: vi.fn((row: unknown) => row)
}))

import { db } from '../../../db/index.js'
import { callExternalApi } from '../../../services/external-apis.js'
import { buildErpPushForCurrentState } from '../../../services/workflow-actions.js'

const REAL = '⟦nvr-secret:token⟧'
const pushAction = (over: Record<string, unknown> = {}) => ({
  type: 'erp_submit',
  external_api: 'MWF',
  endpoint_path: '/update_workflow.php',
  context: {},
  payload_template: `{"token":"${REAL}","workflow_id":"{{ record.mwf_id }}","efp_state":"{{ state.external_label | default: state.label }}","requisition_id":"{{ record.workflow_id }}"}`,
  ...over
})

function fakeDb(tables: Record<string, Array<Record<string, unknown>>>) {
  const fn = vi.fn((table: string) => {
    const rows = tables[table] ?? []
    const b: Record<string, unknown> = {}
    for (const m of ['where', 'whereIn', 'whereNull', 'orderBy', 'limit']) b[m] = vi.fn(() => b)
    b.select = vi.fn(() => Promise.resolve(rows))
    b.first = vi.fn(() => Promise.resolve(rows[0]))
    return b
  })
  ;(fn as unknown as { schema: unknown }).schema = { hasColumn: vi.fn().mockResolvedValue(false) }
  return fn
}

function wire(opts: {
  state?: Record<string, unknown>
  transitions?: Array<Record<string, unknown>>
  record?: Record<string, unknown>
}) {
  const fake = fakeDb({
    nivaro_workflow_instances: [{ template: 'T1', current_state: 'S3' }],
    nivaro_workflow_states: [
      opts.state ?? {
        id: 'S3',
        key: 'waiting_on_level_3_approval',
        label: 'Waiting on Level 3 Approval',
        external_label: 'Waiting On Level 3 Approval'
      }
    ],
    nivaro_external_apis: [{ id: 1, name: 'MWF' }],
    nivaro_workflow_transitions: opts.transitions ?? [
      { id: 'X1', label: 'Approve', actions: JSON.stringify([pushAction()]) }
    ],
    workflows: [opts.record ?? { id: 372931, workflow_id: 'PW27-81371', mwf_id: 'B1020-6087552' }],
    nivaro_users: []
  })
  vi.mocked(db).mockImplementation(fake as never)
  ;(db as unknown as { schema: unknown }).schema = (fake as unknown as { schema: unknown }).schema
}

const call = (states?: { only?: string[]; except?: string[] }) =>
  buildErpPushForCurrentState({
    collection: 'workflows',
    item: '372931',
    apiName: 'MWF',
    endpointPath: '/update_workflow.php',
    userId: null,
    states
  })

afterEach(() => vi.clearAllMocks())

describe('buildErpPushForCurrentState', () => {
  it('renders the push of the step into the CURRENT state, with that state', async () => {
    wire({})
    const r = await call({ except: ['completed'] })
    expect(r).toEqual({
      api_id: 1,
      endpoint_path: '/update_workflow.php',
      body: {
        token: REAL,
        workflow_id: 'B1020-6087552',
        efp_state: 'Waiting On Level 3 Approval',
        requisition_id: 'PW27-81371'
      },
      state: { key: 'waiting_on_level_3_approval', label: 'Waiting on Level 3 Approval' },
      transition_label: 'Approve'
    })
    expect(callExternalApi).not.toHaveBeenCalled()
  })

  it('honours the action’s own gates (skip_when_empty) and says why', async () => {
    wire({
      transitions: [
        {
          id: 'X1',
          label: 'Approve',
          actions: JSON.stringify([pushAction({ skip_when_empty: 'mwf_id' })])
        }
      ],
      record: { id: 372931, workflow_id: 'PW27-81371', mwf_id: null }
    })
    const r = await call()
    expect(r).toEqual({ refused: expect.stringMatching(/mwf_id/) })
  })

  it('refuses when no step into the current state sends this push', async () => {
    wire({
      transitions: [
        {
          id: 'X1',
          label: 'Approve',
          actions: JSON.stringify([pushAction({ endpoint_path: '/other.php' })])
        }
      ]
    })
    expect(await call()).toEqual({
      refused:
        'no step into “Waiting on Level 3 Approval” sends this to MWF, so there is nothing current to send'
    })
  })

  it('the state kind is never the completion push, and the completion kind only that', async () => {
    wire({ state: { id: 'S3', key: 'completed', label: 'Completed', external_label: null } })
    expect(await call({ except: ['completed'] })).toEqual({
      refused: 'this send is not made in “Completed”'
    })
    wire({})
    expect(await call({ only: ['completed'] })).toEqual({
      refused: 'this send is not made in “Waiting on Level 3 Approval”'
    })
  })
})
