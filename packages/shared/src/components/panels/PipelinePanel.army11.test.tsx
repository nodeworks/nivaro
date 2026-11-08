// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { asksFirst, REFUSAL_FIX_ACTIONS, RecordFlagChips, refusalFixFor } from './PipelinePanel'

const states = [
  { id: 'S0', key: 'started', sort: 0, is_terminal: false },
  { id: 'S1', key: 'waiting_on_po', sort: 9, is_terminal: false },
  { id: 'S2', key: 'completed', sort: 11, is_terminal: true },
  { id: 'S3', key: 'canceled', sort: 12, is_terminal: true }
]

describe('asksFirst (army 11)', () => {
  it('a move into Completed always asks (PO Received)', () => {
    expect(asksFirst({ to_state: 'S2' }, states, 'S1')).toBe(true)
  })
  it('a partner order always asks', () => {
    expect(asksFirst({ to_state: 'S1', order_partners: ['MDSi'] }, states, 'S0')).toBe(true)
  })
  it('a plain forward move, a send back and a cancel keep their own rules', () => {
    expect(asksFirst({ to_state: 'S1' }, states, 'S0')).toBe(false)
    expect(asksFirst({ to_state: 'S0' }, states, 'S1')).toBe(false)
    expect(asksFirst({ to_state: 'S3' }, states, 'S1')).toBe(false)
    expect(asksFirst(undefined, states, 'S1')).toBe(false)
  })
})

describe('ON_HOLD refusal', () => {
  it('offers Remove Hold, then retries the move', () => {
    expect(REFUSAL_FIX_ACTIONS.ON_HOLD).toBe('remove-hold')
    const offer = refusalFixFor(
      { response: { code: 'ON_HOLD', error: 'CR26-81440 is on hold' } },
      { transition_id: 't1' }
    )
    expect(offer).toEqual({
      code: 'ON_HOLD',
      actionKey: 'remove-hold',
      transitionId: 't1',
      comment: undefined
    })
  })
})

describe('RecordFlagChips', () => {
  it('shows each flag the record matches', () => {
    const html = renderToStaticMarkup(
      <RecordFlagChips
        flags={[
          { name: 'On hold', color: 'amber' },
          { name: 'Sent back', color: 'red' }
        ]}
      />
    )
    expect(html).toContain('On hold')
    expect(html).toContain('Sent back')
  })
  it('renders nothing without flags', () => {
    expect(renderToStaticMarkup(<RecordFlagChips flags={[]} />)).toBe('')
  })
})
