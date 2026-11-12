import { beforeEach, describe, expect, it, vi } from 'vitest'

// army4 a14-23: an inventory request auto-starts in Engineering Review (the
// binding's auto_start_state) and its approvers were never told. The start now
// fires the same event a transition does — for a person's own create only.

const state = vi.hoisted(() => ({
  binding: null as Record<string, unknown> | null,
  startState: null as Record<string, unknown> | null,
  inserted: [] as unknown[],
  captured: null as null | ((ctx: unknown) => Promise<void> | void)
}))

vi.mock('../../../hooks/registry.js', () => ({
  hooks: {
    after: (_c: string, _a: string, fn: (ctx: unknown) => Promise<void> | void) => {
      state.captured = fn
    }
  }
}))
// Effects run at once (no unit of work in a test).
vi.mock('../../../services/unit-of-work.js', () => ({
  deferEffect: (_l: string, run: () => Promise<unknown>) => run()
}))
const writeStartHistory = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../services/instance-start.js', () => ({ writeStartHistory }))
const trackError = vi.hoisted(() => vi.fn(async (_issue: Record<string, unknown>) => {}))
vi.mock('../../../services/error-tracking.js', () => ({ trackError }))
const emitWorkflowStartEvent = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  emitWorkflowStartEvent,
  syncStateField: vi.fn(async () => {})
}))
vi.mock('../../../db/index.js', () => ({
  db: (table: string) => {
    const c: Record<string, unknown> = {}
    c.where = () => c
    c.orderBy = () => c
    c.first = async () =>
      table === 'nivaro_workflow_bindings'
        ? state.binding
        : table === 'nivaro_workflow_states'
          ? state.startState
          : undefined
    c.insert = async (row: unknown) => {
      state.inserted.push(row)
    }
    return c
  }
}))

import {
  autostartSilenceReason,
  registerPipelineAutostartHooks
} from '../../../hooks/pipeline-autostart.js'

const PERSON = { id: 'U-MIKE', email: 'mike@x.test', role: 'R' }
const req = (url = '/api/items/inventory_request', authMethod: string | null = 'session') => ({
  url,
  raw: { url },
  authMethod
})

async function create(ctx: Record<string, unknown>) {
  registerPipelineAutostartHooks()
  await state.captured?.({ collection: 'inventory_request', keys: [37653], ...ctx })
}

beforeEach(() => {
  emitWorkflowStartEvent.mockClear()
  writeStartHistory.mockClear()
  trackError.mockClear()
  state.inserted.length = 0
  state.binding = {
    collection: 'inventory_request',
    template: 'T-IR',
    auto_start: true,
    auto_start_state: 'S-ER',
    state_field: null
  }
  state.startState = {
    id: 'S-ER',
    key: 'engineering_review',
    is_initial: false,
    is_terminal: false
  }
})

describe('autostart into a later state', () => {
  it('a person’s create announces the start state once', async () => {
    await create({ user: PERSON, req: req() })
    expect(state.inserted).toHaveLength(1)
    expect(emitWorkflowStartEvent).toHaveBeenCalledTimes(1)
    expect(emitWorkflowStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        collection: 'inventory_request',
        item: '37653',
        stateId: 'S-ER',
        userId: 'U-MIKE',
        label: 'Created',
        source: 'auto'
      })
    )
  })

  it('an import create starts the instance and tells nobody', async () => {
    await create({ user: PERSON, req: req('/api/imports/run') })
    expect(state.inserted).toHaveLength(1)
    expect(emitWorkflowStartEvent).not.toHaveBeenCalled()
  })

  it('a create with no request (a script, an import worker) tells nobody', async () => {
    await create({ user: PERSON })
    expect(emitWorkflowStartEvent).not.toHaveBeenCalled()
  })

  it('a record that starts in the initial state is not announced', async () => {
    state.startState = { id: 'S-START', key: 'started', is_initial: true, is_terminal: false }
    await create({ user: PERSON, req: req() })
    expect(state.inserted).toHaveLength(1)
    expect(emitWorkflowStartEvent).not.toHaveBeenCalled()
  })
})

describe('an auto-start that fails part-way is recorded', () => {
  // Production 2026-11: two of 261 inventory request creates stalled ~15 s in auto-start.
  // The instance row was written, the start history row was not, the state's owners were
  // never told, and the catch dropped the error without a trace.
  it('files an issue naming the record and the step, and still does not fail the create', async () => {
    writeStartHistory.mockRejectedValueOnce(
      new Error('Timeout: Request failed to complete in 15000ms')
    )
    await expect(create({ user: PERSON, req: req() })).resolves.toBeUndefined()
    expect(state.inserted).toHaveLength(1)
    expect(emitWorkflowStartEvent).not.toHaveBeenCalled()
    expect(trackError).toHaveBeenCalledTimes(1)
    const issue = trackError.mock.calls[0][0]
    expect(issue.route).toBe('pipeline/autostart')
    expect(issue.message).toContain('inventory_request 37653')
    expect(issue.message).toContain('start history')
    expect(issue.message).toContain('Request failed to complete in 15000ms')
    // The record sits in its start state with nobody told: someone has to look.
    expect(issue.severity).toBe('high')
    expect(issue.userId).toBe('U-MIKE')
  })

  it('a failure before anything was written is recorded as a lesser issue', async () => {
    // Reading the binding's settings fails: nothing was started, nothing is half-done.
    state.binding = {
      get auto_start(): boolean {
        throw new Error('connection lost')
      }
    }
    await expect(create({ user: PERSON, req: req() })).resolves.toBeUndefined()
    expect(state.inserted).toHaveLength(0)
    expect(trackError).toHaveBeenCalledTimes(1)
    expect(trackError.mock.calls[0][0].severity).toBe('medium')
    expect(String(trackError.mock.calls[0][0].message)).toContain('connection lost')
  })

  it('a start that works files nothing', async () => {
    await create({ user: PERSON, req: req() })
    expect(trackError).not.toHaveBeenCalled()
  })
})

describe('autostartSilenceReason', () => {
  const later = { is_initial: false }
  it('machine creates stay silent', () => {
    expect(
      autostartSilenceReason(
        { user: { ...PERSON, account_kind: 'integration' } as any, req: req() as any },
        later
      )
    ).toBe('machine-account')
    expect(
      autostartSilenceReason(
        { user: { ...PERSON, email: 'feed@nivaro.local' } as any, req: req() as any },
        later
      )
    ).toBe('machine-account')
    expect(
      autostartSilenceReason(
        { user: PERSON as any, req: req('/api/items/x', 'api_key') as any },
        later
      )
    ).toBe('machine-auth')
    expect(
      autostartSilenceReason(
        { user: PERSON as any, req: req('/api/staged-imports/9/run') as any },
        later
      )
    ).toBe('bulk-create')
    expect(
      autostartSilenceReason({ user: PERSON as any, req: req('/api/inbound/mdsi') as any }, later)
    ).toBe('bulk-create')
    expect(autostartSilenceReason({ user: undefined, req: req() as any }, later)).toBe('no-user')
    expect(
      autostartSilenceReason({ user: PERSON as any, req: req() as any, dryRun: true }, later)
    ).toBe('dry-run')
  })
  it('a person in the app is announced', () => {
    expect(autostartSilenceReason({ user: PERSON as any, req: req() as any }, later)).toBeNull()
    expect(
      autostartSilenceReason(
        { user: PERSON as any, req: req('/api/items/inventory_request?x=1', 'masquerade') as any },
        later
      )
    ).toBeNull()
  })
})
