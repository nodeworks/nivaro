import { describe, expect, it } from 'vitest'
import {
  describeTrigger,
  type FactUser,
  resolveRequester,
  type SubmissionFacts
} from '../../../services/submission-detail.js'

const PERSON = 'AAAAAAAA-0000-0000-0000-000000000001'
const created = new Date('2026-09-21T18:42:03.000Z')

const USERS: FactUser[] = [
  {
    id: PERSON,
    first_name: 'Dana',
    last_name: 'Reyes',
    email: 'dana@example.com',
    status: 'active',
    is_redacted: false,
    account_kind: null
  }
]

function facts(over: Partial<SubmissionFacts> = {}): SubmissionFacts {
  return {
    raw: {},
    row: {
      id: 1,
      collection: 'orders',
      item: '1',
      external_api: 1,
      status: 'failed',
      attempts: 1,
      payload: null,
      created_at: created,
      updated_at: created,
      error_class: null,
      obligation_id: null,
      requested_by: null,
      requested_via: null
    },
    api: null,
    record_label: null,
    obligation: null,
    obligation_transition: null,
    flow: null,
    attempts: [],
    activity: [],
    call_logs: [],
    history: null,
    record_edit: null,
    newer_landed: null,
    users: USERS,
    ...over
  }
}

const recordEditBy = (user: string) => ({
  action: 'update',
  user,
  comment: null,
  timestamp: created
})

describe('resolveRequester — record-edit inference is scoped and ordered (Task 15d fix round 1)', () => {
  it('a cron trigger wins over a coincidental record edit — cron is checked before the edit', () => {
    const f = facts({
      obligation: {
        id: 1,
        kind: 'x',
        api: 'Partner',
        trigger: 'cron',
        trigger_ref: 'nightly-sync',
        outcome: 'failed',
        reason: null,
        due_at: null,
        resolved_at: null,
        created_at: created
      },
      record_edit: recordEditBy(PERSON)
    })
    const trigger = describeTrigger(f)
    expect(trigger.kind).toBe('cron')
    const r = resolveRequester(f, 1, f.row.created_at, trigger)
    expect(r.kind).not.toBe('person')
    expect(r.basis).toBe('inferred')
    expect(r.label).toMatch(/^Scheduled/)
  })

  it('a flow trigger with no flow user wins over a coincidental record edit', () => {
    const f = facts({
      obligation: {
        id: 1,
        kind: 'x',
        api: 'Partner',
        trigger: 'flow',
        trigger_ref: 'FLOW-1',
        outcome: 'failed',
        reason: null,
        due_at: null,
        resolved_at: null,
        created_at: created
      },
      flow: { id: 'FLOW-1', name: 'Send order', user: null },
      record_edit: recordEditBy(PERSON)
    })
    const trigger = describeTrigger(f)
    expect(trigger.kind).toBe('flow')
    const r = resolveRequester(f, 1, f.row.created_at, trigger)
    expect(r.kind).toBe('flow')
    expect(r.user).toBeNull()
  })

  it('an item-action trigger never borrows a coincidental record edit', () => {
    // No via/obligation naming it — trigger.kind='item-action' comes from
    // the first-send call log alone (no user_id on it, so 2b's own
    // call-log-match step never fires either).
    const f = facts({
      call_logs: [
        {
          id: 1,
          created_at: created,
          method: 'POST',
          url: 'https://partner.example/push',
          response_status: 200,
          duration_ms: 40,
          error: null,
          triggered_by: 'item-action:push-thing',
          user_id: null,
          body_match: true
        }
      ],
      record_edit: recordEditBy(PERSON)
    })
    const trigger = describeTrigger(f)
    expect(trigger.kind).toBe('item-action')
    const r = resolveRequester(f, 1, f.row.created_at, trigger)
    // item-action is not in the {hook, unknown, api} allow-list — it must
    // never borrow an edit that may be unrelated.
    expect(r.basis).toBe('none')
    expect(r.label).toBe('Not recorded')
  })

  it('a hook trigger DOES use the record edit — that is exactly what a hook push means', () => {
    const f = facts({
      obligation: {
        id: 1,
        kind: 'x',
        api: 'Partner',
        trigger: 'hook',
        trigger_ref: 'field:status',
        outcome: 'failed',
        reason: null,
        due_at: null,
        resolved_at: null,
        created_at: created
      },
      record_edit: recordEditBy(PERSON)
    })
    const trigger = describeTrigger(f)
    expect(trigger.kind).toBe('hook')
    const r = resolveRequester(f, 1, f.row.created_at, trigger)
    expect(r.kind).toBe('person')
    expect(r.basis).toBe('inferred')
    expect(r.how).toMatch(/Edited the record/)
  })

  it('an "unknown" trigger (nothing else names it) still uses the record edit', () => {
    const f = facts({ record_edit: recordEditBy(PERSON) })
    const trigger = describeTrigger(f)
    expect(trigger.kind).toBe('unknown')
    const r = resolveRequester(f, 1, f.row.created_at, trigger)
    expect(r.kind).toBe('person')
    expect(r.basis).toBe('inferred')
  })

  it('an "api" trigger (from a call log reading erp-submission) uses the record edit', () => {
    const f = facts({
      call_logs: [
        {
          id: 1,
          created_at: created,
          method: 'POST',
          url: 'https://partner.example/push',
          response_status: 200,
          duration_ms: 40,
          error: null,
          triggered_by: 'erp-submission',
          user_id: null,
          body_match: true
        }
      ],
      record_edit: recordEditBy(PERSON)
    })
    const trigger = describeTrigger(f)
    expect(trigger.kind).toBe('api')
    const r = resolveRequester(f, 1, f.row.created_at, trigger)
    expect(r.kind).toBe('person')
    expect(r.basis).toBe('inferred')
  })

  it('a transition trigger is unaffected by the reorder — unchanged behaviour', () => {
    const f = facts({
      obligation: {
        id: 1,
        kind: 'x',
        api: 'Partner',
        trigger: 'transition',
        trigger_ref: 'T-1',
        outcome: 'failed',
        reason: null,
        due_at: null,
        resolved_at: null,
        created_at: created
      },
      obligation_transition: {
        id: 'T-1',
        label: 'Submit',
        auto_trigger: false,
        template_id: 'TPL-1',
        template_name: 'Orders'
      },
      history: { user: PERSON, origin: 'person', timestamp: created, transition: null },
      record_edit: recordEditBy(PERSON)
    })
    const trigger = describeTrigger(f)
    expect(trigger.kind).toBe('transition')
    const r = resolveRequester(f, 1, f.row.created_at, trigger)
    expect(r.kind).toBe('person')
    expect(r.how).toMatch(/moments before/)
  })
})
