import { describe, expect, it } from 'vitest'
import { obligationNoteText } from '../../../services/integration-notes.js'

describe('obligationNoteText', () => {
  it('says plainly that the partner was told', () => {
    expect(
      obligationNoteText({ api: 'Partner', kind: 'wf.state', outcome: 'sent', reason: null, trigger: 'transition' })
    ).toBe('Partner told (wf.state)')
  })

  it('carries the reason for a skip, because that is the whole point', () => {
    expect(
      obligationNoteText({
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'skipped',
        reason: 'push_when: payload unchanged since the last landed push',
        trigger: 'transition'
      })
    ).toBe('Partner not told (wf.state) — push_when: payload unchanged since the last landed push')
  })

  it('says a send is awaiting acknowledgement rather than claiming it landed', () => {
    expect(
      obligationNoteText({ api: 'Partner', kind: 'ir.order_submit', outcome: 'pending', reason: null, trigger: 'transition' })
    ).toBe('Partner sent (ir.order_submit) — awaiting acknowledgement')
  })

  it('names a failure with its error', () => {
    expect(
      obligationNoteText({ api: 'Partner', kind: 'wf.state', outcome: 'failed', reason: 'HTTP 500', trigger: 'transition' })
    ).toBe('Partner send failed (wf.state) — HTTP 500')
  })

  it('distinguishes a send that never fired from one that was declined', () => {
    expect(
      obligationNoteText({
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'missing',
        reason: 'no send was ever attempted — the trigger did not fire',
        trigger: 'reconcile'
      })
    ).toBe(
      'Partner was never told (wf.state) — no send was ever attempted — the trigger did not fire'
    )
  })

  it('says an overdue obligation is still unmet', () => {
    expect(
      obligationNoteText({ api: 'Partner', kind: 'wf.state', outcome: 'overdue', reason: 'no acknowledgement in 60 minutes', trigger: 'reconcile' })
    ).toBe('Partner still has not got this (wf.state) — no acknowledgement in 60 minutes')
  })

  it('omits a superseded row from the thread entirely', () => {
    expect(
      obligationNoteText({ api: 'Partner', kind: 'wf.state', outcome: 'superseded', reason: 'x', trigger: 'reconcile' })
    ).toBe('')
  })
})
