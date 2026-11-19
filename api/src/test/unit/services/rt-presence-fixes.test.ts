import { describe, expect, it } from 'vitest'
import { keepNewestActivity } from '../../../hooks/presence-typing-strip.js'

describe('M3 — a background tab never makes an active person idle (newest activity wins)', () => {
  const stored = '2026-11-18T12:00:00.000Z'

  it('an older last_active (a tab touched an hour ago) keeps the stored one and its idle claim', () => {
    const p: Record<string, unknown> = {
      last_active: '2026-11-18T11:00:00.000Z',
      is_idle: true,
      last_seen: 'now',
      is_online: true
    }
    keepNewestActivity(p, stored)
    expect(p).toEqual({ last_seen: 'now', is_online: true })
  })

  it('a newer or equal claim is written as sent', () => {
    const p: Record<string, unknown> = { last_active: '2026-11-18T12:00:05.000Z', is_idle: true }
    keepNewestActivity(p, stored)
    expect(p).toEqual({ last_active: '2026-11-18T12:00:05.000Z', is_idle: true })
    const q: Record<string, unknown> = { last_active: stored, is_idle: false }
    keepNewestActivity(q, new Date(stored))
    expect(q).toEqual({ last_active: stored, is_idle: false })
  })

  it('no stored activity, or no claim, leaves the payload alone', () => {
    const p: Record<string, unknown> = { last_active: '2026-11-18T11:00:00.000Z', is_idle: true }
    keepNewestActivity(p, null)
    expect(p.last_active).toBe('2026-11-18T11:00:00.000Z')
    const q: Record<string, unknown> = { is_online: false, is_idle: true }
    keepNewestActivity(q, stored)
    expect(q).toEqual({ is_online: false, is_idle: true })
  })

  it('an unreadable claim is dropped rather than wiping the stored activity', () => {
    const p: Record<string, unknown> = { last_active: 'not a date', is_idle: true }
    keepNewestActivity(p, stored)
    expect(p).toEqual({})
  })
})

describe('L12 — an idle flip tells the Online lists only when what they show moves', () => {
  it('compiles to the rows whose displayed idle state changes', async () => {
    const knex = (await import('knex')).default({ client: 'mssql' })
    const { presenceIdleChangedWhen } = await import('../../../services/presence-sockets.js')
    const now = new Date('2026-11-18T12:00:00Z')
    const sql = (idle: boolean) => {
      const qb = knex('user_presence').where({ user_id: 'u' })
      qb.where((w) => void presenceIdleChangedWhen(idle, now)(w))
      return qb.toSQL().toNative()
    }
    const back = sql(false)
    expect(back.sql).toMatch(/\[last_active\] is null or \[last_active\] < @p1/)
    expect(back.bindings).toEqual(['u', new Date('2026-11-18T11:55:00Z')])
    const away = sql(true)
    expect(away.sql).toMatch(
      /\[last_active\] is null and \(\[is_idle\] = @p1 or \[is_idle\] is null\)/
    )
  })
})

describe('L9 — machine accounts are never listed online', () => {
  it('drops machine-account rows; keeps everything when the read fails', async () => {
    const { withoutMachineAccounts } = await import('../../../routes/presence.js')
    const rows = [{ user_id: 'u-amy' }, { user_id: 'U-BOT' }, { user_id: 'u-ben' }]
    const out = await withoutMachineAccounts(rows, async () => ['u-bot'])
    expect(out.map((r) => r.user_id)).toEqual(['u-amy', 'u-ben'])
    const kept = await withoutMachineAccounts(rows, async () => {
      throw new Error('no column')
    })
    expect(kept).toHaveLength(3)
  })

  it('API-key and machine sockets do not mark presence; View-as is unchanged', async () => {
    const { presenceRole } = await import('../../../services/record-viewing.js')
    expect(presenceRole('apikey', {})).toBe('none')
    expect(presenceRole('session', { account_kind: 'integration' })).toBe('none')
    expect(presenceRole('session', {})).toBe('viewer')
    expect(presenceRole('masq', {})).not.toBe('none')
  })
})
