import type { FastifyInstance } from 'fastify'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3078 — "Why did I get this": notifyUser stores the deciding path and rules on the row when
// the decision runs; old rows read back as "not recorded".

const state = vi.hoisted(() => ({
  inserted: [] as Array<Record<string, unknown>>,
  prefs: null as unknown,
  role: null as string | null,
  roleRows: [] as Array<{ role_id: string; rules: string }>,
  hasReasonColumn: true
}))

function chain(table: string): unknown {
  const first = () => {
    if (table === 'nivaro_users')
      return {
        status: 'active',
        is_redacted: 0,
        email: 'a@x.test',
        phone: null,
        role: state.role,
        preferences: state.prefs ? JSON.stringify({ notification_prefs: state.prefs }) : null
      }
    if (table === 'nivaro_roles') return { name: 'Engineer' }
    return undefined
  }
  const handler: ProxyHandler<object> = {
    get(_t, prop) {
      if (prop === 'then') return undefined
      if (prop === 'first') return async () => first()
      if (prop === 'select')
        return async () => (table === 'nivaro_role_notification_defaults' ? state.roleRows : [])
      if (prop === 'insert')
        return (row: Record<string, unknown>) => {
          state.inserted.push(row)
          return p
        }
      if (prop === 'returning') return async () => [{ id: 77 }]
      return () => p
    }
  }
  const p: unknown = new Proxy({}, handler)
  return p
}
vi.mock('../../../db/index.js', () => ({
  db: Object.assign(
    vi.fn((t: string) => chain(t)),
    { fn: { now: () => 'now' } }
  )
}))
vi.mock('../../../lib/column-probe.js', () => ({
  hasColumn: async (_t: string, c: string) =>
    c === 'delivery_reason' ? state.hasReasonColumn : false
}))
vi.mock('../../../plugins/socketio.js', () => ({
  emitNotification: vi.fn(),
  isUserViewing: () => false
}))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: false })
}))
vi.mock('../../../services/web-push.js', () => ({ sendWebPush: vi.fn(async () => 0) }))
vi.mock('../../../services/chain.js', () => ({
  withChainStep: async (_n: string, fn: () => unknown) => fn()
}))
vi.mock('../../../services/chain-columns.js', () => ({ chainFields: async () => ({}) }))

import { bustNotifyPrefsCache, notifyUser } from '../../../services/notification-channels.js'
import {
  buildDeliveryReason,
  derivePathKind,
  parseDeliveryReason
} from '../../../services/notification-reason.js'
import { bustRoleDefaultsCache } from '../../../services/notification-role-defaults.js'

const app = {} as FastifyInstance
const U = '11111111-1111-1111-1111-111111111111'

beforeEach(() => {
  state.inserted.length = 0
  state.prefs = null
  state.role = null
  state.roleRows = []
  state.hasReasonColumn = true
  bustNotifyPrefsCache()
  bustRoleDefaultsCache()
})

const stored = () => parseDeliveryReason(state.inserted[0]?.delivery_reason)

describe('derivePathKind', () => {
  it('a named source wins, then mention / message / alert / owner / role default / rules', () => {
    expect(derivePathKind({ sourceKind: 'watch', category: 'mentions' })).toBe('watch')
    expect(derivePathKind({ category: 'mentions', sender: 'x' })).toBe('mention')
    expect(derivePathKind({ category: 'workflow', sender: 'x' })).toBe('message')
    expect(derivePathKind({ category: 'alerts' })).toBe('alert')
    expect(derivePathKind({ category: 'workflow', ownsRecord: true })).toBe('owner')
    expect(derivePathKind({ category: 'workflow', inappLayer: 'role' })).toBe('role_default')
    expect(derivePathKind({ category: 'workflow' })).toBe('rules')
  })
})

describe('notifyUser stores the delivery reason', () => {
  it('stores the path and the rule that held push (quiet hours from the person)', async () => {
    state.prefs = { quiet_start: '00:00', quiet_end: '23:59' }
    await notifyUser(app, U, {
      subject: 'Watching REQ-1: updated',
      message: 'x',
      category: 'watch',
      source: { kind: 'watch', label: 'REQ-1', id: 4 },
      why: 'You watch REQ-1.'
    })
    const r = stored()
    expect(r).not.toBeNull()
    expect(r?.path).toMatchObject({ kind: 'watch', text: 'You watch REQ-1.', id: 4 })
    expect(r?.channels).toMatchObject({ inapp: true, push: false })
    const quiet = r?.rules.find((x) => x.code === 'quiet_hours_push')
    expect(quiet?.layer).toBe('person')
    expect(r?.layers?.push).toBe('person')
  })

  it('a role default that turned the category on is the path, naming the role', async () => {
    state.role = 'R1'
    state.roleRows = [
      { role_id: 'R1', rules: JSON.stringify({ matrix: { workflow: { inapp: true } } }) }
    ]
    await notifyUser(app, U, {
      subject: 'Approval requested: CR1',
      message: 'x',
      category: 'workflow'
    })
    const r = stored()
    expect(r?.path.kind).toBe('role_default')
    expect(r?.path.label).toBe('Engineer')
    expect(r?.role).toEqual({ id: 'R1', name: 'Engineer' })
    // The row's own "why me" agrees with the stored reason.
    const detail = JSON.parse(String(state.inserted[0]?.detail))
    expect(detail.why.kind).toBe('role_default')
  })

  it('a database behind migration 514 writes the row without the column', async () => {
    state.hasReasonColumn = false
    await notifyUser(app, U, { subject: 'Hello', message: 'x' })
    expect(state.inserted).toHaveLength(1)
    expect('delivery_reason' in state.inserted[0]).toBe(false)
  })
})

describe('parseDeliveryReason', () => {
  it('old rows (null, junk, another version) are "not recorded"', () => {
    expect(parseDeliveryReason(null)).toBeNull()
    expect(parseDeliveryReason('{not json')).toBeNull()
    expect(parseDeliveryReason(JSON.stringify({ v: 2, path: { kind: 'x' } }))).toBeNull()
  })
  it('round-trips what buildDeliveryReason wrote', () => {
    const r = buildDeliveryReason(
      {
        category: 'sla',
        critical: true,
        inapp: true,
        push: true,
        teams: false,
        email: 'send',
        sms: false,
        dropped: false,
        reasons: [{ code: 'critical', channel: 'all', text: 'Critical', layer: 'system' }],
        layers: {
          inapp: 'system',
          push: 'system',
          teams: 'system',
          email: 'system',
          quiet: 'system'
        },
        role: null
      },
      { kind: 'sla', text: 'SLA breached' }
    )
    expect(parseDeliveryReason(JSON.stringify(r))).toEqual(r)
  })
})
