import type { Knex } from 'knex'
import { isMssql, utcNow } from '../dialect.js'

/**
 * Agents working with people (#3220, #3223).
 *
 * nivaro_agent_questions — ask_human: an agent (an MCP connection, acting as its
 *   person) asks someone a question, optionally with choices. The person answers
 *   in My Work or from the notification; the agent reads the answer by id.
 *   `asker_conn` is the connection key (o<grant> | k<api key> | u<user>) the
 *   question came from, `asker` the person that connection acts as. Questions
 *   expire at `expires_at`; `answer_seen_at` is when the asking agent collected
 *   the answer (my_work lists answers it has not collected yet).
 *
 * nivaro_tasks.agent_assignee / agent_name — a task handed to an agent
 *   connection. `assignee` stays the person the connection acts as (so every
 *   existing gate still applies); agent_assignee names the connection that picks
 *   it up through my_work, agent_name is the connection's name when assigned.
 *
 * Personal data: promote-config must never copy nivaro_agent_questions.
 */
const QUESTIONS = 'nivaro_agent_questions'

export async function up(knex: Knex): Promise<void> {
  const mssql = isMssql(knex)
  const stamp = (t: Knex.CreateTableBuilder, name: string) =>
    mssql ? t.specificType(name, 'datetime2') : t.timestamp(name)

  if (!(await knex.schema.hasTable(QUESTIONS))) {
    await knex.schema.createTable(QUESTIONS, (t) => {
      t.uuid('id').primary()
      t.string('asker_conn', 64).notNullable()
      t.string('asker_name', 200).nullable()
      t.uuid('asker').notNullable().references('id').inTable('nivaro_users').onDelete('NO ACTION')
      t.uuid('recipient')
        .notNullable()
        .references('id')
        .inTable('nivaro_users')
        .onDelete('NO ACTION')
      if (mssql) t.specificType('question', 'nvarchar(max)').notNullable()
      else t.text('question', 'longtext').notNullable()
      // JSON ["Yes","No",…]; null = free text
      if (mssql) t.specificType('choices', 'nvarchar(max)').nullable()
      else t.text('choices', 'longtext').nullable()
      t.boolean('allow_text').notNullable().defaultTo(true)
      t.string('collection', 64).nullable()
      t.string('item', 255).nullable()
      // open | answered | expired | cancelled
      t.string('status', 16).notNullable().defaultTo('open')
      if (mssql) t.specificType('answer', 'nvarchar(max)').nullable()
      else t.text('answer', 'longtext').nullable()
      t.string('answer_choice', 200).nullable()
      t.uuid('answered_by').nullable()
      stamp(t, 'answered_at').nullable()
      stamp(t, 'answer_seen_at').nullable()
      stamp(t, 'expires_at').notNullable()
      for (const name of ['created_at', 'updated_at']) {
        stamp(t, name).notNullable().defaultTo(utcNow(knex))
      }
      t.index(['recipient', 'status'], 'ix_agent_q_recipient')
      t.index(['asker_conn', 'status'], 'ix_agent_q_conn')
    })
  }

  if (await knex.schema.hasTable('nivaro_tasks')) {
    if (!(await knex.schema.hasColumn('nivaro_tasks', 'agent_assignee'))) {
      await knex.schema.alterTable('nivaro_tasks', (t) => {
        t.string('agent_assignee', 64).nullable()
        t.index(['agent_assignee', 'status'], 'ix_tasks_agent_assignee')
      })
    }
    if (!(await knex.schema.hasColumn('nivaro_tasks', 'agent_name'))) {
      await knex.schema.alterTable('nivaro_tasks', (t) => {
        t.string('agent_name', 200).nullable()
      })
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  if (await knex.schema.hasTable('nivaro_tasks')) {
    if (await knex.schema.hasColumn('nivaro_tasks', 'agent_assignee')) {
      await knex.schema
        .alterTable('nivaro_tasks', (t) => {
          t.dropIndex(['agent_assignee', 'status'], 'ix_tasks_agent_assignee')
        })
        .catch(() => undefined)
    }
    for (const col of ['agent_name', 'agent_assignee']) {
      if (await knex.schema.hasColumn('nivaro_tasks', col)) {
        await knex.schema.alterTable('nivaro_tasks', (t) => {
          t.dropColumn(col)
        })
      }
    }
  }
  if (await knex.schema.hasTable(QUESTIONS)) await knex.schema.dropTable(QUESTIONS)
}
