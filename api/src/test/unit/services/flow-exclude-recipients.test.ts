import { afterEach, describe, expect, it, vi } from 'vitest'

// Army 4 (2026-11-05): the notify-owners flows mailed the actor about their own
// Submit / Approve (a14-13/19) and next owners got no in-app ping (a15-3). The
// mail + notification ops take `exclude`; the notification op takes a list.

vi.mock('../../../services/chain-columns.js', () => ({ chainFields: vi.fn(async () => ({})) }))
const sendRawMail = vi.fn(async (_o: Record<string, unknown>) => ({ status: 'sent', log_id: 1 }))
vi.mock('../../../services/mail.js', () => ({
  sendRawMail: (o: Record<string, unknown>) => sendRawMail(o),
  renderMailTemplate: vi.fn(async () => '<p>x</p>'),
  whyContext: vi.fn(async () => ({}))
}))
const notifyUser = vi.fn(async (_app: unknown, _id: string, _o: unknown) => undefined)
vi.mock('../../../services/notification-channels.js', async (orig) => ({
  ...((await orig()) as object),
  notifyUser: (app: unknown, id: string, o: unknown) => notifyUser(app, id, o)
}))
const USERS: Record<string, string> = {
  'owner1@x.com': 'U1',
  'owner2@x.com': 'U2',
  'actor@x.com': 'UA'
}
vi.mock('../../../services/app-links.js', () => ({
  userIdForEmail: vi.fn(async (e: string) => USERS[String(e).toLowerCase()] ?? null),
  recordLink: vi.fn(async () => 'https://portal.test/r')
}))

import { db } from '../../../db/index.js'
import {
  executeFlow,
  resolveExclusions,
  resolveNotificationRecipients
} from '../../../services/flow-executor.js'

function chainFor(table: string, ops: unknown[]) {
  const chain: Record<string, unknown> = {
    select: vi
      .fn()
      .mockResolvedValue(table === 'nivaro_users' ? [{ id: 'UA', email: 'actor@x.com' }] : []),
    insert: vi.fn(() => {
      const r = Promise.resolve([1]) as Promise<unknown> & { returning?: unknown }
      r.returning = vi.fn().mockResolvedValue([{ id: 1 }])
      return r
    }),
    update: vi.fn().mockResolvedValue(1),
    first: vi.fn(async () => null),
    count: vi.fn().mockResolvedValue([{ total: 0 }])
  }
  for (const m of ['where', 'orderBy', 'limit', 'offset', 'whereIn', 'whereNull']) {
    chain[m] = vi.fn(() => chain)
  }
  if (table === 'nivaro_flow_operations') {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is a thenable
    chain.then = (resolve: (v: unknown[]) => void) => resolve(ops)
  }
  return chain
}
const op = (type: string, options: Record<string, unknown>) => ({
  id: 'op-1',
  flow: 'flow-1',
  name: 'Op',
  key: 'op',
  type,
  position_x: 0,
  position_y: 0,
  options: JSON.stringify(options),
  resolve: null,
  reject: null
})
async function run(ops: unknown[], payload: Record<string, unknown>) {
  vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) =>
    chainFor(t, ops)
  )
  return executeFlow({
    flowId: 'flow-1',
    flowName: 'Test',
    trigger: 'test',
    payload,
    log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never
  })
}
const payload = {
  collection: 'workflows',
  item: '1',
  owner_emails: 'owner1@x.com,Actor@x.com,owner2@x.com',
  actor_email: 'actor@x.com',
  friendly_id: 'CR26-1'
}

afterEach(() => {
  sendRawMail.mockClear()
  notifyUser.mockClear()
  vi.mocked(db as unknown as (t: string) => unknown).mockReset()
})

describe('mail op exclude', () => {
  it('leaves the actor out of a split send', async () => {
    await run(
      [
        op('mail', {
          to: '{{owner_emails}}',
          subject: 's',
          body: 'b',
          split: true,
          exclude: '{{actor_email}}'
        })
      ],
      payload
    )
    expect(sendRawMail.mock.calls.map((c) => c[0].to)).toEqual(['owner1@x.com', 'owner2@x.com'])
  })

  it('leaves the actor out of a shared send', async () => {
    await run(
      [op('mail', { to: '{{owner_emails}}', subject: 's', body: 'b', exclude: '{{actor_email}}' })],
      payload
    )
    expect(sendRawMail).toHaveBeenCalledTimes(1)
    expect(sendRawMail.mock.calls[0][0].to).toBe('owner1@x.com, owner2@x.com')
  })

  it('sends nothing (and does not fail) when everyone is excluded', async () => {
    await run(
      [op('mail', { to: '{{actor_email}}', subject: 's', body: 'b', exclude: '{{actor_email}}' })],
      payload
    )
    expect(sendRawMail).not.toHaveBeenCalled()
  })

  it('without exclude, the old behaviour', async () => {
    await run([op('mail', { to: '{{owner_emails}}', subject: 's', body: 'b' })], payload)
    expect(sendRawMail.mock.calls[0][0].to).toBe('owner1@x.com,Actor@x.com,owner2@x.com')
  })
})

describe('notification op recipients', () => {
  it('a single id still works as before', async () => {
    await run([op('notification', { recipient: 'U9', subject: 'Hi' })], payload)
    expect(notifyUser.mock.calls.map((c) => c[1])).toEqual(['U9'])
  })

  it('a list of addresses resolves to users, actor excluded', async () => {
    await run(
      [
        op('notification', {
          recipient: '{{owner_emails}}',
          exclude: '{{actor_email}}',
          subject: 'Waiting on you'
        })
      ],
      payload
    )
    expect(notifyUser.mock.calls.map((c) => c[1])).toEqual(['U1', 'U2'])
  })

  it('an address that is not an active user is dropped, never notified', async () => {
    const ids = await resolveNotificationRecipients('stranger@evil.com, owner1@x.com, U1', {
      emails: new Set(),
      ids: new Set()
    })
    expect(ids).toEqual(['U1'])
  })

  it('an excluded id also excludes that account by address', async () => {
    vi.mocked(db as unknown as (t: string) => unknown).mockImplementation((t: string) =>
      chainFor(t, [])
    )
    const ex = await resolveExclusions('UA', {})
    expect([...ex.ids]).toEqual(['UA'])
    expect([...ex.emails]).toEqual(['actor@x.com'])
  })
})
