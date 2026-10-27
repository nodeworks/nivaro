import { describe, expect, it } from 'vitest'
import * as m from '../../../db/migrations/505_teams_bot.js'

// Minimal fake knex: records DDL; `has` says which tables/columns exist.
function fake(has: { tables: string[]; columns: string[] }) {
  const log = {
    raw: [] as string[],
    alter: [] as string[],
    created: [] as string[],
    cols: [] as string[]
  }
  const tb = (sink: string[]) =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: unknown[]) => {
            if (
              ['string', 'text', 'boolean', 'uuid', 'specificType', 'increments'].includes(prop)
            ) {
              sink.push(`${prop}:${String(args[0])}${args[1] != null ? `:${String(args[1])}` : ''}`)
            }
            return tb(sink)
          }
        }
      }
    )
  const knex = {
    raw: async (sql: string) => void log.raw.push(sql),
    schema: {
      hasTable: async (t: string) => has.tables.includes(t),
      hasColumn: async (t: string, c: string) => has.columns.includes(`${t}.${c}`),
      alterTable: async (t: string, cb: (b: unknown) => void) => {
        log.alter.push(t)
        cb(tb(log.cols))
      },
      createTable: async (t: string, cb: (b: unknown) => void) => {
        log.created.push(t)
        cb(tb(log.cols))
      },
      dropTableIfExists: async () => {}
    }
  }
  return { knex: knex as never, log }
}

describe('migration 505', () => {
  it('adds users columns, filtered unique index, links table and settings columns', async () => {
    const { knex, log } = fake({ tables: ['nivaro_users', 'nivaro_settings'], columns: [] })
    await m.up(knex)
    expect(log.cols).toContain('string:entra_oid:64')
    expect(log.cols).toContain('string:entra_tid:64')
    const idx = log.raw.find((s) => s.includes('CREATE UNIQUE INDEX'))
    expect(idx).toContain('WHERE [entra_oid] IS NOT NULL')
    expect(idx).toContain('sys.indexes')
    expect(log.created).toEqual(['nivaro_teams_links'])
    for (const c of [
      'aad_object_id:64',
      'tenant_id:64',
      'conversation_id:400',
      'service_url:400',
      'status:20',
      'linked_by:20',
      'last_error:500',
      'installed_at',
      'linked_at',
      'last_inbound_at',
      'last_sent_at'
    ])
      expect(log.cols.some((x) => x.includes(c))).toBe(true)
    for (const c of [
      'boolean:teams_bot_enabled',
      'string:teams_bot_app_id:100',
      'string:teams_bot_tenant_id:64'
    ])
      expect(log.cols).toContain(c)
    expect(log.cols.some((x) => x.startsWith('text:teams_bot_app_secret'))).toBe(true)
  })

  it('is a no-op when everything already exists', async () => {
    const { knex, log } = fake({
      tables: ['nivaro_users', 'nivaro_settings', 'nivaro_teams_links'],
      columns: [
        'nivaro_users.entra_oid',
        'nivaro_users.entra_tid',
        'nivaro_settings.teams_bot_enabled',
        'nivaro_settings.teams_bot_app_id',
        'nivaro_settings.teams_bot_app_secret',
        'nivaro_settings.teams_bot_tenant_id'
      ]
    })
    await m.up(knex)
    expect(log.alter).toEqual([])
    expect(log.created).toEqual([])
    expect(log.raw.every((s) => s.includes('IF NOT EXISTS'))).toBe(true)
  })

  it('skips tables that are absent', async () => {
    const { knex, log } = fake({ tables: [], columns: [] })
    await m.up(knex)
    expect(log.alter).toEqual([])
    expect(log.raw).toEqual([])
  })
})
