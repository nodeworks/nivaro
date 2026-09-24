import { describe, expect, it, vi } from 'vitest'

// No DB: template overrides come back empty, the file template renders.
vi.mock('../../../db/index.js', () => ({
  db: vi.fn(() => ({ select: () => Promise.reject(new Error('no db in test')) }))
}))

import { renderMailTemplate } from '../../../services/mail.js'

const text = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/g, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&mdash;/g, '—')
    .replace(/&middot;/g, '·')
    .replace(/&ldquo;|&rdquo;/g, '"')
    .replace(/\s+/g, ' ')

const base = {
  friendly_id: 'MM26INV-32943',
  transition_label: 'Auto-complete (Fusion accepted)',
  from_state: { key: 'order_submission', label: 'Order Submission' },
  to_state: { key: 'completed', label: 'Completed', is_terminal: true },
  hours_in_previous_state: 0.1,
  transitioned_at: '2026-09-24T18:34:00Z',
  owners: [{ first_name: 'Robert', last_name: 'Lee', email: 'r@example.com' }],
  comment: 'auto: Auto-complete (Fusion accepted)',
  comment_is_human: false,
  record_url: 'https://efp.example/r/1',
  record_card: null,
  approval_chain: [],
  brief: null,
  latest_comment: null
}

describe('workflow_transition mail — how a move is described', () => {
  it('an automatic move reads as a sentence, never the rule name or the auto: comment', async () => {
    const out = text(
      await renderMailTemplate('workflow_transition', {
        ...base,
        actor_name: null,
        source: 'auto',
        transition_text: 'Fusion accepted the transfer order, so the request is complete.'
      })
    )
    expect(out).toContain('Automatic update')
    expect(out).toContain('Fusion accepted the transfer order, so the request is complete.')
    expect(out).toContain('No one had to do anything for this step')
    expect(out).not.toContain('"auto:')
    expect(out).not.toContain('Triggered automatically by the system')
    expect(out).not.toContain('no person made this change')
    // the rule name survives only as a parenthetical, never as the headline
    expect(out).not.toMatch(/AUTO-COMPLETE \(FUSION ACCEPTED\)/)
  })

  it('a finished record waits on nobody', async () => {
    const out = text(
      await renderMailTemplate('workflow_transition', {
        ...base,
        actor_name: null,
        source: 'auto',
        transition_text: null
      })
    )
    expect(out).toContain('Nothing further is needed.')
    expect(out).not.toContain('waiting on')
    // no notify_text → still a sentence, not the label
    expect(out).toContain('This happened automatically')
  })

  it('a person’s move keeps the label, the actor and their comment, and who is next', async () => {
    const out = text(
      await renderMailTemplate('workflow_transition', {
        ...base,
        transition_label: 'Approve',
        actor_name: 'Robert Lee',
        actor_email: 'r@example.com',
        source: 'manual',
        to_state: { key: 'finance_review', label: 'Finance Review', is_terminal: false },
        comment: 'looks good',
        comment_is_human: true,
        transition_text: null
      })
    )
    expect(out).toContain('Approve')
    expect(out).toContain('Triggered by Robert Lee')
    expect(out).toContain('It is now waiting on Robert Lee.')
    expect(out).toContain('"looks good"')
    expect(out).not.toContain('Automatic update')
  })
})
