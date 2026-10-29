import { beforeEach, describe, expect, it, vi } from 'vitest'

// #3077 — default notification rules by role. A person's own rules win value by value; anything
// they never set follows their CURRENT role's defaults, resolved at decide time (so a role
// change brings the new role's defaults without copying a row), and the decision says which
// layer decided each channel.

const state = vi.hoisted(() => ({
  user: {
    preferences: null as string | null,
    role: 'R-ENG' as string | null,
    role_name: 'Engineer' as string | null
  },
  roleRows: [] as Array<{ role_id: string; rules: string }>
}))

vi.mock('../../../db/index.js', () => {
  const builder = (table: string) => {
    const b: Record<string, unknown> = {}
    const self = () => b
    b.leftJoin = self
    b.where = self
    b.whereNull = self
    b.first = async () => {
      if (table === 'nivaro_users')
        return {
          status: 'active',
          is_redacted: 0,
          email: 'a@b.c',
          preferences: state.user.preferences,
          role: state.user.role
        }
      if (table === 'nivaro_roles') return { name: state.user.role_name }
      return undefined
    }
    b.select = async () => (table === 'nivaro_role_notification_defaults' ? state.roleRows : [])
    return b
  }
  return { db: builder }
})
vi.mock('../../../plugins/socketio.js', () => ({
  emitNotification: vi.fn(),
  isUserViewing: () => false
}))
vi.mock('../../../services/teams-bot/config.js', () => ({
  getTeamsBotConfig: async () => ({ enabled: false })
}))

import {
  bustNotifyPrefsCache,
  decideDelivery,
  getNotifyPrefsLayered
} from '../../../services/notification-channels.js'
import {
  effectiveRules,
  layerOf,
  mergeNotifyRules,
  sanitizeNotifyRules
} from '../../../services/notification-layers.js'
import { bustRoleDefaultsCache } from '../../../services/notification-role-defaults.js'

const prefs = (np: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ notification_prefs: np, ...extra })

beforeEach(() => {
  state.user = { preferences: null, role: 'R-ENG', role_name: 'Engineer' }
  state.roleRows = [
    {
      role_id: 'R-ENG',
      rules: JSON.stringify({
        quiet_start: '22:00',
        quiet_end: '07:00',
        matrix: { workflow: { push: false, email: 'daily' } }
      })
    },
    {
      role_id: 'R-OPS',
      rules: JSON.stringify({ matrix: { workflow: { inapp: false } } })
    }
  ]
  bustNotifyPrefsCache()
  bustRoleDefaultsCache()
})

const NOON = new Date('2026-10-29T16:00:00Z') // 12:00 ET — outside quiet hours

describe('sanitizeNotifyRules keeps absence', () => {
  it('writes only the values given; explicit none values survive', () => {
    const r = sanitizeNotifyRules({
      quiet_start: '',
      quiet_end: '',
      matrix: { workflow: { push: false }, nope: { inapp: false } },
      escalation: { sla: { push_after_min: 0, email_after_min: 3 } }
    })
    expect(r.matrix).toEqual({ workflow: { push: false } })
    expect(r.quiet_start).toBe('')
    expect(r.escalation).toEqual({ sla: { push_after_min: 0 } })
  })
})

describe('mergeNotifyRules / layerOf', () => {
  const role = { quiet_start: '22:00', quiet_end: '07:00', matrix: { workflow: { push: false } } }
  it('person beats role value by value; the rest follows the role', () => {
    const own = { matrix: { workflow: { inapp: false } } }
    const m = mergeNotifyRules(own, role)
    expect(m.matrix?.workflow).toEqual({ inapp: false, push: false })
    expect(m.quiet_start).toBe('22:00')
    expect(layerOf(own, role, 'matrix.workflow.inapp')).toBe('person')
    expect(layerOf(own, role, 'matrix.workflow.push')).toBe('role')
    expect(layerOf(own, role, 'matrix.workflow.email')).toBe('system')
    expect(layerOf(own, role, 'quiet')).toBe('role')
  })
  it("'' quiet hours over a role window = no quiet hours, owned by the person", () => {
    const own = { quiet_start: '', quiet_end: '' }
    expect(mergeNotifyRules(own, role).quiet_start).toBe('')
    expect(layerOf(own, role, 'quiet')).toBe('person')
  })
  it("a person's legacy daily email beats a role's email mode", () => {
    const r = effectiveRules({}, { matrix: { workflow: { email: 'instant' } } }, 'daily')
    expect(r.matrix?.workflow?.email).toBe('daily')
  })
})

describe('decideDelivery layers', () => {
  const opts = {
    subject: 'Workflow moved to Review',
    category: 'workflow' as const,
    channels: { inapp: true, email: true }
  }

  it('a person with no rules follows their role defaults, and the decision says so', async () => {
    const d = await decideDelivery('u1', opts, NOON)
    expect(d.inapp).toBe(true)
    expect(d.push).toBe(false)
    expect(d.email).toBe('deferred')
    expect(d.layers).toMatchObject({ inapp: 'system', push: 'role', email: 'role', quiet: 'role' })
    expect(d.role).toEqual({ id: 'R-ENG', name: 'Engineer' })
    expect(d.reasons.find((r) => r.code === 'matrix_push_off')?.layer).toBe('role')
  })

  it("the person's own value wins over the role's", async () => {
    state.user.preferences = prefs({ matrix: { workflow: { push: true, email: 'instant' } } })
    const d = await decideDelivery('u1', opts, NOON)
    expect(d.push).toBe(true)
    expect(d.email).toBe('send')
    expect(d.layers).toMatchObject({ push: 'person', email: 'person' })
  })

  it('a role change brings the new role defaults at the next decision (nothing copied)', async () => {
    state.user.preferences = prefs({ matrix: { mentions: { push: false } } })
    const before = await decideDelivery('u1', opts, NOON)
    expect(before.inapp).toBe(true)
    state.user = { ...state.user, role: 'R-OPS', role_name: 'Operations' }
    bustNotifyPrefsCache('u1')
    const after = await decideDelivery('u1', opts, NOON)
    expect(after.inapp).toBe(false)
    expect(after.layers?.inapp).toBe('role')
    expect(after.role).toEqual({ id: 'R-OPS', name: 'Operations' })
    // The engineer defaults are gone: push and email follow the system again.
    expect(after.email).toBe('send')
  })

  it('quiet hours from the role hold a push and name the role layer', async () => {
    state.roleRows = [
      { role_id: 'R-ENG', rules: JSON.stringify({ quiet_start: '22:00', quiet_end: '07:00' }) }
    ]
    bustRoleDefaultsCache()
    const night = new Date('2026-10-30T03:00:00Z') // 23:00 ET
    const d = await decideDelivery('u1', opts, night)
    expect(d.push).toBe(false)
    expect(d.reasons.find((r) => r.code === 'quiet_hours_push')?.layer).toBe('role')
    expect(d.layers?.push).toBe('role')
  })

  it('no role defaults and no own rules = system defaults everywhere', async () => {
    state.roleRows = []
    bustRoleDefaultsCache()
    const d = await decideDelivery('u1', opts, NOON)
    expect(d.push).toBe(true)
    expect(d.layers).toMatchObject({ inapp: 'system', push: 'system', email: 'system' })
    expect(d.role).toBeNull()
  })

  it('proposed own rules (the rules preview) still sit over the role defaults', async () => {
    const l = await getNotifyPrefsLayered('u1', { matrix: { workflow: { inapp: false } } })
    expect(l.merged.matrix?.workflow).toEqual({ inapp: false, push: false, email: 'daily' })
  })
})
