import type { Knex } from 'knex'

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.specificType('ai_model', 'nvarchar(100)').defaultTo('claude-haiku-4-5-20251001')
    t.integer('ai_max_tokens_generate').defaultTo(500)
    t.integer('ai_max_tokens_summarize').defaultTo(200)
    t.integer('sla_business_day_start').defaultTo(9)
    t.integer('sla_business_day_end').defaultTo(17)
    t.specificType('sla_business_days', 'nvarchar(20)').defaultTo('1,2,3,4,5')
    t.integer('file_max_size_mb').defaultTo(50)
    t.integer('collection_page_size').defaultTo(25)
    t.integer('activity_retention_days').nullable()
    t.integer('revision_retention_count').nullable()
  })
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('nivaro_settings', (t) => {
    t.dropColumn('ai_model')
    t.dropColumn('ai_max_tokens_generate')
    t.dropColumn('ai_max_tokens_summarize')
    t.dropColumn('sla_business_day_start')
    t.dropColumn('sla_business_day_end')
    t.dropColumn('sla_business_days')
    t.dropColumn('file_max_size_mb')
    t.dropColumn('collection_page_size')
    t.dropColumn('activity_retention_days')
    t.dropColumn('revision_retention_count')
  })
}
