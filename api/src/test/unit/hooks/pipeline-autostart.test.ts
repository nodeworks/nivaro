import { beforeEach, describe, expect, it, vi } from 'vitest'

// army4 a14-23: an inventory request auto-starts in Engineering Review (the
// binding's auto_start_state) and its approvers were never told. The start now
// fires the same event a transition does — for a person's own create only.

const state = vi.hoisted(() => ({
  binding: null as Record<string, unknown> | null,
  startState: null as Record<string, unknown> | null,
  inserted: [] as unknown[],
  existing: undefined as Record<string, unknown> | undefined,
  deferred: [] as string[],
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
  deferEffect: (l: string, run: () => Promise<unknown>) => {
    state.deferred.push(l)
    return run()
  }
}))
const writeStartHistory = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../services/instance-start.js', () => ({ writeStartHistory }))
const trackError = vi.hoisted(() => vi.fn(async (_issue: Record<string, unknown>) => {}))
vi.mock('../../../services/error-tracking.js', () => ({ trackError }))
const emitWorkflowStartEvent = vi.hoisted(() => vi.fn(async () => {}))
const syncStateField = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('../../../services/workflow-transitions.js', () => ({
  emitWorkflowStartEvent,
  syncStateField
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
          : table === 'nivaro_workflow_instances'
            ? state.existing
            : undefined
    c.insert = async (row: unknown) => {
      state.inserted.push(row)
    }
    return c
  }
}))

import {
  autostartSilenceReason,
  chosenStartSilenceReason,
  registerPipelineAutostartHooks
} from '../../../hooks/pipeline-autostart.js'
import type { StartStateRun } from '../../../services/start-state.js'

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
  syncStateField.mockClear()
  trackError.mockClear()
  state.inserted.length = 0
  state.deferred.length = 0
  state.existing = undefined
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

// Create in a chosen step (2026-11-16): `$start_state` / GraphQL `start_state`
// passed the gate in createOne, which hands the resolved step to the hook.
describe('a create that names its start step', () => {
  const run = (over: Partial<StartStateRun['state']> = {}, stateField: string | null = null) =>
    ({
      template: 'T-WF',
      stateField,
      state: {
        id: 'S-WOMA',
        key: 'waiting_on_manager_approval',
        label: 'Waiting on Manager Approval',
        external_label: null,
        color: null,
        is_initial: false,
        is_terminal: false,
        ...over
      }
    }) as StartStateRun

  it('starts ONE instance in that step, in the request, whatever auto_start says', async () => {
    state.binding = { collection: 'workflows', template: 'T-WF', auto_start: false }
    const r = run()
    await create({ collection: 'workflows', user: PERSON, req: req(), startState: r })
    expect(state.inserted).toHaveLength(1)
    expect(state.inserted[0]).toMatchObject({
      template: 'T-WF',
      collection: 'workflows',
      item: '37653',
      current_state: 'S-WOMA',
      completed_at: null
    })
    // Not deferred: the instance exists before the create answers.
    expect(state.deferred).not.toContain('pipeline-autostart')
    expect(r.instanceId).toBe((state.inserted[0] as { id: string }).id)
    expect(r.startedAt).toBeInstanceOf(Date)
  })

  it('writes one start history row "Created in <label>" with the caller as actor', async () => {
    await create({ collection: 'workflows', user: PERSON, req: req(), startState: run() })
    expect(writeStartHistory).toHaveBeenCalledTimes(1)
    expect(writeStartHistory).toHaveBeenCalledWith(
      expect.objectContaining({
        stateId: 'S-WOMA',
        userId: 'U-MIKE',
        comment: 'Created in Waiting on Manager Approval',
        origin: 'person'
      })
    )
  })

  it('an integration token is the integration, not a person', async () => {
    await create({
      collection: 'workflows',
      user: PERSON,
      req: req('/api/graphql', 'token'),
      startState: run()
    })
    expect(writeStartHistory).toHaveBeenCalledWith(
      expect.objectContaining({ origin: 'integration' })
    )
  })

  it('sets completed_at when the step is terminal', async () => {
    await create({ user: PERSON, req: req(), startState: run({ is_terminal: true }) })
    expect((state.inserted[0] as { completed_at: unknown }).completed_at).toBeInstanceOf(Date)
  })

  it('never starts a second instance', async () => {
    state.existing = { id: 'I-OLD' }
    const r = run()
    await create({ user: PERSON, req: req(), startState: r })
    expect(state.inserted).toHaveLength(0)
    expect(writeStartHistory).not.toHaveBeenCalled()
    expect(r.instanceId).toBeUndefined()
  })

  it('announces the step to its owners after the unit — integrations included', async () => {
    await create({ user: PERSON, req: req('/api/graphql', 'token'), startState: run() })
    expect(state.deferred).toContain('pipeline-start-state:announce')
    await vi.waitFor(() => expect(emitWorkflowStartEvent).toHaveBeenCalled())
    expect(emitWorkflowStartEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stateId: 'S-WOMA',
        template: 'T-WF',
        label: 'Created in Waiting on Manager Approval'
      })
    )
  })

  it('mirrors the state field the way a move does', async () => {
    await create({ user: PERSON, req: req(), startState: run({}, 'status') })
    expect(syncStateField).toHaveBeenCalledWith(
      'inventory_request',
      '37653',
      expect.objectContaining({ key: 'waiting_on_manager_approval' })
    )
  })

  it('a failed history write is filed, never thrown', async () => {
    writeStartHistory.mockRejectedValueOnce(new Error('boom'))
    await expect(create({ user: PERSON, req: req(), startState: run() })).resolves.toBeUndefined()
    expect(trackError).toHaveBeenCalledTimes(1)
    expect(trackError.mock.calls[0][0].severity).toBe('high')
  })

  it('chosenStartSilenceReason: quiet only for rehearsals, the initial step and bulk loads', () => {
    const later = { is_initial: false }
    expect(chosenStartSilenceReason({ req: req('/api/graphql', 'token') as any }, later)).toBeNull()
    expect(chosenStartSilenceReason({ req: req() as any, dryRun: true }, later)).toBe('dry-run')
    expect(chosenStartSilenceReason({ req: req() as any }, { is_initial: true })).toBe(
      'initial-state'
    )
    expect(chosenStartSilenceReason({ req: req('/api/imports/run') as any }, later)).toBe(
      'bulk-create'
    )
  })
})
