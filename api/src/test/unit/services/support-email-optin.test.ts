import { beforeEach, describe, expect, it, vi } from 'vitest'

// The requester's support-email opt-in (preferences.support_email_updates, off by default):
// a notice marked `emailRequester` asks for email on the REQUESTER's copy only when they opted
// in — never on the desk/assignee copies, never for the actor. The pref is read once per notice.

const sent = vi.hoisted(() => [] as Array<{ to: string; channels?: { email?: boolean } }>)
vi.mock('../../../services/notification-channels.js', () => ({
  notifyUser: vi.fn(async (_app: unknown, to: string, o: { channels?: { email?: boolean } }) => {
    sent.push({ to, channels: o.channels })
  })
}))
vi.mock('../../../services/activity.js', () => ({ logActivity: vi.fn(async () => {}) }))

const prefs = vi.hoisted(() => ({ value: null as unknown, reads: 0 }))
vi.mock('../../../db/index.js', async () => {
  const { makeFakeDb } = await import('../../fake-sql.js')
  return {
    db: makeFakeDb(async (q) => {
      if (/from \[nivaro_users\]/.test(q.sql) && q.method === 'first') {
        prefs.reads++
        return prefs.value === undefined ? undefined : { preferences: prefs.value }
      }
      return []
    })
  }
})

import { notifyTicket, supportEmailUpdatesOn } from '../../../services/support-tickets.js'

const t = {
  id: 7,
  kind: 'support',
  collection: null,
  item: null,
  title: 'Need access',
  description: null,
  assignee: 'DESK1',
  status: 'in_progress',
  priority: 'normal',
  created_by: 'REQ',
  category_id: null,
  team_id: null,
  attachments: null,
  legacy_id: null,
  completed_at: null,
  created_at: null,
  updated_at: null
}

const send = (
  recipients: string[],
  actorId: string,
  extra: { email?: boolean; emailRequester?: boolean }
) =>
  notifyTicket({} as never, t, recipients, {
    subject: 'Desk replied: Need access',
    message: 'hello',
    actorId,
    category: 'workflow',
    ...extra
  })

const emailTo = (who: string) => sent.find((s) => s.to === who)?.channels?.email === true

beforeEach(() => {
  sent.length = 0
  prefs.value = null
  prefs.reads = 0
})

describe('support email opt-in', () => {
  it('opted in: only the requester copy asks for email', async () => {
    prefs.value = JSON.stringify({ support_email_updates: true })
    await send(['REQ', 'DESK1', 'DESK2'], 'DESK2', { emailRequester: true })
    expect(sent.map((s) => s.to)).toEqual(['REQ', 'DESK1'])
    expect(emailTo('REQ')).toBe(true)
    expect(emailTo('DESK1')).toBe(false)
    expect(prefs.reads).toBe(1)
  })

  it('not opted in (default): no email for anyone', async () => {
    await send(['REQ', 'DESK1'], 'DESK2', { emailRequester: true })
    expect(sent).toHaveLength(2)
    expect(sent.every((s) => !s.channels?.email)).toBe(true)
    prefs.value = JSON.stringify({ support_email_updates: false })
    sent.length = 0
    await send(['REQ'], 'DESK2', { emailRequester: true })
    expect(emailTo('REQ')).toBe(false)
  })

  it('opted in, but the notice is not news for the requester: no email', async () => {
    prefs.value = { support_email_updates: true }
    await send(['REQ', 'DESK1'], 'DESK2', {})
    expect(sent.every((s) => !s.channels?.email)).toBe(true)
    expect(prefs.reads).toBe(0)
  })

  it('never emails the requester about their own action (and skips the read)', async () => {
    prefs.value = { support_email_updates: true }
    await send(['REQ', 'DESK1'], 'REQ', { emailRequester: true })
    expect(sent.map((s) => s.to)).toEqual(['DESK1'])
    expect(emailTo('DESK1')).toBe(false)
    expect(prefs.reads).toBe(0)
  })

  it('a desk-only notice never reads the pref', async () => {
    prefs.value = { support_email_updates: true }
    await send(['DESK1'], 'DESK2', { emailRequester: true })
    expect(emailTo('DESK1')).toBe(false)
    expect(prefs.reads).toBe(0)
  })

  it('"Assigned to you" (email: true) is unchanged', async () => {
    await send(['DESK1'], 'DESK2', { email: true })
    expect(emailTo('DESK1')).toBe(true)
  })

  it('supportEmailUpdatesOn fails closed', async () => {
    prefs.value = '{not json'
    expect(await supportEmailUpdatesOn('REQ')).toBe(false)
    prefs.value = undefined
    expect(await supportEmailUpdatesOn('REQ')).toBe(false)
    expect(await supportEmailUpdatesOn(null)).toBe(false)
    prefs.value = { support_email_updates: true }
    expect(await supportEmailUpdatesOn('REQ')).toBe(true)
  })
})
