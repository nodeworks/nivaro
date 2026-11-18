import { describe, expect, it, vi } from 'vitest'

// Review 2026-11-18: the unread-DM email quotes the DM, so it is logged as chat mail
// (collection '__chat__') — the mail log and delivery analytics then withhold its body
// outside the logged compliance view.

const first = new Date(Date.now() - 45 * 60_000)

vi.mock('../../../db/index.js', () => {
  const builder = (table: string): Record<string, unknown> => {
    const q: Record<string, unknown> = new Proxy(
      {},
      {
        get(_t, prop: string) {
          if (prop === 'then') {
            const v =
              table === 'chat_messages'
                ? [{ id: 9, sender_name: 'Pat', message: 'the private text', date_created: first }]
                : []
            return (ok: (r: unknown) => unknown) => Promise.resolve(v).then(ok)
          }
          if (prop === 'first')
            return async () =>
              table === 'nivaro_users'
                ? {
                    id: 'U1',
                    email: 'u1@example.com',
                    first_name: 'U',
                    status: 'active',
                    preferences: JSON.stringify({ chat_email_fallback: true })
                  }
                : { id: 1, user: 'U1', room: 'dm:1', last_read_at: null, dm_emailed_at: null }
          if (prop === 'update') return async () => 1
          if (prop === 'modify')
            return (fn: (qb: unknown) => void) => {
              fn(q)
              return q
            }
          return () => q
        }
      }
    )
    return q
  }
  return { db: Object.assign((t: string) => builder(t), { raw: vi.fn() }) }
})
vi.mock('../../../lib/column-probe.js', () => ({ hasColumn: async () => true }))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => null) }))
vi.mock('../../../services/app-links.js', () => ({ linkTo: vi.fn(async () => null) }))
const sendRawMail = vi.fn(async (..._a: unknown[]) => ({ status: 'sent', log_id: 1 }))
vi.mock('../../../services/mail.js', () => ({
  sendRawMail: (...a: unknown[]) => sendRawMail(...a)
}))

import { emailUnreadDm } from '../../../services/chat-send.js'
import { isPrivateMail } from '../../../services/delivery-analytics/model.js'

describe('the unread-DM email is logged as chat mail', () => {
  it('carries collection __chat__, the room and its own template', async () => {
    const sent = await emailUnreadDm({} as never, 'U1', 'dm:1')
    expect(sent).toBe(true)
    const opts = (sendRawMail.mock.calls[0] as unknown[])[0] as Record<string, unknown>
    expect(opts).toMatchObject({
      collection: '__chat__',
      item: 'dm:1',
      template: 'chat_dm_fallback'
    })
    expect(isPrivateMail(opts)).toBe(true)
  })

  it('old rows count as private by collection or a chat template', () => {
    expect(isPrivateMail({ collection: '__chat__', template: 'notification' })).toBe(true)
    expect(isPrivateMail({ collection: null, template: 'chat_dm_fallback' })).toBe(true)
    expect(isPrivateMail({ collection: 'workflows', template: 'workflow_transition' })).toBe(false)
    // A daily summary can quote chat mentions among its deferred lines (security review 2026-11-18).
    expect(isPrivateMail({ collection: null, template: 'daily_digest' })).toBe(true)
  })
})
