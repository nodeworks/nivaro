import { beforeEach, describe, expect, it, vi } from 'vitest'

// A knex stand-in that honours where / whereIn / whereNull on the rows of
// tables[<table>] (column aliases like `c.` stripped); everything else chains.
const tables: Record<string, Array<Record<string, unknown>>> = {}

const norm = (v: unknown) => (typeof v === 'string' ? v.toLowerCase() : v)

function builder(table: string): unknown {
  const preds: Array<(r: Record<string, unknown>) => boolean> = []
  const col = (c: unknown) => String(c).replace(/^\w+\./, '')
  const target = {
    // biome-ignore lint/suspicious/noThenProperty: a knex builder is thenable
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      Promise.resolve((tables[table] ?? []).filter((r) => preds.every((p) => p(r)))).then(
        resolve,
        reject
      )
  }
  const proxy: unknown = new Proxy(target, {
    get(t, prop) {
      if (prop === 'then') return t.then
      return (...args: unknown[]) => {
        if (prop === 'where' && args.length === 2) {
          const [c, v] = args
          preds.push((r) => norm(r[col(c)]) === norm(v))
        } else if (prop === 'whereIn') {
          const [c, vs] = args as [string, unknown[]]
          const set = new Set(vs.map(norm))
          preds.push((r) => set.has(norm(r[col(c)])))
        } else if (prop === 'whereNull') {
          const [c] = args
          preds.push((r) => r[col(c)] == null)
        }
        return proxy
      }
    }
  })
  return proxy
}

vi.mock('../../../db/index.js', () => {
  const db = Object.assign(
    vi.fn((t: string) => builder(String(t).split(' ')[0])),
    { schema: { hasColumn: vi.fn(async () => true) }, raw: vi.fn(async () => []) }
  )
  return { db }
})
vi.mock('../../../services/mail-types.js', () => ({
  labelledChanges: vi.fn(async () => [{ field: 'x', label: 'X', old: '1', new: '2' }])
}))

import { resetChainColumnProbe } from '../../../services/chain-columns.js'
import { deliveryChannels, loadChainSteps } from '../../../services/event-path/exact.js'
import { labelledChanges } from '../../../services/mail-types.js'

const T = new Date('2026-09-24T10:00:05.000Z')
const CHAIN = '8b6213be-eae8-4cb2-b027-2f0ab216282b'

beforeEach(() => {
  for (const k of Object.keys(tables)) delete tables[k]
  resetChainColumnProbe()
  vi.mocked(labelledChanges).mockClear()
})

describe('loadChainSteps — who was told (#706)', () => {
  it('turns inbox rows and mail-log rows into notify / mail steps, the email under its notification', async () => {
    tables.nivaro_notifications = [
      {
        id: 5,
        chain_id: CHAIN,
        chain_parent: 'history:9',
        subject: 'Approve CM26-1',
        timestamp: T,
        category: 'workflow',
        lane: 'needs_you',
        delivery: JSON.stringify({
          inapp: { status: 'delivered' },
          push: { status: 'no_subscription' },
          email: { status: 'sent', mail_log_id: 3 },
          sms: { status: 'not_requested' }
        }),
        collection: 'workflows',
        item: '7',
        first_name: 'Beth',
        last_name: 'Owner'
      }
    ]
    tables.nivaro_mail_log = [
      {
        id: 3,
        chain_id: CHAIN,
        chain_parent: 'notification:5',
        to: 'beth@example.com',
        subject: 'Approve CM26-1',
        template: 'notification',
        status: 'sent',
        error: null,
        collection: 'workflows',
        item: '7',
        created_at: T
      },
      {
        id: 4,
        chain_id: CHAIN,
        chain_parent: 'cron:digest',
        to: 'a@example.com, b@example.com',
        subject: 'Digest',
        template: null,
        status: 'failed',
        error: 'SMTP 421',
        collection: null,
        item: null,
        created_at: T
      }
    ]

    const admin = await loadChainSteps(CHAIN, { withBodies: true })
    const notify = admin.steps.find((s) => s.key === 'notification:5')
    expect(notify).toMatchObject({
      kind: 'notify',
      parent: 'history:9',
      summary: 'Told Beth Owner · in-app, email',
      record: { collection: 'workflows', item: '7' }
    })
    expect(notify?.detail).toMatchObject({ type: 'notify', subject: 'Approve CM26-1' })
    const mail = admin.steps.find((s) => s.key === 'mail:3')
    expect(mail).toMatchObject({ kind: 'mail', parent: 'notification:5', failed: false })
    expect(mail?.detail).toMatchObject({ type: 'mail', to: 'beth@example.com', recipients: 1 })
    const digest = admin.steps.find((s) => s.key === 'mail:4')
    expect(digest).toMatchObject({
      summary: 'Email to 2 recipients · failed',
      failed: true,
      reason: 'SMTP 421'
    })

    // A non-admin sees who and how, never addresses or subjects.
    const viewer = await loadChainSteps(CHAIN, { withBodies: false })
    expect(viewer.steps.find((s) => s.key === 'notification:5')?.detail).toMatchObject({
      subject: null
    })
    expect(viewer.steps.find((s) => s.key === 'mail:3')?.detail).toMatchObject({
      to: null,
      subject: null,
      recipients: 1
    })
  })
})

describe('deliveryChannels', () => {
  it('reads reached and failed channels, skipping ones never asked for', () => {
    expect(
      deliveryChannels({
        inapp: { status: 'delivered' },
        push: { status: 'failed' },
        email: { status: 'deferred' },
        sms: { status: 'not_requested' }
      })
    ).toMatchObject({ reached: ['in-app', 'email'], failed: ['push'] })
  })

  it('an unparseable record reads as the inbox row only', () => {
    expect(deliveryChannels('{nope').reached).toEqual(['in-app'])
  })
})
