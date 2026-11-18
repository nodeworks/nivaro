import { describe, expect, it } from 'vitest'
import type { SendStatusFact } from '../../lib/send-status'
import type { MoveProblem } from './BackgroundMove'
import {
  composePipelineNotices,
  type HeldAutoTransition,
  isPlainProblem,
  pipelineEventWords,
  SAME_EVENT_WINDOW_MS
} from './pipeline-notices'

const T0 = Date.parse('2026-11-18T15:31:00Z')
const iso = (offsetMs = 0) => new Date(T0 + offsetMs).toISOString()
const PARTNER =
  'The projectId:USNED GENESIS CAP LABOR 2022 is not valid the customer:COMC120. Please contact MDSi customer support.'
const STORED = `Auto-submit (MDSi): submission failed — HTTP 400: "${PARTNER}"`

const problem = (over: Partial<MoveProblem> = {}): MoveProblem => ({
  id: 71,
  transition_id: 'T-AUTO',
  transition_label: 'Auto-submit (MDSi)',
  started_at: iso(-2000),
  started_by: null,
  started_by_name: null,
  mode: 'auto',
  result: 'refused',
  reason: STORED,
  finished_at: iso(),
  ...over
})
const held = (over: Partial<HeldAutoTransition> = {}): HeldAutoTransition => ({
  transition_id: 't-auto',
  transition_label: 'Auto-submit (MDSi)',
  error_class: 'validation',
  error: STORED,
  attempts: 1,
  first_failed_at: iso(),
  last_failed_at: iso(1000),
  retry_at: null,
  ...over
})
const send = (over: Partial<SendStatusFact> = {}): SendStatusFact => ({
  id: 900,
  api: 'MDSi',
  status: 'failed',
  started_at: iso(-1500),
  finished_at: iso(-500),
  external_ref: null,
  error_class: 'validation',
  reason: `HTTP 400: "${PARTNER}"`,
  answer_by: null,
  usual_answer_ms: null,
  ...over
})

describe('composePipelineNotices: one event, one notice', () => {
  it('the run, the held auto move and the refused send of the same push merge into one', () => {
    const out = composePipelineNotices({ problem: problem(), held: [held()], sends: [send()] })
    expect(out.events).toHaveLength(1)
    expect(out.events[0].problem?.id).toBe(71)
    expect(out.events[0].held?.transition_id).toBe('t-auto')
    expect(out.events[0].send?.id).toBe(900)
    expect(out.spokenSendIds).toEqual([900])
    expect(isPlainProblem(out.events[0])).toBe(false)
  })

  it('a held auto move alone takes its refused send', () => {
    const out = composePipelineNotices({ problem: null, held: [held()], sends: [send()] })
    expect(out.events).toHaveLength(1)
    expect(out.events[0].send?.id).toBe(900)
  })

  it('a send matches by the partner’s same words even when the label does not name it', () => {
    const out = composePipelineNotices({
      problem: problem({
        transition_label: 'Submit',
        reason: STORED.replace('Auto-submit (MDSi)', 'Submit')
      }),
      held: [],
      sends: [send({ api: 'Ledger' })]
    })
    expect(out.events[0].send?.id).toBe(900)
  })

  it('the closest send in time speaks for the event; the other stays its own line', () => {
    const out = composePipelineNotices({
      problem: problem(),
      held: [],
      sends: [send({ id: 1, finished_at: iso(-10 * 60_000) }), send({ id: 2 })]
    })
    expect(out.events[0].send?.id).toBe(2)
    expect(out.spokenSendIds).toEqual([2])
  })
})

describe('composePipelineNotices: different events stay separate', () => {
  it('a held move of another transition is its own notice', () => {
    const out = composePipelineNotices({
      problem: problem(),
      held: [held({ transition_id: 'T-OTHER', transition_label: 'Sync (Ledger)', error: 'x' })],
      sends: []
    })
    expect(out.events).toHaveLength(2)
    expect(out.events[0].held).toBeNull()
    expect(out.events[1].held?.transition_id).toBe('T-OTHER')
  })

  it('the same transition failing hours apart is not the same event', () => {
    const late = 3 * 60 * 60_000
    const out = composePipelineNotices({
      problem: problem(),
      held: [held({ first_failed_at: iso(late), last_failed_at: iso(late) })],
      sends: []
    })
    expect(out.events).toHaveLength(2)
  })

  it('a send outside the window, to another partner, or that went through is not merged', () => {
    const out = composePipelineNotices({
      problem: problem(),
      held: [],
      sends: [
        send({ id: 1, finished_at: iso(SAME_EVENT_WINDOW_MS + 60_000) }),
        send({ id: 2, api: 'Ledger', reason: 'HTTP 400: "Closed period."' }),
        send({ id: 3, status: 'accepted', error_class: null, reason: null })
      ]
    })
    expect(out.events).toHaveLength(1)
    expect(out.events[0].send).toBeNull()
    expect(isPlainProblem(out.events[0])).toBe(true)
    expect(out.spokenSendIds).toEqual([])
  })

  it('a run whose send got no answer keeps that send to itself and merges nothing', () => {
    const out = composePipelineNotices({
      problem: problem({
        result: 'interrupted',
        unanswered: { submission_id: 900, api_name: 'MDSi', started_at: iso(), stale: true }
      }),
      held: [held()],
      sends: [send({ status: 'sending' })]
    })
    expect(out.events).toHaveLength(2)
    expect(out.events[0].held).toBeNull()
    expect(out.events[0].send).toBeNull()
    expect(out.spokenSendIds).toEqual([900])
  })
})

describe('pipelineEventWords', () => {
  const time = () => '10:31 AM'

  it('says the event once: what failed, the partner’s words quoted once, when, what to do', () => {
    const [ev] = composePipelineNotices({
      problem: problem(),
      held: [held({ attempts: 3 })],
      sends: [send()]
    }).events
    const w = pipelineEventWords(ev, {
      now: T0,
      time,
      startedBy: 'Started automatically',
      canOpenIntegrations: true,
      canMoveByHand: true
    })
    expect(w.label).toBe('Auto-submit (MDSi)')
    expect(w.headline).toBe('did not go through. The record was not moved.')
    expect(w.reason).toMatch(
      /^MDSi refused it at .+: “The projectId:USNED GENESIS CAP LABOR 2022 is not valid the customer:COMC120\.”$/
    )
    // The partner's closing "contact support" footer is not a second instruction.
    expect(w.reason).not.toMatch(/contact/i)
    expect(w.next).toBe(
      'It won’t send the same request again. Change that on the record and it sends again by itself. Or move the record by hand.'
    )
    // The time is in the reason line: the quiet line does not repeat it.
    expect(w.meta).toBe('Started automatically · 3 attempts')
    expect(w.status).toBe(400)
    expect(w.raw).toBe(STORED)
    expect(w.ids.map((r) => r.label)).toEqual(['Run', 'Send', 'Transition'])
    // The partner sentence appears exactly once across everything shown.
    const shown = [w.headline, w.reason, w.next, w.meta].join(' ')
    expect(shown.split('is not valid the customer').length - 1).toBe(1)
  })

  it('a held move with a retry coming says when, and nothing about fixing', () => {
    const w = pipelineEventWords(
      {
        problem: null,
        held: held({ error_class: 'transient', retry_at: iso(25 * 60_000) }),
        send: null
      },
      { now: T0, time }
    )
    expect(w.next).toBe('It tries the same push again in 25 min.')
    expect(w.meta).toBe('Started automatically · 10:31 AM')
  })

  it('without the send the stored reason is read plainly, the time on the quiet line', () => {
    const w = pipelineEventWords(
      { problem: problem(), held: held(), send: null },
      { now: T0, time, startedBy: 'Started automatically', canRetry: true }
    )
    expect(w.reason).toMatch(/^The other system refused what was sent: “The projectId/)
    expect(w.next).toBe(
      'It won’t send the same request again. Change that on the record and it sends again by itself, or try again.'
    )
    expect(w.meta).toBe('Started automatically · 10:31 AM')
  })

  it('a person’s run with a Try again: change it, then try again', () => {
    const w = pipelineEventWords(
      { problem: problem({ mode: 'background' }), held: null, send: send() },
      { now: T0, time, startedBy: 'You started it', canRetry: true }
    )
    expect(w.next).toBe('Change that on the record, then try again.')
  })
})
