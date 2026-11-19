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
