import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { obligationNoteText } from '../../../services/integration-notes.js'
import { plainObligationReason } from '../../../services/obligation-reason-text.js'

describe('obligationNoteText', () => {
  it('says plainly that the partner was told', () => {
    expect(
      obligationNoteText({
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'sent',
        reason: null,
        trigger: 'transition'
      })
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
      obligationNoteText({
        api: 'Partner',
        kind: 'ir.order_submit',
        outcome: 'pending',
        reason: null,
        trigger: 'transition'
      })
    ).toBe('Partner sent (ir.order_submit) — awaiting acknowledgement')
  })

  it('names a failure with its error', () => {
    expect(
      obligationNoteText({
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'failed',
        reason: 'HTTP 500',
        trigger: 'transition'
      })
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
      obligationNoteText({
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'overdue',
        reason: 'no acknowledgement in 60 minutes',
        trigger: 'reconcile'
      })
    ).toBe('Partner still has not got this (wf.state) — no acknowledgement in 60 minutes')
  })

  it('omits a superseded row from the thread entirely', () => {
    expect(
      obligationNoteText({
        api: 'Partner',
        kind: 'wf.state',
        outcome: 'superseded',
        reason: 'x',
        trigger: 'reconcile'
      })
    ).toBe('')
  })
})

describe('plainObligationReason', () => {
  it('words the stored skip vocabulary for people', () => {
    expect(
      obligationNoteText({
        api: 'LinX',
        kind: 'LinX — workflow status write-back',
        outcome: 'skipped',
        reason: 'skip_when_empty: nuvolo_id empty',
        trigger: 'transition'
      })
    ).toBe('LinX not told (LinX — workflow status write-back) — this record has no Nuvolo ID yet')
    expect(plainObligationReason('skip_unless_any: none of po_number, requisition_id is set')).toBe(
      'this record has none of PO number, Requisition ID yet'
    )
    expect(plainObligationReason('not configured: external_api missing on the action')).toBe(
      'the send is not set up yet (external_api is missing)'
    )
    expect(plainObligationReason('HTTP 500')).toBe('HTTP 500')
  })

  it('is byte-identical to the packages/shared twin', () => {
    const api = new URL('../../../services/obligation-reason-text.ts', import.meta.url)
    const shared = new URL(
      '../../../../../packages/shared/src/lib/obligation-reason-text.ts',
      import.meta.url
    )
    expect(readFileSync(api, 'utf8')).toBe(readFileSync(shared, 'utf8'))
  })
})
