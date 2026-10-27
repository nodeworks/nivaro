import { describe, expect, it } from 'vitest'
import {
  CARD_MAX_BYTES,
  type CardAction,
  notificationCard,
  resultCard
} from '../../../services/teams-bot/cards.js'

const base = {
  subject: 'Approval requested: PO 100',
  message: 'Your approval is requested.',
  categoryLabel: 'Workflow',
  openUrl: 'https://nivaro.test/collections/pos/100'
}
const action = (over: Partial<CardAction> = {}): CardAction => ({
  kind: 'approval',
  ref: '12',
  action: 'approved',
  label: 'Approve',
  nonce: 'n-1',
  ...over
})

describe('notificationCard', () => {
  it('card stays under 24 KB with a 60 KB message', () => {
    const card = notificationCard({ ...base, message: 'é'.repeat(60 * 1024), actions: [action()] })
    const bytes = Buffer.byteLength(JSON.stringify(card), 'utf8')
    expect(bytes).toBeLessThanOrEqual(CARD_MAX_BYTES)
    expect(JSON.stringify(card)).toContain('Open in Nivaro')
    expect(card.version).toBe('1.5')
  })

  it('card has no actions when the notification has none', () => {
    const card = notificationCard({ ...base, actions: [] })
    // only the Open link, never an Action.Execute
    expect(card.actions?.map((a) => a.type)).toEqual(['Action.OpenUrl'])
  })

  it('carries verb nivaro and the action data on every button', () => {
    const card = notificationCard({
      ...base,
      actions: [
        action(),
        action({ action: 'rejected', label: 'Reject', needsComment: true, nonce: 'n-2' })
      ]
    })
    const exec = (card.actions ?? []).filter((a) => a.type === 'Action.Execute')
    expect(exec).toHaveLength(2)
    expect(exec[0]).toMatchObject({
      verb: 'nivaro',
      data: { kind: 'approval', ref: '12', action: 'approved', nonce: 'n-1' }
    })
    expect(exec[1]).toMatchObject({ associatedInputs: 'auto', data: { nonce: 'n-2' } })
    // the comment box exists once, and only because a button needs it
    expect(card.body.filter((b) => b.type === 'Input.Text')).toHaveLength(1)
  })

  it('has no comment box when no button needs a comment', () => {
    const card = notificationCard({ ...base, actions: [action()] })
    expect(card.body.some((b) => b.type === 'Input.Text')).toBe(false)
  })

  it('shows the record and its state', () => {
    const card = notificationCard({
      ...base,
      recordLabel: 'PO 100',
      stateLabel: 'In review',
      actions: []
    })
    expect(JSON.stringify(card.body)).toContain('PO 100 · In review')
  })
})

describe('resultCard', () => {
  it('is text with an optional Open link', () => {
    expect(resultCard('Approved by you').actions).toBeUndefined()
    expect(resultCard('Done', 'https://x.test').actions?.[0]).toMatchObject({
      type: 'Action.OpenUrl'
    })
  })
})
