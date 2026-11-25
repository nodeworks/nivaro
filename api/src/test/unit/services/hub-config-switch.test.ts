import type { Knex } from 'knex'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// The Hub's config promotion switch: off by default (no row, an unreadable row), saved as one
// JSON object in nivaro_extension_settings, true/false only.

vi.mock('../../../db/index.js', async () => {
  const knex = (await import('knex')).default
  const { sqliteAfterCreate, sqliteCompat } = await import('../../../db/sqlite.js')
  sqliteCompat()
  const db = knex({
    client: 'better-sqlite3',
    connection: { filename: ':memory:' },
    useNullAsDefault: true,
    pool: { min: 1, max: 1, afterCreate: sqliteAfterCreate }
  })
  return { db }
})

const { db } = (await import('../../../db/index.js')) as unknown as { db: Knex }
const S = await import('../../../services/hub/config/switch.js')

beforeAll(async () => {
  await db.schema.createTable('nivaro_extension_settings', (t) => {
    t.increments('id')
    t.string('extension_id', 100)
    t.string('key', 100)
    t.text('value')
    t.dateTime('updated_at')
    t.uuid('updated_by')
  })
})
afterAll(async () => {
  await db.destroy()
})

describe('config promotion switch', () => {
  it('is off with no row and with a row that cannot be read', async () => {
    expect(await S.configPromotionOn()).toBe(false)
    await db('nivaro_extension_settings').insert({
      extension_id: S.SWITCH_EXT,
      key: S.SWITCH_KEY,
      value: 'not json'
    })
    expect(await S.configPromotionOn()).toBe(false)
    await db('nivaro_extension_settings').del()
  })

  it('turns on and off; only true / false are accepted', async () => {
    await S.saveConfigSwitch({ config_promotion: true }, '00000000-0000-4000-8000-000000000001')
    expect(await S.configPromotionOn()).toBe(true)
    await S.saveConfigSwitch({ config_promotion: false }, null)
    expect(await S.configPromotionOn()).toBe(false)
    expect(await db('nivaro_extension_settings').count('* as n').first()).toMatchObject({ n: 1 })
    await expect(S.saveConfigSwitch({ config_promotion: 'yes' }, null)).rejects.toMatchObject({
      code: 'BAD_SWITCH',
      status: 400
    })
  })

  it('refuses in plain words', () => {
    const e = S.switchedOff()
    expect(e).toMatchObject({ code: 'CONFIG_PROMOTION_OFF', status: 409 })
    expect(e.message).toBe(
      'Config promotion is off until it has been tried on a staging pair. An administrator can turn it on in Hub settings.'
    )
  })
})
