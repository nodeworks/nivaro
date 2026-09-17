import type { Knex } from 'knex'

/**
 * Ask AI learns from its own answers.
 *
 *   nivaro_ai_playbooks — one row per standalone question the chat answered
 *     with tool calls: the question, its embedding, the tool plan that worked
 *     and the answer. Similar new questions get the plan as a worked example in
 *     the system prompt, so the model stops rediscovering the same path.
 *   nivaro_ai_feedback  — thumbs up/down per question (request_id), one per
 *     person. The playbook's rating is the sum, and a net-negative playbook is
 *     never offered again.
 */
export async function up(knex: Knex): Promise<void> {
  if (!(await knex.schema.hasTable('nivaro_ai_playbooks'))) {
    await knex.schema.createTable('nivaro_ai_playbooks', (t) => {
      t.bigIncrements('id')
      t.dateTime('created_at').notNullable()
      t.dateTime('updated_at').notNullable()
      t.uuid('user').nullable()
      t.string('request_id', 40).nullable()
      t.string('feature', 30).notNullable().defaultTo('chat')
      t.string('question', 2000).notNullable()
      t.string('question_norm', 500).notNullable() // trimmed, lower-cased, single-spaced
      t.text('embedding').notNullable() // JSON number[]
      t.text('plan').notNullable() // JSON [{tool, input}]
      t.text('answer').nullable() // capped
      t.integer('rounds').nullable()
      t.integer('rating').nullable() // sum of feedback ratings; NULL = none yet
      t.integer('use_count').notNullable().defaultTo(0)
      t.dateTime('last_used_at').nullable()
      t.index(['question_norm'], 'ix_ai_playbooks_norm')
      t.index(['request_id'], 'ix_ai_playbooks_request')
      t.index(['updated_at'], 'ix_ai_playbooks_updated')
    })
  }
  if (!(await knex.schema.hasTable('nivaro_ai_feedback'))) {
    await knex.schema.createTable('nivaro_ai_feedback', (t) => {
      t.bigIncrements('id')
      t.dateTime('created_at').notNullable()
      t.string('request_id', 40).notNullable()
      t.uuid('user').notNullable()
      t.smallint('rating').notNullable() // 1 | -1
      t.string('comment', 1000).nullable()
      t.unique(['request_id', 'user'], { indexName: 'ux_ai_feedback_request_user' })
      t.index(['created_at'], 'ix_ai_feedback_created')
    })
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('nivaro_ai_feedback')
  await knex.schema.dropTableIfExists('nivaro_ai_playbooks')
}
