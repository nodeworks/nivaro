import { describe, expect, it } from 'vitest'
import * as m510 from '../../../db/migrations/510_agent_triggers.js'
import * as m511 from '../../../db/migrations/511_agent_questions_task_agents.js'

// Minimal fake knex: records tables created, columns named and columns added.
function fake(tables: string[], columns: string[] = []) {
  const log = { created: [] as string[], cols: [] as string[], altered: [] as string[] }
  const tb = (): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop: string) {
          return (...args: unknown[]) => {
            if (
              [
                'string',
                'specificType',
                'text',
                'integer',
                'uuid',
                'boolean',
                'increments',
                'bigIncrements'
              ].includes(prop)
            )
              log.cols.push(`${prop}:${String(args[0])}`)
            if (prop === 'index' || prop === 'unique') {
              const name = args[1] as string | { indexName?: string }
              log.cols.push(`${prop}:${typeof name === 'object' ? name?.indexName : name}`)
            }
            return tb()
          }
        }
      }
    )
  const knex = {
    client: { config: { client: 'mssql' } },
    raw: (sql: string) => ({ sql }),
    fn: { now: () => 'now' },
    schema: {
      hasTable: async (t: string) => tables.includes(t) || log.created.includes(t),
      hasColumn: async (t: string, c: string) => columns.includes(`${t}.${c}`),
      createTable: async (t: string, cb: (b: unknown) => void) => {
        log.created.push(t)
        cb(tb())
      },
      alterTable: async (t: string, cb: (b: unknown) => void) => {
        log.altered.push(t)
        cb(tb())
      },
      dropTable: async () => {}
    }
  }
  return { knex: knex as never, log }
}

describe('migration 510 — agent triggers', () => {
  it('creates the triggers and deliveries tables', async () => {
    const { knex, log } = fake(['nivaro_users'])
    await m510.up(knex)
    expect(log.created).toEqual(['nivaro_agent_triggers', 'nivaro_agent_trigger_deliveries'])
    for (const c of [
      'string:url',
      'string:signing_secret',
      'specificType:headers',
      'uuid:owner',
      'integer:max_attempts',
      'uuid:delivery_key',
      'string:status',
      'specificType:next_attempt_at',
      'index:ix_agent_deliv_due',
      'unique:ux_agent_deliv_key'
    ])
      expect(log.cols).toContain(c)
  })
  it('is a no-op when the tables exist', async () => {
    const { knex, log } = fake([
      'nivaro_users',
      'nivaro_agent_triggers',
      'nivaro_agent_trigger_deliveries'
    ])
    await m510.up(knex)
    expect(log.created).toEqual([])
  })
})

describe('migration 511 — agent questions + task agents', () => {
  it('creates the questions table and adds the task agent columns', async () => {
    const { knex, log } = fake(['nivaro_users', 'nivaro_tasks'])
    await m511.up(knex)
    expect(log.created).toEqual(['nivaro_agent_questions'])
    expect(log.altered).toEqual(['nivaro_tasks', 'nivaro_tasks'])
    for (const c of [
      'uuid:id',
      'string:asker_conn',
      'uuid:recipient',
      'specificType:choices',
      'specificType:expires_at',
      'string:agent_assignee',
      'index:ix_tasks_agent_assignee',
      'string:agent_name'
    ])
      expect(log.cols).toContain(c)
  })
  it('skips what is already there', async () => {
    const { knex, log } = fake(
      ['nivaro_users', 'nivaro_tasks', 'nivaro_agent_questions'],
      ['nivaro_tasks.agent_assignee', 'nivaro_tasks.agent_name']
    )
    await m511.up(knex)
    expect(log.created).toEqual([])
    expect(log.altered).toEqual([])
  })
})
